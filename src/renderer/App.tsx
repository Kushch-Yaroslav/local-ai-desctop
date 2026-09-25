import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Check, Copy, File, Folder, Pencil, RotateCcw, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { TaskPlanPanel } from './components/Composer';
import { AgentTimeline } from './components/AgentTimeline';
import { Markdown } from './components/Markdown';
import { useAppStore } from './store/app-store';
import type { Attachment, GenerationStats, ProjectReference } from '../shared/types';

function GenerationIndicator({ state }: { state: string }) {
  const label = state === 'waiting-for-approval' ? 'Ожидает подтверждения' : state === 'using-tool' ? 'Использую инструмент' : state === 'running-terminal' ? 'Запускаю terminal' : state === 'stopping' ? 'Останавливаю' : state === 'generating' ? 'Пишу ответ' : 'Думаю';
  return <div className="generation-indicator" role="status" aria-label={label}><span className="generation-orb" /><span>{label}</span><i /><i /><i /></div>;
}

function MessageAttachments({ attachments }: { attachments: Attachment[] }) { return <div className="message-attachments">{attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}</div>; }
function MessageProjectReferences({ references }: { references: ProjectReference[] }) { return <div className="message-project-references">{references.map((reference) => <span key={reference.id} className={`message-project-reference project-${reference.projectSlot}`}>{reference.kind === 'folder' ? <Folder size={12} /> : <File size={12} />}<span>{reference.relativePath}</span><small>{reference.projectLabel}</small></span>)}</div>; }

const EDITOR_MAX_HEIGHT = 320;

function MessageEditor({ text, onChange, onSave, onCancel }: { text: string; onChange: (value: string) => void; onSave: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current; if (!textarea) return;
    textarea.style.height = '0px';
    const height = Math.min(textarea.scrollHeight, EDITOR_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > EDITOR_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [text]);
  return <div className="message-editor"><textarea ref={ref} value={text} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSave(); } }} autoFocus /><div className="message-editor-actions"><button aria-label="Сохранить" title="Сохранить (Enter)" onClick={onSave}><Check size={15} /></button><button aria-label="Отмена" title="Отмена (Esc)" onClick={onCancel}><X size={15} /></button></div></div>;
}

function UserMessageActions({ content, onEdit, onRegenerate, regenerateDisabled }: { content: string; onEdit: () => void; onRegenerate: () => void; regenerateDisabled: boolean }) {
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
  return <div className="user-message-actions" aria-label="Действия с сообщением"><button className={`user-message-action${copyState === 'error' ? ' is-error' : ''}`} title={copied ? 'Скопировано' : copyState === 'error' ? 'Не удалось скопировать' : 'Копировать текст'} aria-label={copied ? 'Текст скопирован' : 'Копировать текст'} onClick={() => { void copy(); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button><button className="user-message-action" title="Редактировать" aria-label="Редактировать сообщение" onClick={onEdit}><Pencil size={14} /></button><button className="user-message-action" title="Сгенерировать ответ заново" aria-label="Сгенерировать ответ заново" disabled={regenerateDisabled} onClick={onRegenerate}><RotateCcw size={14} /></button></div>;
}

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (attachment.kind !== 'image' || !attachment.storageRef) return; void window.localAi.attachments.dataUrl(attachment.id).then(setUrl); }, [attachment.id, attachment.kind, attachment.storageRef]);
  const imageNumber = Number(attachment.metadata?.imageNumber) || attachment.index + 1;
  const name = attachment.kind === 'image' ? `Image ${imageNumber}` : attachment.filename;
  const detail = attachment.status === 'ready' ? '✓ Готово' : attachment.status === 'processing' ? '◌ Обработка…' : attachment.status === 'ocr_required' ? 'OCR потребуется' : attachment.status === 'error' ? `✕ ${attachment.error ?? 'Ошибка'}` : attachment.status === 'cancelled' ? 'Отменено' : 'Ожидает обработки';
  return <div className={`message-attachment ${attachment.kind === 'image' ? 'image' : ''}`}>{url ? <img src={url} alt={name} /> : attachment.kind === 'image' ? <span className="attachment-image-placeholder">{imageNumber}</span> : <span className="attachment-file-icon">{attachment.filename.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span><strong>{name}</strong><small>{detail}</small></span></div>;
}

function GenerationStatsView({ stats }: { stats: GenerationStats }) {
  const number = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
  const tokens = (value: number) => {
    const rounded = Math.round(Math.abs(value)); const lastTwo = rounded % 100; const last = rounded % 10;
    return lastTwo >= 11 && lastTwo <= 14 ? 'токенов' : last === 1 ? 'токен' : last >= 2 && last <= 4 ? 'токена' : 'токенов';
  };
  const rate = stats.tokensPerSecond === undefined ? null : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: stats.tokensPerSecond >= 10 ? 0 : 1 }).format(stats.tokensPerSecond);
  const duration = stats.generationDurationMs === undefined ? null : `${(stats.generationDurationMs / 1000).toFixed(stats.generationDurationMs >= 10_000 ? 0 : 1)}s`;
  const details = [`Сгенерировано: ${number(stats.outputTokens)} ${tokens(stats.outputTokens)}`, rate && `Генерация: ${rate} ток/с`, duration && `Длительность генерации: ${duration}`, stats.timeToFirstTokenMs !== undefined && `Первый токен: ${(stats.timeToFirstTokenMs / 1000).toFixed(2)} с`, stats.inputTokens !== undefined && `Токенов промпта: ${number(stats.inputTokens)}`].filter(Boolean).join('\n');
  return <small className="generation-stats" title={details}>{rate ? `${rate} ток/с · ` : ''}{number(stats.outputTokens)} {tokens(stats.outputTokens)}</small>;
}

export function App() {
  const { initialize, refreshHardware, handleStream, activeId, conversations, messages, isGenerating, generationState, toolActivities, analysisRuns, editMessage, regenerateMessage, continueGeneration, lastFinishReason } = useAppStore();
  const endRef = useRef<HTMLDivElement>(null); const conversationRef = useRef<HTMLElement>(null); const followStream = useRef(true);
  const [editingId, setEditingId] = useState<string | null>(null); const [editingText, setEditingText] = useState('');
  const [agentClock, setAgentClock] = useState(() => Date.now());
  const active = conversations.find((item) => item.id === activeId);
  useEffect(() => { void initialize(); const timer = window.setInterval(() => void refreshHardware(), 2_000); const unlisten = window.localAi.chat.onStream(handleStream); return () => { window.clearInterval(timer); unlisten(); }; }, [initialize, refreshHardware, handleStream]);
  useEffect(() => { if (!isGenerating || active?.mode !== 'agent') return; setAgentClock(Date.now()); const timer = window.setInterval(() => setAgentClock(Date.now()), 1_000); return () => window.clearInterval(timer); }, [isGenerating, active?.mode]);
  useLayoutEffect(() => { followStream.current = true; }, [activeId]);
  useLayoutEffect(() => { const conversation = conversationRef.current; if (!conversation || !followStream.current) return; conversation.scrollTo({ top: conversation.scrollHeight, behavior: isGenerating ? 'auto' : 'smooth' }); }, [messages, isGenerating, toolActivities]);
  const updateFollowState = () => { const element = conversationRef.current; if (element) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; };
  return <div className="app-shell"><Sidebar /><main className="main"><Toolbar /><section ref={conversationRef} onScroll={updateFollowState} className="conversation">
    {active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> {active.workingDirectory ? 'Файловые инструменты ограничены выбранным проектом; terminal стартует в его корне и может работать с пользовательскими путями.' : 'Файловые инструменты проекта отключены; terminal стартует в домашней папке и может выполнять контролируемые системные задачи.'}{active.webMode === 'auto' ? ' Также доступен изолированный web.' : ''}</div>}
    {messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>Чем могу помочь?</h1><p>Выберите одну из локальных моделей и начните разговор.</p></div>}
    {messages.map((message) => {
      const run = analysisRuns.find((candidate) => candidate.assistantMessageId === message.id);
      const liveRun = message.id.startsWith('stream-') && isGenerating && active?.mode === 'agent' ? analysisRuns.find((candidate) => candidate.status === 'running' && candidate.assistantMessageId === null) : undefined;
      const activities = message.id.startsWith('stream-') && isGenerating ? toolActivities : run?.actions ?? [];
      const isAgentTurn = active?.mode === 'agent' && message.role === 'assistant';
      const body = editingId === message.id ? <MessageEditor text={editingText} onChange={setEditingText} onSave={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }} onCancel={() => setEditingId(null)} /> : <>{message.projectReferences?.length ? <MessageProjectReferences references={message.projectReferences} /> : null}{message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}{isAgentTurn ? <AgentTimeline timeline={message.thinkingTimeline} activities={activities} now={agentClock} streaming={message.id.startsWith('stream-') && isGenerating} error={message.agentError} cancelled={message.agentCancelled} /> : null}{message.content ? <Markdown streaming={message.id.startsWith('stream-') && isGenerating}>{message.content}</Markdown> : message.role === 'assistant' && isGenerating && !message.thinking && !isAgentTurn ? <GenerationIndicator state={generationState} /> : null}{message.role === 'assistant' && message.taskPlan ? <TaskPlanPanel plan={message.taskPlan} /> : null}{message.role === 'assistant' && message.generationStats ? <GenerationStatsView stats={message.generationStats} /> : null}</>;
      const editing = editingId === message.id;
      return <article className={`message ${message.role} ${editing ? 'is-editing' : ''} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}>{message.role === 'user' ? <div className="user-message-stack"><div className="message-content">{body}</div>{!editing && <UserMessageActions content={message.content} onEdit={() => { setEditingId(message.id); setEditingText(message.content); }} onRegenerate={() => { void regenerateMessage(message); }} regenerateDisabled={isGenerating} />}</div> : <div className="message-content">{body}</div>}</article>;
    })}
    {lastFinishReason === 'length' && !isGenerating && <button className="continue-button" onClick={() => void continueGeneration()}>Продолжить ответ</button>}
    <div ref={endRef} />
  </section><Composer /></main></div>;
}
