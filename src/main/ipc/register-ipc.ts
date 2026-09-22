import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ApprovalDecision, ApprovalStatus, ChatRequest, Conversation, ProjectReference, ProjectSuggestion, RiskCategory, ThinkingTimelineEvent } from '../../shared/types';
import { Database } from '../services/database';
import { getHardwareStats } from '../services/hardware';
import { OllamaBackend } from '../backends/ollama-backend';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { ProjectChatService, type AgentProject } from '../services/project-chat';
import { paths } from '../services/paths';
import { log } from '../services/logger';
import { contextPresetsFor, getModelProfile, modelRegistry } from '../models/model-registry';
import { WebBrowserService } from '../web/web-tools';
import { webToolDefinitions } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { chatMessagesWithSystemPrefix, chatSystemContext } from '../services/capabilities';
import { projectToolDefinitions, ReadonlyProjectTools, reportProgressToolDefinition, terminalToolDefinition, type ApprovalResult, type ConfirmAction } from '../tools/project-tools';
import { AttachmentService } from '../services/attachment-service';
import { AttachmentPipeline } from '../services/attachment-pipeline';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ollamaErrorDiagnostics } from '../backends/ollama-errors';
import { saveGenerationDiagnosticsBestEffort } from '../services/generation-diagnostics';
import { taskNotesToolDefinition } from '../services/task-notes';
import { agentPlanToolDefinition } from '../services/agent-plan';
import { projectDirectoryName } from '../../shared/project-references';
import { executionMode } from '../../shared/generation-mode';
import { existingProjectDirectory } from '../services/project-picker';

const database = new Database();
const selectedBackend = process.env.LOCAL_AI_BACKEND === 'llama-cpp' ? 'llama-cpp' : 'ollama';
const llamaRuntimeModelId = process.env.LOCAL_AI_LLAMA_MODEL_ID ?? 'qwen3.8:27b-q4_K_M';
const ollama = new OllamaBackend();
const llamaCpp = new LlamaCppBackend(process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081', 65_536, process.env.LOCAL_AI_LLAMA_CPP_VISION === '1', llamaRuntimeModelId);
const backend = selectedBackend === 'llama-cpp' ? llamaCpp : ollama;
const web = new WebBrowserService();
const projectChat = new ProjectChatService(backend, web);
const webChat = new WebChatService(backend, web);
const attachments = new AttachmentService(database);
const attachmentPipeline = new AttachmentPipeline(database, attachments);
type ActiveGeneration = { id: string; abort: AbortController; settled: Promise<void>; finish: () => void };
const activeGenerations = new Map<string, ActiveGeneration>();
type PendingApproval = { approvalId: string; conversationId: string; generation: ActiveGeneration; actionId: string; category: RiskCategory; root: string; resolve: (result: ApprovalResult) => void; settled: boolean; abort: () => void; emit: (payload: Record<string, unknown>) => void };
const pendingApprovals = new Map<string, PendingApproval>();
const sessionApprovals = new Map<string, { root: string; categories: Set<RiskCategory> }>();

const waitFor = (promise: Promise<void>, timeoutMs: number): Promise<void> => new Promise((resolve) => {
  const timeout = setTimeout(resolve, timeoutMs);
  timeout.unref();
  void promise.then(() => { clearTimeout(timeout); resolve(); }, () => { clearTimeout(timeout); resolve(); });
});

/** Called by Electron's main lifecycle before process exit, never by a renderer. */
export async function shutdownRuntime(): Promise<void> {
  const active = [...activeGenerations.values()];
  log('runtime.shutdown.started', { backend: selectedBackend, activeGenerations: active.length });
  for (const generation of active) generation.abort.abort();
  await Promise.allSettled(active.map((generation) => waitFor(generation.settled, 4_000)));
  if (selectedBackend === 'ollama') {
    try { await ollama.unloadTrackedModels(); }
    catch (error) { log('runtime.shutdown.ollama-unload.failed', ollamaErrorDiagnostics(error)); }
  }
  log('runtime.shutdown.finished', { backend: selectedBackend });
}

function settleApproval(pending: PendingApproval, result: ApprovalResult, status: Exclude<ApprovalStatus, 'pending'>): void {
  if (pending.settled) return;
  pending.settled = true;
  pendingApprovals.delete(pending.approvalId);
  pending.generation.abort.signal.removeEventListener('abort', pending.abort);
  pending.resolve(result);
  if (activeGenerations.get(pending.conversationId) === pending.generation && !pending.generation.abort.signal.aborted) {
    pending.emit({ type: 'approval-resolved', conversationId: pending.conversationId, generationId: pending.generation.id, actionId: pending.actionId, approvalId: pending.approvalId, status });
  }
}

async function cancelGeneration(conversationId: string, generationId?: string, reason: 'user_stop' | 'superseded' = 'superseded'): Promise<void> {
  const active = activeGenerations.get(conversationId);
  if (!active || (generationId && active.id !== generationId)) return;
  log('generation.cancelled', { conversationId, generationId: active.id, reason });
  active.abort.abort(); await active.settled;
}

function inlineConfirmation(event: Electron.IpcMainInvokeEvent, conversationId: string, generation: ActiveGeneration, root: string): ConfirmAction {
  const emit = (payload: Record<string, unknown>) => event.sender.send('chat:stream', payload);
  return async (request, signal) => {
    if (signal.aborted || activeGenerations.get(conversationId) !== generation) return { approved: false, reason: 'cancelled' };
    const requestRoot = request.root ?? root;
    const session = sessionApprovals.get(conversationId);
    if (session?.root === requestRoot && session.categories.has(request.category)) {
      emit({ type: 'approval-resolved', conversationId, generationId: generation.id, actionId: request.actionId, approvalId: `session-${randomUUID()}`, status: 'session-approved' });
      return { approved: true, reason: 'session' };
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalResult>((resolve) => {
      const abort = () => settleApproval(pending, { approved: false, reason: 'cancelled' }, 'rejected');
      const pending: PendingApproval = { approvalId, conversationId, generation, actionId: request.actionId, category: request.category, root: requestRoot, resolve, settled: false, abort, emit };
      pendingApprovals.set(approvalId, pending);
      signal.addEventListener('abort', abort, { once: true });
      emit({ type: 'approval-request', conversationId, generationId: generation.id, actionId: request.actionId, approval: { approvalId, category: request.category, status: 'pending' } });
    });
  };
}

export function registerIpc(): void {
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', (_event, requestedModelId?: string) => {
    const modelId = requestedModelId ?? (selectedBackend === 'llama-cpp' ? llamaRuntimeModelId : modelRegistry[0].id);
    if (!getModelProfile(modelId)) throw new Error('Выбранная модель отсутствует в реестре приложения');
    return database.createConversation(modelId);
  });
  ipcMain.handle('conversations:update', async (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'reasoningMode' | 'webMode'>>) => {
    const current = database.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const nextModelId = patch.modelId ?? current.modelId;
    const profile = nextModelId ? getModelProfile(nextModelId) : undefined;
    if (nextModelId && !profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const allowed = profile ? contextPresetsFor(profile.maxContext) : [];
    const requestedContext = patch.contextWindow ?? current.contextWindow;
    const contextWindow = allowed.length && !allowed.includes(requestedContext) ? allowed.at(-1)! : requestedContext;
    const updated = database.updateConversation(id, { ...patch, contextWindow });
    if ((patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory)) sessionApprovals.delete(id);
    if (patch.modelId !== undefined && patch.modelId !== current.modelId) database.setContextUsage(id, null, null);
    if (selectedBackend === 'ollama' && patch.modelId !== undefined && patch.modelId !== current.modelId && current.modelId) void ollama.unloadModel(current.modelId);
    return database.getConversation(id) ?? updated;
  });
  ipcMain.handle('conversations:delete', async (_event, id: string) => { sessionApprovals.delete(id); await attachments.removeManagedFiles(database.deleteConversation(id)); });
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
  ipcMain.handle('messages:edit', async (_event, messageId: string, content: string, fallback?: { conversationId: string; content: string }) => {
    const message = database.getMessage(messageId) ?? (fallback ? database.findUserMessage(fallback.conversationId, fallback.content) : null); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId); const edited = database.editUserMessageAndTruncate(message.id, content);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return edited;
  });
  ipcMain.handle('messages:regenerate', async (_event, messageId: string) => {
    const message = database.getMessage(messageId); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId);
    const retained = database.regenerateUserMessageAndTruncate(message.id);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return retained;
  });
  ipcMain.handle('projects:search', async (_event, conversationId: string, query: string): Promise<ProjectSuggestion[]> => {
    const conversation = database.getConversation(conversationId);
    if (!conversation?.workingDirectory || typeof query !== 'string') return [];
    const projects = [
      { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 (${projectDirectoryName(conversation.workingDirectory)})` },
      ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 (${projectDirectoryName(conversation.secondaryWorkingDirectory)})` }] : []),
    ].filter((project): project is { id: string; slot: 1 | 2; root: string; label: string } => Boolean(project.id));
    const groups = await Promise.all(projects.map(async (project) => (await ReadonlyProjectTools.findResources(project.root, query.trim(), 30)).map((resource): ProjectSuggestion => ({ id: randomUUID(), projectId: project.id, projectSlot: project.slot, projectPath: project.root, projectLabel: project.label, relativePath: resource.relativePath, kind: resource.kind }))));
    return groups.flat();
  });
  ipcMain.handle('attachments:import', (_event, input) => attachments.import(input));
  ipcMain.handle('attachments:list', (_event, messageId: string) => database.listAttachments(messageId));
  ipcMain.handle('attachments:dataUrl', async (_event, id: string) => {
    const attachment = database.getAttachment(id); if (!attachment || attachment.kind !== 'image') return null;
    const data = await readFile(attachment.storageRef); return `data:${attachment.mimeType};base64,${data.toString('base64')}`;
  });
  ipcMain.handle('analysis:list', (_event, conversationId: string) => database.listAnalysisRuns(conversationId));
  ipcMain.handle('models:list', async () => {
    try { return await backend.getModels(); }
    catch (error) { log('backend.models.failed', { backend: selectedBackend, message: error instanceof Error ? error.message : String(error) }); return []; }
  });
  ipcMain.handle('settings:get', () => ({ selectedBackend, ollamaUrl: 'http://127.0.0.1:11434', llamaServerPath: selectedBackend === 'llama-cpp' ? process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? null : null, ...(selectedBackend === 'llama-cpp' ? { llamaRuntimeModelId } : {}), modelsPath: paths.models }));
  ipcMain.handle('hardware:get', getHardwareStats);
  ipcMain.handle('dialog:chooseDirectory', async (_event, initialDirectory?: string | null) => {
    const window = BrowserWindow.getFocusedWindow();
    const defaultPath = await existingProjectDirectory(initialDirectory);
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId: string, generationId?: string) => { await cancelGeneration(conversationId, generationId, 'user_stop'); });
  ipcMain.handle('chat:approve', (_event, request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }) => {
    const pending = pendingApprovals.get(request.approvalId);
    if (!['reject', 'once', 'session'].includes(request.decision) || !pending || pending.conversationId !== request.conversationId || pending.generation.id !== request.generationId || activeGenerations.get(request.conversationId) !== pending.generation || pending.generation.abort.signal.aborted) return false;
    if (request.decision === 'session') {
      const session = sessionApprovals.get(pending.conversationId);
      const categories = session?.root === pending.root ? session.categories : new Set<RiskCategory>();
      categories.add(pending.category);
      sessionApprovals.set(pending.conversationId, { root: pending.root, categories });
    }
    const approved = request.decision !== 'reject';
    settleApproval(pending, approved ? { approved: true, reason: request.decision === 'session' ? 'session' : 'once' } : { approved: false, reason: 'user_rejected' }, approved ? request.decision === 'session' ? 'session-approved' : 'approved' : 'rejected');
    return true;
  });
  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {
    await cancelGeneration(request.conversationId, undefined, 'superseded');
    const abort = new AbortController(); let finish!: () => void;
    const generation: ActiveGeneration = { id: request.generationId, abort, settled: new Promise<void>((resolve) => { finish = resolve; }), finish };
    activeGenerations.set(request.conversationId, generation);
    const current = () => activeGenerations.get(request.conversationId) === generation && !abort.signal.aborted;
    let run: AnalysisRun | null = null;
    try {
    const user = request.persistUserMessage ? request.messages.at(-1) : null;
    if (request.persistUserMessage && (!user || user.role !== 'user')) throw new Error('Неверное сообщение');
    const conversation = database.getConversation(request.conversationId);
    if (!conversation) throw new Error('Чат не найден');
    const mode = executionMode(conversation.mode, request.mode);
    if (conversation.modelId && conversation.modelId !== request.model) throw new Error('Выбранная модель была изменена. Повторите отправку сообщения.');
    const primaryProject = conversation.workingDirectory && conversation.primaryProjectId ? { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 — ${projectDirectoryName(conversation.workingDirectory)}` } : null;
    const selectedProjects: AgentProject[] = primaryProject ? [primaryProject, ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 — ${projectDirectoryName(conversation.secondaryWorkingDirectory)}` }] : [])] : [];
    const validReferences = (references: ProjectReference[] | undefined): ProjectReference[] => (references ?? []).filter((reference) => selectedProjects.some((project) => project.id === reference.projectId && project.slot === reference.projectSlot && project.root === reference.projectPath) && (reference.kind === 'file' || reference.kind === 'folder') && Boolean(reference.relativePath));
    if (user) { user.projectReferences = validReferences(user.projectReferences); database.addMessage(request.conversationId, 'user', user.content, user.id, user.projectReferences); }
    const emitAttachment = (chunk: import('../../shared/types').StreamEvent) => event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
    const attachmentIds = [...(request.attachmentIds ?? [])];
    if (user) {
      for (const input of request.attachments ?? []) {
        if (input.messageId !== user.id) throw new Error('Вложение относится к другому сообщению');
        try { const attachment = await attachments.import(input); attachmentIds.push(attachment.id); }
        catch (error) { emitAttachment({ type: 'attachment', activity: { id: `attachment-${input.id ?? randomUUID()}`, label: input.filename, detail: `✕ ${error instanceof Error ? error.message : String(error)}`, status: 'error' } }); }
      }
    }
    if (!current()) return;
    // Ollama advertises capabilities with the installed tag. This governs routing
    // for every image turn in the active history, rather than guessing from names.
    const hasImages = database.listAttachmentsForConversation(request.conversationId).some((attachment) => attachment.kind === 'image');
    const requestUser = user ?? [...request.messages].reverse().find((message) => message.role === 'user');
    const retryAttachmentIds = requestUser ? database.listAttachments(requestUser.id).filter((attachment) => attachment.status === 'pending' || attachment.status === 'cancelled').map((attachment) => attachment.id) : [];
    const nativeImagesRequested = attachmentPipeline.hasNativeImagesForRequest(request.messages);
    const nativeVision = nativeImagesRequested && await backend.supportsVision(request.model, abort.signal);
    const preprocessIds = [...new Set([...attachmentIds, ...retryAttachmentIds])];
    log('attachment.vision-routing', { generationId: generation.id, modelId: request.model, hasImages, nativeImagesRequested, route: nativeVision ? 'native' : nativeImagesRequested ? 'unsupported' : hasImages ? 'deferred' : 'none' });
    if (preprocessIds.length) await attachmentPipeline.preprocessCurrent(preprocessIds, abort.signal, emitAttachment, nativeVision);
    if (!current()) return;
    await backend.ensureModelAvailable(request.model);
    if (!current()) return;
    let output = ''; let thinking = ''; let messageDiagnostics: import('../../shared/types').GenerationDiagnostics | undefined; let completed = false; let failed = false; let finishReason: 'stop' | 'length' = 'stop';
    const thinkingTimeline: ThinkingTimelineEvent[] = []; const activityTimelinePositions = new Map<string, number>(); let timelinePosition = 0; let lastTimelineKind: ThinkingTimelineEvent['kind'] | null = null;
    const agentProjects: AgentProject[] = mode === 'agent' ? [...selectedProjects] : [];
    const agentRoot = agentProjects[0]?.root ?? null;
    const enabledTools = mode === 'agent' ? [taskNotesToolDefinition.function.name, agentPlanToolDefinition.function.name, reportProgressToolDefinition.function.name, terminalToolDefinition.function.name, ...(agentProjects.length ? projectToolDefinitions.map((tool) => tool.function.name) : []), ...(conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [])] : conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [];
    log('generation.snapshot', { generationId: generation.id, chatId: request.conversationId, mode, storedMode: conversation.mode, requestedMode: request.mode, workingDirectory: conversation.workingDirectory, resolvedWorkingDirectory: agentRoot, projects: agentProjects.map((project) => ({ id: project.id, slot: project.slot })), webMode: conversation.webMode, modelId: request.model, contextSize: conversation.contextWindow, reasoningMode: conversation.reasoningMode, enabledTools });
    run = mode === 'agent' ? database.createAnalysisRun(request.conversationId, conversation.reasoningMode) : null;
    if (run && current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run });
      const context = await backend.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (!current()) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, generationId: generation.id, ...context });
      // Image descriptions are excluded for native-vision requests: the original
      // image payload is attached only to its owning user turn below.
      let history = attachmentPipeline.buildContext(request.messages, !hasImages);
      if (nativeVision) history = await attachmentPipeline.prepareNativeImages(history, abort.signal);
      const stream = mode === 'agent'
        ? projectChat.stream(request.model, history, agentProjects, abort.signal, context.active, conversation.reasoningMode, conversation.webMode, inlineConfirmation(event, request.conversationId, generation, agentRoot ?? homedir()), { generationId: generation.id, conversationId: request.conversationId })
        : conversation.webMode === 'auto'
          ? webChat.stream(request.model, history, abort.signal, context.active, conversation.reasoningMode)
          : backend.streamChat(request.model, chatMessagesWithSystemPrefix(history, [chatSystemContext({ webAvailable: false }, conversation.reasoningMode === 'deep' ? 'deep' : 'fast')], request.conversationId, `capability-${request.conversationId}`), abort.signal, context.active, conversation.reasoningMode);
      for await (let chunk of stream) {
        if (!current()) break;
        if (chunk.type === 'token') output += chunk.content;
        if (chunk.type === 'thinking') {
          thinking += chunk.content;
          if (mode === 'agent') {
            if (lastTimelineKind !== 'reasoning') { timelinePosition += 1; thinkingTimeline.push({ id: randomUUID(), kind: 'reasoning', content: chunk.content, position: timelinePosition }); lastTimelineKind = 'reasoning'; }
            else { const entry = thinkingTimeline.at(-1); if (entry?.kind === 'reasoning') entry.content += chunk.content; }
            chunk = { ...chunk, timelinePosition };
          }
        }
        if (chunk.type === 'context-usage') {
          database.setContextUsage(request.conversationId, request.model, chunk.used);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id, modelId: request.model });
          continue;
        }
        if (chunk.type === 'diagnostics') {
          const diagnostics = { ...chunk.diagnostics, generationId: generation.id, conversationId: request.conversationId, createdAt: new Date().toISOString() };
          messageDiagnostics = diagnostics;
          saveGenerationDiagnosticsBestEffort((value) => database.saveGenerationDiagnostics(value), diagnostics);
          log('generation.diagnostics', diagnostics);
          event.sender.send('chat:stream', { type: 'diagnostics', conversationId: request.conversationId, generationId: generation.id, diagnostics });
          continue;
        }
        if (chunk.type === 'done') { completed = true; finishReason = chunk.finishReason === 'length' ? 'length' : 'stop'; continue; }
        if (chunk.type === 'error') failed = true;
        if (run && chunk.type === 'tool') {
          const existingPosition = activityTimelinePositions.get(chunk.activity.id);
          const position = existingPosition ?? (timelinePosition += 1);
          if (existingPosition === undefined) { activityTimelinePositions.set(chunk.activity.id, position); thinkingTimeline.push({ id: randomUUID(), kind: 'activity', activityId: chunk.activity.id, position }); }
          lastTimelineKind = 'activity';
          const activity = { ...chunk.activity, timelinePosition: position };
          const updated = database.addAnalysisAction(run.id, activity);
          const visibleActivity = { ...activity };
          delete visibleActivity.rawOutput;
          event.sender.send('chat:stream', { ...chunk, activity: visibleActivity, runId: run.id, conversationId: request.conversationId, generationId: generation.id });
          event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: updated });
        } else event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
      }
      if (!current()) { if (run) database.finishAnalysisRun(run.id, 'cancelled', null); return; }
      if (failed || !completed) { if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: database.finishAnalysisRun(run.id, 'error', null) }); return; }
      const inputTokens = messageDiagnostics?.promptEvalCount ?? messageDiagnostics?.inputTokens;
      const generationStats = messageDiagnostics?.evalCount === undefined ? undefined : {
        outputTokens: messageDiagnostics.evalCount,
        ...(messageDiagnostics.tokensPerSecond !== undefined ? { tokensPerSecond: messageDiagnostics.tokensPerSecond } : {}),
        ...(messageDiagnostics.evalDuration !== undefined ? { generationDurationMs: messageDiagnostics.evalDuration / 1_000_000 } : {}),
        ...(messageDiagnostics.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: messageDiagnostics.timeToFirstTokenMs } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      };
      const assistant = output ? database.addMessage(request.conversationId, 'assistant', output, undefined, [], { ...(thinking.trim() ? { thinking } : {}), ...(thinkingTimeline.length ? { thinkingTimeline } : {}), ...(generationStats ? { generationStats } : {}) }) : null;
      if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: database.finishAnalysisRun(run.id, 'completed', assistant?.id ?? null) });
      event.sender.send('chat:stream', { type: 'done', conversationId: request.conversationId, generationId: generation.id, assistant, finishReason });
    } catch (error) {
      log('generation.failed', { generationId: generation.id, conversationId: request.conversationId, model: request.model, ...ollamaErrorDiagnostics(error) });
      if (run) { const finished = database.finishAnalysisRun(run.id, abort.signal.aborted ? 'cancelled' : 'error', null); if (current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: finished }); }
      if (current()) event.sender.send('chat:stream', { type: 'error', conversationId: request.conversationId, generationId: generation.id, message: 'Не удалось выполнить запрос', details: error instanceof Error ? error.message : String(error) });
    } finally {
      if (activeGenerations.get(request.conversationId) === generation) {
        activeGenerations.delete(request.conversationId);
        if (abort.signal.aborted) event.sender.send('chat:stream', { type: 'cancelled', conversationId: request.conversationId, generationId: generation.id });
      }
      generation.finish();
    }
  });
}
