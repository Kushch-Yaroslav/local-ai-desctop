import { getLanguage } from '../../shared/locale';
import { modelLanguageDirective } from '../../shared/model-language';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { agentRuntimePath, paths } from './paths';
import { agentEvidenceDir } from './agent-evidence';
import type { AgentPlan, AgentPlanStepStatus, ChatMessage, ModelTodo, ReasoningMode, StreamEvent, SteeringIntent, TerminalExecution, ToolActivity, WebMode, WorkBudget } from '../../shared/types';
import { WebBrowserService, webToolDefinitions, activityForWebTool, type WebBrowserSession } from '../web/web-tools';
import { maxOutputTokens } from '../models/model-registry';

/** Project identity is a transport value, not an orchestration subsystem. */
export type AgentProject = { id: string; slot: 1 | 2; root: string; label: string };

type RuntimeEvent = {
  budget?: WorkBudget;
  type: string; content?: string; id?: string; name?: string; message?: string; detail?: string; status?: string;
  diff?: string | null; is_error?: boolean; plan?: unknown; memory?: unknown; used?: number; limit?: number;
  before?: number; after?: number; stream?: string; state?: string; index?: number;
  prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null; cached_tokens?: number | null; cache_write_tokens?: number | null;
  prompt_ms?: number | null; predicted_ms?: number | null; predicted_per_second?: number | null; finish_reason?: string;
  phase?: string; max_tokens?: number; context_limit?: number; projected_input_tokens?: number;
  reserved_output_tokens?: number; complete?: boolean; continuation_count?: number; chars?: number;
  continuation?: number; prior_chars?: number; next_max_tokens?: number; arguments?: Record<string, unknown>;
  command?: string; cwd?: string; pid?: number; pgid?: number; session_id?: number; started_at?: number;
  exists?: boolean; manifest_version?: number; total_files?: number; approximate_bytes?: number;
  knowledge_reads?: number; knowledge_writes?: number; cache_hits?: number; stale_source_entries?: number; bytes_injected?: number;
};
type RuntimeRequest = {
  type: 'run'; run_id: string; endpoint: string; model: string; system: string; ui_language?: 'ru' | 'en'; user: string; user_images?: string[]; user_image_refs?: string[]; web_tools?: unknown[];
  project_root?: string; secondary_project_root?: string; context_limit: number; reasoning_mode: ReasoningMode;
  supports_reasoning: boolean; reasoning_options?: Record<string, Record<string, unknown>>;
  web_mode: WebMode; policy: 'auto' | 'safe'; history: unknown[]; task_memory?: AgentPlan['taskMemory']; provider_max_output?: number;
  evidence_dir?: string; workspace_roots?: string[];
};

export function statusActivity(runId: string, ordinal: number, content: string): ToolActivity {
  return {
    id: `agent-status-${runId}-${ordinal}`,
    label: 'Progress',
    detail: content.trim().split('\n')[0].slice(0, 160),
    kind: 'progress',
    state: 'completed',
    output: content,
  };
}

export function runtimeTextEvent(event: Pick<RuntimeEvent, 'type' | 'content'>, runId: string, statusOrdinal: number): StreamEvent | null {
  if (event.type === 'content_delta' || event.type === 'final_delta') return { type: 'token', content: event.content ?? '' };
  if (event.type === 'agent_status') return { type: 'tool', activity: statusActivity(runId, statusOrdinal, event.content ?? '') };
  return null;
}

/** The latest actual user node owns an Agent run. */
export function splitAgentRunHistory(history: ChatMessage[]): { user: string; images: string[]; imageRefs: string[]; prior: ChatMessage[] } {
  const currentIndex = history.map((message) => message.role).lastIndexOf('user');
  if (currentIndex < 0 || !history[currentIndex].content.trim()) throw new Error('В запросе агента нет текущего сообщения пользователя.');
  return { user: history[currentIndex].content, images: history[currentIndex].images ?? [], imageRefs: imageReferences(history[currentIndex]), prior: history.slice(0, currentIndex) };
}

function imageReferences(message: ChatMessage): string[] {
  return (message.attachments ?? []).filter(attachment => attachment.kind === 'image').map(attachment => attachment.id);
}

const status = (value: unknown): AgentPlanStepStatus => value === 'completed' || value === 'abandoned' || value === 'in_progress' ? value : 'pending';
const label = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;

function modelTodo(value: unknown): ModelTodo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.phases)) return undefined;
  return {
    phases: raw.phases.map((candidate, phaseIndex) => {
      const phase = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
      const items = Array.isArray(phase.items) ? phase.items.map((candidateItem, itemIndex) => {
        const item = candidateItem && typeof candidateItem === 'object' ? candidateItem as Record<string, unknown> : {};
        return { id: label(item.id, `todo-${phaseIndex + 1}-${itemIndex + 1}`), content: label(item.content ?? item.label, 'Todo item'), status: status(item.status), ...(typeof item.memory_id === 'string' ? { memoryId: item.memory_id } : typeof item.memoryId === 'string' ? { memoryId: item.memoryId } : {}) };
      }) : [];
      return { name: typeof phase.name === 'string' ? phase.name : 'Work', items };
    }).filter((phase) => phase.items.length > 0),
    ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
  };
}

/** Converts both pre-migration snapshots and Rust GoalPlan payloads to the UI
 * shape. Old plan data remains readable while new runs always receive stable
 * milestone/task IDs. */
export function taskPlan(value: unknown): AgentPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { milestones: [] };
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.milestones)) {
    const todo = modelTodo(raw.model_todo ?? raw.modelTodo);
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
      ...(todo ? { modelTodo: todo } : {}),
      ...(raw.workBudget ? { workBudget: raw.workBudget as WorkBudget } : {}),
      ...(raw.task_memory && typeof raw.task_memory === 'object' ? { taskMemory: raw.task_memory as AgentPlan['taskMemory'] } : raw.taskMemory && typeof raw.taskMemory === 'object' ? { taskMemory: raw.taskMemory as AgentPlan['taskMemory'] } : {}),
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
  const todo = modelTodo(raw.model_todo ?? raw.modelTodo);
  return { milestones: [], ...(todo ? { modelTodo: todo } : {}), ...(raw.task_memory && typeof raw.task_memory === 'object' ? { taskMemory: raw.task_memory as AgentPlan['taskMemory'] } : {}) };
}

/** Electron bridge for the Rust runtime. It passes each content delta through
 * immediately; `final` is metadata, not a delayed text transport. */
export class RustAgentRuntime {
  private readonly steering = new Map<string, (content: string, intent?: SteeringIntent) => Promise<void>>();
  constructor(private readonly endpoint: string, private readonly binary = agentRuntimePath(), private readonly web = new WebBrowserService()) {}

  steer(runId: string, content: string, intent?: SteeringIntent): Promise<void> {
    const send = this.steering.get(runId);
    if (!send) return Promise.reject(new Error('Agent ещё не готов к уточнению или уже завершён.'));
    return send(content, intent);
  }

  async *stream(model: string, history: ChatMessage[], projects: AgentProject[], signal: AbortSignal, contextLimit: number, reasoningMode: ReasoningMode, webMode: WebMode, runId: string, persistedTaskMemory?: AgentPlan['taskMemory'], conversationId?: string, supportsReasoning = true, reasoningOptions?: Record<string, Record<string, unknown>>, workspaceRoots: readonly string[] = []): AsyncIterable<StreamEvent> {
    if (signal.aborted) { yield { type: 'cancelled' }; return; }
    if (!existsSync(this.binary)) throw new Error(`Rust Agent Runtime V2 не собран: ${this.binary}. Выполните cargo build в rust-agent.`);
    const child = spawn(this.binary, [], { stdio: 'pipe' });
    const lines = createInterface({ input: child.stdout });
    let processError: Error | null = null;
    const failedProcess = (error: Error) => { processError = error; lines.close(); };
    child.once('error', failedProcess);
    child.stdin.on('error', failedProcess);
    const pending: Array<{ content: string; resolve: () => void; reject: (error: Error) => void }> = [];
    this.steering.set(runId, (content, intent) => {
      if (!child.stdin.writable || signal.aborted) return Promise.reject(new Error('Agent уже завершён.'));
      if (pending.length >= 4) return Promise.reject(new Error('Слишком много ожидающих уточнений.'));
      return new Promise<void>((resolve, reject) => {
        pending.push({ content, resolve, reject });
        child.stdin.write(`${JSON.stringify({ type: 'steer', run_id: runId, content, ...(intent ? { intent } : {}) })}\n`);
      });
    });
    let session: Promise<WebBrowserSession> | undefined;
    const closeWeb = () => { void session?.then((browser) => browser.close(), () => undefined); };
    signal.addEventListener('abort', closeWeb, { once: true });
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
      ui_language: getLanguage(),
      system: `${modelLanguageDirective()}\nYou are Local AI Desktop Agent. Work autonomously inside the scope described below. Use tools only with complete valid JSON arguments.\n${projects.map((project) => `Project ${project.slot}: ${project.label}; identity=${project.id}; root=${project.root}`).join('\n')}`,
      user: current.user, user_images: current.images, user_image_refs: current.imageRefs, web_tools: webMode === 'auto' ? webToolDefinitions : [], project_root: projects[0]?.root, secondary_project_root: projects[1]?.root, ...(workspaceRoots.length ? { workspace_roots: [...workspaceRoots] } : {}),
      context_limit: contextLimit, reasoning_mode: reasoningMode, supports_reasoning: supportsReasoning, reasoning_options: reasoningOptions, web_mode: webMode, policy: 'auto',
      history: current.prior.filter((message) => !message.agentError && !message.agentCancelled).map((message) => ({ role: message.role, content: message.content, ...(imageReferences(message).length ? { image_refs: imageReferences(message) } : {}), ...(message.images?.length ? { images: message.images } : {}) })),
      ...(conversationId ? { evidence_dir: agentEvidenceDir(paths.userData, conversationId) } : {}),
      ...(persistedTaskMemory ? { task_memory: persistedTaskMemory } : {}),
      provider_max_output: maxOutputTokens,
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    let compactions = 0;
    let statusCount = 0;
    let terminalFinal = false;
    let terminalFailure = false;
    let terminalStopped = false;
    let terminalFinishReason: 'stop' | 'length' = 'stop';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      for await (const line of lines) {
        let event: RuntimeEvent;
        try { event = JSON.parse(line) as RuntimeEvent; } catch { continue; }
        if (event.type === 'host_tool_call') {
          let result: unknown;
          try {
            if (signal.aborted) throw new Error('Web request cancelled');
            if (webMode !== 'auto' || !webToolDefinitions.some((tool) => tool.function.name === event.name)) throw new Error('Web tool is unavailable');
            session ??= this.web.openSession();
            const browser = await session;
            if (signal.aborted) { await browser.close(); throw new Error('Web request cancelled'); }
            result = JSON.parse(await browser.execute({ name: event.name!, arguments: event.arguments ?? {} }));
          } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
          if (!signal.aborted && child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'host_tool_result', run_id: runId, id: event.id, result })}\n`);
          continue;
        }
        if (event.type === 'steering_accepted' || event.type === 'steering_rejected') {
          const next = pending.shift();
          if (event.type === 'steering_accepted') next?.resolve();
          else next?.reject(new Error(event.message ?? 'Agent уже завершён.'));
        }
        else if (event.type === 'steering_applied') {
          yield { type: 'steering', userMessage: { id: '', conversationId: conversationId ?? '', role: 'user', content: event.content ?? '', createdAt: new Date().toISOString() }, status: 'applied' };
        }
        else if (event.type === 'run_paused') yield { type: 'paused' };
        else if (event.type === 'thinking_delta') yield { type: 'thinking', content: event.content ?? '' };
        else if (event.type === 'turn_started') yield { type: 'agent-telemetry', telemetry: { turn: event.index ?? 0 } };
        else if (event.type === 'work_budget' && event.budget) yield { type: 'work-budget', budget: event.budget };
        else if (event.type === 'content_delta' || event.type === 'final_delta' || event.type === 'agent_status') {
          if (event.type === 'agent_status') statusCount += 1;
          yield runtimeTextEvent(event, runId, statusCount)!;
        }
        else if (event.type === 'tool_call_started') {
          const command = event.name === 'run_terminal' && typeof event.arguments?.command === 'string' ? event.arguments.command : undefined;
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel(event.name), detail: command ?? event.name, kind: activityKind(event.name), state: 'running', ...(command ? { terminal: { command, status: 'running' } } : {}) } };
        } else if (event.type === 'tool_process_started') {
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel('run_terminal'), detail: event.command ?? 'Terminal', kind: 'terminal', state: 'running', terminal: { command: event.command, cwd: event.cwd, pid: event.pid, pgid: event.pgid, sessionId: event.session_id, startedAt: timestamp(event.started_at), status: 'running' } } };
        } else if (event.type === 'tool_output_delta') {
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel('run_terminal'), kind: 'terminal', state: 'running', terminal: event.stream === 'stderr' ? { stderr: `${event.content ?? ''}\n` } : { stdout: `${event.content ?? ''}\n` } } };
        } else if (event.type === 'tool_result' || event.type === 'tool_error') {
          const failed = event.is_error || event.type === 'tool_error';
          // A result carries its call ID, so it finalizes the card the call
          // opened. Fields it does not know must stay absent rather than
          // undefined, or the merge would erase the started command.
          const parsed = event.name === 'run_terminal' ? terminalResult(event.content ?? event.message) ?? (failed ? { exitCode: null } : undefined) : undefined;
          const terminal = parsed && { ...parsed, status: parsed.status ?? (failed ? 'error' as const : 'completed' as const), finishedAt: parsed.finishedAt ?? new Date().toISOString() };
          const detail = terminal?.command ?? (event.name === 'run_terminal' ? undefined : event.name);
          yield { type: 'tool', activity: { id: event.id ?? crypto.randomUUID(), label: activityLabel(event.name), ...(detail ? { detail } : {}), kind: activityKind(event.name), state: failed ? 'error' : 'completed', output: event.content ?? event.message, rawOutput: event.content ?? event.message, ...(terminal ? { terminal } : {}), ...(event.diff ? { metadata: { diff: event.diff } } : {}) } };
        } else if (event.type === 'task_memory_update' && event.memory && typeof event.memory === 'object') {
          yield { type: 'task-memory', memory: event.memory as NonNullable<AgentPlan['taskMemory']> };
        } else if (event.type === 'context_optimized') {
          compactions += 1;
          yield { type: 'tool', activity: { id: `context-${runId}-${compactions}`, label: 'Context optimized', detail: `${event.before ?? 0} → ${event.after ?? 0} tokens`, kind: 'context', state: 'completed' } };
          yield { type: 'context-usage', used: event.after ?? 0, maximum: contextLimit };
          yield { type: 'agent-telemetry', telemetry: { compactions } };
        } else if (event.type === 'knowledge_cache') {
          yield { type: 'agent-telemetry', telemetry: { knowledgeCacheFiles: event.total_files, knowledgeCacheBytes: event.approximate_bytes, knowledgeCacheHits: event.cache_hits, knowledgeCacheStale: event.stale_source_entries, knowledgeCacheInjectedBytes: event.bytes_injected } };
        } else if (event.type === 'context_stats') {
          yield { type: 'context-usage', used: event.used ?? 0, maximum: event.limit ?? contextLimit };
          yield { type: 'agent-telemetry', telemetry: { contextUsed: event.used, contextLimit: event.limit ?? contextLimit } };
        } else if (event.type === 'turn_usage') {
          const tokensPerSecond = finiteMetric(event.predicted_per_second);
          const cachedTokens = finiteMetric(event.cached_tokens);
          const cacheWriteTokens = finiteMetric(event.cache_write_tokens);
          yield { type: 'agent-telemetry', telemetry: {
            inputTokens: finiteMetric(event.prompt_tokens) ?? 0,
            outputTokens: finiteMetric(event.completion_tokens) ?? 0,
            ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
            ...(cachedTokens === undefined ? {} : { cachedTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
          } };
        } else if (event.type === 'agent_stopped') {
          terminalStopped = true;
          if (child.stdin.writable) child.stdin.end();
          yield { type: 'cancelled' };
          break;
        } else if (event.type === 'agent_error') {
          terminalFailure = true;
          // The worker has ended; its protocol supervisor still awaits stdin.
          // End this run's stream now so IPC can release inference ownership.
          if (child.stdin.writable) child.stdin.end();
          yield { type: 'error', message: 'Rust Agent Runtime V2 error', details: event.message };
          break;
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
      else if (!signal.aborted && !terminalFailure && !terminalStopped) yield { type: 'error', message: 'Rust Agent Runtime V2 ended without a terminal final response', details: processError ? String(processError) : stderr.trim() || 'The runtime closed before emitting a final event.' };
    } finally {
      signal.removeEventListener('abort', closeWeb);
      closeWeb();
      this.steering.delete(runId);
      for (const next of pending) next.reject(new Error('Agent завершён до принятия уточнения.'));
      signal.removeEventListener('abort', stop);
      if (child.stdin.writable) child.stdin.end();
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    }
  }
}

function activityLabel(name?: string): string {
  if (name?.startsWith('web_')) return activityForWebTool({ name, arguments: {} }).label;
  return ({ list_directory: 'Просмотр структуры проекта', read_file: 'Чтение файла', write_file: 'Изменение файла', replace_text: 'Изменение файла', create_file: 'Создание файла', apply_patch: 'Изменение проекта', delete_file: 'Удаление файла', run_terminal: 'Запуск terminal', task_memory: 'Task Memory', deliverables: 'Требуемый результат', plan: 'План выполнения', project_knowledge_index: 'Индекс знаний проекта', project_knowledge_read: 'Чтение знаний проекта', project_knowledge_update: 'Обновление знаний проекта' } as Record<string, string>)[name ?? ''] ?? 'Действие агента';
}
function activityKind(name?: string): NonNullable<import('../../shared/types').ToolActivity['kind']> {
  return name?.startsWith('web_') ? 'web' : name === 'run_terminal' ? 'terminal' : name === 'deliverables' || name === 'plan' ? 'planning' : name === 'task_memory' || name === 'project_knowledge_read' || name === 'project_knowledge_index' ? 'file_read' : name === 'read_file' ? 'file_read' : name === 'list_directory' ? 'directory' : 'mutation';
}
function timestamp(value: number | undefined): string | undefined { return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined; }
function terminalResult(raw: string | undefined): TerminalExecution | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = parsed.execution && typeof parsed.execution === 'object' ? parsed.execution as Record<string, unknown> : parsed;
    if (!('command' in result) && !('exit_code' in result) && !('status' in result)) return { status: 'error', exitCode: null };
    const terminal: TerminalExecution = { command: text(result.command), cwd: text(result.cwd), pid: number(result.pid), pgid: number(result.pgid), sessionId: number(result.session_id), startedAt: timestamp(number(result.started_at)), finishedAt: timestamp(number(result.finished_at)), exitCode: number(result.exit_code) ?? null, timedOut: bool(result.timed_out), cancelled: bool(result.cancelled), status: terminalStatus(result.status), stdout: text(result.stdout), stderr: text(result.stderr) };
    return Object.fromEntries(Object.entries(terminal).filter(([, value]) => value !== undefined)) as TerminalExecution;
  } catch { return undefined; }
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const terminalStatus = (value: unknown): TerminalExecution['status'] | undefined => ['running', 'completed', 'partial_success', 'error', 'cancelled', 'timed_out'].includes(String(value)) ? String(value) as TerminalExecution['status'] : undefined;
const finiteMetric = (value: number | null | undefined): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
