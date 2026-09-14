import { create } from 'zustand';
import type { AnalysisProgress, AnalysisRun, ChatMessage, Conversation, FinishReason, GenerationDiagnostics, HardwareStats, ModelInfo, ToolActivity } from '../../shared/types';

type State = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  models: ModelInfo[];
  hardware: HardwareStats | null;
  isGenerating: boolean;
  generationId: string | null;
  generationState: 'idle' | 'thinking' | 'using-tool' | 'running-terminal' | 'generating' | 'stopping' | 'cancelled' | 'error';
  error: string | null;
  toolActivities: ToolActivity[];
  toolActivityCount: number;
  activeContextWindow: number | null;
  analysisProgress: AnalysisProgress[];
  analysisRuns: AnalysisRun[];
  lastFinishReason: FinishReason | null;
  performance: GenerationDiagnostics | null;
  initialize: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  createConversation: () => Promise<void>;
  updateConversation: (id: string, patch: Partial<Conversation>) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshHardware: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  continueGeneration: () => Promise<void>;
  editMessage: (message: ChatMessage, content: string) => Promise<boolean>;
  stop: () => Promise<void>;
  handleStream: (event: { type: string; content?: string; message?: string; details?: string; activity?: ToolActivity; run?: AnalysisRun; progress?: AnalysisProgress; requested?: number; active?: number; supported?: number; used?: number; maximum?: number; conversationId: string; generationId: string; modelId?: string; assistant?: ChatMessage | null; finishReason?: FinishReason; diagnostics?: Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt'> }) => void;
};

const assistantId = (generationId: string) => `stream-${generationId}`;
const now = () => new Date().toISOString();

export const useAppStore = create<State>((set, get) => {
  const pendingTokens = new Map<string, string>();
  let animationFrame: number | null = null;
  const flushTokens = () => {
    animationFrame = null;
    if (pendingTokens.size === 0) return;
    const tokens = new Map(pendingTokens); pendingTokens.clear();
    set((state) => ({ messages: state.messages.map((message) => {
      const token = tokens.get(get().generationId ?? '');
      return token && message.id === assistantId(get().generationId ?? '') ? { ...message, content: message.content + token } : message;
    }) }));
  };
  return {
  conversations: [], activeId: null, messages: [], models: [], hardware: null, isGenerating: false, generationId: null, generationState: 'idle', error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: null, analysisProgress: [], analysisRuns: [], lastFinishReason: null, performance: null,
  initialize: async () => {
    const [conversations, models] = await Promise.all([window.localAi.conversations.list(), window.localAi.models.list()]);
    set({ conversations, models });
    if (conversations[0]) await get().selectConversation(conversations[0].id);
    else await get().createConversation();
    await get().refreshHardware();
  },
  selectConversation: async (id) => { if (get().activeId !== id && get().generationId) await get().stop(); const [messages, analysisRuns] = await Promise.all([window.localAi.messages.list(id), window.localAi.analysis.list(id)]); const conversation = get().conversations.find((item) => item.id === id); set({ activeId: id, messages, analysisRuns, isGenerating: false, generationId: null, generationState: 'idle', error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: conversation?.contextWindow ?? null, analysisProgress: [], lastFinishReason: null, performance: null }); },
  createConversation: async () => {
    const activeChat = get().conversations.find((chat) => chat.id === get().activeId);
    const conversation = await window.localAi.conversations.create(activeChat?.modelId ?? get().models[0]?.id);
    set((state) => ({ conversations: [conversation, ...state.conversations] })); await get().selectConversation(conversation.id);
  },
  updateConversation: async (id, patch) => {
    const updated = await window.localAi.conversations.update(id, patch);
    set((state) => ({ conversations: state.conversations.map((chat) => chat.id === id ? updated : chat), activeContextWindow: state.activeId === id ? updated.contextWindow : state.activeContextWindow, performance: state.activeId === id && patch.modelId !== undefined ? null : state.performance }));
  },
  deleteConversation: async (id) => {
    await window.localAi.conversations.delete(id);
    const remaining = get().conversations.filter((item) => item.id !== id);
    set({ conversations: remaining, activeId: null, messages: [] });
    if (remaining[0]) await get().selectConversation(remaining[0].id); else await get().createConversation();
  },
  refreshHardware: async () => set({ hardware: await window.localAi.hardware.get() }),
  sendMessage: async (content) => {
    if (get().generationId) await get().stop();
    const { activeId, conversations, messages, models } = get();
    if (!activeId || !content.trim()) return;
    const chat = conversations.find((item) => item.id === activeId); const model = chat?.modelId ?? models[0]?.id;
    if (!model) { set({ error: 'Нет доступных моделей. Запустите Ollama и загрузите модель.' }); return; }
    const user: ChatMessage = { id: crypto.randomUUID(), conversationId: activeId, role: 'user', content: content.trim(), createdAt: now() };
    const generationId = crypto.randomUUID(); const streaming: ChatMessage = { id: assistantId(generationId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    set({ messages: [...messages, user, streaming], isGenerating: true, generationId, generationState: 'thinking', error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [], lastFinishReason: null, performance: null });
    if (!chat?.modelId) await get().updateConversation(activeId, { modelId: model });
    if (chat?.title === 'Новый чат') await get().updateConversation(activeId, { title: content.trim().slice(0, 56) });
    try { await window.localAi.chat.send({ conversationId: activeId, model, messages: [...messages, user], generationId, persistUserMessage: true }); }
    catch (error) { set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'error', error: error instanceof Error ? error.message : 'Не удалось отправить сообщение', messages: state.messages.filter((message) => message.id !== assistantId(generationId)) } : {}); }
  },
  continueGeneration: async () => {
    const { activeId, conversations, messages, models, isGenerating, lastFinishReason } = get();
    if (!activeId || isGenerating || lastFinishReason !== 'length') return;
    const chat = conversations.find((item) => item.id === activeId); const model = chat?.modelId ?? models[0]?.id;
    if (!model) return;
    const generationId = crypto.randomUUID(); const streaming: ChatMessage = { id: assistantId(generationId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    const continuation: ChatMessage = { id: `continue-${generationId}`, conversationId: activeId, role: 'system', content: 'Продолжи предыдущий ответ с места остановки. Не повторяй уже сказанное; начни с следующей незавершённой мысли.', createdAt: now() };
    set({ messages: [...messages, streaming], isGenerating: true, generationId, generationState: 'thinking', error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [], lastFinishReason: null, performance: null });
    try { await window.localAi.chat.send({ conversationId: activeId, model, messages: [...messages, continuation], generationId, persistUserMessage: false }); }
    catch (error) { set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'error', error: error instanceof Error ? error.message : 'Не удалось продолжить ответ', messages: state.messages.filter((message) => message.id !== assistantId(generationId)) } : {}); }
  },
  editMessage: async (message, content) => {
    if (get().generationId) await get().stop();
    let saved: ChatMessage[];
    try { saved = await window.localAi.messages.edit(message.id, content, { conversationId: message.conversationId, content: message.content }); }
    catch (error) { set({ error: error instanceof Error ? error.message : 'Не удалось сохранить изменение' }); return false; }
    const activeId = get().activeId; const chat = get().conversations.find((item) => item.id === activeId); const model = chat?.modelId ?? get().models[0]?.id;
    if (!activeId || !chat || !model) return false;
    const generationId = crypto.randomUUID(); const streaming: ChatMessage = { id: assistantId(generationId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    set({ messages: [...saved, streaming], isGenerating: true, generationId, generationState: 'thinking', error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [], lastFinishReason: null, performance: null });
    try { await window.localAi.chat.send({ conversationId: activeId, model, messages: saved, generationId, persistUserMessage: false }); }
    catch (error) { set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'error', error: error instanceof Error ? error.message : 'Не удалось перегенерировать ответ', messages: state.messages.filter((message) => message.id !== assistantId(generationId)) } : {}); }
    return true;
  },
  stop: async () => { const { activeId, generationId } = get(); if (!activeId || !generationId) return; set({ generationState: 'stopping' }); await window.localAi.chat.stop(activeId, generationId); set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'cancelled', messages: state.messages.filter((message) => message.id !== assistantId(generationId)), performance: null } : {}); },
  handleStream: (event) => {
    if (event.type === 'context-usage' && typeof event.used === 'number') {
      const used = event.used;
      set((state) => ({ conversations: state.conversations.map((chat) => chat.id === event.conversationId ? { ...chat, contextTokens: used, contextModelId: event.modelId ?? chat.modelId } : chat) }));
    }
    if (event.conversationId !== get().activeId || event.generationId !== get().generationId) return;
    if (event.type === 'token') {
      pendingTokens.set(event.generationId, (pendingTokens.get(event.generationId) ?? '') + (event.content ?? ''));
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(flushTokens);
    }
    if (event.type === 'tool' && event.activity) set((state) => ({ generationState: event.activity!.label === 'Запуск terminal' ? 'running-terminal' : 'using-tool', toolActivities: [...state.toolActivities, event.activity!].slice(-40), toolActivityCount: state.toolActivityCount + 1 }));
    if (event.type === 'analysis-run' && event.run) set((state) => ({ analysisRuns: [...state.analysisRuns.filter((run) => run.id !== event.run!.id), event.run!] }));
    if (event.type === 'analysis' && event.progress) set({ analysisProgress: [event.progress] });
    if (event.type === 'context' && event.active) set({ activeContextWindow: event.active });
    if (event.type === 'diagnostics' && event.diagnostics) set({ performance: { ...event.diagnostics, generationId: event.generationId, conversationId: event.conversationId, createdAt: now() } });
    if (event.type === 'token') set({ generationState: 'generating' });
    if (event.type === 'error') { flushTokens(); pendingTokens.delete(event.generationId); set((state) => ({ isGenerating: false, generationId: null, generationState: 'error', error: event.details ? `${event.message}: ${event.details}` : event.message ?? 'Ошибка генерации', messages: state.messages.filter((message) => message.id !== assistantId(event.generationId)), lastFinishReason: null, performance: null })); }
    if (event.type === 'cancelled') { flushTokens(); pendingTokens.delete(event.generationId); set((state) => ({ isGenerating: false, generationId: null, generationState: 'cancelled', messages: state.messages.filter((message) => message.id !== assistantId(event.generationId)), lastFinishReason: 'cancelled', performance: null })); }
    if (event.type === 'done') { flushTokens(); set((state) => ({ isGenerating: false, generationId: null, generationState: 'idle', messages: state.messages.flatMap((message) => message.id === assistantId(event.generationId) ? (event.assistant ? [event.assistant] : []) : [message]), lastFinishReason: event.finishReason ?? 'stop' })); }
  },
};
});
