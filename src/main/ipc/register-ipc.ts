import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { AnalysisRun, ChatRequest, Conversation } from '../../shared/types';
import { Database } from '../services/database';
import { getHardwareStats } from '../services/hardware';
import { OllamaBackend } from '../backends/ollama-backend';
import { ProjectChatService } from '../services/project-chat';
import { paths } from '../services/paths';
import { log } from '../services/logger';
import { contextPresetsFor, getModelProfile, modelRegistry } from '../models/model-registry';
import { WebBrowserService } from '../web/web-tools';
import { webToolDefinitions } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { capabilitySystemContext } from '../services/capabilities';
import { projectToolDefinitions, type ConfirmAction } from '../tools/project-tools';

const database = new Database();
const ollama = new OllamaBackend();
const web = new WebBrowserService();
const confirmAgentAction: ConfirmAction = async (request, signal) => {
  if (signal.aborted) return false;
  const options = { type: 'warning' as const, buttons: ['Разрешить', 'Отмена'], defaultId: 1, cancelId: 1, title: request.title, message: 'Agent запрашивает действие с повышенным риском', detail: request.detail, noLink: true };
  const owner = BrowserWindow.getFocusedWindow(); const answer = (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options)).then((result) => result.response === 0);
  const cancelled = new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }));
  return (await Promise.race([answer, cancelled])) && !signal.aborted;
};
const projectChat = new ProjectChatService(ollama, web, confirmAgentAction);
const webChat = new WebChatService(ollama, web);
type ActiveGeneration = { id: string; abort: AbortController; settled: Promise<void>; finish: () => void };
const activeGenerations = new Map<string, ActiveGeneration>();

async function cancelGeneration(conversationId: string, generationId?: string): Promise<void> {
  const active = activeGenerations.get(conversationId);
  if (!active || (generationId && active.id !== generationId)) return;
  active.abort.abort(); await active.settled;
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
    if (patch.modelId !== undefined && patch.modelId !== current.modelId) database.setContextUsage(id, null, null);
    if (patch.modelId !== undefined && patch.modelId !== current.modelId && current.modelId) void ollama.unloadModel(current.modelId);
    return database.getConversation(id) ?? updated;
  });
  ipcMain.handle('conversations:delete', (_event, id: string) => database.deleteConversation(id));
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
  ipcMain.handle('messages:edit', async (_event, messageId: string, content: string, fallback?: { conversationId: string; content: string }) => {
    const message = database.getMessage(messageId) ?? (fallback ? database.findUserMessage(fallback.conversationId, fallback.content) : null); if (!message) throw new Error('Сообщение не найдено');
    await cancelGeneration(message.conversationId); return database.editUserMessageAndTruncate(message.id, content);
  });
  ipcMain.handle('analysis:list', (_event, conversationId: string) => database.listAnalysisRuns(conversationId));
  ipcMain.handle('models:list', async () => {
    try { return await ollama.getModels(); }
    catch (error) { log('ollama.models.failed', error instanceof Error ? { message: error.message } : undefined); return []; }
  });
  ipcMain.handle('settings:get', () => ({ selectedBackend: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', llamaServerPath: null, modelsPath: paths.models }));
  ipcMain.handle('hardware:get', getHardwareStats);
  ipcMain.handle('dialog:chooseDirectory', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId: string, generationId?: string) => { await cancelGeneration(conversationId, generationId); });
  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {
    await cancelGeneration(request.conversationId);
    const abort = new AbortController(); let finish!: () => void;
    const generation: ActiveGeneration = { id: request.generationId, abort, settled: new Promise<void>((resolve) => { finish = resolve; }), finish };
    activeGenerations.set(request.conversationId, generation);
    const current = () => activeGenerations.get(request.conversationId) === generation && !abort.signal.aborted;
    let run: AnalysisRun | null = null;
    try {
    const user = request.messages.at(-1);
    if (!user || user.role !== 'user') throw new Error('Неверное сообщение');
    const conversation = database.getConversation(request.conversationId);
    if (!conversation) throw new Error('Чат не найден');
    if (conversation.modelId && conversation.modelId !== request.model) throw new Error('Выбранная модель была изменена. Повторите отправку сообщения.');
    await ollama.ensureModelAvailable(request.model);
    if (!current()) return;
    if (request.persistUserMessage) database.addMessage(request.conversationId, 'user', user.content, user.id);
    let output = ''; let completed = false; let failed = false;
    const agentRoot = conversation.mode === 'agent' ? conversation.workingDirectory ?? paths.root : null;
    const enabledTools = agentRoot ? [...projectToolDefinitions.map((tool) => tool.function.name), ...(conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [])] : conversation.webMode === 'auto' ? webToolDefinitions.map((tool) => tool.function.name) : [];
    log('generation.snapshot', { generationId: generation.id, chatId: request.conversationId, mode: conversation.mode, workingDirectory: conversation.workingDirectory, resolvedWorkingDirectory: agentRoot, webMode: conversation.webMode, modelId: request.model, contextSize: conversation.contextWindow, reasoningLevel: conversation.analysisDepth, enabledTools });
    run = agentRoot ? database.createAnalysisRun(request.conversationId, conversation.analysisDepth) : null;
    if (run && current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run });
      const context = await ollama.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (!current()) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, generationId: generation.id, ...context });
      const stream = agentRoot
        ? projectChat.stream(request.model, request.messages, agentRoot, abort.signal, context.active, conversation.analysisDepth, conversation.webMode)
        : conversation.webMode === 'auto'
          ? webChat.stream(request.model, request.messages, abort.signal, context.active, conversation.analysisDepth)
          : ollama.streamChat(request.model, [{ id: `capability-${request.conversationId}`, conversationId: request.conversationId, role: 'system', content: capabilitySystemContext({ webAvailable: false }), createdAt: new Date().toISOString() }, ...request.messages], abort.signal, context.active, conversation.analysisDepth);
      for await (const chunk of stream) {
        if (!current()) break;
        if (chunk.type === 'token') output += chunk.content;
        if (chunk.type === 'context-usage') {
          database.setContextUsage(request.conversationId, request.model, chunk.used);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id, modelId: request.model });
          continue;
        }
        if (chunk.type === 'done') { completed = true; continue; }
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
      event.sender.send('chat:stream', { type: 'done', conversationId: request.conversationId, generationId: generation.id, assistant });
    } catch (error) {
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
