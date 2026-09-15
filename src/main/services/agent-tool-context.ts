import type { ToolMessage } from '../backends/types';

const pinSteps = 6;
const loopWindowSteps = 8;
const mutatingTools = new Set(['apply_patch', 'write_file', 'create_file', 'delete_file', 'run_terminal']);
type Read = { key: string; path: string; range: string; fingerprint: string; readCount: number; firstReadStep: number; lastReadStep: number; pinUntil: number; loopSuspected: boolean };
type Entry = { tool: string; argumentsObject: Record<string, unknown>; message: ToolMessage; raw: string; compacted: boolean; compactReason?: string; mutating: boolean; failed: boolean; step: number; read?: Read };
export type ToolContextStats = { size: number; budget: number; compacted: number; peakSize: number; activeReads: number; suspectedReadLoops: number };
export type ReadDiagnostic = { path: string; range: string; fingerprint: string; readCount: number; sameContentAlreadyRead: boolean; previousResultActive: boolean; previousResultCompacted: boolean; previousCompactionReason?: string; repeatedReadLoopSuspected: boolean; pinned: boolean };
const json = (content: string): Record<string, unknown> | undefined => { try { const value = JSON.parse(content); return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; } catch { return undefined; } };
function readFrom(tool: string, raw: string, step: number): Read | undefined {
  if (tool !== 'read_file' && tool !== 'inspect_package_json') return undefined;
  const value = json(raw); if (!value) return undefined; const path = typeof value.path === 'string' ? value.path : undefined; const fingerprint = typeof value.fingerprint === 'string' ? value.fingerprint : undefined;
  if (!path || !fingerprint) return undefined;
  const range = typeof value.start_line === 'number' ? `lines:${value.start_line}-${value.end_line}` : `bytes:${value.byte_start ?? 0}-${value.byte_end ?? 0}`;
  return { key: `${path}\u0000${range}\u0000${fingerprint}`, path, range, fingerprint, readCount: 1, firstReadStep: step, lastReadStep: step, pinUntil: 0, loopSuspected: false };
}
function reference(entry: Entry, reason: string): string { const read = entry.read; return JSON.stringify({ context_compacted: true, tool: entry.tool, path: read?.path ?? entry.argumentsObject.path, range: read?.range, fingerprint: read?.fingerprint, original_chars: entry.raw.length, reason, note: read ? 'Previously received this file chunk; call read_file with a specific range to restore it if needed.' : `Previously received ${entry.tool}; full output omitted from active context.` }); }

/** Generation-local deterministic context working set. Raw reads survive compaction outside the active prompt. */
export class AgentToolContext {
  private readonly entries: Entry[] = []; private readonly reads = new Map<string, Entry>(); private compacted = 0; private peakSize = 0;
  readonly budget: number;
  constructor(contextWindow: number) { this.budget = Math.max(12_000, Math.min(160_000, Math.floor(contextWindow * 2))); }
  add(tool: string, argumentsObject: Record<string, unknown>, message: ToolMessage, step = 0): { stats: ToolContextStats; read?: ReadDiagnostic } {
    const raw = message.content; const value = json(raw); const entry: Entry = { tool, argumentsObject, message, raw, compacted: false, mutating: mutatingTools.has(tool), failed: typeof value?.error === 'string', step };
    const read = readFrom(tool, raw, step); let diagnostic: ReadDiagnostic | undefined;
    if (read) {
      const previous = this.reads.get(read.key);
      if (previous?.read) {
        const prior = previous.read; const wasCompacted = previous.compacted; const reason = previous.compactReason; prior.readCount += 1; prior.lastReadStep = step; prior.pinUntil = Math.max(prior.pinUntil, step + pinSteps);
        if (step - prior.firstReadStep <= loopWindowSteps && prior.readCount >= 3) prior.loopSuspected = true;
        if (previous.compacted) { previous.message.content = previous.raw; previous.compacted = false; previous.compactReason = undefined; }
        message.content = JSON.stringify({ cached_read: true, path: prior.path, range: prior.range, fingerprint: prior.fingerprint, content_available_in_active_context: true, read_count: prior.readCount, repeated_read_loop_suspected: prior.loopSuspected });
        diagnostic = { path: prior.path, range: prior.range, fingerprint: prior.fingerprint, readCount: prior.readCount, sameContentAlreadyRead: true, previousResultActive: !wasCompacted, previousResultCompacted: wasCompacted, previousCompactionReason: reason, repeatedReadLoopSuspected: prior.loopSuspected, pinned: true };
      } else { entry.read = read; this.reads.set(read.key, entry); diagnostic = { path: read.path, range: read.range, fingerprint: read.fingerprint, readCount: 1, sameContentAlreadyRead: false, previousResultActive: false, previousResultCompacted: false, repeatedReadLoopSuspected: false, pinned: false }; }
    }
    this.entries.push(entry); if (entry.mutating && !entry.failed) this.invalidate(tool, raw); this.compact(step); this.peakSize = Math.max(this.peakSize, this.size()); return { stats: this.stats(), ...(diagnostic ? { read: diagnostic } : {}) };
  }
  stats(): ToolContextStats { return { size: this.size(), budget: this.budget, compacted: this.compacted, peakSize: this.peakSize, activeReads: [...this.reads.values()].filter((entry) => !entry.compacted).length, suspectedReadLoops: [...this.reads.values()].filter((entry) => entry.read?.loopSuspected).length }; }
  private size(): number { return this.entries.reduce((sum, entry) => sum + entry.message.content.length, 0); }
  private invalidate(tool: string, raw: string): void { const value = json(raw); const paths = new Set<string>(); if (typeof value?.path === 'string') paths.add(value.path); for (const key of ['files', 'changed'] as const) if (Array.isArray(value?.[key])) for (const path of value![key]) if (typeof path === 'string') paths.add(path); for (const [key, entry] of this.reads) if (tool === 'run_terminal' || (entry.read && paths.has(entry.read.path))) { if (!entry.compacted) { entry.message.content = reference(entry, 'invalidated_by_mutation'); entry.compacted = true; entry.compactReason = 'invalidated_by_mutation'; this.compacted += 1; } this.reads.delete(key); } }
  private compact(step: number): void { while (this.size() > this.budget) { const candidates = this.entries.filter((entry) => !entry.compacted && !entry.failed && !entry.mutating && (!entry.read || entry.read.pinUntil <= step)); if (!candidates.length) break; candidates.sort((a, b) => (a.read?.lastReadStep ?? a.step) - (b.read?.lastReadStep ?? b.step) || (a.read?.readCount ?? 0) - (b.read?.readCount ?? 0) || b.message.content.length - a.message.content.length); const entry = candidates[0]; entry.message.content = reference(entry, entry.read ? 'stale_low_relevance_read' : 'low_relevance_tool_result'); entry.compacted = true; entry.compactReason = entry.read ? 'stale_low_relevance_read' : 'low_relevance_tool_result'; this.compacted += 1; } }
}
