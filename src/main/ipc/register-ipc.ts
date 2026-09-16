import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ApprovalDecision, ApprovalStatus, ChatRequest, Conversation, RiskCategory } from '../../shared/types';
import { Database } from '../services/database';
import { getHardwareStats } from '../services/hardware';
import { OllamaBackend } from '../backends/ollama-backend';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { ProjectChatService } from '../services/project-chat';
import { paths } from '../services/paths';
import { log } from '../services/logger';
import { contextPresetsFor, getModelProfile, modelRegistry } from '../models/model-registry';
import { WebBrowserService } from '../web/web-tools';
import { webToolDefinitions } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { capabilitySystemContext } from '../services/capabilities';
import { projectToolDefinitions, type ApprovalResult, type ConfirmAction } from '../tools/project-tools';
import { AttachmentService } from '../services/attachment-service';
import { AttachmentPipeline } from '../services/attachment-pipeline';
import { readFile } from 'node:fs/promises';
import { ollamaErrorDiagnostics } from '../backends/ollama-errors';
import { saveGenerationDiagnosticsBestEffort } from '../services/generation-diagnostics';
import { taskNotesToolDefinition } from '../services/task-notes';
import { agentPlanToolDefinition } from '../services/agent-plan';

const database = new Database();
const selectedBackend = process.env.LOCAL_AI_BACKEND === 'llama-cpp' ? 'llama-cpp' : 'ollama';
const ollama = new OllamaBackend();
const llamaCpp = new LlamaCppBackend(process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081', 65_536, process.env.LOCAL_AI_LLAMA_CPP_VISION === '1');
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

async function cancelGeneration(conversationId: string, generationId?: string): Promise<void> {
  const active = activeGenerations.get(conversationId);
  if (!active || (generationId && active.id !== generationId)) return;
  active.abort.abort(); await active.settled;
}

function inlineConfirmation(event: Electron.IpcMainInvokeEvent, conversationId: string, generation: ActiveGeneration, root: string): ConfirmAction {
  const emit = (payload: Record<string, unknown>) => event.sender.send('chat:stream', payload);
  return async (request, signal) => {
    if (signal.aborted || activeGenerations.get(conversationId) !== generation) return { approved: false, reason: 'cancelled' };
    const session = sessionApprovals.get(conversationId);
    if (session?.root === root && session.categories.has(request.category)) {
      emit({ type: 'approval-resolved', conversationId, generationId: generation.id, actionId: request.actionId, approvalId: `session-${randomUUID()}`, status: 'session-approved' });
      return { approved: true, reason: 'session' };
    }
    const approvalId = randomUUID();
    return new Promise<ApprovalResult>((resolve) => {
      const abort = () => settleApproval(pending, { approved: false, reason: 'cancelled' }, 'rejected');
      const pending: PendingApproval = { approvalId, conversationId, generation, actionId: request.actionId, category: request.category, root, resolve, settled: false, abort, emit };
      pendingApprovals.set(approvalId, pending);
      signal.addEventListener('abort', abort, { once: true });
      emit({ type: 'approval-request', conversationId, generationId: generation.id, actionId: request.actionId, approval: { approvalId, category: request.category, status: 'pending' } });
    });
  };
}

export function registerIpc(): void {
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', (_event, requestedModelId?: string) => {
    const modelId = requestedModelId ?? modelRegistry[0].id;
    if (!getModelProfile(modelId)) throw new Error('Выбранная модель отсутствует в реестре приложения');
    return database.createConversation(modelId);
  });
  ipcMain.handle('conversations:update', async (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'contextWindow' | 'analysisDepth' | 'webMode'>>) => {
    const current = database.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const nextModelId = patch.modelId ?? current.modelId;
    const profile = nextModelId ? getModelProfile(nextModelId) : undefined;
    if (nextModelId && !profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const allowed = profile ? contextPresetsFor(profile.maxContext) : [];
    const requestedContext = patch.contextWindow ?? current.contextWindow;
    const contextWindow = allowed.length && !allowed.includes(requestedContext) ? allowed.at(-1)! : requestedContext;
    const updated = database.updateConversation(id, { ...patch, contextWindow });
    if (patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) sessionApprovals.delete(id);
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
  ipcMain.handle('settings:get', () => ({ selectedBackend, ollamaUrl: 'http://127.0.0.1:11434', llamaServerPath: selectedBackend === 'llama-cpp' ? process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? null : null, modelsPath: paths.models }));
  ipcMain.handle('hardware:get', getHardwareStats);
  ipcMain.handle('dialog:chooseDirectory', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId: string, generationId?: string) => { await cancelGeneration(conversationId, generationId); });
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
    await cancelGeneration(request.conversationId);
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
    if (conversation.modelId && conversation.modelId !== request.model) throw new Error('Выбранная модель была изменена. Повторите отправку сообщения.');
    if (user) database.addMessage(request.conversationId, 'user', user.content, user.id);
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
    const nativeVision = hasImages && await backend.supportsVision(request.model, abort.signal);
    const preprocessIds = hasImages ? [...new Set([...attachmentIds, ...database.listAttachmentsForConversation(request.conversationId).filter((attachment) => attachment.kind === 'image' && !attachment.visionAnalysis).map((attachment) => attachment.id)])] : attachmentIds;
    log('attachment.vision-routing', { generationId: generation.id, modelId: request.model, hasImages, route: nativeVision ? 'native' : hasImages ? 'unsupported' : 'none' });
    if (preprocessIds.length) await attachmentPipeline.preprocessCurrent(preprocessIds, abort.signal, emitAttachment, nativeVision);
    if (!current()) return;
    await backend.ensureModelAvailable(request.model);
    if (!current()) return;
    let output = ''; let completed = false; let failed = false; let finishReason: 'stop' | 'length' = 'stop';
    const agentRoot = conversation.mode === 'agent' ? conversation.workingDirectory ?? paths.root : null;
    const enabledTools = agentRoot ? [taskNotesToolDefinition.function.name, agentPlanToolDefinition.function.name, ...projectToolDefinitions.map((tool) => tool.function.name), ...(conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [])] : conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [];
    log('generation.snapshot', { generationId: generation.id, chatId: request.conversationId, mode: conversation.mode, workingDirectory: conversation.workingDirectory, resolvedWorkingDirectory: agentRoot, webMode: conversation.webMode, modelId: request.model, contextSize: conversation.contextWindow, reasoningPreset: conversation.analysisDepth, enabledTools });
    run = agentRoot ? database.createAnalysisRun(request.conversationId, conversation.analysisDepth) : null;
    if (run && current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run });
      const context = await backend.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (!current()) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, generationId: generation.id, ...context });
      // Image descriptions are excluded for native-vision requests: the original
      // image payload is attached only to its owning user turn below.
      let history = attachmentPipeline.buildContext(request.messages, !nativeVision);
      if (nativeVision) history = await attachmentPipeline.prepareNativeImages(history, abort.signal);
      const stream = agentRoot
        ? projectChat.stream(request.model, history, agentRoot, abort.signal, context.active, conversation.analysisDepth, conversation.webMode, inlineConfirmation(event, request.conversationId, generation, agentRoot), { generationId: generation.id, conversationId: request.conversationId })
        : conversation.webMode === 'auto'
          ? webChat.stream(request.model, history, abort.signal, context.active, conversation.analysisDepth)
          : backend.streamChat(request.model, [{ id: `capability-${request.conversationId}`, conversationId: request.conversationId, role: 'system', content: capabilitySystemContext({ webAvailable: false }), createdAt: new Date().toISOString() }, ...history], abort.signal, context.active, conversation.analysisDepth);
      for await (const chunk of stream) {
        if (!current()) break;
        if (chunk.type === 'token') output += chunk.content;
        if (chunk.type === 'context-usage') {
          database.setContextUsage(request.conversationId, request.model, chunk.used);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id, modelId: request.model });
          continue;
        }
        if (chunk.type === 'diagnostics') {
          const diagnostics = { ...chunk.diagnostics, generationId: generation.id, conversationId: request.conversationId, createdAt: new Date().toISOString() };
          saveGenerationDiagnosticsBestEffort((value) => database.saveGenerationDiagnostics(value), diagnostics);
          log('generation.diagnostics', diagnostics);
          event.sender.send('chat:stream', { type: 'diagnostics', conversationId: request.conversationId, generationId: generation.id, diagnostics });
          continue;
        }
        if (chunk.type === 'done') { completed = true; finishReason = chunk.finishReason === 'length' ? 'length' : 'stop'; continue; }
        if (chunk.type === 'error') failed = true;
        if (run && chunk.type === 'tool') {
          const updated = database.addAnalysisAction(run.id, chunk.activity);
          event.sender.send('chat:stream', { ...chunk, runId: run.id, conversationId: request.conversationId, generationId: generation.id });
          event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: updated });
        } else event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
      }
      if (!current()) { if (run) database.finishAnalysisRun(run.id, 'cancelled', null); return; }
      if (failed || !completed) { if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: database.finishAnalysisRun(run.id, 'error', null) }); return; }
      const assistant = output ? database.addMessage(request.conversationId, 'assistant', output) : null;
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
