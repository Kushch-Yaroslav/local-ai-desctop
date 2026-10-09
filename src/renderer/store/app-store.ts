import { t } from '../../shared/locale';
import { activeConversationModel } from '../../shared/model-selection';
import { create } from 'zustand';
import type { ActionApproval, AgentPlan, AgentTelemetry, WorkBudget, AnalysisProgress, AnalysisRun, AppSettings, Attachment, AttachmentStatus, ApprovalDecision, ApprovalStatus, ChatMessage, Conversation, FinishReason, GenerationDiagnostics, HardwareStats, ModelInfo, ProjectReference, SteeringIntent, ToolActivity } from '../../shared/types';
import { isCurrentGenerationEvent } from '../../shared/generation-guard';
import { pinLegacyReasoning, revertRefusedPatch, type ModeTransition } from '../../shared/conversation-settings';
import { appendPausedMarker, appendReasoningFragments, applySteeringEvent } from '../../shared/thinking-timeline';
import { richArtifactFingerprint } from '../../shared/rich-artifacts';

type State = {
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  models: ModelInfo[];
  hardware: HardwareStats | null;
  settings: AppSettings | null;
  isGenerating: boolean;
  generationId: string | null;
  generationConversationId: string | null;
  /** Process-wide inference ownership token; per-chat view state stays separate. */
  generationOwnerId: string | null;
  generationState: 'idle' | 'thinking' | 'reasoning' | 'using-tool' | 'running-terminal' | 'waiting-for-approval' | 'generating' | 'stopping' | 'cancelled' | 'error';
  error: string | null;
  toolActivities: ToolActivity[];
  toolActivityCount: number;
  activeContextWindow: number | null;
  analysisProgress: AnalysisProgress[];
  analysisRuns: AnalysisRun[];
  agentPlan: AgentPlan | null;
  lastFinishReason: FinishReason | null;
  performance: GenerationDiagnostics | null;
  pendingApproval: { actionId: string; approval: ActionApproval } | null;
  approvalSubmitting: boolean;
  agentTelemetry: AgentTelemetry | null;
  /** Mode selections sent to the main process but not yet confirmed, per conversation. */
  modeTransitions: Record<string, ModeTransition>;
  initialize: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  createConversation: () => Promise<void>;
  updateConversation: (id: string, patch: Partial<Conversation>) => Promise<void>;
  refreshRuntime: () => Promise<void>;
  refreshRuntimeStatus: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  refreshHardware: () => Promise<void>;
  sendMessage: (content: string, files?: File[], projectReferences?: ProjectReference[]) => Promise<void>;
  steer: (content: string, intent?: SteeringIntent) => Promise<boolean>;
  steeringStatus: 'accepted' | 'applied' | null;
  approveAction: (decision: ApprovalDecision) => Promise<void>;
  editMessage: (message: ChatMessage, content: string) => Promise<boolean>;
  regenerateMessage: (message: ChatMessage) => Promise<boolean>;
  stop: () => Promise<void>;
  handleStream: (event: { type: string; state?: 'waiting' | 'streaming'; content?: string; artifact?: import('../../shared/rich-artifacts').RichArtifact; message?: string; userMessage?: ChatMessage; details?: string; activity?: ToolActivity; memory?: NonNullable<AgentPlan['taskMemory']>; budget?: WorkBudget; run?: AnalysisRun; progress?: AnalysisProgress; requested?: number; active?: number; supported?: number; used?: number; maximum?: number; timelinePosition?: number; telemetry?: Partial<AgentTelemetry>; conversationId: string; generationId: string; modelId?: string; assistant?: ChatMessage | null; finishReason?: FinishReason; diagnostics?: Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt'>; actionId?: string; approval?: ActionApproval; approvalId?: string; status?: Exclude<ApprovalStatus, 'pending'> | AttachmentStatus | 'accepted' | 'applied' }) => void;
};

const assistantId = (generationId: string) => `stream-${generationId}`;
const now = () => new Date().toISOString();
const isImageFile = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);

/** A terminal tool emits start metadata, streamed output, then one final
 * result. Keep that lifecycle as one activity in memory just as SQLite does;
 * a stdout delta must never erase its command or process identity. */
const mergeToolActivity = (prior: ToolActivity | undefined, next: ToolActivity): ToolActivity => {
  if (!prior) return next;
  const priorTerminal = prior.terminal;
  const nextTerminal = next.terminal;
  const terminal = priorTerminal || nextTerminal ? {
    ...priorTerminal,
    ...nextTerminal,
    ...(nextTerminal?.stdout !== undefined ? { stdout: nextTerminal.finishedAt ? nextTerminal.stdout : `${priorTerminal?.stdout ?? ''}${nextTerminal.stdout}` } : {}),
    ...(nextTerminal?.stderr !== undefined ? { stderr: nextTerminal.finishedAt ? nextTerminal.stderr : `${priorTerminal?.stderr ?? ''}${nextTerminal.stderr}` } : {}),
  } : undefined;
  return { ...prior, ...next, ...(terminal ? { terminal } : {}) };
};

const viewKeys = ['messages', 'isGenerating', 'generationId', 'generationState', 'error', 'toolActivities', 'toolActivityCount', 'activeContextWindow', 'analysisProgress', 'analysisRuns', 'agentPlan', 'lastFinishReason', 'performance', 'pendingApproval', 'approvalSubmitting', 'agentTelemetry', 'steeringStatus'] as const;
type ConversationView = Pick<State, typeof viewKeys[number]>;
const viewOf = (state: State): ConversationView => Object.fromEntries(viewKeys.map((key) => [key, state[key]])) as ConversationView;

const modeUpdatesInFlight = new Map<string, number>();

export const useAppStore = create<State>((rawSet, rawGet) => {
  const views = new Map<string, ConversationView>();
  let routedId: string | null = null;
  let selection = 0;
  const get = (): State => {
    const state = rawGet();
    return routedId && routedId !== state.activeId ? { ...state, ...views.get(routedId), activeId: routedId } : state;
  };
  const set = (update: Partial<State> | ((state: State) => Partial<State>)) => {
    const patch = typeof update === 'function' ? update(get()) : update;
    if (!routedId || routedId === rawGet().activeId) { rawSet(patch); return; }
    const viewPatch = Object.fromEntries(Object.entries(patch).filter(([key]) => viewKeys.some((viewKey) => viewKey === key)));
    views.set(routedId, { ...views.get(routedId)!, ...viewPatch });
    rawSet(Object.fromEntries(Object.entries(patch).filter(([key]) => !viewKeys.some((viewKey) => viewKey === key))));
  };
  const withView = (id: string | null, action: () => void) => {
    const previous = routedId;
    routedId = id;
    try { action(); } finally { routedId = previous; }
  };
  const releaseGeneration = (generationId: string) => {
    if (rawGet().generationOwnerId === generationId) rawSet({ generationConversationId: null, generationOwnerId: null });
  };
  const pendingTokens = new Map<string, string>();
  const pendingThinking = new Map<string, Array<{ content: string; timelinePosition?: number }>>();
  let animationFrame: number | null = null;
  let branchRegenerationPending = false;
  const drainStream = (immediate = false) => {
    animationFrame = null;
    if (pendingTokens.size === 0 && pendingThinking.size === 0) return;
    // Content deltas arrive immediately from the sidecar. A small client-side
    // queue keeps large provider chunks from appearing as a single flash while
    // remaining much faster than normal local-model token generation. `done`
    // drains it synchronously, and Stop clears it synchronously.
    const take = (value: string): string => immediate ? value : Array.from(value).slice(0, 48).join('');
    const tokens = new Map<string, string>(); const thinking = new Map<string, Array<{ content: string; timelinePosition?: number }>>();
    for (const [id, value] of pendingTokens) { const visible = take(value); tokens.set(id, visible); const rest = value.slice(visible.length); if (rest) pendingTokens.set(id, rest); else pendingTokens.delete(id); }
    for (const [id, value] of pendingThinking) { thinking.set(id, value); pendingThinking.delete(id); }
    withView(rawGet().generationConversationId, () => set((state) => ({ messages: state.messages.map((message) => {
      const token = tokens.get(get().generationId ?? '');
      const reasoning = thinking.get(get().generationId ?? '');
      const timeline = reasoning ? appendReasoningFragments(message.thinkingTimeline ?? [], reasoning) : undefined;
      return (token || reasoning?.length) && message.id === assistantId(get().generationId ?? '') ? { ...message, ...(token ? { content: message.content + token } : {}), ...(reasoning?.length ? { thinking: (message.thinking ?? '') + reasoning.map((fragment) => fragment.content).join(''), ...(timeline?.length ? { thinkingTimeline: timeline } : {}) } : {}) } : message;
    }) })));
    if (!immediate && (pendingTokens.size || pendingThinking.size)) animationFrame = window.requestAnimationFrame(() => drainStream());
  };
  // The live stream turn is replaced by the run's persisted history once the
  // run is final without an assistant message, so the view after Stop/failure
  // is the same one a chat switch or restart reconstructs from the database.
  const generationRuns = new Map<string, string>();
  const isOrphanFinished = (run: AnalysisRun) => run.status !== 'running' && !run.assistantMessageId;
  const adoptRuns = (generationId: string, runs: AnalysisRun[]) => (state: State): Partial<State> => {
    const runId = generationRuns.get(generationId);
    const finished = runs.find((run) => run.id === runId && isOrphanFinished(run));
    return { analysisRuns: runs, ...(finished ? { messages: state.messages.filter((message) => message.id !== assistantId(generationId)) } : {}) };
  };
  const finishAgentStream = (messages: ChatMessage[], generationId: string, terminal: { error?: string; cancelled?: boolean }) => messages.map((message) => message.id === assistantId(generationId)
    ? { ...message, ...(terminal.error ? { agentError: terminal.error } : {}), ...(terminal.cancelled ? { agentCancelled: true } : {}), agentFinishedAt: now() }
    : message);
  const regenerateSavedBranch = async (saved: ChatMessage[], errorMessage: string, activeId: string): Promise<boolean> => {
    const chat = get().conversations.find((item) => item.id === activeId); const model = activeConversationModel(chat, get().settings?.llamaRuntime);
    if (!activeId || !chat || !model) return false;
    set((state) => ({ conversations: state.conversations.map((item) => item.id === activeId ? { ...item, contextTokens: null, contextModelId: null } : item) }));
    // The database already truncated the regenerated branch. Refresh its run
    // projection as well as messages; otherwise withRunHistory resurrects the
    // stopped attempt from the renderer cache alongside the new stream.
    const [analysisRuns, agentPlan] = await Promise.all([
      window.localAi.analysis.list(activeId), window.localAi.agentPlans.get(activeId),
    ]);
    const generationId = crypto.randomUUID(); const streaming: ChatMessage = { id: assistantId(generationId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    withView(activeId, () => set({ analysisRuns, agentPlan, messages: [...saved, streaming], isGenerating: true, generationId, generationConversationId: activeId, generationOwnerId: generationId, generationState: 'thinking', error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [], lastFinishReason: null, performance: null, pendingApproval: null, approvalSubmitting: false, steeringStatus: null, agentTelemetry: { turn: 0, inputTokens: 0, outputTokens: 0, actions: 0, startedAt: now() } }));
    try { await window.localAi.chat.send({ conversationId: activeId, model, mode: chat.mode, messages: saved, generationId, persistUserMessage: false }); }
    catch (error) { withView(activeId, () => set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'error', error: error instanceof Error ? error.message : errorMessage, messages: finishAgentStream(state.messages, generationId, { error: error instanceof Error ? error.message : errorMessage }) } : {})); }
    finally { releaseGeneration(generationId); }
    return true;
  };
  return {
  modeTransitions: {},
  conversations: [], activeId: null, messages: [], models: [], hardware: null, settings: null, isGenerating: false, generationId: null, generationConversationId: null, generationOwnerId: null, generationState: 'idle', error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: null, analysisProgress: [], analysisRuns: [], agentPlan: null, lastFinishReason: null, performance: null, pendingApproval: null, approvalSubmitting: false, agentTelemetry: null, steeringStatus: null,
  initialize: async () => {
    const [conversations, models, settings] = await Promise.all([window.localAi.conversations.list(), window.localAi.models.list(), window.localAi.settings.get()]);
    set({ conversations, models, settings });
    if (conversations[0]) await get().selectConversation(conversations[0].id);
    else await get().createConversation();
    await get().refreshHardware();
  },
  selectConversation: async (id) => {
    const request = ++selection;
    const [messages, analysisRuns, agentPlan] = await Promise.all([window.localAi.messages.list(id), window.localAi.analysis.list(id), window.localAi.agentPlans.get(id)]);
    if (request !== selection) return;
    if (get().activeId) views.set(get().activeId!, viewOf(get()));
    const conversation = get().conversations.find((item) => item.id === id);
    const cached = views.get(id);
    set({ activeId: id, messages, analysisRuns, agentPlan: agentPlan ?? [...messages].reverse().find((message) => message.taskPlan)?.taskPlan ?? null, isGenerating: false, generationId: null, generationState: 'idle', error: null, toolActivities: [], toolActivityCount: 0, activeContextWindow: activeConversationModel(conversation, get().settings?.llamaRuntime) ? get().settings?.llamaRuntime?.contextWindow ?? null : null, analysisProgress: [], lastFinishReason: null, performance: null, pendingApproval: null, approvalSubmitting: false, agentTelemetry: null, steeringStatus: null, ...(cached && (cached.isGenerating || cached.generationState === 'error' || cached.generationState === 'cancelled') ? cached : {}) });
  },
  createConversation: async () => {
    const conversation = await window.localAi.conversations.create();
    set((state) => ({ conversations: [conversation, ...state.conversations] })); await get().selectConversation(conversation.id);
  },
  updateConversation: async (id, requestedPatch) => {
    const before = get().conversations.find((chat) => chat.id === id);
    const patch = before ? pinLegacyReasoning(before, get().models.find((model) => model.id === before.modelId)?.reasoning, requestedPatch) : requestedPatch;
    const tracksMode = patch.reasoningMode !== undefined || patch.mode !== undefined || patch.thinkingEnabled !== undefined || patch.reasoningEffort !== undefined;
    if (tracksMode && before) {
      modeUpdatesInFlight.set(id, (modeUpdatesInFlight.get(id) ?? 0) + 1);
      set((state) => {
        const existing = state.modeTransitions[id];
        const effective = existing?.effective ?? { reasoningMode: before.reasoningMode === 'deep' ? 'deep' as const : 'fast' as const, mode: before.mode, thinkingEnabled: before.thinkingEnabled, reasoningEffort: before.reasoningEffort };
        return { modeTransitions: { ...state.modeTransitions, [id]: { effective, desired: { ...existing?.desired, ...(patch.reasoningMode !== undefined ? { reasoningMode: patch.reasoningMode === 'deep' ? 'deep' : 'fast' } : {}), ...(patch.mode !== undefined ? { mode: patch.mode } : {}), ...(patch.thinkingEnabled !== undefined ? { thinkingEnabled: patch.thinkingEnabled } : {}), ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}) } } } };
      });
    }
    const settle = () => {
      if (!tracksMode) return;
      const remaining = (modeUpdatesInFlight.get(id) ?? 1) - 1;
      if (remaining > 0) { modeUpdatesInFlight.set(id, remaining); return; }
      modeUpdatesInFlight.delete(id);
      set((state) => { const rest = { ...state.modeTransitions }; delete rest[id]; return { modeTransitions: rest }; });
    };
    if (before) set((state) => ({ conversations: state.conversations.map((chat) => chat.id === id ? { ...chat, ...patch } : chat), activeContextWindow: state.activeId === id && patch.contextWindow !== undefined ? patch.contextWindow : state.activeContextWindow, performance: state.activeId === id && patch.modelId !== undefined ? null : state.performance }));
    try {
      const updated = await window.localAi.conversations.update(id, patch);
      set((state) => ({ conversations: state.conversations.map((chat) => chat.id === id ? updated : chat), activeContextWindow: state.activeId === id ? updated.contextWindow : state.activeContextWindow, performance: state.activeId === id && patch.modelId !== undefined ? null : state.performance }));
      settle();
      if (patch.modelId !== undefined || patch.contextWindow !== undefined) await get().refreshRuntime();
    } catch (error) {
      if (before) set((state) => ({ conversations: state.conversations.map((chat) => chat.id === id ? revertRefusedPatch(chat, before, patch) : chat), activeContextWindow: state.activeId === id && patch.contextWindow !== undefined ? before.contextWindow : state.activeContextWindow }));
      settle();
      // A refused runtime switch leaves the stored conversation unchanged; show the real reason and the real runtime.
      set({ error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      await get().refreshRuntime();
      throw error;
    }
  },
  refreshRuntime: async () => {
    try {
      const [settings, models] = await Promise.all([window.localAi.settings.get(), window.localAi.models.list()]);
      set({ settings, models });
    } catch { /* the next poll retries */ }
  },
  refreshRuntimeStatus: async () => {
    try {
      const llamaRuntime = await window.localAi.runtime.state();
      const settings = get().settings;
      if (!settings || JSON.stringify(settings.llamaRuntime) === JSON.stringify(llamaRuntime)) return;
      set({ settings: { ...settings, llamaRuntime, llamaRuntimeModelId: llamaRuntime.modelId ?? undefined } });
    } catch { /* the next status poll retries */ }
  },
  deleteConversation: async (id) => {
    await window.localAi.conversations.delete(id);
    views.delete(id);
    const remaining = get().conversations.filter((item) => item.id !== id);
    set({ conversations: remaining });
    if (get().activeId !== id) return;
    set({ activeId: null, messages: [] });
    if (remaining[0]) await get().selectConversation(remaining[0].id); else await get().createConversation();
  },
  refreshHardware: async () => set({ hardware: await window.localAi.hardware.get() }),
  sendMessage: async (content, files = [], projectReferences = []) => {
    if (get().generationConversationId || branchRegenerationPending) { set({ error: t("Уже выполняется генерация или подготовка повтора. Дождитесь завершения или остановите её в активном чате.") }); return; }
    const { activeId, conversations, messages, settings } = get();
    if (!activeId || (!content.trim() && files.length === 0)) return;
    const chat = conversations.find((item) => item.id === activeId); const model = activeConversationModel(chat, settings?.llamaRuntime);
    if (!model) { set({ error: t("Выберите модель перед отправкой сообщения.") }); return; }
    const userId = crypto.randomUUID();
    let imageIndex = 0;
    const attached: Attachment[] = files.map((file, index) => { const isImage = isImageFile(file); return { id: crypto.randomUUID(), messageId: userId, index, kind: isImage ? 'image' : file.name.endsWith('.pdf') ? 'pdf' : /\.(xlsx|xls)$/i.test(file.name) ? 'spreadsheet' : file.name.endsWith('.docx') ? 'document' : 'text', mimeType: file.type || 'application/octet-stream', filename: file.name, size: file.size, storageRef: '', status: 'pending', metadata: isImage ? { imageNumber: ++imageIndex } : undefined, createdAt: now(), updatedAt: now() }; });
    const user: ChatMessage = { id: userId, conversationId: activeId, role: 'user', content: content.trim() || t("Вложения"), createdAt: now(), attachments: attached, projectReferences };
    const generationId = crypto.randomUUID(); const streaming: ChatMessage = { id: assistantId(generationId), conversationId: activeId, role: 'assistant', content: '', createdAt: now() };
    set({ messages: [...messages, user, streaming], isGenerating: true, generationId, generationConversationId: activeId, generationOwnerId: generationId, generationState: 'thinking', error: null, toolActivities: [], toolActivityCount: 0, analysisProgress: [], lastFinishReason: null, performance: null, pendingApproval: null, approvalSubmitting: false, agentTelemetry: chat?.mode === 'agent' ? { turn: 0, inputTokens: 0, outputTokens: 0, actions: 0, startedAt: now() } : null });
    try {
      set({ steeringStatus: null });
      if (!chat?.modelId) await get().updateConversation(activeId, { modelId: model });
      if (chat?.title === 'Новый чат') await get().updateConversation(activeId, { title: content.trim().slice(0, 56) });
      const attachmentInputs = await Promise.all(files.map(async (file, index) => ({ id: attached[index].id, messageId: user.id, index: attached[index].index, filename: file.name, mimeType: file.type, data: new Uint8Array(await file.arrayBuffer()) })));
      await window.localAi.chat.send({ conversationId: activeId, model, mode: chat?.mode, messages: [...messages, user], generationId, persistUserMessage: true, attachments: attachmentInputs });
    }
    catch (error) { withView(activeId, () => set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'error', error: error instanceof Error ? error.message : t("Не удалось отправить сообщение"), messages: state.messages.filter((message) => message.id !== assistantId(generationId)) } : {})); }
    finally { releaseGeneration(generationId); }
  },
  editMessage: async (message, content) => {
    if (!activeConversationModel(get().conversations.find((chat) => chat.id === message.conversationId), get().settings?.llamaRuntime)) { set({ error: t("Выберите модель перед перегенерацией.") }); return false; }
    if (get().generationConversationId || branchRegenerationPending) { set({ error: t("Дождитесь завершения генерации перед редактированием.") }); return false; }
    branchRegenerationPending = true;
    try {
      const saved = await window.localAi.messages.edit(message.id, content, { conversationId: message.conversationId, content: message.content });
      return await regenerateSavedBranch(saved, t("Не удалось перегенерировать ответ"), message.conversationId);
    }
    catch (error) { set({ error: error instanceof Error ? error.message : t("Не удалось сохранить изменение") }); return false; }
    finally { branchRegenerationPending = false; }
  },
  steer: async (content, intent) => {
    const { activeId, generationId } = get();
    if (!activeId || !generationId) return false;
    try { await window.localAi.chat.steer(activeId, generationId, content, intent); return true; }
    catch (error) { withView(activeId, () => set({ error: error instanceof Error ? error.message : String(error) })); return false; }
  },
  regenerateMessage: async (message) => {
    if (!activeConversationModel(get().conversations.find((chat) => chat.id === message.conversationId), get().settings?.llamaRuntime)) { set({ error: t("Выберите модель перед перегенерацией.") }); return false; }
    if (branchRegenerationPending || get().generationConversationId || get().activeId !== message.conversationId) return false;
    branchRegenerationPending = true;
    try {
      const saved = await window.localAi.messages.regenerate(message.id);
      return await regenerateSavedBranch(saved, t("Не удалось перегенерировать ответ"), message.conversationId);
    } catch (error) { set({ error: error instanceof Error ? error.message : t("Не удалось перегенерировать ответ") }); return false; }
    finally { branchRegenerationPending = false; }
  },
  approveAction: async (decision) => {
    const { activeId, generationId, pendingApproval, approvalSubmitting } = get();
    if (!activeId || !generationId || !pendingApproval || approvalSubmitting) return;
    set({ approvalSubmitting: true });
    const accepted = await window.localAi.chat.approve({ conversationId: activeId, generationId, approvalId: pendingApproval.approval.approvalId, decision });
    if (!accepted) set((state) => state.generationId === generationId ? { approvalSubmitting: false } : {});
  },
  stop: async () => {
    const { activeId, generationId } = get(); if (!activeId || !generationId) return;
    set({ generationState: 'stopping', pendingApproval: null, approvalSubmitting: false });
    await window.localAi.chat.stop(activeId, generationId);
    pendingTokens.delete(generationId); pendingThinking.delete(generationId); if (animationFrame !== null) { window.cancelAnimationFrame(animationFrame); animationFrame = null; }
    withView(activeId, () => set((state) => state.generationId === generationId ? { isGenerating: false, generationId: null, generationState: 'cancelled', messages: finishAgentStream(state.messages, generationId, { cancelled: true }), performance: null, pendingApproval: null, approvalSubmitting: false } : {}));
    // `chat:stop` resolves after the main process finalized the run, so the database is authoritative here.
    if (!generationRuns.has(generationId)) return;
    try { const runs = await window.localAi.analysis.list(activeId); withView(activeId, () => set(adoptRuns(generationId, runs))); } catch { /* the analysis-run event already carried the final run */ }
  },
  handleStream: (event) => {
    if (event.conversationId !== rawGet().activeId && !views.has(event.conversationId)) return;
    withView(event.conversationId, () => {
    if (event.type === 'context-usage' && typeof event.used === 'number') {
      const used = event.used;
      set((state) => ({ conversations: state.conversations.map((chat) => chat.id === event.conversationId ? { ...chat, contextTokens: used, contextModelId: event.modelId ?? chat.modelId } : chat) }));
    }
    if (!isCurrentGenerationEvent(event.conversationId, event.generationId, get().activeId, get().generationId)) return;
    if (event.type === 'steering' && event.userMessage) {
      const message = event.userMessage;
      const incomingStatus: 'accepted' | 'applied' = event.status === 'applied' ? 'applied' : 'accepted';
      set((state) => {
        const assistantMessageId = assistantId(event.generationId);
        const assistant = state.messages.find((entry) => entry.id === assistantMessageId);
        const timeline = assistant?.thinkingTimeline ?? [];
        const nextTimeline = applySteeringEvent(timeline, message.id, incomingStatus, event.timelinePosition);
        const entry = nextTimeline.find((candidate) => candidate.kind === 'steering' && candidate.messageId === message.id);
        const status: 'accepted' | 'applied' = entry?.kind === 'steering' ? entry.status : incomingStatus;
        const messages = state.messages.some((entry) => entry.id === message.id)
          ? state.messages.map((entry) => entry.id === assistantMessageId && nextTimeline !== timeline ? { ...entry, thinkingTimeline: nextTimeline } : entry)
          : [...state.messages.filter((entry) => entry.id !== assistantMessageId), message, ...state.messages.filter((entry) => entry.id === assistantMessageId).map((entry) => ({ ...entry, ...(nextTimeline !== timeline ? { thinkingTimeline: nextTimeline } : {}) }))];
        return { steeringStatus: status, messages };
      });
    }
    if (event.type === 'paused') {
      set((state) => {
        const assistantMessageId = assistantId(event.generationId);
        return { messages: state.messages.map((entry) => entry.id === assistantMessageId ? { ...entry, thinkingTimeline: appendPausedMarker(entry.thinkingTimeline ?? [], event.timelinePosition) } : entry) };
      });
    }
    if (event.type === 'token') {
      pendingTokens.set(event.generationId, (pendingTokens.get(event.generationId) ?? '') + (event.content ?? ''));
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(() => drainStream());
    }
    if (event.type === 'agent-telemetry' && event.telemetry) {
      const telemetry = event.telemetry;
      set((state) => state.agentTelemetry ? {
        agentTelemetry: {
          ...state.agentTelemetry,
          ...telemetry,
          inputTokens: state.agentTelemetry.inputTokens + (telemetry.inputTokens ?? 0),
          outputTokens: state.agentTelemetry.outputTokens + (telemetry.outputTokens ?? 0),
          ...(telemetry.cachedTokens === undefined ? {} : { cachedTokens: (state.agentTelemetry.cachedTokens ?? 0) + telemetry.cachedTokens }),
          ...(telemetry.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: (state.agentTelemetry.cacheWriteTokens ?? 0) + telemetry.cacheWriteTokens }),
        },
      } : {});
    }
    if (event.type === 'model-state') set({ generationState: event.state === 'waiting' ? 'thinking' : 'reasoning' });
    if (event.type === 'thinking') {
      pendingThinking.set(event.generationId, [...(pendingThinking.get(event.generationId) ?? []), { content: event.content ?? '', timelinePosition: event.timelinePosition }]);
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(() => drainStream());
      if (event.content && get().generationState !== 'reasoning') set({ generationState: 'reasoning' });
    }
    if (event.type === 'rich-artifact' && event.artifact) { performance.mark(`rich.received.${event.artifact.id}`); set((state) => ({ messages: state.messages.map((message) => message.id === assistantId(event.generationId) ? { ...message, richArtifacts: [...(message.richArtifacts ?? []).filter((item) => richArtifactFingerprint(item) !== richArtifactFingerprint(event.artifact!)), event.artifact!] } : message) })); }
    if ((event.type === 'tool' || event.type === 'attachment') && event.activity) set((state) => {
      const priorActivity = state.toolActivities.find((activity) => activity.id === event.activity!.id);
      const exists = Boolean(priorActivity);
      const mergedActivity = mergeToolActivity(priorActivity, event.activity!);
      const attachmentId = event.activity!.id.startsWith('attachment-') ? event.activity!.id.slice('attachment-'.length) : null;
      return {
        generationState: mergedActivity.kind === 'progress' ? state.generationState : mergedActivity.state === 'completed' || mergedActivity.state === 'error' ? 'thinking' : event.type === 'attachment' && event.activity!.status === 'processing' ? 'using-tool' : event.activity!.kind === 'terminal' ? 'running-terminal' : 'using-tool',
        toolActivities: [...state.toolActivities.filter((activity) => activity.id !== event.activity!.id), mergedActivity].slice(-100), toolActivityCount: exists || event.activity!.kind === 'progress' ? state.toolActivityCount : state.toolActivityCount + 1, agentTelemetry: state.agentTelemetry ? { ...state.agentTelemetry, actions: exists || event.activity!.kind === 'progress' ? state.agentTelemetry.actions : state.agentTelemetry.actions + 1 } : null,
        messages: state.messages.map((message) => {
          if (attachmentId) return { ...message, attachments: message.attachments?.map((attachment) => attachment.id === attachmentId ? event.activity!.attachment ?? { ...attachment, status: event.activity!.status ?? attachment.status, error: event.activity!.status === 'error' ? event.activity!.detail : attachment.error, updatedAt: now() } : attachment) };
          if (event.activity!.timelinePosition === undefined || message.id !== assistantId(event.generationId)) return message;
          const entries = message.thinkingTimeline ?? [];
          return entries.some((entry) => entry.kind === 'activity' && entry.activityId === event.activity!.id) ? message : { ...message, thinkingTimeline: [...entries, { id: `activity-${event.activity!.id}`, kind: 'activity', activityId: event.activity!.id, position: event.activity!.timelinePosition }] };
        }),
      };
    });
    if (event.type === 'approval-request' && event.actionId && event.approval) set((state) => ({ generationState: 'waiting-for-approval', pendingApproval: { actionId: event.actionId!, approval: event.approval! }, approvalSubmitting: false, toolActivities: state.toolActivities.map((activity) => activity.id === event.actionId ? { ...activity, approval: event.approval } : activity) }));
    if (event.type === 'approval-resolved' && event.actionId && event.approvalId && event.status) { const approvalStatus = event.status as Exclude<ApprovalStatus, 'pending'>; set((state) => ({ generationState: state.generationState === 'waiting-for-approval' ? 'using-tool' : state.generationState, pendingApproval: state.pendingApproval?.approval.approvalId === event.approvalId ? null : state.pendingApproval, approvalSubmitting: false, toolActivities: state.toolActivities.map((activity) => activity.id === event.actionId ? { ...activity, approval: { approvalId: event.approvalId!, category: activity.approval?.category ?? 'system_command', status: approvalStatus } } : activity) })); }
    if (event.type === 'work-budget' && event.budget) set((state) => ({ agentPlan: { milestones: [], ...state.agentPlan, workBudget: event.budget } }));
    if (event.type === 'task-memory' && event.memory) {
      const prior = get().agentPlan?.taskMemory;
      // Knowledge updates do not redraw unchanged plan/results/evidence.
      if (!prior || JSON.stringify(prior?.plan) !== JSON.stringify(event.memory.plan) || JSON.stringify(prior?.deliverables) !== JSON.stringify(event.memory.deliverables) || JSON.stringify(prior?.verification) !== JSON.stringify(event.memory.verification)) {
        set({ agentPlan: { milestones: [], ...(get().agentPlan?.workBudget ? { workBudget: get().agentPlan!.workBudget } : {}), taskMemory: { entries: [], plan: event.memory.plan, deliverables: event.memory.deliverables, verification: event.memory.verification } } });
      }
    }
    if (event.type === 'analysis-run' && event.run) { generationRuns.set(event.generationId, event.run.id); set((state) => adoptRuns(event.generationId, [...state.analysisRuns.filter((run) => run.id !== event.run!.id), event.run!])(state)); }
    if (event.type === 'analysis' && event.progress) set({ analysisProgress: [event.progress] });
    if (event.type === 'context' && event.active) set({ activeContextWindow: event.active });
    if (event.type === 'diagnostics' && event.diagnostics) set({ performance: { ...event.diagnostics, generationId: event.generationId, conversationId: event.conversationId, createdAt: now() } });
    if (event.type === 'token' && get().generationState !== 'generating') set({ generationState: 'generating' });
    if (event.type === 'error') { releaseGeneration(event.generationId); drainStream(true); pendingTokens.delete(event.generationId); pendingThinking.delete(event.generationId); const message = event.details ? `${event.message}: ${event.details}` : event.message ?? t("Ошибка генерации"); set((state) => ({ isGenerating: false, generationId: null, generationState: 'error', error: message, messages: finishAgentStream(state.messages, event.generationId, { error: message }), lastFinishReason: null, performance: null, pendingApproval: null, approvalSubmitting: false, agentTelemetry: state.agentTelemetry ? { ...state.agentTelemetry, finishedAt: now() } : null })); }
    if (event.type === 'cancelled') { releaseGeneration(event.generationId); drainStream(true); pendingTokens.delete(event.generationId); pendingThinking.delete(event.generationId); set((state) => ({ isGenerating: false, generationId: null, generationState: 'cancelled', messages: finishAgentStream(state.messages, event.generationId, { cancelled: true }), lastFinishReason: 'cancelled', performance: null, pendingApproval: null, approvalSubmitting: false, agentTelemetry: state.agentTelemetry ? { ...state.agentTelemetry, finishedAt: now() } : null })); }
    if (event.type === 'done') { releaseGeneration(event.generationId); drainStream(true); set((state) => ({ isGenerating: false, generationId: null, generationState: 'idle', messages: state.messages.flatMap((message) => message.id === assistantId(event.generationId) ? (event.assistant ? [event.assistant] : []) : [message]), lastFinishReason: event.finishReason ?? 'stop', agentTelemetry: state.agentTelemetry ? { ...state.agentTelemetry, finishedAt: now() } : null })); }
    });
  },
};
});
