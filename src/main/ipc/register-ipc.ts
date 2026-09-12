import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { ChatRequest, Conversation } from '../../shared/types';
import { Database } from '../services/database';
import { getHardwareStats } from '../services/hardware';
import { OllamaBackend } from '../backends/ollama-backend';
import { ProjectChatService } from '../services/project-chat';
import { paths } from '../services/paths';
import { log } from '../services/logger';

const database = new Database();
const ollama = new OllamaBackend();
const projectChat = new ProjectChatService(ollama);
let activeAbort: AbortController | null = null;

export function registerIpc(): void {
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', () => database.createConversation());
  ipcMain.handle('conversations:update', (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'contextWindow' | 'analysisDepth'>>) => database.updateConversation(id, patch));
  ipcMain.handle('conversations:delete', (_event, id: string) => database.deleteConversation(id));
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
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
  ipcMain.handle('chat:stop', () => { activeAbort?.abort(); });
  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {
    if (activeAbort) activeAbort.abort();
    const abort = new AbortController(); activeAbort = abort;
    const user = request.messages.at(-1);
    if (!user || user.role !== 'user') throw new Error('Неверное сообщение');
    const conversation = database.getConversation(request.conversationId);
    if (!conversation) throw new Error('Чат не найден');
    database.addMessage(request.conversationId, 'user', user.content);
    let output = '';
    const run = conversation.workingDirectory ? database.createAnalysisRun(request.conversationId, conversation.analysisDepth) : null;
    if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, run });
    try {
      const context = await ollama.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (abort.signal.aborted) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, ...context });
      const stream = conversation.workingDirectory
        ? projectChat.stream(request.model, request.messages, conversation.workingDirectory, abort.signal, context.active, conversation.analysisDepth)
        : ollama.streamChat(request.model, request.messages, abort.signal, context.active);
      for await (const chunk of stream) {
        if (chunk.type === 'token') output += chunk.content;
        if (run && chunk.type === 'tool') {
          const updated = database.addAnalysisAction(run.id, chunk.activity);
          event.sender.send('chat:stream', { ...chunk, runId: run.id, conversationId: request.conversationId });
          event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, run: updated });
        } else event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId });
      }
      const assistant = output ? database.addMessage(request.conversationId, 'assistant', output) : null;
      if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, run: database.finishAnalysisRun(run.id, abort.signal.aborted ? 'cancelled' : 'completed', assistant?.id ?? null) });
    } catch (error) {
      if (run) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, run: database.finishAnalysisRun(run.id, abort.signal.aborted ? 'cancelled' : 'error', null) });
      if (!abort.signal.aborted) event.sender.send('chat:stream', { type: 'error', conversationId: request.conversationId, message: 'Не удалось проанализировать проект', details: error instanceof Error ? error.message : String(error) });
    } finally { if (activeAbort === abort) activeAbort = null; }
  });
}
