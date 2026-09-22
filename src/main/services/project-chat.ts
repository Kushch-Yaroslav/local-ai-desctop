import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { AgentPlan, ChatMessage, FinishReason, ReasoningMode, StreamEvent, ToolActivity, WebMode } from '../../shared/types';
import type { InferenceDiagnostics, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { validateLlamaMessageSequence } from '../backends/llama-cpp-backend';
import { AgentActionBudget, AnalysisEngine } from './analysis-engine';
import { log } from './logger';
import { ReadonlyProjectTools, TerminalTools, activityForTool, projectToolDefinitions, reportProgressToolDefinition, terminalToolDefinition, type ConfirmAction, type ProjectToolCall, type ProjectToolDefinition } from '../tools/project-tools';
import { capabilitySystemContext } from './capabilities';
import { WebBrowserService, type WebBrowserSession, activityForWebTool, webToolDefinitions } from '../web/web-tools';
import { AgentToolContext, type ReadDiagnostic, type ToolContextStats } from './agent-tool-context';
import { AgentContextManager, type ContextCompactionStats } from './agent-context-manager';
import { OllamaRequestError, classifyOllamaError, ollamaErrorDiagnostics } from '../backends/ollama-errors';
import { isTaskNotesCall, TaskNotes, taskNotesToolDefinition } from './task-notes';
import { agentPlanToolDefinition, AgentPlanState, isAgentPlanCall } from './agent-plan';
import { projectDirectoryName } from '../../shared/project-references';

const finalizationThreshold = 5;
// A near-full 32K prompt can spend more than two minutes on prompt evaluation
// alone. This is a bounded final-answer reserve, independent of tool turns.
const finalSynthesisTimeoutMs = 240_000;
const initialInferenceRetryDelayMs = 150;
const maxMalformedToolArgumentRecoveries = 2;
const maxToolFailureRecoveries = 3;
type AgentRuntimeContext = { generationId: string; conversationId: string };
export type AgentProject = { id: string; slot: 1 | 2; root: string; label: string };

const agentActionExecutionPolicy = `
AGENT ACTION EXECUTION POLICY:
In Agent mode, when the user asks you to make, configure, install, modify, inspect, fix, create, delete, run, or otherwise perform an action on their local computer, prefer using available tools to perform the task.
Do not replace an executable action with a tutorial or a list of commands when the required tools are available. First inspect the current environment when necessary, then execute the task.
For system configuration, begin with safe diagnostics of the current environment before choosing an implementation. If elevated privileges are needed, complete every safe non-privileged step first, then request confirmation only for the specific privileged command.
If a task can be completed or materially progressed with a tool, do not finish the Agent turn with zero tool calls unless there is a concrete reason.
This rule applies to action-oriented requests, not ordinary informational questions. It is correct to answer without tools when the user asks only for an explanation or explicitly says not to perform anything.
Only fall back to instructions when the required capability is unavailable, a required permission or confirmation cannot be obtained automatically, the action is blocked by policy, or the user explicitly asks only for instructions.`;
const recallPreviousToolResultDefinition: ProjectToolDefinition = { type: 'function', function: { name: 'recall_previous_tool_result', description: 'Точечно возвращает raw evidence из более раннего tool result текущего Agent run после context compaction. Используй, когда Working Memory указывает на нужную точную старую деталь; не заменяй этим широкое повторное исследование.', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 240 }, tool_call_id: { type: 'string', maxLength: 100 } }, required: ['query'] } } };
const isHistoryRecallCall = (call: ProjectToolCall): boolean => call.name === 'recall_previous_tool_result';

function parseCall(call: ToolCall): ProjectToolCall {
  const raw = call.function.arguments; let argumentsObject: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { argumentsObject = JSON.parse(raw) as Record<string, unknown>; } catch { argumentsObject = {}; } } else if (raw && typeof raw === 'object') argumentsObject = raw;
  return { name: call.function.name, arguments: argumentsObject, ...(call.id ? { toolCallId: call.id } : {}) };
}
type TextualToolCallParse = { calls: ProjectToolCall[]; malformed: boolean; reason?: string };
function safeTextShape(value: string): Record<string, unknown> {
  return {
    length: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
    hasToolCallTag: /<tool_call>/i.test(value),
    hasCreateFileFunctionTag: /<function=create_file>/i.test(value),
    hasPathParameterTag: /<parameter=path>/i.test(value),
    leadingWhitespaceLength: value.length - value.trimStart().length,
    trailingWhitespaceLength: value.length - value.trimEnd().length,
  };
}
function safeArgumentsShape(argumentsObject: Record<string, unknown>): Record<string, unknown> {
  return {
    keys: Object.keys(argumentsObject).sort(),
    content: typeof argumentsObject.content === 'string' ? { length: argumentsObject.content.length, sha256: createHash('sha256').update(argumentsObject.content).digest('hex') } : undefined,
  };
}

/**
 * Qwen chat templates can emit this exact protocol through llama.cpp instead of
 * OpenAI's `tool_calls`. Accept only complete wrappers and complete parameter
 * pairs so ordinary prose cannot become a project operation.
 */
function parseTextualToolCalls(content: string): TextualToolCallParse {
  const calls: ProjectToolCall[] = [];
  const callPattern = /<tool_call>\s*<function=([a-z_]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  for (const call of content.matchAll(callPattern)) {
    const argumentsObject: Record<string, unknown> = {};
    const parameterPattern = /<parameter=([a-z_]+)>([\s\S]*?)<\/parameter>/g;
    let parameterCursor = 0;
    for (const parameter of call[2].matchAll(parameterPattern)) {
      if (call[2].slice(parameterCursor, parameter.index).trim()) return { calls: [], malformed: true, reason: 'unexpected_function_content' };
      const name = parameter[1];
      // File content is opaque: do not trim or otherwise modify multiline HTML,
      // scripts, styles, or template literals. Scalar parameters are normalized.
      const raw = parameter[2]; const normalized = name === 'content' ? raw : raw.trim();
      argumentsObject[name] = /^\d+$/.test(normalized) ? Number(normalized) : normalized;
      parameterCursor = (parameter.index ?? 0) + parameter[0].length;
    }
    if (!Object.keys(argumentsObject).length || call[2].slice(parameterCursor).trim()) return { calls: [], malformed: true, reason: 'missing_or_invalid_parameters' };
    // Qwen's textual template uses file_path, while the registered project tools
    // use path. Keep this narrowly scoped to the two file-content tools.
    if ((call[1] === 'create_file' || call[1] === 'write_file') && argumentsObject.path === undefined && argumentsObject.file_path !== undefined) {
      argumentsObject.path = argumentsObject.file_path;
      delete argumentsObject.file_path;
    }
    calls.push({ name: call[1], arguments: argumentsObject });
  }
  const resemblesProtocol = /<tool_call>\s*<function=[a-z_]+>/s.test(content);
  return calls.length ? { calls, malformed: false } : resemblesProtocol ? { calls: [], malformed: true, reason: 'incomplete_wrapper' } : { calls: [], malformed: false };
}

/** Removes only complete internal protocol wrappers, never ordinary prose. */
function stripTextualToolCalls(content: string): string {
  return content
    .replace(/<tool_call>\s*<function=[a-z_]+>[\s\S]*?<\/function>\s*<\/tool_call>/g, '')
    // A native structured call still wins, but a malformed duplicate protocol
    // fragment must not become visible assistant prose.
    .replace(/<tool_call>\s*<function=[a-z_]+>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * Keep the Agent's replayable history as structured arguments. Ollama feeds
 * historical assistant calls back through its Qwen tool parser and rejects a
 * JSON string there, while llama.cpp's OpenAI wire adapter serializes this
 * canonical object at its own boundary.
 */
function normalizedToolCalls(calls: ProjectToolCall[]): ToolCall[] {
  return calls.map((call) => ({ id: call.toolCallId ?? randomUUID(), type: 'function', function: { name: call.name, arguments: call.arguments } }));
}
function toolResult(call: ProjectToolCall, content: string): ToolMessage {
  return { role: 'tool', tool_name: call.name, ...(call.toolCallId ? { tool_call_id: call.toolCallId } : {}), content };
}
function skippedToolResult(call: ProjectToolCall, failedCall: ProjectToolCall): ToolMessage {
  return toolResult(call, JSON.stringify({ error: `Вызов пропущен после ошибки ${failedCall.name}; исправь предыдущий вызов и затем повтори нужные действия.`, code: 'tool_call_skipped', tool: call.name }));
}
const chunkText = (content: string): string[] => content.match(/[\s\S]{1,96}/g) ?? [];
const signature = (call: ProjectToolCall): string => `${call.name}:${JSON.stringify(Object.entries(call.arguments).sort(([a], [b]) => a.localeCompare(b)))}`;
function lowInformation(raw: string): boolean { try { const value = JSON.parse(raw) as Record<string, unknown>; return typeof value.error === 'string' || (Array.isArray(value.entries) && value.entries.length === 0) || (Array.isArray(value.matches) && value.matches.length === 0); } catch { return false; } }
function resultObject(raw: string): Record<string, unknown> { try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
function compactFailureReason(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : 'Инструмент не смог выполнить запрос.';
}
function compactToolFailure(call: ProjectToolCall, raw: string): string {
  const result = resultObject(raw);
  return JSON.stringify({
    error: compactFailureReason(result.error),
    code: 'tool_call_failed',
    tool: call.name,
    instruction: 'Исправь аргументы или выбери другой допустимый инструмент. Не повторяй действие, отклонённое пользователем.',
  });
}
function toolRecoveryNotice(call: ProjectToolCall, attempt: number, reason: string): ToolMessage {
  return runtimeNotice('tool_call_failed', `Вызов инструмента не выполнен. tool=${call.name}; reason=${reason}; recovery_attempt=${attempt}. Исправь аргументы или выбери другой допустимый инструмент и продолжи. Не повторяй действие, отклонённое пользователем.`);
}
function malformedToolArgumentsNotice(attempt: number): ToolMessage {
  return runtimeNotice('malformed_tool_arguments', `Локальный inference runtime отклонил сгенерированные JSON-аргументы вызова инструмента до выполнения. recovery_attempt=${attempt}. Повтори решение с одним корректным вызовом инструмента и валидным JSON. Для большого содержимого сначала создай короткий каркас, затем вноси небольшие patch; не отправляй длинный документ одним аргументом.`);
}
function recoveryActivity(label: string, attempt: number, failure: string): ToolActivity {
  return { id: randomUUID(), label, kind: 'other', state: 'error', metadata: { recovery_attempt: attempt, failure } };
}
function scopedProjectResult(raw: string, project: AgentProject | undefined): string {
  if (!project) return raw;
  const value = resultObject(raw);
  return Object.keys(value).length ? JSON.stringify({ ...value, project_id: project.id, project_slot: project.slot, project_label: project.label }) : raw;
}
function planSnapshot(value: Record<string, unknown>): AgentPlan | undefined {
  const plan = value.plan;
  return plan && typeof plan === 'object' && !Array.isArray(plan) && Array.isArray((plan as { steps?: unknown }).steps) ? plan as AgentPlan : undefined;
}
function lineRange(value: Record<string, unknown>): string | undefined {
  if (typeof value.start_line === 'number') return typeof value.end_line === 'number' && value.end_line !== value.start_line ? `строки ${value.start_line}–${value.end_line}` : `строка ${value.start_line}`;
  if (typeof value.byte_start === 'number') return typeof value.byte_end === 'number' ? `байты ${value.byte_start}–${value.byte_end}` : `с байта ${value.byte_start}`;
  return undefined;
}
type StagnationStats = {
  explorationActions: number; broadExplorationActions: number; targetedExplorationActions: number; repeatedExplorationActions: number; mutationActions: number; verificationActions: number;
  exactDuplicateReads: number; coveredReads: number; overlappingReads: number; newInformationReads: number; meaningfulSourceDiscoveries: number; stepsSinceLastNewInformation: number; stepsSinceLastMeaningfulSourceInformation: number; stepsSinceLastMutation: number;
  codingChangeTask: boolean; analysisTask: boolean; progressEvents: number; planProgressEvents: number; taskNoteUpdates: number; stepsSinceLastProgress: number; inspectionActionsSinceCheckpoint: number; overlappingInspections: number; repeatedSearches: number; interventionLevel: number; stagnationSuspected: boolean;
};
type StagnationIntervention = 'first' | 'second' | 'stalled';
type StagnationUpdate = { stats: StagnationStats; intervention?: StagnationIntervention };

const mutationTools = new Set(['apply_patch', 'write_file', 'create_file', 'delete_file']);
const verificationTools = new Set(['git_status', 'git_diff', 'run_terminal']);
const explorationTools = new Set(['read_file', 'inspect_package_json', 'search_text', 'find_files', 'search_files', 'list_directory', 'web_search', 'web_open']);
const codingChangeLanguage = /(?:\b(?:add|change|create|edit|feature|fix|implement|improve|refactor|remove|update|bug)\b|исправ|реализ|добав|измен|редакт|созда|удал|улучш|рефактор|фич)/i;
const analysisOnlyLanguage = /(?:\b(?:analysis(?:[ -]only)?|research(?:[ -]only)?|review(?:[ -]only)?|read[ -]only|do not modify(?: any)? files?|without (?:making )?changes?|no file changes?)\b|только анализ|без изменений|не изменяй(?:те)? файлы|не менять файлы|исследовательск(?:ая|ий)|ревью)/i;
const sourcePath = (call: ProjectToolCall, read?: ReadDiagnostic): string => read?.path ?? (typeof call.arguments.path === 'string' ? call.arguments.path.replace(/\\/g, '/').replace(/^\.\//, '') : '');
const lowValuePathSegment = new Set(['.git', '.next', '.cache', '.venv', '__pycache__', 'build', 'coverage', 'dist', 'generated', 'node_modules', 'out', 'target', 'vendor', 'venv']);
const meaningfulExtension = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|swift|rb|php|cs|c(?:pp|xx)?|h(?:pp)?|css|s[ac]ss|less|html?|vue|svelte|json|ya?ml|toml|ini|cfg)$/i;
const meaningfulBasename = /^(?:dockerfile|makefile|cmakelists\.txt|cargo\.toml|go\.mod|go\.sum|package\.json|pnpm-lock\.yaml|yarn\.lock|composer\.json|pyproject\.toml|requirements(?:-[\w.-]+)?\.txt|setup\.cfg)$/i;
const meaningfulSource = (path: string): boolean => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.split('/').some((segment) => lowValuePathSegment.has(segment.toLowerCase()))) return false;
  const basename = normalized.split('/').at(-1) ?? '';
  return meaningfulExtension.test(basename) || meaningfulBasename.test(basename) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(basename);
};
const resultPaths = (raw: string): string[] => {
  const value = resultObject(raw); if (!Array.isArray(value.matches)) return [];
  return value.matches.flatMap((match) => typeof match === 'string' ? [match] : match && typeof match === 'object' && typeof (match as { path?: unknown }).path === 'string' ? [(match as { path: string }).path] : []);
};
const firstStagnationGuidance = 'Релевантные области проекта уже изучены, а последние действия повторяют известный контекст. Перед новым исследованием назови один конкретный неразрешённый вопрос и используй только узкий поиск или диапазон чтения для него. Если такого вопроса нет, перейди к запрошенному изменению, затем выполни сфокусированную проверку. Не перечитывай неизменённые доступные диапазоны только ради уверенности.';
const secondStagnationGuidance = 'Исследование всё ещё не продвигается после предыдущей подсказки, а реализации нет. Не выполняй широкий обзор проекта и не перечитывай целиком неизменённые файлы. Изучай только узкую конкретную зависимость; иначе внеси запрошенное изменение, проверь его и заверши работу.';
const plannedStagnationGuidance = 'У тебя уже есть Plan. Сначала сверяйся с task_plan и Task Notes: отметь завершённое исследование, зафиксируй существенные факты в notes и определи один минимально необходимый следующий шаг. Если исследование закрыто, переведи следующий шаг плана в in_progress и переходи к реализации или проверке, а не продолжай широкий поиск.';
const analysisStagnationGuidance = 'Ты долго исследуешь проект. Зафиксируй новые выводы в Task Notes. Закрой текущий Plan step или объясни, какой конкретный неизвестный факт ещё нужен. Если данных уже достаточно — переходи к следующим пунктам Plan или final synthesis. Не перечитывай уже изученные области без конкретной причины.';
const analysisStagnationGuard = 'Исследование всё ещё не даёт новых подтверждённых фактов. Не повторяй уже изученные файлы или одинаковые поиски. Зафиксируй оставшиеся evidence в Task Notes и Plan; если этого достаточно для исходного вопроса, подготовь итоговый synthesis.';
const analysisCheckpointActions = 10;
type Inspection = { path: string; start?: number; end?: number };
const terminalInspection = (call: ProjectToolCall): Inspection | undefined => {
  if (call.name !== 'run_terminal' || typeof call.arguments.command !== 'string') return undefined;
  const command = call.arguments.command;
  if (!/\b(?:sed|awk|grep|rg|cat|head|tail)\b/.test(command)) return undefined;
  // Keep the path itself in capture group 1. The previous non-capturing
  // expression always produced undefined here, so sed/awk/grep inspections
  // escaped the overlap detector merely by using a different tool.
  const path = command.match(/([\w./-]+\.(?:py|[cm]?[jt]sx?|go|rs|java|kt|json|ya?ml))(?:\s|$)/)?.[1];
  if (!path) return undefined;
  const range = command.match(/(\d+)\s*[,\-:]\s*(\d+)/);
  return { path: path.replace(/^\.\//, ''), ...(range ? { start: Number(range[1]), end: Number(range[2]) } : {}) };
};
const overlappingInspection = (one: Inspection, two: Inspection): boolean => one.path === two.path && (one.start === undefined || two.start === undefined || (one.start <= (two.end ?? two.start) && two.start <= (one.end ?? one.start)));
const searchKey = (call: ProjectToolCall): string | undefined => (call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') && typeof call.arguments.query === 'string' ? `${call.name}:${String(call.arguments.path ?? '')}:${call.arguments.query.trim().toLowerCase()}` : undefined;

class AgentStagnation {
  private readonly codingChangeTask: boolean;
  private readonly analysisTask: boolean;
  private readonly stats: StagnationStats;
  private interventionLevel = 0;
  private interventionStep = 0;
  private interventionRepeatedReads = 0;
  private interventionMeaningfulDiscoveries = 0;
  private readonly meaningfulResources = new Set<string>();
  private lastNotes = '';
  private lastPlan = '';
  private readonly inspections: Inspection[] = [];
  private readonly searches = new Set<string>();

  constructor(history: ChatMessage[]) {
    const userText = history.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    this.analysisTask = analysisOnlyLanguage.test(userText);
    this.codingChangeTask = !this.analysisTask && codingChangeLanguage.test(userText);
    this.stats = { explorationActions: 0, broadExplorationActions: 0, targetedExplorationActions: 0, repeatedExplorationActions: 0, mutationActions: 0, verificationActions: 0, exactDuplicateReads: 0, coveredReads: 0, overlappingReads: 0, newInformationReads: 0, meaningfulSourceDiscoveries: 0, stepsSinceLastNewInformation: 0, stepsSinceLastMeaningfulSourceInformation: 0, stepsSinceLastMutation: 0, codingChangeTask: this.codingChangeTask, analysisTask: this.analysisTask, progressEvents: 0, planProgressEvents: 0, taskNoteUpdates: 0, stepsSinceLastProgress: 0, inspectionActionsSinceCheckpoint: 0, overlappingInspections: 0, repeatedSearches: 0, interventionLevel: 0, stagnationSuspected: false };
  }

  isAnalysisTask(): boolean { return this.analysisTask; }
  hasSufficientAnalysisEvidence(): boolean {
    // Evidence has to be materialized, but a good long analysis should not
    // lose its final answer merely because reads themselves are no longer
    // treated as progress. Two Notes/Plan checkpoints plus several distinct
    // sources are enough for a bounded best-effort synthesis.
    return this.analysisTask
      && this.stats.meaningfulSourceDiscoveries >= 5
      && this.stats.taskNoteUpdates >= 2
      && this.stats.planProgressEvents >= 2;
  }

  record(call: ProjectToolCall, read: ReadDiagnostic | undefined, raw: string, action: number): StagnationUpdate {
    const mutation = mutationTools.has(call.name);
    const verification = verificationTools.has(call.name);
    const exploration = explorationTools.has(call.name);
    const newRead = read?.relationship === 'new';
    const discovered = new Set<string>();
    if (newRead && meaningfulSource(sourcePath(call, read))) discovered.add(sourcePath(call, read));
    if ((call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') && !lowInformation(raw)) for (const path of resultPaths(raw)) if (meaningfulSource(path)) discovered.add(path);
    const meaningfulDiscovery = [...discovered].some((path) => !this.meaningfulResources.has(path));
    for (const path of discovered) this.meaningfulResources.add(path);
    if (mutation) { this.stats.mutationActions += 1; this.stats.stepsSinceLastMutation = 0; } else this.stats.stepsSinceLastMutation += 1;
    if (verification) this.stats.verificationActions += 1;
    if (exploration) {
      this.stats.explorationActions += 1;
      if (read?.relationship === 'exact_duplicate') { this.stats.exactDuplicateReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (read?.relationship === 'covered') { this.stats.coveredReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (read?.relationship === 'overlap') { this.stats.overlappingReads += 1; this.stats.repeatedExplorationActions += 1; }
      else if (call.name === 'read_file' || call.name === 'inspect_package_json') {
        this.stats.targetedExplorationActions += 1;
        if (newRead) { this.stats.newInformationReads += 1; this.stats.stepsSinceLastNewInformation = 0; }
      } else if (call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') this.stats.targetedExplorationActions += 1;
      else this.stats.broadExplorationActions += 1;
    }
    if (!read || read.relationship !== 'new') this.stats.stepsSinceLastNewInformation += 1;
    if (meaningfulDiscovery) { this.stats.meaningfulSourceDiscoveries += 1; this.stats.stepsSinceLastMeaningfulSourceInformation = 0; } else this.stats.stepsSinceLastMeaningfulSourceInformation += 1;
    const value = resultObject(raw);
    const readInspection = read ? { path: sourcePath(call, read), ...(typeof value.start_line === 'number' ? { start: value.start_line, end: typeof value.end_line === 'number' ? value.end_line : value.start_line } : {}) } : undefined;
    const inspected = readInspection ?? terminalInspection(call);
    const overlapping = Boolean(inspected && this.inspections.some((previous) => overlappingInspection(previous, inspected)));
    if (inspected) { this.inspections.push(inspected); if (overlapping) this.stats.overlappingInspections += 1; }
    if (this.analysisTask && call.name === 'run_terminal' && inspected) { this.stats.explorationActions += 1; this.stats.targetedExplorationActions += 1; }
    const query = searchKey(call); const repeatedSearch = Boolean(query && this.searches.has(query));
    if (query) { this.searches.add(query); if (repeatedSearch) this.stats.repeatedSearches += 1; }
    const notes = typeof value.notes === 'string' ? value.notes.trim() : '';
    const notesProgress = isTaskNotesCall(call) && call.arguments.action === 'update' && notes.length > 0 && notes !== this.lastNotes;
    if (notesProgress) { this.lastNotes = notes; this.stats.taskNoteUpdates += 1; }
    const plan = isAgentPlanCall(call) ? planSnapshot(value) : undefined;
    const planState = plan ? plan.steps.map((step) => `${step.id}:${step.status}`).join('|') : '';
    const planProgress = Boolean(planState && planState !== this.lastPlan);
    if (planProgress) { this.lastPlan = planState; this.stats.planProgressEvents += 1; }
    // Inspection is evidence only once it is materialized as a finding, Notes
    // delta or Plan transition. A new tool or slightly shifted range alone is
    // not meaningful analysis progress.
    const nonInspectionVerification = verification && !inspected && !lowInformation(raw);
    const progress = (!this.analysisTask && meaningfulDiscovery) || notesProgress || planProgress || nonInspectionVerification || (call.name === 'web_search' || call.name === 'web_open') && !lowInformation(raw) || Boolean(query && !repeatedSearch && !lowInformation(raw));
    const inspectionAction = Boolean(inspected || query);
    if (progress) { this.stats.progressEvents += 1; this.stats.stepsSinceLastProgress = 0; this.stats.inspectionActionsSinceCheckpoint = 0; this.stats.overlappingInspections = 0; this.stats.repeatedSearches = 0; } else {
      this.stats.stepsSinceLastProgress += 1;
      if (inspectionAction) this.stats.inspectionActionsSinceCheckpoint += 1;
    }
    if (mutation) this.resetEpisode();
    const repeatedSignal = this.stats.repeatedExplorationActions >= 3;
    const broadLowYieldSignal = this.stats.broadExplorationActions >= 4 && this.stats.stepsSinceLastMeaningfulSourceInformation >= 6;
    const staleMeaningfulSourceSignal = this.stats.stepsSinceLastMeaningfulSourceInformation >= 8;
    const analysisLoopSignal = (repeatedSignal && this.stats.stepsSinceLastProgress >= 3) || (this.stats.broadExplorationActions >= 4 && this.stats.stepsSinceLastProgress >= 6) || this.stats.stepsSinceLastProgress >= 8 || (this.stats.inspectionActionsSinceCheckpoint >= analysisCheckpointActions && (this.stats.overlappingInspections >= 3 || this.stats.repeatedSearches >= 2));
    this.stats.stagnationSuspected = this.analysisTask
      ? this.stats.explorationActions >= 18 && analysisLoopSignal
      : this.codingChangeTask && this.stats.mutationActions === 0 && this.stats.explorationActions >= 18 && this.stats.meaningfulSourceDiscoveries >= 5 && (repeatedSignal || broadLowYieldSignal || staleMeaningfulSourceSignal);
    const intervention = this.nextIntervention(action);
    this.stats.interventionLevel = this.interventionLevel;
    return { stats: { ...this.stats, stepsSinceLastMutation: this.stats.mutationActions ? this.stats.stepsSinceLastMutation : action }, ...(intervention ? { intervention } : {}) };
  }

  private resetEpisode(): void {
    this.interventionLevel = 0; this.interventionStep = 0; this.interventionRepeatedReads = 0; this.interventionMeaningfulDiscoveries = this.stats.meaningfulSourceDiscoveries;
  }

  private nextIntervention(action: number): StagnationIntervention | undefined {
    if (!this.stats.stagnationSuspected) return undefined;
    if (this.interventionLevel === 0) return this.startIntervention('first', action);
    const actionsSinceIntervention = action - this.interventionStep;
    const duplicateReadsSinceIntervention = this.stats.repeatedExplorationActions - this.interventionRepeatedReads;
    const meaningfulDiscoveriesSinceIntervention = this.stats.meaningfulSourceDiscoveries - this.interventionMeaningfulDiscoveries;
    const recurring = actionsSinceIntervention >= (this.interventionLevel === 1 ? 8 : 6)
      && (duplicateReadsSinceIntervention >= 3 || (meaningfulDiscoveriesSinceIntervention === 0 && this.stats.stepsSinceLastMeaningfulSourceInformation >= 6));
    if (!recurring) return undefined;
    return this.interventionLevel === 1 ? this.startIntervention('second', action) : this.startIntervention('stalled', action);
  }

  private startIntervention(kind: StagnationIntervention, action: number): StagnationIntervention {
    this.interventionLevel += 1; this.interventionStep = action; this.interventionRepeatedReads = this.stats.repeatedExplorationActions; this.interventionMeaningfulDiscoveries = this.stats.meaningfulSourceDiscoveries;
    return kind;
  }
}
function completedActivity(activity: ToolActivity, call: ProjectToolCall, raw: string, durationMs: number, context?: { read?: ReadDiagnostic }): ToolActivity {
  const value = resultObject(raw); const error = typeof value.error === 'string';
  const metadata: Record<string, string | number | boolean | null> = { duration_ms: durationMs };
  let detail = activity.detail;
  if (call.name === 'read_file' || call.name === 'inspect_package_json') {
    const path = typeof value.path === 'string' ? value.path : typeof call.arguments.path === 'string' ? call.arguments.path : 'package.json';
    const range = lineRange(value);
    detail = range ? `${path} · ${range}` : `${path} · весь файл`;
    for (const key of ['fingerprint', 'status', 'unchanged', 'requested_range_already_available', 'readCount', 'sameContentAlreadyRead', 'previousResultActive', 'previousResultCompacted', 'previousResultInvalidated', 'previousInvalidationReason', 'relationship', 'coveredByRange', 'pinned', 'repeatedReadLoopSuspected'] as const) {
      if (key === 'status') { if (typeof value.status === 'string') metadata.status = value.status; continue; }
      const field = value[key] ?? context?.read?.[key];
      if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') metadata[key] = field;
    }
    if (range) metadata.actual_range = range;
  } else if (call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files') {
    const count = Array.isArray(value.matches) ? value.matches.length : 0;
    detail = `${activity.detail ?? ''} · ${count} ${count === 1 ? 'совпадение' : count < 5 ? 'совпадения' : 'совпадений'}`.trim(); metadata.matches = count;
  } else if (call.name === 'list_directory') {
    const count = Array.isArray(value.entries) ? value.entries.length : 0; detail = `${typeof value.root === 'string' ? value.root : activity.detail ?? '.'} · ${count} элементов`; metadata.entries = count;
  } else if (call.name === 'run_terminal') {
    const exit = typeof value.exit_code === 'number' ? value.exit_code : null; detail = `${activity.detail ?? ''} · ${exit === null ? 'завершено' : `exit ${exit}`} · ${(durationMs / 1000).toFixed(1)}s`; metadata.exit_code = exit;
    if (typeof value.cwd === 'string') metadata.cwd = value.cwd;
  } else if (call.name === 'apply_patch' || call.name === 'write_file' || call.name === 'create_file' || call.name === 'delete_file') {
    const paths = Array.isArray(value.files) ? value.files.filter((item): item is string => typeof item === 'string') : typeof value.path === 'string' ? [value.path] : [];
    if (paths.length) detail = paths.join(' · ');
  } else if (call.name === 'task_plan') {
    detail = call.arguments.action === 'create' ? 'План создан' : call.arguments.action === 'update' ? 'План обновлён' : 'План прочитан';
    const plan = planSnapshot(value);
    if (plan) {
      metadata.steps = plan.steps.length;
      metadata.completed_steps = plan.steps.filter((step) => step.status === 'completed').length;
    }
  }
  const output = call.name === 'task_notes' ? (typeof value.notes === 'string' ? value.notes : undefined)
    : call.name === 'run_terminal' ? [typeof value.stdout === 'string' ? value.stdout : '', typeof value.stderr === 'string' ? value.stderr : ''].filter(Boolean).join('\n').slice(0, 12_000)
    : call.name === 'search_text' || call.name === 'find_files' || call.name === 'search_files' || call.name === 'list_directory' ? JSON.stringify(value.matches ?? value.entries ?? [], null, 2).slice(0, 12_000)
      : call.name === 'git_status' || call.name === 'git_diff' ? String(value.status ?? value.diff ?? '').slice(0, 12_000)
        : error ? String(value.error).slice(0, 2_000) : undefined;
  return { ...activity, detail, state: error || (call.name === 'run_terminal' && value.exit_code !== 0) ? 'error' : 'completed', metadata, output };
}
const runtimeNotice = (kind: string, content: string): ToolMessage => ({ role: 'user', content: `<runtime_context kind="${kind}">${content}</runtime_context>` });
function contextCompactionActivity(stats: ContextCompactionStats): ToolActivity {
  const effective = stats.meaningfulSavings;
  return {
    id: randomUUID(), label: effective ? 'Контекст оптимизирован' : 'Контекст не сокращён', detail: effective ? `${stats.inputTokensBefore.toLocaleString('ru-RU')} → ${stats.inputTokensAfter.toLocaleString('ru-RU')} токенов` : 'Недостаточно места для полезного сокращения', kind: 'context', state: 'completed',
    metadata: { context_window: stats.contextWindow, input_tokens_before: stats.inputTokensBefore, input_tokens_after: stats.inputTokensAfter, saved_tokens: stats.savedTokens, meaningful_savings: effective, compacted_messages: stats.compactedMessages, compacted_tool_results: stats.compactedToolResults, compaction_count: stats.compactionCount, ineffective_compaction_count: stats.ineffectiveCompactionCount, working_memory_tokens: stats.workingMemoryTokens, facts_added: stats.factsAdded, facts_updated: stats.factsUpdated, facts_deduplicated: stats.factsDeduplicated, stale_facts_removed: stats.staleFactsRemoved, history_retrieval_count: stats.historyRetrievalCount, post_compaction_reread_count: stats.postCompactionRereadCount, checkpoint_reason: stats.checkpointReason ?? 'refresh', level: stats.level ?? 'normal' },
  };
}
const planIsComplete = (value: AgentPlan | null): boolean => Boolean(value?.steps.length && value.steps.every((step) => step.status === 'completed'));
const recentAgentProgress = (stats: StagnationStats | undefined): boolean => Boolean(stats && !stats.stagnationSuspected && (stats.stepsSinceLastMeaningfulSourceInformation <= 12 || stats.stepsSinceLastMutation <= 12 || stats.verificationActions > 0));
function actionBudgetActivity(previous: number, next: number): ToolActivity {
  return { id: randomUUID(), label: 'Бюджет действий расширен', detail: `${previous} → ${next}`, kind: 'progress', state: 'completed', metadata: { previous_budget: previous, action_budget: next } };
}
const referenceContext = (message: ChatMessage): string => {
  const references = message.projectReferences ?? [];
  if (!references.length) return message.content;
  const items = references.map((reference) => `- ${reference.kind === 'file' ? 'Explicit file (read this directly before broad exploration when relevant)' : 'Explicit folder scope (use list/search/read inside it; do not recursively load it)'}: ${reference.relativePath} | Project ${reference.projectSlot} (${projectDirectoryName(reference.projectPath)}) | project_id=${reference.projectId} | created_slot=Project ${reference.projectSlot}`).join('\n');
  return `<project_references>\n${items}\n</project_references>\n\n${message.content}`;
};
const agentHistory = (history: ChatMessage[]): ToolMessage[] => {
  const representedReferences = new Set(history.filter((message) => message.role === 'system' && message.id.startsWith('project-references-')).map((message) => message.id.slice('project-references-'.length)));
  return history.map(({ id, role, content, images, projectReferences, ...message }) => role === 'system' ? runtimeNotice('history', content) : ({ role, content: role === 'user' && !representedReferences.has(id) ? referenceContext({ id, ...message, role, content, images, projectReferences }) : content, ...(images?.length ? { images } : {}) }));
};
const messageMetadata = (messages: ToolMessage[]): Array<Record<string, unknown>> => messages.map((message, index) => {
  let contentKind: string | undefined;
  try { const value = JSON.parse(message.content) as { context_compacted?: boolean; cached_read?: boolean; status?: unknown }; if (value.context_compacted) contentKind = 'compacted_tool_result'; else if (value.cached_read || value.status === 'unchanged') contentKind = 'cached_read'; } catch { /* Do not log content. */ }
  if (message.content.startsWith('<runtime_context')) contentKind = 'runtime_context';
  return { index, role: message.role, toolName: message.tool_name, toolCallId: message.tool_call_id, toolCallCount: message.tool_calls?.length ?? 0, toolCallIds: message.tool_calls?.map((call) => call.id), contentKind };
});

export class ProjectChatService {
  constructor(private readonly backend: ToolCallingBackend, private readonly web: WebBrowserService) {}

  async *stream(model: string, history: ChatMessage[], root: string | AgentProject[], signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, webMode: WebMode, confirm: ConfirmAction, runtime?: AgentRuntimeContext): AsyncIterable<StreamEvent> {
    const projects: AgentProject[] = typeof root === 'string' ? [{ id: 'project-1', slot: 1, root, label: 'Project 1' }] : root;
    const primary = projects.find((project) => project.slot === 1) ?? projects[0];
    const engine = new AnalysisEngine(); const tools = new Map(await Promise.all(projects.map(async (project) => [project.id, await ReadonlyProjectTools.open(project.root, confirm)] as const)));
    const terminal = await TerminalTools.open(primary?.root ?? homedir(), confirm);
    let webSession: WebBrowserSession | null = null;
    if (webMode === 'auto') {
      try { webSession = await this.web.openSession(); }
      catch (error) { log('web.session.unavailable', { message: error instanceof Error ? error.message : String(error) }); }
    }
    const closeWebOnAbort = () => { void webSession?.close(); };
    signal.addEventListener('abort', closeWebOnAbort, { once: true });
    const toolDefinitions = [taskNotesToolDefinition, agentPlanToolDefinition, reportProgressToolDefinition, recallPreviousToolResultDefinition, terminalToolDefinition, ...(projects.length ? projectToolDefinitions : []), ...(webSession ? webToolDefinitions : [])];
    const availableToolNames = new Set(toolDefinitions.map((definition) => definition.function.name));
    const projectContext = projects.map((project) => `- Project ${project.slot}: Name: ${projectDirectoryName(project.root)}; Role: ${project.slot === 1 ? 'primary' : 'secondary'}; project_id=${project.id}${project.slot === 1 ? '; default for every tool call without a project scope.' : ''}`).join('\n');
    const projectInstructions = projects.length
      ? `Available projects (paths are scoped by the tool runtime):\n${projectContext}\nEvery project tool accepts optional project_id or project_slot. Use project_id for an explicit reference, and never infer project identity from a relative path.`
      : 'Проект не выбран: project filesystem tools недоступны. Для пользовательских и системных задач используй run_terminal.';
    const messages: ToolMessage[] = [{ role: 'system', content: `${capabilitySystemContext({ webAvailable: Boolean(webSession), projectRoot: primary?.root, projectWriteAvailable: Boolean(primary), terminalAvailable: true, terminalInitialCwd: terminal.cwd })}\n${projectInstructions}\n${agentActionExecutionPolicy}\n${engine.strategy()} Рабочий цикл для задач изменения кода: Explore → Implement → Verify → Finalize. Сначала найди только нужные места и зависимости; когда поведение и точки изменения понятны, переходи к минимальной реализации, а не продолжай широкое исследование ради дополнительной уверенности. Перед повторным чтением неизменённого файла назови конкретный неразрешённый вопрос и предпочти узкий диапазон. В сложных или длинных задачах используй Task Notes: фиксируй существенные находки и перед повторным чтением уже исследованных файлов сначала сверяйся с notes. Planning через task_plan доступен для задач с несколькими этапами, исследованием нескольких частей проекта или существенной проверкой; простые задачи не требуют плана. Plan хранит этапы, а Task Notes — факты и решения. После исследования обновляй статусы Plan и переходи к реализации, не продолжай бесконечное чтение. Не обновляй notes или Plan после каждого вызова инструмента. После изменения выполни сфокусированную проверку и заверши ответ. Для явно исследовательской задачи изменение файла не требуется. Используй report_progress редко и только при переходе между изучением, реализацией и проверкой; это короткий пользовательский статус, не рассуждение. Результаты инструментов могут быть детерминированно сокращены ради контекстного бюджета; для полного содержания файла снова вызови read_file с конкретным диапазоном.` }, ...agentHistory(history)];
    const toolContext = new AgentToolContext(contextWindow);
    const taskNotes = new TaskNotes();
    const plan = new AgentPlanState();
    const contextManager = new AgentContextManager(contextWindow);
    const actionBudget = new AgentActionBudget();
    const workingMemory = () => ({ plan: plan.snapshot(), taskNotes: taskNotes.snapshot() });
    const runtimeActivities: ToolActivity[] = [];
    const onContextCompaction = (stats: ContextCompactionStats) => runtimeActivities.push(contextCompactionActivity(stats));
    let actions = 0; let progressReports = 0; let repeats = 0; let lowInfo = 0; let warningSent = false; let researchFinished = false; let initialInferencePending = true; let malformedToolArgumentRecoveries = 0; let protocolFailureRecoveries = 0; let recoveryPending = false; let latestStagnationStats: StagnationStats | undefined;
    const toolFailureAttempts = new Map<string, number>();
    const progressMessages = new Set<string>();
    const completed = new Set<string>();
    const stagnation = new AgentStagnation(history);
    try { while (!signal.aborted) {
      const previousBudget = actionBudget.snapshot();
      const budget = actionBudget.assess({ actions, planComplete: planIsComplete(plan.snapshot()), stalled: Boolean(latestStagnationStats?.stagnationSuspected), recentProgress: recentAgentProgress(latestStagnationStats) });
      if (budget.extended) {
        log('agent.action-budget.extended', { ...runtime, actions, previousBudget, actionBudget: budget.limit, compactionCount: contextManager.stats().compactionCount, recentProgress: recentAgentProgress(latestStagnationStats) });
        yield { type: 'tool', activity: actionBudgetActivity(previousBudget, budget.limit) };
        messages.push(runtimeNotice('action_budget_extended', `Задача продолжает продвигаться, поэтому бюджет действий расширен с ${previousBudget} до ${budget.limit}. Продолжай только необходимые шаги и заверши работу после проверки.`));
      }
      if (budget.shouldFinalize) {
        log('agent.action-budget.finalize', { ...runtime, actions, actionBudget: budget.limit, planComplete: planIsComplete(plan.snapshot()), stalled: Boolean(latestStagnationStats?.stagnationSuspected), atAbsoluteCap: budget.atAbsoluteCap });
        yield* this.synthesize(model, messages, engine, signal, contextWindow, reasoningMode, '', actions, toolContext.stats(), runtime, contextManager, workingMemory, runtimeActivities, onContextCompaction); return;
      }
      const remaining = budget.limit - actions;
      if (remaining <= finalizationThreshold && !warningSent) { messages.push(runtimeNotice('action_budget', 'Осталось мало вызовов. Закрой только наиболее важные пробелы и заверши исследование.')); warningSent = true; }
      let response: ToolMessage;
      try {
        response = await this.inference(model, messages, toolDefinitions, signal, contextWindow, reasoningMode, actions, toolContext.stats(), runtime, initialInferencePending, recoveryPending, contextManager, workingMemory, onContextCompaction);
        while (runtimeActivities.length) yield { type: 'tool', activity: runtimeActivities.shift()! };
        initialInferencePending = false;
        recoveryPending = false;
        // A response reached the normal Agent protocol, so a later malformed
        // server-side call is a new recovery episode.
        malformedToolArgumentRecoveries = 0;
      } catch (error) {
        initialInferencePending = false;
        const classified = classifyOllamaError(error, signal);
        if (signal.aborted || classified.kind === 'cancelled') throw classified;
        if (classified.kind !== 'malformed_tool_arguments') throw classified;
        malformedToolArgumentRecoveries += 1;
        log('agent.malformed-tool-arguments', { ...runtime, agentStep: actions, phase: 'tool_decision', recoveryAttempt: malformedToolArgumentRecoveries, recoveryLimit: maxMalformedToolArgumentRecoveries, tool: undefined, argumentLength: undefined, ...ollamaErrorDiagnostics(classified) });
        if (malformedToolArgumentRecoveries > maxMalformedToolArgumentRecoveries) {
          log('agent.malformed-tool-arguments.exhausted', { ...runtime, agentStep: actions, recoveryAttempts: malformedToolArgumentRecoveries - 1, recoveryLimit: maxMalformedToolArgumentRecoveries });
          yield { type: 'error', message: 'Агент не смог сформировать корректный вызов инструмента', details: 'Модель дважды получила запрос исправить JSON-аргументы инструмента.' };
          return;
        }
        yield { type: 'tool', activity: recoveryActivity('Некорректные аргументы инструмента — запрошено исправление', malformedToolArgumentRecoveries, 'malformed_tool_arguments') };
        messages.push(malformedToolArgumentsNotice(malformedToolArgumentRecoveries));
        recoveryPending = true;
        continue;
      }
      const rawContent = response.content ?? '';
      const textual = response.tool_calls?.length ? undefined : parseTextualToolCalls(rawContent);
      if (textual && /<tool_call>/i.test(rawContent)) log('agent.tool-call.textual.fallback', { ...runtime, agentStep: actions, raw: safeTextShape(rawContent), malformed: textual.malformed, reason: textual.reason, calls: textual.calls.map((call) => ({ name: call.name, arguments: safeArgumentsShape(call.arguments), registered: availableToolNames.has(call.name) })) });
      if (textual?.malformed) {
        protocolFailureRecoveries += 1;
        log('agent.tool-call.textual.invalid', { ...runtime, agentStep: actions, reason: textual.reason, recoveryAttempt: protocolFailureRecoveries, recoveryLimit: maxToolFailureRecoveries });
        if (protocolFailureRecoveries > maxToolFailureRecoveries) {
          yield { type: 'error', message: 'Агент не смог исправить вызов инструмента', details: 'Модель несколько раз вернула некорректный формат вызова инструмента.' };
          return;
        }
        yield { type: 'tool', activity: recoveryActivity('Некорректный вызов инструмента — запрошено исправление', protocolFailureRecoveries, 'malformed_textual_protocol') };
        messages.push({ role: 'assistant', content: stripTextualToolCalls(rawContent) });
        messages.push(runtimeNotice('malformed_tool_protocol', `Вызов инструмента не выполнен: некорректный формат (${textual.reason ?? 'unknown'}). recovery_attempt=${protocolFailureRecoveries}. Сформируй один корректный вызов доступного инструмента или короткий итог без инструмента.`));
        recoveryPending = true;
        continue;
      }
      const calls = response.tool_calls?.length ? response.tool_calls.map(parseCall) : textual?.calls ?? [];
      // llama.cpp sometimes omits call IDs. Generate one before history is
      // constructed so sibling calls with the same name remain distinguishable.
      for (const call of calls) call.toolCallId ??= randomUUID();
      const assistantContent = calls.length ? stripTextualToolCalls(rawContent) : rawContent;
      // Calls are retained in canonical structured form. Each backend adapts
      // this representation at its own protocol boundary.
      messages.push({ role: 'assistant', content: assistantContent, tool_calls: calls.length ? normalizedToolCalls(calls) : undefined });
      if (calls.length === 0) {
        if (response.finish_reason === 'length') {
          log('agent.tool-decision.truncated', { ...runtime, agentStep: actions, content: safeTextShape(rawContent), reasoning: safeTextShape(response.thinking ?? '') });
          yield { type: 'error', message: 'Агент не завершил выбор действия', details: 'Модель достигла доступного лимита вывода до вызова инструмента. Увеличьте Context Window или сократите историю.' };
          return;
        }
        researchFinished = true;
        yield* this.synthesize(model, messages, engine, signal, contextWindow, reasoningMode, assistantContent, actions, toolContext.stats(), runtime, contextManager, workingMemory, runtimeActivities, onContextCompaction);
        return;
      }
      protocolFailureRecoveries = 0;
      let lowInformationNotice = false;
      let stagnationIntervention: StagnationIntervention | undefined;
      let pendingWorkingMemoryReminder: ReturnType<AgentContextManager['observe']>;
      let batchRecovery: { call: ProjectToolCall; attempt: number; reason: string; failure: string } | undefined;
      let batchRecoveryExhausted = false;
      let actionBudgetReached = false;
      for (const [callIndex, call] of calls.entries()) {
        if (signal.aborted) {
          // A stopped run will not request another inference, but retaining a
          // complete local history prevents an invalid partial batch being
          // persisted or accidentally reused by future orchestration.
          for (const skipped of calls.slice(callIndex)) messages.push(toolResult(skipped, JSON.stringify({ error: 'Generation cancelled', code: 'tool_call_cancelled', tool: skipped.name })));
          break;
        }
        if (batchRecovery || actionBudgetReached) {
          messages.push(skippedToolResult(call, batchRecovery?.call ?? call));
          continue;
        }
        if (actions >= actionBudget.snapshot()) {
          actionBudgetReached = true;
          messages.push(toolResult(call, JSON.stringify({ error: 'Текущий бюджет действий исчерпан; вызов не выполнен.', code: 'action_budget_exhausted', tool: call.name })));
          continue;
        }
        if (!availableToolNames.has(call.name)) {
          protocolFailureRecoveries += 1;
          const reason = `Недоступный инструмент "${call.name}"`;
          const result = compactToolFailure(call, JSON.stringify({ error: reason }));
          messages.push(toolResult(call, result));
          log('agent.tool-call.unknown', { ...runtime, agentStep: actions, tool: call.name, toolCallId: call.toolCallId, argumentKeys: Object.keys(call.arguments), recoveryAttempt: protocolFailureRecoveries, recoveryLimit: maxToolFailureRecoveries });
          batchRecovery = { call, attempt: protocolFailureRecoveries, reason, failure: 'unknown_tool' };
          batchRecoveryExhausted = protocolFailureRecoveries > maxToolFailureRecoveries;
          continue;
        }
        if (call.name === 'report_progress') {
          const message = typeof call.arguments.message === 'string' ? call.arguments.message.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
          const accepted = message.length >= 3 && progressReports < 12 && !progressMessages.has(message);
          const actionId = randomUUID();
          if (accepted) {
            progressReports += 1; progressMessages.add(message);
            yield { type: 'tool', activity: { id: actionId, ...activityForTool({ ...call, arguments: { message } }), metadata: { progress_index: progressReports } } };
          }
          messages.push(toolResult(call, JSON.stringify(accepted ? { reported: true } : { reported: false, reason: 'Progress updates are limited; continue with the task.' })));
          continue;
        }
        const key = signature(call);
        // Re-reading is valid after mutations, for another range, and for verification.
        // The context manager deduplicates unchanged same-range reads without hiding content.
        if (completed.has(key) && toolFailureAttempts.has(key)) {
          const failedAttempt = toolFailureAttempts.get(key);
          const recoveryAttempt = (failedAttempt ?? 0) + 1;
          toolFailureAttempts.set(key, recoveryAttempt);
          log('agent.tool-call.recovery.repeated-failure', { ...runtime, agentStep: actions, tool: call.name, recoveryAttempt, recoveryLimit: maxToolFailureRecoveries });
          messages.push(toolResult(call, compactToolFailure(call, JSON.stringify({ error: 'Идентичный вызов уже завершился ошибкой.' }))));
          batchRecovery = { call, attempt: recoveryAttempt, reason: 'Идентичный вызов уже завершился ошибкой. Измени аргументы или выбери другой инструмент.', failure: 'repeated_tool_failure' };
          batchRecoveryExhausted = recoveryAttempt > maxToolFailureRecoveries;
          continue;
        }
        if (completed.has(key) && call.name !== 'read_file' && !isTaskNotesCall(call) && !isAgentPlanCall(call)) {
          repeats += 1; messages.push(toolResult(call, JSON.stringify({ warning: 'Идентичный вызов уже выполнен. Смени стратегию или заверши исследование.' })));
          if (repeats >= 3) researchFinished = true;
          continue;
        }
        completed.add(key); actions += 1;
        const isWebTool = webToolDefinitions.some((definition) => definition.function.name === call.name);
        const isTerminalTool = call.name === terminalToolDefinition.function.name;
        const actionId = randomUUID();
        const activity: ToolActivity = { id: actionId, ...(isWebTool ? { ...activityForWebTool(call), kind: 'web' as const, state: 'running' as const } : activityForTool(call)) };
        yield { type: 'tool', activity };
        const startedAt = Date.now();
        const explicitProjectId = typeof call.arguments.project_id === 'string' ? call.arguments.project_id : undefined;
        const requestedSlot = call.arguments.project_slot === 2 ? 2 : 1;
        const targetProject = explicitProjectId ? projects.find((project) => project.id === explicitProjectId) : projects.find((project) => project.slot === requestedSlot) ?? primary;
        log('agent.tool.execute.started', { ...runtime, agentStep: actions, actionId, tool: call.name, arguments: safeArgumentsShape(call.arguments), targetProject: targetProject ? { id: targetProject.id, slot: targetProject.slot } : null, registered: availableToolNames.has(call.name), route: isTaskNotesCall(call) ? 'task_notes' : isAgentPlanCall(call) ? 'task_plan' : isWebTool ? 'web' : isTerminalTool ? 'terminal' : targetProject ? 'project' : 'missing_project' });
        let unscopedResult: string;
        try {
          unscopedResult = isTaskNotesCall(call) ? taskNotes.execute(call) : isAgentPlanCall(call) ? plan.execute(call) : isHistoryRecallCall(call) ? contextManager.retrieve(typeof call.arguments.query === 'string' ? call.arguments.query : '', typeof call.arguments.tool_call_id === 'string' ? call.arguments.tool_call_id : undefined) : isWebTool && webSession ? await webSession.execute(call) : isTerminalTool ? await terminal.execute(call, signal, actionId) : targetProject ? await tools.get(targetProject.id)!.execute(call, signal, actionId) : JSON.stringify({ error: `Unknown or unavailable project_id: ${explicitProjectId}` });
        } catch (error) {
          // A Stop can race a running executor. Its call was already emitted by
          // the assistant, so record a cancellation result before terminating
          // the run rather than leaving an invalid partial tool batch.
          unscopedResult = JSON.stringify({ error: signal.aborted ? 'Generation cancelled' : compactFailureReason(error instanceof Error ? error.message : String(error)) });
        }
        const scopedResult = !isTaskNotesCall(call) && !isAgentPlanCall(call) && !isHistoryRecallCall(call) && !isWebTool && !isTerminalTool ? scopedProjectResult(unscopedResult, targetProject) : unscopedResult;
        const rawExecutionResult = resultObject(scopedResult);
        const failed = typeof rawExecutionResult.error === 'string';
        const result = failed ? compactToolFailure(call, scopedResult) : scopedResult;
        log('agent.tool.execute.finished', { ...runtime, agentStep: actions, actionId, tool: call.name, resultLength: result.length, resultSha256: createHash('sha256').update(result).digest('hex'), succeeded: !failed, error: failed ? compactFailureReason(rawExecutionResult.error) : undefined });
        engine.record(call.name, result);
        const toolMessage = toolResult(call, result);
        messages.push(toolMessage);
        if (lowInformation(result)) { lowInfo += 1; if (lowInfo === 3) lowInformationNotice = true; } else lowInfo = 0;
        const contextUpdate = toolContext.add(call.name, call.arguments, toolMessage, actions);
        const workingMemoryReminder = contextManager.observe(toolMessage, messages, workingMemory(), scopedResult);
        // A model may emit sibling calls in one assistant message. A user
        // runtime notice is valid only after every sibling has its tool result.
        if (workingMemoryReminder) pendingWorkingMemoryReminder = workingMemoryReminder;
        const stats = contextUpdate.stats;
        if (contextUpdate.read) log('agent.read.diagnostics', { ...runtime, agentStep: actions, normalizedPath: contextUpdate.read.path, requestedRange: contextUpdate.read.range, fileFingerprint: contextUpdate.read.fingerprint, readCount: contextUpdate.read.readCount, sameContentAlreadyRead: contextUpdate.read.sameContentAlreadyRead, relationship: contextUpdate.read.relationship, coveredByRange: contextUpdate.read.coveredByRange, previousResultActive: contextUpdate.read.previousResultActive, previousResultCompacted: contextUpdate.read.previousResultCompacted, previousCompactionReason: contextUpdate.read.previousCompactionReason, previousResultInvalidated: contextUpdate.read.previousResultInvalidated, previousInvalidationReason: contextUpdate.read.previousInvalidationReason, repeatedReadLoopSuspected: contextUpdate.read.repeatedReadLoopSuspected, pinned: contextUpdate.read.pinned, activeToolResultContextSize: stats.size, contextBudget: stats.budget, peakActiveToolResultContextSize: stats.peakSize });
        if (contextUpdate.invalidation) log('agent.read.cache.invalidated', { ...runtime, agentStep: actions, tool: call.name, ...contextUpdate.invalidation, totalInvalidatedReads: stats.invalidatedReads });
        const stagnationUpdate = stagnation.record(call, contextUpdate.read, result, actions);
        latestStagnationStats = stagnationUpdate.stats;
        if (mutationTools.has(call.name)) stagnationIntervention = undefined;
        log('agent.stagnation.diagnostics', { ...runtime, agentStep: actions, ...stagnationUpdate.stats });
        if (stagnationUpdate.intervention) {
          stagnationIntervention = stagnationUpdate.intervention;
          log('agent.stagnation.intervention', { ...runtime, agentStep: actions, level: stagnationUpdate.intervention, ...stagnationUpdate.stats });
        }
        if (stats.compacted) log('agent.context.compacted', { ...runtime, agentStep: actions, tool: call.name, toolResultContextSize: stats.size, toolResultContextBudget: stats.budget, compactedResults: stats.compacted });
        const finishedActivity = { ...completedActivity(activity, call, result, Date.now() - startedAt, contextUpdate), rawOutput: scopedResult };
        if (targetProject && !isTaskNotesCall(call) && !isAgentPlanCall(call) && !isWebTool && !isTerminalTool) finishedActivity.metadata = { ...finishedActivity.metadata, project: targetProject.label, project_slot: targetProject.slot };
        const contextResult = resultObject(toolMessage.content);
        if (isAgentPlanCall(call)) {
          const snapshot = planSnapshot(contextResult);
          if (snapshot && typeof contextResult.error !== 'string') finishedActivity.plan = snapshot;
        }
        if (typeof contextResult.status === 'string') finishedActivity.metadata = { ...finishedActivity.metadata, status: contextResult.status };
        yield { type: 'tool', activity: finishedActivity };
        if (failed) {
          const reason = compactFailureReason(rawExecutionResult.error);
          const failureKey = signature(call);
          const recoveryAttempt = (toolFailureAttempts.get(failureKey) ?? 0) + 1;
          toolFailureAttempts.set(failureKey, recoveryAttempt);
          log('agent.tool-call.recovery', { ...runtime, agentStep: actions, tool: call.name, argumentLength: typeof call.arguments.content === 'string' ? call.arguments.content.length : undefined, recoveryAttempt, recoveryLimit: maxToolFailureRecoveries, reason });
          batchRecovery = { call, attempt: recoveryAttempt, reason, failure: 'tool_call_failed' };
          batchRecoveryExhausted = recoveryAttempt > maxToolFailureRecoveries;
          if (batchRecoveryExhausted) log('agent.tool-call.recovery.exhausted', { ...runtime, agentStep: actions, tool: call.name, recoveryAttempts: recoveryAttempt - 1, recoveryLimit: maxToolFailureRecoveries });
        }
      }
      if (pendingWorkingMemoryReminder) messages.push(runtimeNotice(`working_memory_${pendingWorkingMemoryReminder.reason}`, pendingWorkingMemoryReminder.message));
      const sequenceError = validateLlamaMessageSequence(messages);
      if (sequenceError) {
        log('agent.message-sequence.invalid', { ...runtime, agentStep: actions, sequenceError, messages: messageMetadata(messages) });
        throw new Error(`Некорректная последовательность Agent сообщений: ${sequenceError}`);
      }
      if (signal.aborted) return;
      if (batchRecovery) {
        if (batchRecoveryExhausted) {
          yield { type: 'error', message: 'Агент не смог исправить вызов инструмента', details: 'Несколько вызовов инструмента завершились ошибкой. Проверьте задачу или сформулируйте следующий шаг точнее.' };
          return;
        }
        yield { type: 'tool', activity: recoveryActivity(batchRecovery.failure === 'unknown_tool' ? 'Недоступный инструмент — запрошено исправление' : 'Неуспешный вызов инструмента — запрошено исправление', batchRecovery.attempt, batchRecovery.failure) };
        messages.push(toolRecoveryNotice(batchRecovery.call, batchRecovery.attempt, batchRecovery.reason));
        recoveryPending = true;
        continue;
      }
      if (researchFinished) { yield* this.synthesize(model, messages, engine, signal, contextWindow, reasoningMode, '', actions, toolContext.stats(), runtime, contextManager, workingMemory, runtimeActivities, onContextCompaction); return; }
      if (stagnationIntervention === 'stalled') {
        log('agent.stalled.exploration', { ...runtime, actions, ...latestStagnationStats });
        if (stagnation.isAnalysisTask() && stagnation.hasSufficientAnalysisEvidence()) {
          messages.push(runtimeNotice('stagnation_synthesis', 'Повторное исследование больше не добавляет новых фактов. Сформируй лучший итог по уже собранным evidence, Plan и Task Notes. Не вызывай инструменты.'));
          yield* this.synthesize(model, messages, engine, signal, contextWindow, reasoningMode, '', actions, toolContext.stats(), runtime, contextManager, workingMemory, runtimeActivities, onContextCompaction);
          return;
        }
        yield { type: 'error', message: 'Агент остановился: исследование не продвигается', details: stagnation.isAnalysisTask() ? 'agent_stalled_exploration: после двух подсказок не появились новые подтверждённые факты, Plan progress или Task Notes evidence.' : 'agent_stalled_exploration: после двух подсказок не появились реализация или новая существенная информация.' };
        return;
      }
      if (stagnationIntervention === 'first') messages.push(runtimeNotice(plan.hasPlan ? 'stagnation_plan_guidance' : 'stagnation_guidance', stagnation.isAnalysisTask() ? analysisStagnationGuidance : plan.hasPlan ? plannedStagnationGuidance : firstStagnationGuidance));
      if (stagnationIntervention === 'second') messages.push(runtimeNotice('stagnation_guard', stagnation.isAnalysisTask() ? analysisStagnationGuard : secondStagnationGuidance));
      if (lowInformationNotice) messages.push(runtimeNotice('low_information', 'Последние действия дали мало новой информации. Сузь исследование или заверши ответ.'));
    } } catch (error) {
      if (signal.aborted) return;
      const classified = classifyOllamaError(error, signal);
      const details = error instanceof Error ? error.message : String(error);
      log('agent.inference.failed', { ...runtime, phase: researchFinished ? 'final-synthesis.error' : 'research.error', actions, model, contextWindow, toolResultContext: toolContext.stats(), ...ollamaErrorDiagnostics(classified) });
      if (classified.kind === 'connection_failure' || classified.kind === 'connection_reset') {
        yield { type: 'error', message: classified.message };
      } else yield { type: 'error', message: 'Анализ не завершился', details };
    } finally { signal.removeEventListener('abort', closeWebOnAbort); await webSession?.close(); }
  }

  private async *synthesize(model: string, messages: ToolMessage[], engine: AnalysisEngine, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, fallback: string, actions: number, toolContext: ToolContextStats, runtime?: AgentRuntimeContext, contextManager?: AgentContextManager, workingMemory?: () => { plan: ReturnType<AgentPlanState['snapshot']>; taskNotes: string }, runtimeActivities: ToolActivity[] = [], onContextCompaction?: (stats: ContextCompactionStats) => void): AsyncIterable<StreamEvent> {
    const evidence = engine.prompt();
    messages.push(runtimeNotice('evidence_map', evidence), runtimeNotice('finalization', 'Исследование завершено. Сформируй один итоговый ответ на исходный вопрос пользователя, опираясь на evidence map и релевантные доступные результаты инструментов. Не вызывай инструменты.'));
    try {
      const response = await this.finalRequest(model, messages, signal, contextWindow, reasoningMode, actions, toolContext, runtime, contextManager, workingMemory, onContextCompaction);
      while (runtimeActivities.length) yield { type: 'tool', activity: runtimeActivities.shift()! };
      if (response.finish_reason === 'length') throw new OllamaRequestError('output_limit', 'Итоговый ответ Ollama был остановлен по лимиту длины', { causeDetail: 'done_reason=length' });
      if (response.tool_calls?.length) throw new OllamaRequestError('malformed_response', 'Ollama вернул tool call вместо итогового ответа', { causeDetail: 'final request did not allow tools' });
      if (/<tool_call>\s*<function=[a-z_]+>/i.test(response.content ?? '')) throw new OllamaRequestError('malformed_response', 'Ollama вернул текстовый tool call вместо итогового ответа', { causeDetail: 'final request did not allow tools' });
      const content = response.content?.trim() || fallback;
      if (!content) {
        const reason = response.thinking?.trim() ? 'Ollama вернул reasoning без итогового текста' : 'Ollama вернул корректный ответ без итогового текста';
        throw new OllamaRequestError('empty_response', reason, { causeDetail: JSON.stringify({ finish_reason: response.finish_reason, has_thinking: Boolean(response.thinking?.trim()) }) });
      }
      if (typeof response.prompt_eval_count === 'number') yield { type: 'context-usage', used: response.prompt_eval_count, maximum: contextWindow };
      yield* this.emit(content, engine, signal, response.inference ? { ...response.inference, toolResultContextSize: toolContext.size, toolResultContextBudget: toolContext.budget, toolResultCompacted: toolContext.compacted } : undefined, actions, response.finish_reason);
    } catch (error) {
      if (signal.aborted) return;
      const classified = classifyOllamaError(error, signal);
      const details = error instanceof Error ? error.message : String(error);
      const timedOut = details.includes('timed out');
      log('agent.final.failed', { ...runtime, phase: timedOut ? 'final-synthesis.timeout' : 'final-synthesis.error', model, actions, contextWindow, fallback: Boolean(fallback), ...ollamaErrorDiagnostics(error) });
      // A tool protocol in final synthesis is neither an answer nor a safe
      // fallback condition. Tools are unavailable in this phase, so reporting
      // completion here would turn an invalid model action into false success.
      if (classified.kind === 'malformed_response') {
        yield { type: 'error', message: 'Не удалось сформировать итоговый ответ' };
        return;
      }
      if (fallback.trim()) { yield* this.emit(fallback, engine, signal, undefined, actions, 'stop'); return; }
      yield classified.kind === 'connection_failure' || classified.kind === 'connection_reset'
        ? { type: 'error', message: classified.message }
        : { type: 'error', message: 'Не удалось сформировать итоговый ответ', details };
    }
  }

  private async finalRequest(model: string, messages: ToolMessage[], signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, actions: number, toolContext: ToolContextStats, runtime?: AgentRuntimeContext, contextManager?: AgentContextManager, workingMemory?: () => { plan: ReturnType<AgentPlanState['snapshot']>; taskNotes: string }, onContextCompaction?: (stats: ContextCompactionStats) => void): Promise<ToolMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), finalSynthesisTimeoutMs);
    let rejectTimeout: ReturnType<typeof setTimeout> | null = null;
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      return await Promise.race([
        // Finalization does not need another tool-planning reasoning trace.
        // Keeping it in auto mode leaves the available output budget for the
        // user-facing answer instead of exhausting it before any text appears.
        this.inference(model, messages, undefined, combined, contextWindow, 'auto', actions, toolContext, runtime, false, false, contextManager, workingMemory, onContextCompaction),
        new Promise<never>((_resolve, reject) => { rejectTimeout = setTimeout(() => reject(new Error('final synthesis timed out')), finalSynthesisTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); if (rejectTimeout) clearTimeout(rejectTimeout); }
  }

  /** The first model request has no tool side effects, so one transient connection retry is safe. */
  private async inference(model: string, messages: ToolMessage[], tools: unknown[] | undefined, signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningMode, agentStep: number, toolContext: ToolContextStats | undefined, runtime?: AgentRuntimeContext, initialInference = false, recoveryPending = false, contextManager?: AgentContextManager, workingMemory?: () => { plan: ReturnType<AgentPlanState['snapshot']>; taskNotes: string }, onContextCompaction?: (stats: ContextCompactionStats) => void): Promise<ToolMessage> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal.aborted) {
        if (initialInference) log('agent.initial-inference.cancelled', { ...runtime, model, agentStep, attempt, reason: 'cancelled_or_superseded' });
        throw new OllamaRequestError('cancelled', 'Запрос к локальному inference runtime отменён');
      }
      try {
        if (contextManager && workingMemory) {
          const context = await contextManager.prepare(messages, tools, async () => this.backend.countInputTokens
            ? this.backend.countInputTokens(model, messages, tools, contextWindow, reasoningMode, signal)
            : contextManager.estimate(messages, tools), workingMemory());
          log('agent.context.manager', { ...runtime, agentStep, ...context });
          if (context.compactionAttempted) onContextCompaction?.(context);
        }
        log('agent.message.sequence', { ...runtime, agentStep, messages: messageMetadata(messages) });
        log('agent.inference.attempt', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, contextLimit: contextWindow, toolResultContextSize: toolContext?.size, toolResultContextBudget: toolContext?.budget, toolResultCompacted: toolContext?.compacted });
        if (initialInference && attempt === 1) log('agent.initial-inference.started', { ...runtime, model, agentStep, contextLimit: contextWindow });
        const phase = recoveryPending ? 'recovery' : initialInference ? 'initial' : tools ? 'post_tool' : 'final';
        const response = await this.backend.chatWithTools(model, messages, tools, signal, contextWindow, reasoningMode, { ...runtime, agentStep, phase });
        log('agent.inference.success', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, promptEvalCount: response.prompt_eval_count, finishReason: response.finish_reason });
        if (initialInference && attempt === 2) log('agent.initial-inference.retry.succeeded', { ...runtime, model, agentStep, retryCount: 1 });
        if (response.inference) {
          response.inference = { ...response.inference, ollamaRequestAttempt: attempt, ollamaRetryCount: attempt - 1, toolResultContextSize: toolContext?.size, toolResultContextBudget: toolContext?.budget, toolResultCompacted: toolContext?.compacted };
        }
        return response;
      } catch (error) {
        const classified = classifyOllamaError(error, signal);
        const connectionFailure = classified.kind === 'connection_failure' || classified.kind === 'connection_reset';
        const willRetry = initialInference && agentStep === 0 && connectionFailure && attempt === 1 && !signal.aborted;
        log('agent.inference.failure', { ...runtime, model, agentStep, attempt, retryCount: attempt - 1, contextLimit: contextWindow, initialInference, willRetry, ...ollamaErrorDiagnostics(classified) });
        if (initialInference && connectionFailure) {
          log(attempt === 1 ? 'agent.initial-inference.connection-failed' : 'agent.initial-inference.retry.failed', { ...runtime, model, agentStep, retryCount: attempt - 1, ...ollamaErrorDiagnostics(classified) });
        }
        if (!willRetry) throw classified;
        log('agent.initial-inference.retry.started', { ...runtime, model, agentStep, retryCount: 1, delayMs: initialInferenceRetryDelayMs });
        await this.waitForRetry(initialInferenceRetryDelayMs, signal);
      }
    }
    throw new OllamaRequestError('internal', 'Initial inference retry exited unexpectedly');
  }

  private async waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new OllamaRequestError('cancelled', 'Запрос к Ollama отменён');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, delay);
      const abort = () => { clearTimeout(timer); done(); };
      function done(): void { signal.removeEventListener('abort', abort); resolve(); }
      signal.addEventListener('abort', abort, { once: true });
    });
    if (signal.aborted) throw new OllamaRequestError('cancelled', 'Запрос к Ollama отменён');
  }

  private async *emit(content: string, engine: AnalysisEngine, signal: AbortSignal, inference: InferenceDiagnostics | undefined, actions: number, finishReason: FinishReason | undefined): AsyncIterable<StreamEvent> {
    for (const token of chunkText(content)) { if (signal.aborted) return; yield { type: 'token', content: token }; }
    if (inference) yield { type: 'diagnostics', diagnostics: { ...inference, agentStepCount: actions, finishReason: finishReason ?? 'stop' } };
    yield { type: 'done', finishReason: finishReason ?? 'stop' };
  }
}
