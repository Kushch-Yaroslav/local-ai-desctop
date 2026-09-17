import type { ToolMessage } from '../backends/types';

const pinSteps = 6;
const loopWindowSteps = 8;
const mutatingTools = new Set(['apply_patch', 'write_file', 'create_file', 'delete_file']);
type RangeKind = 'bytes' | 'lines';
export type ReadRelationship = 'new' | 'exact_duplicate' | 'covered' | 'overlap';
type Range = { kind: RangeKind; start: number; end: number; fullFile: boolean };
type Read = { key: string; path: string; range: string; rangeValue: Range; fingerprint: string; readCount: number; firstReadStep: number; lastReadStep: number; pinUntil: number; loopSuspected: boolean };
type Entry = { tool: string; argumentsObject: Record<string, unknown>; message: ToolMessage; raw: string; compacted: boolean; compactReason?: string; mutating: boolean; failed: boolean; step: number; read?: Read };
type InvalidatedRead = { reason: string; step: number; path: string; fingerprint: string; rangeValue: Range };
export type ToolContextStats = { size: number; budget: number; compacted: number; peakSize: number; activeReads: number; suspectedReadLoops: number; invalidatedReads: number };
export type ReadDiagnostic = {
  path: string; range: string; fingerprint: string; readCount: number; sameContentAlreadyRead: boolean; previousResultActive: boolean; previousResultCompacted: boolean; previousCompactionReason?: string;
  previousResultInvalidated: boolean; previousInvalidationReason?: string; unchanged?: boolean; requested_range_already_available?: boolean; repeatedReadLoopSuspected: boolean; pinned: boolean; relationship: ReadRelationship; coveredByRange?: string;
};
export type ToolContextUpdate = { stats: ToolContextStats; read?: ReadDiagnostic; invalidation?: { reason: string; reads: number } };

const json = (content: string): Record<string, unknown> | undefined => { try { const value = JSON.parse(content); return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; } catch { return undefined; } };
const normalizedPath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');
function readFrom(tool: string, raw: string, step: number): Read | undefined {
  if (tool !== 'read_file' && tool !== 'inspect_package_json') return undefined;
  const value = json(raw); if (!value) return undefined; const sourcePath = typeof value.path === 'string' ? value.path : undefined; const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : undefined;
  if (!sourcePath || !fingerprint) return undefined;
  const rangeValue: Range = typeof value.start_line === 'number'
    ? { kind: 'lines', start: value.start_line, end: typeof value.end_line === 'number' ? value.end_line : value.start_line, fullFile: value.start_line === 1 && value.has_more === false }
    : { kind: 'bytes', start: typeof value.byte_start === 'number' ? value.byte_start : 0, end: typeof value.byte_end === 'number' ? value.byte_end : 0, fullFile: value.byte_start === 0 && typeof value.size_bytes === 'number' && value.byte_end === value.size_bytes };
  const projectId = typeof value.project_id === 'string' ? value.project_id : 'project-1';
  const path = `${projectId}:${normalizedPath(sourcePath)}`; const range = `${rangeValue.kind}:${rangeValue.start}-${rangeValue.end}`;
  return { key: `${path}\u0000${range}\u0000${fingerprint}`, path, range, rangeValue, fingerprint, readCount: 1, firstReadStep: step, lastReadStep: step, pinUntil: 0, loopSuspected: false };
}
function reference(entry: Entry, reason: string): string {
  const read = entry.read;
  return JSON.stringify({ context_compacted: true, tool: entry.tool, path: read?.path ?? entry.argumentsObject.path, range: read?.range, fingerprint: read?.fingerprint, original_chars: entry.raw.length, reason, note: read ? 'Previously received this file chunk; call read_file with a specific range to restore it if needed.' : `Previously received ${entry.tool}; full output omitted from active context.` });
}
function overlaps(one: Range, two: Range): boolean {
  if (one.fullFile || two.fullFile) return true;
  if (one.kind !== two.kind) return false;
  return one.kind === 'bytes' ? one.start < two.end && two.start < one.end : one.start <= two.end && two.start <= one.end;
}
function covers(one: Range, two: Range): boolean { return one.fullFile || one.kind === two.kind && one.start <= two.start && one.end >= two.end; }
function terminalMayMutate(command: string): boolean {
  // Stderr suppression does not change project files. Strip it before the
  // conservative redirection check so `command -v node 2>/dev/null` stays
  // classified as read-only.
  const cleaned = command.replace(/\d*>(?:&\d+|\/dev\/null)/g, '').trim();
  if (!cleaned) return true;
  if (/\$\(|`|(?:^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|chmod|chown|tee|truncate|dd|install)\b|\bsed\s+-i\b|\bgit\s+(?:commit|reset|checkout|restore|clean|apply|merge|rebase)\b|\bnpm\s+(?:install|uninstall|ci|update|run|exec)\b|\b(?:writeFile|appendFile|copyFile|unlink|rename|mkdir|rm|chmod|chown|exec|spawn|fork|child_process)\b|(?:^|[^&])>{1,2}(?!&)/i.test(cleaned)) return true;
  const harmlessNodeEval = /^\s*(?:(?:const|let|var)\s+[\s\S]*?require\(['"](?:node:[\w-]+|\.\/package\.json)['"]\)[\s\S]*?;\s*)?console\.log\([\s\S]*\)\s*;?\s*$/;
  const withoutHarmlessNodeEval = cleaned.replace(/node(?:js|22)?\s+-e\s+(['"])([\s\S]*?)\1/g, (whole, _quote: string, program: string) => harmlessNodeEval.test(program) && !/\b(?:process|import|await|function|=>)\b/.test(program) ? 'node-e-read-only' : whole);
  const segments = withoutHarmlessNodeEval.split(/&&|;|\|/).map((segment) => segment.trim()).filter(Boolean);
  const readOnly = /^(?:cd\s+[~/\w./-]+|command\s+-v\s+[\w\s.-]+|type\s+[\w\s.-]+|which\s+[\w\s.-]+|pwd|echo(?:\s|$)|ls(?:\s|$)|find(?:\s|$)|rg(?:\s|$)|grep(?:\s|$)|cat(?:\s|$)|head(?:\s|$)|tail(?:\s|$)|wc(?:\s|$)|git\s+(?:status|diff|log|branch)(?:\s|$)|node(?:js|22)?\s+(?:--version|-v)\s*$|npm\s+(?:--version|-v)\s*$)/i;
  return !segments.every((segment) => segment === 'node-e-read-only' || readOnly.test(segment));
}

/** Generation-local deterministic context working set. Raw reads survive compaction outside the active prompt. */
export class AgentToolContext {
  private readonly entries: Entry[] = [];
  private readonly reads = new Map<string, Entry>();
  private readonly invalidated = new Map<string, InvalidatedRead>();
  private compacted = 0;
  private peakSize = 0;
  private invalidatedReads = 0;
  readonly budget: number;
  constructor(contextWindow: number) { this.budget = Math.max(12_000, Math.min(160_000, Math.floor(contextWindow * 2))); }

  add(tool: string, argumentsObject: Record<string, unknown>, message: ToolMessage, step = 0): ToolContextUpdate {
    const raw = message.content; const value = json(raw);
    const entry: Entry = { tool, argumentsObject, message, raw, compacted: false, mutating: mutatingTools.has(tool) || tool === 'run_terminal' && terminalMayMutate(typeof argumentsObject.command === 'string' ? argumentsObject.command : ''), failed: typeof value?.error === 'string', step };
    const read = readFrom(tool, raw, step); let diagnostic: ReadDiagnostic | undefined;
    if (read) {
      const previous = this.reads.get(read.key); const invalidated = this.invalidated.get(read.key) ?? this.invalidatedCoverage(read);
      if (previous?.read) {
        const prior = previous.read; const wasCompacted = previous.compacted; const reason = previous.compactReason;
        prior.readCount += 1; prior.lastReadStep = step; prior.pinUntil = Math.max(prior.pinUntil, step + pinSteps);
        if (step - prior.firstReadStep <= loopWindowSteps && prior.readCount >= 3) prior.loopSuspected = true;
        if (previous.compacted) {
          previous.message.content = previous.raw; previous.compacted = false; previous.compactReason = undefined;
          message.content = JSON.stringify({ status: 'restored_cached_read', path: prior.path, range: prior.range, fingerprint: prior.fingerprint, content_available_in_active_context: true, read_count: prior.readCount, repeated_read_loop_suspected: prior.loopSuspected });
        } else message.content = JSON.stringify({ status: 'unchanged', unchanged: true, requested_range_already_available: true, path: prior.path, range: prior.range, fingerprint: prior.fingerprint, message: 'This unchanged range is already available in the current generation context. Use the existing result unless a different range or refreshed file state is required.', read_count: prior.readCount, repeated_read_loop_suspected: prior.loopSuspected });
        diagnostic = { path: prior.path, range: prior.range, fingerprint: prior.fingerprint, readCount: prior.readCount, sameContentAlreadyRead: true, previousResultActive: !wasCompacted, previousResultCompacted: wasCompacted, previousCompactionReason: reason, previousResultInvalidated: false, ...(!wasCompacted ? { unchanged: true, requested_range_already_available: true } : {}), repeatedReadLoopSuspected: prior.loopSuspected, pinned: true, relationship: 'exact_duplicate' };
      } else {
        const coverage = this.coverage(read);
        entry.read = read; this.reads.set(read.key, entry); this.invalidated.delete(read.key);
        diagnostic = {
          path: read.path, range: read.range, fingerprint: read.fingerprint, readCount: 1, sameContentAlreadyRead: false, previousResultActive: false, previousResultCompacted: false,
          previousResultInvalidated: Boolean(invalidated), ...(invalidated ? { previousInvalidationReason: invalidated.reason } : {}), repeatedReadLoopSuspected: false, pinned: false,
          relationship: coverage?.relationship ?? 'new', ...(coverage ? { coveredByRange: coverage.entry.read!.range } : {}),
        };
      }
    }
    this.entries.push(entry);
    const invalidation = entry.mutating && !entry.failed ? this.invalidate(tool, raw, step, tool === 'run_terminal' ? 'terminal_may_have_mutated_files' : 'invalidated_by_mutation') : undefined;
    this.compact(step); this.peakSize = Math.max(this.peakSize, this.size());
    return { stats: this.stats(), ...(diagnostic ? { read: diagnostic } : {}), ...(invalidation ? { invalidation } : {}) };
  }

  stats(): ToolContextStats {
    return { size: this.size(), budget: this.budget, compacted: this.compacted, peakSize: this.peakSize, activeReads: [...this.reads.values()].filter((entry) => !entry.compacted).length, suspectedReadLoops: [...this.reads.values()].filter((entry) => entry.read?.loopSuspected).length, invalidatedReads: this.invalidatedReads };
  }
  private size(): number { return this.entries.reduce((sum, entry) => sum + entry.message.content.length, 0); }
  private coverage(read: Read): { relationship: 'covered' | 'overlap'; entry: Entry } | undefined {
    const candidates = [...this.reads.values()].filter((entry) => entry.read && entry.read.path === read.path && entry.read.fingerprint === read.fingerprint && entry.read.key !== read.key && overlaps(entry.read.rangeValue, read.rangeValue));
    if (!candidates.length) return undefined;
    candidates.sort((one, two) => (one.read!.rangeValue.end - one.read!.rangeValue.start) - (two.read!.rangeValue.end - two.read!.rangeValue.start));
    const entry = candidates.find((candidate) => covers(candidate.read!.rangeValue, read.rangeValue)) ?? candidates[0];
    return { relationship: covers(entry.read!.rangeValue, read.rangeValue) ? 'covered' : 'overlap', entry };
  }
  private invalidatedCoverage(read: Read): InvalidatedRead | undefined {
    return [...this.invalidated.values()].find((entry) => entry.path === read.path && entry.fingerprint === read.fingerprint && overlaps(entry.rangeValue, read.rangeValue));
  }
  private invalidate(tool: string, raw: string, step: number, reason: string): { reason: string; reads: number } | undefined {
    const value = json(raw); const paths = new Set<string>();
    if (typeof value?.path === 'string') paths.add(normalizedPath(value.path));
    for (const key of ['files', 'changed'] as const) if (Array.isArray(value?.[key])) for (const path of value![key]) if (typeof path === 'string') paths.add(normalizedPath(path));
    let count = 0;
    for (const [key, entry] of this.reads) {
      if (tool !== 'run_terminal' && (!entry.read || !paths.has(entry.read.path))) continue;
      if (!entry.compacted) { entry.message.content = reference(entry, reason); entry.compacted = true; entry.compactReason = reason; this.compacted += 1; }
      this.reads.delete(key);
      if (entry.read) this.invalidated.set(key, { reason, step, path: entry.read.path, fingerprint: entry.read.fingerprint, rangeValue: entry.read.rangeValue });
      count += 1;
    }
    this.invalidatedReads += count;
    return count ? { reason, reads: count } : undefined;
  }
  private compact(step: number): void {
    while (this.size() > this.budget) {
      const candidates = this.entries.filter((entry) => !entry.compacted && !entry.failed && !entry.mutating && (!entry.read || entry.read.pinUntil <= step));
      if (!candidates.length) break;
      candidates.sort((a, b) => (a.read?.lastReadStep ?? a.step) - (b.read?.lastReadStep ?? b.step) || (a.read?.readCount ?? 0) - (b.read?.readCount ?? 0) || b.message.content.length - a.message.content.length);
      const entry = candidates[0]; entry.message.content = reference(entry, entry.read ? 'stale_low_relevance_read' : 'low_relevance_tool_result'); entry.compacted = true; entry.compactReason = entry.read ? 'stale_low_relevance_read' : 'low_relevance_tool_result'; this.compacted += 1;
    }
  }
}
