import { create } from 'zustand';
import type { AnalysisProgress, AnalysisRun, ChatMessage, Conversation, HardwareStats, ModelInfo, ToolActivity } from '../../shared/types';

type State = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  models: ModelInfo[];
  hardware: HardwareStats | null;
  isGenerating: boolean;
  error: string | null;
  toolActivities: ToolActivity[];
  toolActivityCount: number;
  activeContextWindow: number | null;
  analysisProgress: AnalysisProgress[];
  analysisRuns: AnalysisRun[];
  initialize: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  createConversation: () => Promise<void>;
  updateConversation: (id: string, patch: Partial<Conversation>) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshHardware: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  stop: () => Promise<void>;
  handleStream: (event: { type: string; content?: string; message?: string; details?: string; activity?: ToolActivity; run?: AnalysisRun; progress?: AnalysisProgress; requested?: number; active?: number; supported?: number; conversationId: string }) => void;
};

const assistantId = (conversationId: string) => `stream-${conversationId}`;
const now = () => new Date().toISOString();

export const useAppStore = create<State>((set, get) => {
  const pendingTokens = new Map<string, string>();
  let animationFrame: number | null = null;
  const flushTokens = () => {
    animationFrame = null;
    if (pendingTokens.size === 0) return;
    const tokens = new Map(pendingTokens); pendingTokens.clear();
    set((state) => ({ messages: state.messages.map((message) => {
      const token = tokens.get(message.conversationId);
      return token && message.id === assistantId(message.conversationId) ? { ...message, content: message.content + token } : message;
    }) }));
  };
  return {
  conversations: [], activeId: null, messages: [], models: [], hardware: null, isGenerating: false, error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: null, analysisProgress: [], analysisRuns: [],
  initialize: async () => {
    const [conversations, models] = await Promise.all([window.localAi.conversations.list(), window.localAi.models.list()]);
    set({ conversations, models });
    if (conversations[0]) await get().selectConversation(conversations[0].id);
    else await get().createConversation();
    await get().refreshHardware();
  },
  selectConversation: async (id) => { const [messages, analysisRuns] = await Promise.all([window.localAi.messages.list(id), window.localAi.analysis.list(id)]); const conversation = get().conversations.find((item) => item.id === id); set({ activeId: id, messages, analysisRuns, error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: conversation?.contextWindow ?? null, analysisProgress: [] }); },
  createConversation: async () => {
    const conversation = await window.localAi.conversations.create();
    set((state) => ({ conversations: [conversation, ...state.conversations] })); await get().selectConversation(conversation.id);
  },
  updateConversation: async (id, patch) => {
    const updated = await window.localAi.conversations.update(id, patch);
    set((state) => ({ conversations: state.conversations.map((chat) => chat.id === id ? updated : chat), activeContextWindow: state.activeId === id ? updated.contextWindow : state.activeContextWindow }));
  },
  deleteConversation: async (id) => {
    await window.localAi.conversations.delete(id);
    const remaining = get().conversations.filter((item) => item.id !== id);
    set({ conversations: remaining, activeId: null, messages: [] });
    if (remaining[0]) await get().selectConversation(remaining[0].id); else await get().createConversation();
  },
  refreshHardware: async () => set({ hardware: await window.localAi.hardware.get() }),
  sendMessage: async (content) => {
    const { activeId, conversations, messages, models } = get();
    if (!activeId || !content.trim()) return;
    const chat = conversations.find((item) => item.id === activeId); const model = chat?.modelId ?? models[0]?.id;
    if (!model) { set({ error: 'Нет доступных моделей. Запустите Ollama и загрузите модель.' }); return; }
    const user: ChatMessage = { id: crypto.randomUUID(), conversationId: activeId, role: 'user', content: content.trim(), createdAt: now() };
    const streaming: ChatMessage = { id: assistantId(activeId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    set({ messages: [...messages, user, streaming], isGenerating: true, error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [] });
    if (!chat?.modelId) await get().updateConversation(activeId, { modelId: model });
    if (chat?.title === 'Новый чат') await get().updateConversation(activeId, { title: content.trim().slice(0, 56) });
    try { await window.localAi.chat.send({ conversationId: activeId, model, messages: [...messages, user] }); }
    catch (error) { set({ isGenerating: false, error: error instanceof Error ? error.message : 'Не удалось отправить сообщение' }); }
  },
  stop: async () => { await window.localAi.chat.stop(); set({ isGenerating: false }); },
  handleStream: (event) => {
    if (event.conversationId !== get().activeId) return;
    if (event.type === 'token') {
      pendingTokens.set(event.conversationId, (pendingTokens.get(event.conversationId) ?? '') + (event.content ?? ''));
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(flushTokens);
    }
    if (event.type === 'tool' && event.activity) set((state) => ({ toolActivities: [...state.toolActivities, event.activity!].slice(-40), toolActivityCount: state.toolActivityCount + 1 }));
    if (event.type === 'analysis-run' && event.run) set((state) => ({ analysisRuns: [...state.analysisRuns.filter((run) => run.id !== event.run!.id), event.run!] }));
    if (event.type === 'analysis' && event.progress) set({ analysisProgress: [event.progress] });
    if (event.type === 'context' && event.active) set({ activeContextWindow: event.active });
    if (event.type === 'error') { flushTokens(); set({ isGenerating: false, error: event.details ? `${event.message}: ${event.details}` : event.message ?? 'Ошибка генерации' }); }
    if (event.type === 'done') { flushTokens(); set((state) => ({ isGenerating: false, messages: state.messages.map((message) => message.id === assistantId(event.conversationId) ? { ...message, id: crypto.randomUUID() } : message) })); }
  },
};
});
