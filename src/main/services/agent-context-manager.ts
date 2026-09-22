import type { AgentPlan } from '../../shared/types';
import type { ToolMessage } from '../backends/types';

/** All percentages are relative to the user's selected context window. */
export const agentContextThresholds = {
  // At 32K the previous 70% trigger was masked by the bounded recent-tool
  // window in read-heavy runs, so durable checkpoints never formed. Start at
  // 60%; normal compaction still targets 52%, preserving a real output reserve.
  checkpoint: 0.60,
  normal: 0.75,
  strong: 0.85,
  emergency: 0.90,
  normalTarget: 0.52,
  strongTarget: 0.52,
  emergencyTarget: 0.46,
  recentFraction: 0.14,
} as const;

export type ContextCompactionStats = {
  contextWindow: number;
  inputTokensBefore: number;
  inputTokensAfter: number;
  compactionTriggered: boolean;
  checkpointUpdated: boolean;
  compactedMessages: number;
  compactedToolResults: number;
  compactionCount: number;
  savedTokens: number;
  meaningfulSavings: boolean;
  compactionAttempted: boolean;
  ineffectiveCompactionCount: number;
  workingMemoryTokens: number;
  checkpointReason?: 'pre_compaction' | 'compaction' | 'refresh';
  factsAdded: number;
  factsUpdated: number;
  factsDeduplicated: number;
  staleFactsRemoved: number;
  historyRetrievalCount: number;
  postCompactionRereadCount: number;
  level?: 'normal' | 'strong' | 'emergency';
};

type CheckpointSource = { plan: AgentPlan | null; taskNotes: string; toolFacts: string[]; references: string[]; failed: string[]; modified: string[] };
export type WorkingMemoryReminder = { reason: 'inspection_batch' | 'plan_transition'; message: string };

const compactMarker = '<runtime_context kind="agent_compacted">This earlier interaction is represented by the current working-memory checkpoint.</runtime_context>';
const short = (text: string, limit = 700): string => text.replace(/\s+/g, ' ').trim().slice(0, limit);
const parse = (text: string): Record<string, unknown> | undefined => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } };
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Generation-local active-context selector. It never mutates persisted chat
 * messages or raw tool results; it only replaces entries in the payload array.
 */
export class AgentContextManager {
  private checkpointMessage: ToolMessage | undefined;
  private compactionCount = 0;
  private readonly facts = new Set<string>();
  private readonly failures = new Set<string>();
  private readonly modified = new Set<string>();
  private readonly references = new Set<string>();
  private ineffectiveCompactionCount = 0;
  private lastIneffectiveInputTokens = 0;
  private lastCompactedInputTokens = 0;
  private factsAdded = 0;
  private factsUpdated = 0;
  private factsDeduplicated = 0;
  private staleFactsRemoved = 0;
  private historyRetrievalCount = 0;
  private postCompactionRereadCount = 0;
  private readonly rawHistory = new Map<string, string>();
  private inspectionsSinceMaterialization = 0;
  private lastReminderAt = 0;
  private lastNotes = '';
  private lastPlan = '';
  private lastStats: ContextCompactionStats;

  constructor(private readonly contextWindow: number) {
    this.lastStats = { contextWindow, inputTokensBefore: 0, inputTokensAfter: 0, compactionTriggered: false, checkpointUpdated: false, compactedMessages: 0, compactedToolResults: 0, compactionCount: 0, savedTokens: 0, meaningfulSavings: false, compactionAttempted: false, ineffectiveCompactionCount: 0, workingMemoryTokens: 0, factsAdded: 0, factsUpdated: 0, factsDeduplicated: 0, staleFactsRemoved: 0, historyRetrievalCount: 0, postCompactionRereadCount: 0 };
  }

  stats(): ContextCompactionStats {
    return {
      ...this.lastStats,
      workingMemoryTokens: Math.ceil((this.checkpointMessage?.content.length ?? 0) / 4),
      factsAdded: this.factsAdded,
      factsUpdated: this.factsUpdated,
      factsDeduplicated: this.factsDeduplicated,
      staleFactsRemoved: this.staleFactsRemoved,
      historyRetrievalCount: this.historyRetrievalCount,
      postCompactionRereadCount: this.postCompactionRereadCount,
    };
  }

  /** Keep an existing checkpoint current without an extra model call. */
  observe(message: ToolMessage, messages: ToolMessage[], state: { plan: AgentPlan | null; taskNotes: string }, rawResult?: string): WorkingMemoryReminder | undefined {
    // AgentToolContext deliberately shapes very large results before they go
    // back to the model. Keep the executor result separately so a later
    // targeted recall is useful rather than merely returning that shape.
    if (message.tool_call_id) this.rawHistory.set(message.tool_call_id, rawResult ?? message.content);
    if (this.checkpointMessage && message.tool_name === 'read_file') this.postCompactionRereadCount += 1;
    const plan = JSON.stringify(state.plan);
    const notesChanged = state.taskNotes !== this.lastNotes;
    const planChanged = plan !== this.lastPlan;
    const isInspection = ['read_file', 'search_text', 'search_files', 'find_files', 'list_directory', 'inspect_package_json', 'run_terminal'].includes(message.tool_name ?? '');
    if (notesChanged || planChanged) {
      this.inspectionsSinceMaterialization = 0;
      this.lastNotes = state.taskNotes;
      this.lastPlan = plan;
    } else if (isInspection) this.inspectionsSinceMaterialization += 1;
    let reminder: WorkingMemoryReminder | undefined;
    // A compact checkpoint is only useful if the agent has periodically turned
    // reads into facts. Eight inspections is enough to catch a long tracing
    // phase without nagging after every ordinary tool call.
    if (this.inspectionsSinceMaterialization >= 8 && this.inspectionsSinceMaterialization - this.lastReminderAt >= 8) {
      this.lastReminderAt = this.inspectionsSinceMaterialization;
      reminder = { reason: 'inspection_batch', message: 'You have inspected several sources without materializing the result. Update Task Notes with durable confirmed facts, hypotheses that were confirmed or rejected, unresolved questions, and the next concrete Plan step. Do not copy raw code or logs.' };
    } else if (planChanged && this.checkpointMessage) {
      reminder = { reason: 'plan_transition', message: 'The Plan changed. Refresh Task Notes with the durable result of the completed step and the one concrete unknown for the next step before broad exploration.' };
    }
    if (!this.checkpointMessage) return reminder;
    const source: CheckpointSource = { plan: state.plan, taskNotes: state.taskNotes, toolFacts: [], references: [], failed: [], modified: [] };
    this.capture(message, source); this.absorb(source); this.updateCheckpoint(messages, state);
    return reminder;
  }

  /** Generation-local, on-demand access to raw evidence compacted out of the prompt. */
  retrieve(query: string, id?: string): string {
    const needle = query.trim().toLowerCase();
    const entries = id ? [...this.rawHistory].filter(([key]) => key === id) : [...this.rawHistory].filter(([, raw]) => !needle || raw.toLowerCase().includes(needle));
    this.historyRetrievalCount += 1;
    return JSON.stringify({ retrieved: entries.slice(-3).map(([tool_call_id, raw]) => ({ tool_call_id, raw_result: raw.slice(0, 12_000) })), total_matches: entries.length, note: 'Use this exact earlier evidence; do not broadly reread the project unless it is stale or incomplete.' });
  }

  /** A conservative fallback used only by mock backends or an unavailable tokenizer probe. */
  estimate(messages: ToolMessage[], tools: unknown[] | undefined): number {
    return Math.ceil((JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / 2) + messages.length * 20 + 256;
  }

  async prepare(messages: ToolMessage[], tools: unknown[] | undefined, count: () => Promise<number>, state: { plan: AgentPlan | null; taskNotes: string }): Promise<ContextCompactionStats> {
    let current = await count();
    const inputTokensBefore = current;
    if (current < Math.floor(this.contextWindow * agentContextThresholds.checkpoint)) {
      this.lastStats = this.statsFor(inputTokensBefore, current, false, false, 0, 0, 0, false);
      return this.stats();
    }
    const minimumSavings = Math.max(128, Math.floor(this.contextWindow * 0.01));
    // A complete final tool exchange can remain verbatim above the trigger.
    // Retry only after enough fresh prompt growth can produce useful savings.
    if (inputTokensBefore - Math.max(this.lastIneffectiveInputTokens, this.lastCompactedInputTokens) < minimumSavings) {
      this.lastStats = this.statsFor(inputTokensBefore, current, false, false, 0, 0, 0, false);
      return this.stats();
    }
    const originals = messages.map((message) => ({ message, content: message.content }));
    const originalCheckpoint = this.checkpointMessage;
    const level = current >= this.contextWindow * agentContextThresholds.emergency ? 'emergency' : current >= this.contextWindow * agentContextThresholds.strong ? 'strong' : 'normal';
    const target = Math.floor(this.contextWindow * (level === 'emergency' ? agentContextThresholds.emergencyTarget : level === 'strong' ? agentContextThresholds.strongTarget : agentContextThresholds.normalTarget));
    const source: CheckpointSource = { plan: state.plan, taskNotes: state.taskNotes, toolFacts: [], references: [], failed: [], modified: [] };
    const protectedStart = this.recentStart(messages);
    let compactedMessages = 0; let compactedToolResults = 0;

    // Complete tool exchanges must stay structurally valid. We compact their
    // payload text in place and retain the assistant tool_call metadata/IDs.
    for (let index = 1; index < protectedStart && current > target; index += 1) {
      const message = messages[index];
      if (message === this.checkpointMessage || message.content === compactMarker) continue;
      this.capture(message, source);
      if (message.tool_call_id && !this.rawHistory.has(message.tool_call_id)) this.rawHistory.set(message.tool_call_id, message.content);
      if (message.role === 'tool') {
        message.content = this.compactTool(message);
        compactedToolResults += 1;
      } else message.content = compactMarker;
      compactedMessages += 1;
      current = await count();
    }
    // At an emergency threshold, older non-tool conversations can otherwise
    // consume the entire window. Keep the latest exchange verbatim, then trim
    // as little of the recent tail as is necessary to stay safely operable.
    if (current > target && level === 'emergency') {
      for (let index = protectedStart; index < messages.length - 2 && current > target; index += 1) {
        const message = messages[index];
        if (message === this.checkpointMessage || message.content === compactMarker) continue;
        this.capture(message, source);
        if (message.tool_call_id && !this.rawHistory.has(message.tool_call_id)) this.rawHistory.set(message.tool_call_id, message.content);
        if (message.role === 'tool') { message.content = this.compactTool(message); compactedToolResults += 1; }
        else message.content = compactMarker;
        compactedMessages += 1;
        current = await count();
      }
    }
    this.absorb(source);
    let checkpointUpdated = compactedMessages > 0 || !this.checkpointMessage;
    if (checkpointUpdated) this.updateCheckpoint(messages, state);
    let after = await count();
    let savedTokens = Math.max(0, inputTokensBefore - after);
    const meaningfulSavings = compactedMessages > 0 && savedTokens >= minimumSavings;
    if (!meaningfulSavings) {
      for (const original of originals) original.message.content = original.content;
      if (!originalCheckpoint && this.checkpointMessage) {
        const index = messages.indexOf(this.checkpointMessage);
        if (index >= 0) messages.splice(index, 1);
      }
      this.checkpointMessage = originalCheckpoint;
      after = inputTokensBefore;
      savedTokens = 0;
      checkpointUpdated = false;
      compactedMessages = 0;
      compactedToolResults = 0;
      this.ineffectiveCompactionCount += 1;
      this.lastIneffectiveInputTokens = inputTokensBefore;
    } else {
      this.compactionCount += 1;
      this.lastIneffectiveInputTokens = 0;
      this.lastCompactedInputTokens = after;
      this.lastNotes = state.taskNotes;
      this.lastPlan = JSON.stringify(state.plan);
      this.inspectionsSinceMaterialization = 0;
    }
    this.lastStats = { ...this.statsFor(inputTokensBefore, after, meaningfulSavings, checkpointUpdated, compactedMessages, compactedToolResults, savedTokens, true), ...(meaningfulSavings ? { checkpointReason: 'pre_compaction' as const } : {}), level };
    return this.stats();
  }

  private statsFor(inputTokensBefore: number, inputTokensAfter: number, compactionTriggered: boolean, checkpointUpdated: boolean, compactedMessages: number, compactedToolResults: number, savedTokens: number, compactionAttempted: boolean): ContextCompactionStats {
    return { contextWindow: this.contextWindow, inputTokensBefore, inputTokensAfter, compactionTriggered, checkpointUpdated, compactedMessages, compactedToolResults, compactionCount: this.compactionCount, savedTokens, meaningfulSavings: compactionTriggered, compactionAttempted, ineffectiveCompactionCount: this.ineffectiveCompactionCount, workingMemoryTokens: Math.ceil((this.checkpointMessage?.content.length ?? 0) / 4), factsAdded: this.factsAdded, factsUpdated: this.factsUpdated, factsDeduplicated: this.factsDeduplicated, staleFactsRemoved: this.staleFactsRemoved, historyRetrievalCount: this.historyRetrievalCount, postCompactionRereadCount: this.postCompactionRereadCount };
  }

  private recentStart(messages: ToolMessage[]): number {
    const charBudget = Math.max(4_000, Math.floor(this.contextWindow * agentContextThresholds.recentFraction * 2));
    let chars = 0; let index = messages.length;
    // Keep only the most recent complete exchanges verbatim. Older details
    // are represented by Working Memory rather than preventing the next
    // checkpoint from getting below its trigger.
    while (index > 1 && (chars < charBudget || messages.length - index < 2)) { index -= 1; chars += messages[index].content.length + JSON.stringify(messages[index].tool_calls ?? []).length; }
    return index;
  }

  private capture(message: ToolMessage, source: CheckpointSource): void {
    const text = message.content;
    if (text.includes('<project_references>')) source.references.push(short(text, 1_000));
    if (message.role === 'user' && text.trim() && !text.startsWith('<runtime_context')) {
      const constraints = [...text.matchAll(/\b(?:do not modify(?: any)? files?|analysis[- ]only|review[- ]only|research[- ]only|no file modifications?)\b/gi)].map((match) => match[0]);
      const goal = short(text, 48);
      source.references.push(`Goal / constraints: ${short([goal, ...constraints].join('; '), 100)}`);
    }
    const value = parse(text);
    if (!value) { if (message.role === 'assistant' && text.trim()) source.toolFacts.push(short(text)); return; }
    const tool = message.tool_name ?? (typeof value.tool === 'string' ? value.tool : undefined);
    const path = typeof value.path === 'string' ? value.path : undefined;
    const project = typeof value.project_label === 'string' ? value.project_label : typeof value.project_slot === 'number' ? `Project ${value.project_slot}` : undefined;
    const command = typeof value.command === 'string' ? value.command : undefined;
    const exit = typeof value.exit_code === 'number' ? ` exit=${value.exit_code}` : '';
    if (path) source.toolFacts.push(`${tool ?? 'tool'}: ${project ? `${project} / ` : ''}${path}${exit}`);
    else if (command) source.toolFacts.push(`${tool ?? 'terminal'}: ${short(command, 220)}${exit}`);
    else if (tool) source.toolFacts.push(`${tool}: ${short(JSON.stringify(value), 360)}`);
    const error = typeof value.error === 'string' ? value.error : typeof value.reason === 'string' && value.failed ? value.reason : undefined;
    if (error) source.failed.push(`${tool ?? 'tool'}: ${short(error, 500)}`);
    for (const file of stringList(value.files).concat(stringList(value.changed))) source.modified.push(file);
  }

  private compactTool(message: ToolMessage): string {
    const value = parse(message.content);
    const out: Record<string, unknown> = { context_compacted: true, tool: message.tool_name, full_raw_result: 'preserved in Agent run history' };
    if (value) {
      for (const key of ['path', 'command', 'cwd', 'exit_code', 'error', 'status', 'files', 'changed', 'fingerprint', 'matches'] as const) if (value[key] !== undefined) out[key] = value[key];
      const stdout = typeof value.stdout === 'string' ? value.stdout : typeof value.content === 'string' ? value.content : undefined;
      const stderr = typeof value.stderr === 'string' ? value.stderr : undefined;
      if (stdout) out.important_result = short(stdout, 900);
      if (stderr) out.important_errors = short(stderr, 900);
    } else out.important_result = short(message.content, 900);
    return JSON.stringify(out);
  }

  private absorb(source: CheckpointSource): void {
    // Tool/path (including project identity) is a stable fact identity; a
    // later result with a changed exit state replaces the previous snapshot.
    const keyFor = (value: string): string => value.replace(/\s+exit=-?\d+$/, '');
    const add = (target: Set<string>, value: string): void => {
      if (target.has(value)) { this.factsDeduplicated += 1; return; }
      const key = keyFor(value);
      const previous = [...target].find((item) => keyFor(item) === key);
      if (previous) { target.delete(previous); target.add(value); this.factsUpdated += 1; return; }
      target.add(value); this.factsAdded += 1;
    };
    for (const value of source.toolFacts) add(this.facts, value);
    for (const value of source.failed) add(this.failures, value);
    for (const value of source.modified) add(this.modified, value);
    for (const value of source.references) add(this.references, value);
    const budgetChars = Math.max(4_000, Math.min(9_000, Math.floor(this.contextWindow * 0.08 * 4)));
    for (const target of [this.facts, this.failures, this.modified, this.references]) while (target.size > 48) { target.delete(target.values().next().value!); this.staleFactsRemoved += 1; }
    while ([...this.facts, ...this.failures, ...this.modified, ...this.references].join('\n').length > budgetChars && this.facts.size > 12) { this.facts.delete(this.facts.values().next().value!); this.staleFactsRemoved += 1; }
  }

  private updateCheckpoint(messages: ToolMessage[], state: { plan: AgentPlan | null; taskNotes: string }): void {
    const body = [
      'WORKING MEMORY CHECKPOINT (older raw interaction has been compacted; full raw tool results remain in Agent run history).',
      state.plan ? `Current plan: ${JSON.stringify(state.plan)}` : '',
      state.taskNotes ? `Task Notes: ${state.taskNotes}` : '',
      this.references.size ? `Important entities / projects:\n${[...this.references].slice(-8).join('\n')}` : '',
      this.facts.size ? `Confirmed facts / architecture evidence:\n${[...this.facts].slice(-16).map((value) => `- ${value}`).join('\n')}` : '',
      this.modified.size ? `Modified files / current work state:\n${[...this.modified].slice(-16).map((value) => `- ${value}`).join('\n')}` : '',
      this.failures.size ? `Failed approaches / unresolved blockers (do not repeat without new evidence):\n${[...this.failures].slice(-12).map((value) => `- ${value}`).join('\n')}` : '',
      'Treat Working Memory and Task Notes as the authoritative summary of earlier work. Do not re-explore resolved areas unless a specific detail is missing or stale. For exact older evidence, use recall_previous_tool_result instead of a broad project scan. Continue with the next concrete Plan step.',
    ].filter(Boolean).join('\n\n');
    if (!this.checkpointMessage) {
      this.checkpointMessage = { role: 'user', content: `<runtime_context kind="working_memory_checkpoint">${body}</runtime_context>` };
      messages.splice(1, 0, this.checkpointMessage);
    } else this.checkpointMessage.content = `<runtime_context kind="working_memory_checkpoint">${body}</runtime_context>`;
  }
}
