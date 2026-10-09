import { galleryFailureWarning } from '../shared/rich-artifacts';
import { useLocale } from './use-locale';
import { t, tr, localizeMessage, setLanguage } from '../shared/locale';
import { activeConversationModel } from '../shared/model-selection';
import { localizeProjectLabel, tokensWord } from '../shared/localization';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bot, Check, Copy, File, Folder, Pencil, RotateCcw, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { AgentTimeline } from './components/AgentTimeline';
import { Markdown } from './components/Markdown';
import { validateMermaidSource } from './mermaid-validation';
const RichArtifacts = lazy(() => import('./components/RichArtifacts').then((module) => ({ default: module.RichArtifacts })));
import { progressIndicatorLabel } from '../shared/generation-progress';
import { useAppStore } from './store/app-store';
import { steeringMessageIds } from '../shared/thinking-timeline';
import { runForMessage, runTurnId, withRunHistory } from '../shared/run-history';
import type { Attachment, GenerationStats, ProjectReference } from '../shared/types';

function GenerationIndicator({ state, toolLabel }: { state: string; toolLabel?: string }) {
  useLocale();
  const label = toolLabel ? t(toolLabel) : state === 'thinking' ? t('Ожидаю ответ модели…') : state === 'waiting-for-approval' ? t("Ожидает подтверждения") : state === 'using-tool' ? t("Использую инструмент") : state === 'running-terminal' ? t("Запускаю terminal") : state === 'stopping' ? t("Останавливаю") : state === 'generating' ? t("Пишу ответ") : t("Думаю");
  return <div className="generation-indicator" role="status" aria-label={label}><span className="generation-orb" /><span>{label}</span><i /><i /><i /></div>;
}

function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  useLocale(); return <div className="message-attachments">{attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}</div>; }
function MessageProjectReferences({ references }: { references: ProjectReference[] }) {
  useLocale(); return <div className="message-project-references">{references.map((reference) => <span key={reference.id} className={`message-project-reference project-${reference.projectSlot}`}>{reference.kind === 'folder' ? <Folder size={12} /> : <File size={12} />}<span>{reference.relativePath}</span><small>{localizeProjectLabel(reference.projectLabel)}</small></span>)}</div>; }

const EDITOR_MAX_HEIGHT = 320;

function MessageEditor({ text, onChange, onSave, onCancel }: { text: string; onChange: (value: string) => void; onSave: () => void; onCancel: () => void }) {
  useLocale();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current; if (!textarea) return;
    textarea.style.height = '0px';
    const height = Math.min(textarea.scrollHeight, EDITOR_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > EDITOR_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);
  return <div className="message-editor"><textarea ref={ref} value={text} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSave(); } }} autoFocus /><div className="message-editor-actions"><button aria-label={t("Сохранить")} title={t("Сохранить (Enter)")} onClick={onSave}><Check size={15} /></button><button aria-label={t("Отмена")} title={t("Отмена (Esc)")} onClick={onCancel}><X size={15} /></button></div></div>;
}

function UserMessageActions({ content, onEdit, onRegenerate, regenerateDisabled }: { content: string; onEdit: () => void; onRegenerate: () => void; regenerateDisabled: boolean }) {
  useLocale();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => { if (resetTimer.current !== null) window.clearTimeout(resetTimer.current); }, []);
  const copy = async () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    try { await navigator.clipboard.writeText(content); setCopyState('copied'); }
    catch { setCopyState('error'); }
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1_500);
  };
  const copied = copyState === 'copied';
  return <div className="user-message-actions" aria-label={t("Действия с сообщением")}><button className={`user-message-action${copyState === 'error' ? ' is-error' : ''}`} title={copied ? t("Скопировано") : copyState === 'error' ? t("Не удалось скопировать") : t("Копировать текст")} aria-label={copied ? t("Текст скопирован") : t("Копировать текст")} onClick={() => { void copy(); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button><button className="user-message-action" title={t("Редактировать")} aria-label={t("Редактировать сообщение")} onClick={onEdit}><Pencil size={14} /></button><button className="user-message-action" title={t("Сгенерировать ответ заново")} aria-label={t("Сгенерировать ответ заново")} disabled={regenerateDisabled} onClick={onRegenerate}><RotateCcw size={14} /></button></div>;
}

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  useLocale();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (attachment.kind !== 'image' || !attachment.storageRef) return; void window.localAi.attachments.dataUrl(attachment.id).then(setUrl); }, [attachment.id, attachment.kind, attachment.storageRef]);
  const imageNumber = Number(attachment.metadata?.imageNumber) || attachment.index + 1;
  const name = attachment.kind === 'image' ? tr`Изображение ${imageNumber}` : attachment.filename;
  const detail = attachment.status === 'ready' ? t("✓ Готово") : attachment.status === 'processing' ? t("◌ Обработка…") : attachment.status === 'ocr_required' ? t("OCR потребуется") : attachment.status === 'error' ? `✕ ${localizeMessage(attachment.error ?? t("Ошибка"))}` : attachment.status === 'cancelled' ? t("Отменено") : t("Ожидает обработки");
  return <div className={`message-attachment ${attachment.kind === 'image' ? 'image' : ''}`}>{url ? <img src={url} alt={name} /> : attachment.kind === 'image' ? <span className="attachment-image-placeholder">{imageNumber}</span> : <span className="attachment-file-icon">{attachment.filename.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span><strong>{name}</strong><small>{detail}</small></span></div>;
}

function GenerationStatsView({ stats }: { stats: GenerationStats }) {
  useLocale();
  const number = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
  const tokens = tokensWord;
  const rate = stats.tokensPerSecond === undefined ? null : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: stats.tokensPerSecond >= 10 ? 0 : 1 }).format(stats.tokensPerSecond);
  const duration = stats.generationDurationMs === undefined ? null : tr`${(stats.generationDurationMs / 1000).toFixed(stats.generationDurationMs >= 10_000 ? 0 : 1)} с`;
  const details = [tr`Сгенерировано: ${number(stats.outputTokens)} ${tokens(stats.outputTokens)}`, rate && tr`Генерация: ${rate} ток/с`, duration && tr`Длительность генерации: ${duration}`, stats.timeToFirstTokenMs !== undefined && tr`Первый токен: ${(stats.timeToFirstTokenMs / 1000).toFixed(2)} с`, stats.inputTokens !== undefined && tr`Токенов промпта: ${number(stats.inputTokens)}`].filter(Boolean).join('\n');
  return <small className="generation-stats" title={details}>{rate ? tr`${rate} ток/с · ` : ''}{number(stats.outputTokens)} {tokens(stats.outputTokens)}</small>;
}

export function App() {
  useLocale();
  const { initialize, refreshHardware, handleStream, activeId, conversations, messages, isGenerating, generationConversationId, generationState, toolActivities, analysisRuns, editMessage, regenerateMessage, lastFinishReason, error, settings } = useAppStore(useShallow((state) => ({ initialize: state.initialize, refreshHardware: state.refreshHardware, handleStream: state.handleStream, activeId: state.activeId, conversations: state.conversations, messages: state.messages, isGenerating: state.isGenerating, generationConversationId: state.generationConversationId, generationState: state.generationState, toolActivities: state.toolActivities, analysisRuns: state.analysisRuns, editMessage: state.editMessage, regenerateMessage: state.regenerateMessage, lastFinishReason: state.lastFinishReason, error: state.error, settings: state.settings })));
  useEffect(() => { if (settings?.setup?.config.language) { setLanguage(settings.setup.config.language); document.documentElement.lang = settings.setup.config.language; } }, [settings?.setup?.config.language]);
  useEffect(() => window.localAi.settings.onLanguageChanged?.((language) => {
    setLanguage(language); document.documentElement.lang = language;

  }), []);
  const endRef = useRef<HTMLDivElement>(null); const conversationRef = useRef<HTMLElement>(null); const followStream = useRef(true);
  const [editingId, setEditingId] = useState<string | null>(null); const [editingText, setEditingText] = useState('');
  const [agentClock, setAgentClock] = useState(() => Date.now());
  const active = conversations.find((item) => item.id === activeId);
  useEffect(() => { void initialize(); const timer = window.setInterval(() => void refreshHardware(), 2_000); const unlisten = window.localAi.chat.onStream(handleStream); return () => { window.clearInterval(timer); unlisten(); }; }, [initialize, refreshHardware, handleStream]);
  useEffect(() => { if (!isGenerating || active?.mode !== 'agent') return; setAgentClock(Date.now()); const timer = window.setInterval(() => setAgentClock(Date.now()), 1_000); return () => window.clearInterval(timer); }, [isGenerating, active?.mode]);
  useEffect(() => window.localAi.chat.onDiagramValidation(({ id, source }) => {
    void validateMermaidSource(source).then(() => window.localAi.chat.diagramValidationResult(id), (error: unknown) => window.localAi.chat.diagramValidationResult(id, error instanceof Error ? error.message : String(error)));
  }), []);
  useLayoutEffect(() => { followStream.current = true; }, [activeId]);
  // Following the stream must not read layout in the commit phase: `scrollHeight` forces a synchronous style
  // recalculation and layout of the whole conversation, which grows with the run. One scroll per frame is
  // scheduled instead; the browser needs that layout for painting anyway, so the follow costs nothing extra.
  const scrollFrame = useRef<number | null>(null);
  const scheduleBottomFollow = useCallback((behavior: ScrollBehavior) => {
    if (!followStream.current || scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const conversation = conversationRef.current;
      if (conversation && followStream.current) conversation.scrollTo({ top: conversation.scrollHeight, behavior });
    });
  }, []);
  useEffect(() => { scheduleBottomFollow(isGenerating ? 'auto' : 'smooth'); }, [messages, isGenerating, toolActivities, scheduleBottomFollow]);
  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    // Composer/status expansion changes the viewport, not the streamed messages.
    // Use the same follow flag and frame scheduler; never pull an earlier reader down.
    const observer = new ResizeObserver(() => scheduleBottomFollow('auto'));
    observer.observe(conversation);
    return () => observer.disconnect();
  }, [scheduleBottomFollow]);
  useEffect(() => () => { if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current); }, []);
  const updateFollowState = () => { const element = conversationRef.current; if (element) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; };
  const rendered = withRunHistory(messages, analysisRuns);
  const embeddedSteeringIds = steeringMessageIds(rendered);
  return <div className="app-shell"><Sidebar /><main className="main"><Toolbar /><section ref={conversationRef} onScroll={updateFollowState} className="conversation">
    {error && <p className="attachment-error" role="alert">{localizeMessage(error)}</p>}
    {generationConversationId && generationConversationId !== activeId && <p role="status">{t("Генерация продолжается в другом чате. Откройте отмеченный чат, чтобы увидеть ход работы или остановить её.")}</p>}
    {active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> {active.workingDirectory ? t("Файловые инструменты ограничены выбранным проектом и папками, которые вы назвали в сообщениях; терминал стартует в корне проекта.") : t("Проект не выбран: файловые инструменты и терминал доступны только для папок, абсолютный путь к которым вы укажете в сообщении (терминал стартует в последней названной). Без пути — только рассуждение и планирование.")}</div>}
    {messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>{t("Чем могу помочь?")}</h1><p>{t("Выберите одну из локальных моделей и начните разговор.")}</p></div>}
    {rendered.map((message) => {
      if (message.role === 'user' && embeddedSteeringIds.has(message.id)) return null;
      const run = runForMessage(analysisRuns, message.id);
      const activities = message.id.startsWith('stream-') && isGenerating ? toolActivities : run?.actions ?? [];
      const isAgentTurn = message.role === 'assistant' && (active?.mode === 'agent' || message.id === (run && runTurnId(run.id)));
      const body = editingId === message.id ? <MessageEditor text={editingText} onChange={setEditingText} onSave={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }} onCancel={() => setEditingId(null)} /> : <>{message.projectReferences?.length ? <MessageProjectReferences references={message.projectReferences} /> : null}{message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}{message.role === 'assistant' && (isAgentTurn || message.thinking || message.thinkingTimeline?.length) ? <AgentTimeline timeline={message.thinkingTimeline} activities={isAgentTurn ? activities : []} messages={rendered} reasoning={message.thinking} now={agentClock} streaming={message.id.startsWith('stream-') && isGenerating} error={message.agentError} cancelled={message.agentCancelled} /> : null}{message.content ? <Markdown streaming={message.id.startsWith('stream-') && isGenerating}>{message.content}</Markdown> : null}{message.role === 'assistant' && message.id.startsWith('stream-') && isGenerating && progressIndicatorLabel(generationState, toolActivities, isAgentTurn) ? <GenerationIndicator state={generationState} toolLabel={progressIndicatorLabel(generationState, toolActivities, isAgentTurn) ?? undefined} /> : null}{message.role === 'assistant' && message.richArtifacts?.length ? <Suspense fallback={null}><RichArtifacts artifacts={message.richArtifacts} /></Suspense> : null}{message.role === 'assistant' && (!message.id.startsWith('stream-') || !isGenerating) && galleryFailureWarning(activities, message.richArtifacts) ? <p className="rich-response-warning" role="status">{t('Галерея не создана. Найденные изображения и ссылки не означают, что галерея была показана.')}</p> : null}{message.role === 'assistant' && message.generationStats ? <GenerationStatsView stats={message.generationStats} /> : null}</>;
      const editing = editingId === message.id;
      return <article className={`message ${message.role} ${editing ? 'is-editing' : ''} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}>{message.role === 'user' ? <div className="user-message-stack"><div className="message-content">{body}</div>{!editing && <UserMessageActions content={message.content} onEdit={() => { if (!generationConversationId) { setEditingId(message.id); setEditingText(message.content); } }} onRegenerate={() => { void regenerateMessage(message); }} regenerateDisabled={!activeConversationModel(active, settings?.llamaRuntime) || Boolean(generationConversationId)} />}</div> : <div className="message-content">{body}</div>}</article>;
    })}
    {!isGenerating && active?.mode === 'agent' && messages.at(-1)?.role === 'user' && analysisRuns.at(-1)?.status === 'interrupted' && <p className="agent-notice" role="status">{t("Предыдущий запуск был прерван. Его прогресс сохранён: отправьте сообщение, чтобы продолжить, или нажмите «Сгенерировать ответ заново», чтобы начать с чистого состояния.")}</p>}
    {lastFinishReason === 'length' && !isGenerating && <p className="truncation-notice" role="status">{t("Ответ сохранён, но достигнут предел продолжения. Текст выше не потерян.")}</p>}
    <div ref={endRef} />
  </section><Composer /></main></div>;
}
