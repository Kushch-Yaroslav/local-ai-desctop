import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentPlan, AgentPlanStepStatus, ChatMessage, ReasoningMode, StreamEvent, TerminalExecution, WebMode } from '../../shared/types';
import { maxOutputTokens } from '../models/model-registry';

/** Project identity is a transport value, not an orchestration subsystem. */
export type AgentProject = { id: string; slot: 1 | 2; root: string; label: string };

type RuntimeEvent = {
  type: string; content?: string; id?: string; name?: string; message?: string; detail?: string; status?: string;
  diff?: string | null; is_error?: boolean; plan?: unknown; used?: number; limit?: number;
  before?: number; after?: number; stream?: string; state?: string; index?: number;
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number; cache_write_tokens?: number;
  prompt_ms?: number; predicted_ms?: number; predicted_per_second?: number; finish_reason?: string;
  phase?: string; max_tokens?: number; context_limit?: number; projected_input_tokens?: number;
  reserved_output_tokens?: number; complete?: boolean; continuation_count?: number; chars?: number;
  continuation?: number; prior_chars?: number; next_max_tokens?: number; arguments?: Record<string, unknown>;
  command?: string; cwd?: string; pid?: number; pgid?: number; session_id?: number; started_at?: number;
};
type RuntimeRequest = {
  type: 'run'; run_id: string; endpoint: string; model: string; system: string; user: string;
  project_root?: string; secondary_project_root?: string; context_limit: number; reasoning_mode: ReasoningMode;
  web_mode: WebMode; policy: 'auto' | 'safe'; history: unknown[]; plan?: AgentPlan; provider_max_output?: number;
};

/** The latest actual user node owns an Agent run. */
export function splitAgentRunHistory(history: ChatMessage[]): { user: string; prior: ChatMessage[] } {
  const currentIndex = history.map((message) => message.role).lastIndexOf('user');
  if (currentIndex < 0 || !history[currentIndex].content.trim()) throw new Error('Agent request has no current user message.');
  return { user: history[currentIndex].content, prior: history.slice(0, currentIndex) };
}

const status = (value: unknown): AgentPlanStepStatus => value === 'completed' || value === 'abandoned' || value === 'in_progress' ? value : 'pending';
const label = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;

/** Converts both pre-migration snapshots and Rust GoalPlan payloads to the UI
 * shape. Old plan data remains readable while new runs always receive stable
 * milestone/task IDs. */
export function taskPlan(value: unknown): AgentPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { milestones: [] };
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.milestones)) {
    return {
      milestones: raw.milestones.map((candidate, milestoneIndex) => {
        const milestone = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
        const rawWork = milestone.work_plan ?? milestone.workPlan;
        const work = rawWork && typeof rawWork === 'object' ? rawWork as Record<string, unknown> : {};
        const tasks = Array.isArray(work.tasks) ? work.tasks.map((candidateTask, taskIndex) => {
          const task = candidateTask && typeof candidateTask === 'object' ? candidateTask as Record<string, unknown> : {};
          return { id: label(task.id, `task-${milestoneIndex + 1}-${taskIndex + 1}`), label: label(task.label ?? task.content, 'Work item'), status: status(task.status), ...(typeof task.revision === 'number' ? { revision: task.revision } : {}) };
        }) : [];
        return {
          id: label(milestone.id, `milestone-${milestoneIndex + 1}`), label: label(milestone.label ?? milestone.name, 'Milestone'),
          status: status(milestone.status), workPlan: { tasks, ...(typeof work.revision === 'number' ? { revision: work.revision } : {}) },
          ...(typeof milestone.revision === 'number' ? { revision: milestone.revision } : {}),
        };
      }),
      ...(typeof raw.active_milestone_id === 'string' ? { activeMilestoneId: raw.active_milestone_id } : typeof raw.activeMilestoneId === 'string' ? { activeMilestoneId: raw.activeMilestoneId } : {}),
      ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
    };
  }
  const steps = Array.isArray(raw.steps) ? raw.steps.map((candidate, index) => {
    const step = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    return { id: label(step.id, `legacy-task-${index + 1}`), label: label(step.label, 'Work item'), status: status(step.status) };
  }) : [];
  if (steps.length) {
    const active = steps.find((step) => step.status === 'in_progress');
    return { milestones: [{ id: 'legacy-milestone-1', label: 'Previous plan', status: active ? 'in_progress' : steps.every((step) => step.status === 'completed' || step.status === 'abandoned') ? 'completed' : 'pending', workPlan: { tasks: steps } }], activeMilestoneId: active ? 'legacy-milestone-1' : undefined };
  }
  return { milestones: [] };
}

function latestPlan(history: ChatMessage[]): AgentPlan | undefined {
  for (const message of [...history].reverse()) {
    if (message.taskPlan) return taskPlan(message.taskPlan);
  }
  return undefined;
}

/** Electron bridge for the Rust runtime. It passes each content delta through
 * immediately; `final` is metadata, not a delayed text transport. */
export class RustAgentRuntime {
  constructor(private readonly endpoint: string, private readonly binary = process.env.LOCAL_AI_AGENT_RUNTIME ?? resolve(process.cwd(), 'rust-agent', 'target', 'debug', 'local-ai-agent-runtime')) {}

  async *stream(model: string, history: ChatMessage[], projects: AgentProject[], signal: AbortSignal, contextLimit: number, reasoningMode: ReasoningMode, webMode: WebMode, runId: string, persistedPlan?: AgentPlan | null): AsyncIterable<StreamEvent> {
    if (!existsSync(this.binary)) throw new Error(`Rust Agent Runtime V2 не собран: ${this.binary}. Выполните cargo build в rust-agent.`);
    const child = spawn(this.binary, [], { stdio: 'pipe' });
    let stopped = false;
    const stop = () => {
      if (stopped || !child.stdin.writable) return;
      stopped = true;
      child.stdin.write(`${JSON.stringify({ type: 'cancel', run_id: runId })}\n`);
      setTimeout(() => { if (!child.killed && child.exitCode === null) child.kill('SIGTERM'); }, 2_000).unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    const current = splitAgentRunHistory(history);
    const request: RuntimeRequest = {
      type: 'run', run_id: runId, endpoint: this.endpoint, model,
      system: 'You are Local AI Desktop Agent. Work autonomously inside the selected project scope. Use tools only with complete valid JSON arguments.',
      user: current.user, project_root: projects[0]?.root, secondary_project_root: projects[1]?.root,
      context_limit: contextLimit, reasoning_mode: reasoningMode, web_mode: webMode, policy: 'auto',
      history: current.prior.filter((message) => !message.agentError && !message.agentCancelled).map((message) => ({ role: message.role, content: message.content })),
      plan: persistedPlan ? taskPlan(persistedPlan) : latestPlan(current.prior),
      provider_max_output: maxOutputTokens,
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    const lines = createInterface({ input: child.stdout });
    let compactions = 0;
    let terminalFinal = false;
    let terminalFailure = false;
    let terminalFinishReason: 'stop' | 'length' = 'stop';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      for await (const line of lines) {
        let event: RuntimeEvent;
        try { event = JSON.parse(line) as RuntimeEvent; } catch { continue; }
        if (event.type === 'thinking_delta') yield { type: 'thinking', content: event.content ?? '' };
        else if (event.type === 'turn_started') yield { type: 'agent-telemetry', telemetry: { turn: event.index ?? 0 } };
        else if (event.type === 'content_delta' || event.type === 'final_delta') yield { type: 'token', content: event.content ?? '' };
        else if (event.type === 'tool_call_started') {
          const command = event.name === 'run_terminal' && typeof event.arguments?.command === 'string' ? event.arguments.command : undefined;
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel(event.name), detail: command ?? event.name, kind: activityKind(event.name), state: 'running', ...(command ? { terminal: { command, status: 'running' } } : {}) } };
        } else if (event.type === 'tool_process_started') {
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel('run_terminal'), detail: event.command ?? 'Terminal', kind: 'terminal', state: 'running', terminal: { command: event.command, cwd: event.cwd, pid: event.pid, pgid: event.pgid, sessionId: event.session_id, startedAt: timestamp(event.started_at), status: 'running' } } };
        } else if (event.type === 'tool_output_delta') {
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel('run_terminal'), kind: 'terminal', state: 'running', terminal: event.stream === 'stderr' ? { stderr: `${event.content ?? ''}\n` } : { stdout: `${event.content ?? ''}\n` } } };
        } else if (event.type === 'tool_result' || event.type === 'tool_error') {
          const terminal = event.name === 'run_terminal' ? terminalResult(event.content ?? event.message) : undefined;
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel(event.name), detail: terminal?.command ?? event.name, kind: activityKind(event.name), state: event.is_error || event.type === 'tool_error' ? 'error' : 'completed', output: event.content ?? event.message, rawOutput: event.content ?? event.message, ...(terminal ? { terminal } : {}), ...(event.diff ? { metadata: { diff: event.diff } } : {}) } };
        } else if (event.type === 'plan_update') {
          yield { type: 'task-plan', plan: taskPlan(event.plan) };
        } else if (event.type === 'context_optimized') {
          compactions += 1;
          yield { type: 'tool', activity: { id: `context-${runId}-${compactions}`, label: 'Context optimized', detail: `${event.before ?? 0} → ${event.after ?? 0} tokens`, kind: 'context', state: 'completed' } };
          yield { type: 'context-usage', used: event.after ?? 0, maximum: contextLimit };
          yield { type: 'agent-telemetry', telemetry: { compactions } };
        } else if (event.type === 'context_stats') {
          yield { type: 'context-usage', used: event.used ?? 0, maximum: event.limit ?? contextLimit };
          yield { type: 'agent-telemetry', telemetry: { contextUsed: event.used, contextLimit: event.limit ?? contextLimit } };
        } else if (event.type === 'turn_usage') {
          yield { type: 'agent-telemetry', telemetry: { inputTokens: event.prompt_tokens, outputTokens: event.completion_tokens, tokensPerSecond: event.predicted_per_second, cachedTokens: event.cached_tokens, cacheWriteTokens: event.cache_write_tokens } };
        } else if (event.type === 'agent_stopped') {
          child.stdin.end();
          yield { type: 'cancelled' };
        } else if (event.type === 'agent_error') {
          terminalFailure = true;
          yield { type: 'error', message: 'Rust Agent Runtime V2 error', details: event.message };
        }
        if (event.type === 'final') {
          // A bounded continuation cap is still a terminal user-visible result:
          // preserve partial text and expose finishReason=length rather than
          // discarding it as an error.
          terminalFinal = true;
          terminalFinishReason = event.finish_reason === 'length' ? 'length' : 'stop';
          if (child.stdin.writable) child.stdin.end();
        }
      }
      if (!signal.aborted && terminalFinal) yield { type: 'done', finishReason: terminalFinishReason };
      else if (!signal.aborted && !terminalFailure) yield { type: 'error', message: 'Rust Agent Runtime V2 ended without a terminal final response', details: 'The runtime closed before emitting a final event.' };
    } finally {
      signal.removeEventListener('abort', stop);
      if (child.stdin.writable) child.stdin.end();
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    }
    if (stderr.trim()) throw new Error(`Rust Agent Runtime V2 stderr: ${stderr.trim()}`);
  }
}

function activityLabel(name?: string): string {
  return ({ list_directory: 'Просмотр структуры проекта', read_file: 'Чтение файла', write_file: 'Изменение файла', create_file: 'Создание файла', apply_patch: 'Изменение проекта', delete_file: 'Удаление файла', run_terminal: 'Запуск terminal', task_plan: 'Планирование' } as Record<string, string>)[name ?? ''] ?? 'Действие агента';
}
function activityKind(name?: string): NonNullable<import('../../shared/types').ToolActivity['kind']> {
  return name === 'run_terminal' ? 'terminal' : name === 'task_plan' ? 'planning' : name === 'read_file' ? 'file_read' : name === 'list_directory' ? 'directory' : 'mutation';
}
function timestamp(value: number | undefined): string | undefined { return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined; }
function terminalResult(raw: string | undefined): TerminalExecution | undefined {
  if (!raw) return undefined;
  try {
    const result = JSON.parse(raw) as Record<string, unknown>;
    return { command: text(result.command), cwd: text(result.cwd), pid: number(result.pid), pgid: number(result.pgid), sessionId: number(result.session_id), startedAt: timestamp(number(result.started_at)), finishedAt: timestamp(number(result.finished_at)), exitCode: number(result.exit_code) ?? null, timedOut: bool(result.timed_out), cancelled: bool(result.cancelled), status: terminalStatus(result.status), stdout: text(result.stdout), stderr: text(result.stderr) };
  } catch { return undefined; }
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const terminalStatus = (value: unknown): TerminalExecution['status'] | undefined => ['running', 'completed', 'error', 'cancelled', 'timed_out'].includes(String(value)) ? String(value) as TerminalExecution['status'] : undefined;
