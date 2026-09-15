import type { ToolMessage } from '../backends/types';

const recentFullResults = 4;
const mutatingTools = new Set(['apply_patch', 'write_file', 'create_file', 'delete_file', 'run_terminal']);

type Entry = { tool: string; argumentsObject: Record<string, unknown>; message: ToolMessage; compacted: boolean; mutating: boolean; failed: boolean };
export type ToolContextStats = { size: number; budget: number; compacted: number };

const length = (message: ToolMessage): number => message.content.length;

function reference(tool: string, argumentsObject: Record<string, unknown>, raw: string): string {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const path = typeof value.path === 'string' ? value.path : typeof argumentsObject.path === 'string' ? argumentsObject.path : undefined;
    const range = typeof value.start_line === 'number' && typeof value.end_line === 'number'
      ? ` lines ${value.start_line}-${value.end_line}`
      : typeof value.byte_start === 'number' && typeof value.byte_end === 'number' ? ` bytes ${value.byte_start}-${value.byte_end}` : '';
    return JSON.stringify({ context_compacted: true, tool, path, range: range.trim() || undefined, original_chars: raw.length, note: `Previously received ${tool}${path ? ` for ${path}` : ''}${range}; full output omitted from active context. Re-run the tool with a specific range if needed.` });
  } catch {
    return JSON.stringify({ context_compacted: true, tool, original_chars: raw.length, note: `Previously received ${tool}; full output omitted from active context. Re-run the tool if needed.` });
  }
}

/** Generation-local, deterministic compaction. It never asks a model to invent a summary. */
export class AgentToolContext {
  private readonly entries: Entry[] = [];
  private compacted = 0;
  readonly budget: number;

  constructor(contextWindow: number) {
    // Reserve most of the window for instructions, chat history, tool schemas and output.
    this.budget = Math.max(12_000, Math.min(160_000, Math.floor(contextWindow * 2)));
  }

  add(tool: string, argumentsObject: Record<string, unknown>, message: ToolMessage): ToolContextStats {
    const failed = (() => { try { return typeof (JSON.parse(message.content) as { error?: unknown }).error === 'string'; } catch { return false; } })();
    const entry = { tool, argumentsObject, message, compacted: false, mutating: mutatingTools.has(tool), failed };
    this.entries.push(entry);
    // A default read_file block can be 128 KB. Keep one such block from consuming
    // the entire active context before there is an older result to replace.
    if (!entry.mutating && !entry.failed && message.content.length > Math.floor(this.budget / 2)) {
      message.content = reference(tool, argumentsObject, message.content);
      entry.compacted = true;
      this.compacted += 1;
    }
    this.compact();
    return this.stats();
  }

  stats(): ToolContextStats { return { size: this.entries.reduce((sum, entry) => sum + length(entry.message), 0), budget: this.budget, compacted: this.compacted }; }

  private compact(): void {
    let stats = this.stats();
    for (const protectedCount of [recentFullResults, 2, 1]) {
      for (let index = 0; stats.size > this.budget && index < this.entries.length - protectedCount; index += 1) {
        const entry = this.entries[index];
        if (entry.compacted || entry.failed || entry.mutating) continue;
        entry.message.content = reference(entry.tool, entry.argumentsObject, entry.message.content);
        entry.compacted = true;
        this.compacted += 1;
        stats = this.stats();
      }
    }
  }
}
