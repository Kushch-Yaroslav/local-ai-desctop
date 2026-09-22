import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Brain, Check, ChevronRight, CircleDot, Copy, File, Folder, ListTodo, Pencil, RotateCcw, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { Markdown } from './components/Markdown';
import { useAppStore } from './store/app-store';
import type { AgentPlan, AnalysisRun, ApprovalDecision, Attachment, GenerationStats, ProjectReference, ToolActivity } from '../shared/types';
import { parseTaskNotes } from '../shared/task-notes-format';
import { pendingTimelineActivities, thinkingTimeline } from '../shared/thinking-timeline';

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

const noteInline = (text: string) => text.split(/((?:[\w.-]+\/)+[\w./-]+|\b(?:npm|pnpm|yarn|git)\s+[\w./:@=-]+)/g).map((part, index) => /^(?:[\w.-]+\/)+[\w./-]+$|^(?:npm|pnpm|yarn|git)\s+/.test(part) ? <code key={index}>{part}</code> : part);
function TaskNotesContent({ notes }: { notes: string }) {
  const [expanded, setExpanded] = useState(false); const long = notes.length > 1_200;
  const visible = long && !expanded ? notes.slice(0, 1_200).replace(/\s+\S*$/, '').trimEnd() : notes;
  return <div className="task-notes-content">{parseTaskNotes(visible).map((block, index) => block.kind === 'paragraph' ? <p key={index}>{block.lines.map((line, lineIndex) => <span key={lineIndex}>{noteInline(line)}{lineIndex < block.lines.length - 1 && <br />}</span>)}</p> : block.kind === 'unordered' ? <ul key={index}>{block.lines.map((line, lineIndex) => <li key={lineIndex}>{noteInline(line)}</li>)}</ul> : <ol key={index}>{block.lines.map((line, lineIndex) => <li key={lineIndex}>{noteInline(line)}</li>)}</ol>)}{long && <button type="button" className="task-notes-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Свернуть' : 'Показать полностью'}</button>}</div>;
}

const THINKING_DEFAULT_HEIGHT = 360; const THINKING_MIN_HEIGHT = 190;

function ThinkingBlock({ content, timeline: recordedTimeline, streaming, activities = [], onApproval, approvalSubmitting = false, onReadingOlder }: { content?: string; timeline?: import('../shared/types').ThinkingTimelineEvent[]; streaming: boolean; activities?: ToolActivity[]; onApproval?: (decision: ApprovalDecision) => void; approvalSubmitting?: boolean; onReadingOlder?: () => void }) {
  const [expanded, setExpanded] = useState(streaming); const [height, setHeight] = useState(THINKING_DEFAULT_HEIGHT); const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight); const [highlightedApprovalId, setHighlightedApprovalId] = useState<string | null>(null); const [focusActivityId, setFocusActivityId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null); const followRef = useRef(true); const programmaticScroll = useRef(false); const highlightTimer = useRef<number | null>(null);
  useEffect(() => { if (streaming) setExpanded(true); }, [streaming]);
  useEffect(() => { const update = () => setViewportHeight(window.innerHeight); window.addEventListener('resize', update); return () => { window.removeEventListener('resize', update); if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current); }; }, []);
  const maxHeight = Math.max(THINKING_MIN_HEIGHT, viewportHeight - 240); const effectiveHeight = Math.min(height, maxHeight);
  const timeline = thinkingTimeline(content, activities, streaming, recordedTimeline); const pendingApprovals = pendingTimelineActivities(timeline); const pending = pendingApprovals[0];
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!streaming || !expanded || !element || !followRef.current) return;
    const frame = window.requestAnimationFrame(() => { if (!followRef.current) return; programmaticScroll.current = true; element.scrollTop = element.scrollHeight; window.requestAnimationFrame(() => { programmaticScroll.current = false; }); });
    return () => window.cancelAnimationFrame(frame);
  }, [streaming, expanded, content, activities, effectiveHeight]);
  useLayoutEffect(() => {
    if (!focusActivityId || !expanded) return;
    const frame = window.requestAnimationFrame(() => { const container = scrollRef.current; const target = container?.querySelector<HTMLElement>(`[data-activity-id="${focusActivityId}"]`); if (container && target) container.scrollTo({ top: container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - target.clientHeight) / 2, behavior: 'smooth' }); setFocusActivityId(null); });
    return () => window.cancelAnimationFrame(frame);
  }, [focusActivityId, expanded, timeline]);
  if (!timeline.length) return null;
  const updateFollow = () => { const element = scrollRef.current; if (!element || programmaticScroll.current) return; followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48; if (!followRef.current) onReadingOlder?.(); };
  const focusApproval = () => { if (!pending) return; followRef.current = false; setExpanded(true); setFocusActivityId(pending.activity.id); setHighlightedApprovalId(pending.activity.id); if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current); highlightTimer.current = window.setTimeout(() => setHighlightedApprovalId(null), 1_600); };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => { event.preventDefault(); const startY = event.clientY; const startHeight = effectiveHeight; const resize = (move: PointerEvent) => setHeight(Math.max(THINKING_MIN_HEIGHT, Math.min(Math.max(THINKING_MIN_HEIGHT, window.innerHeight - 240), startHeight + move.clientY - startY))); const finish = () => { window.removeEventListener('pointermove', resize); window.removeEventListener('pointerup', finish); }; window.addEventListener('pointermove', resize); window.addEventListener('pointerup', finish, { once: true }); };
  return <details className={`thinking-block${streaming ? ' is-streaming' : ''}`} open={expanded} onToggle={(event) => { if (event.currentTarget !== event.target) return; const open = (event.currentTarget as HTMLDetailsElement).open; setExpanded(open); if (open && streaming) { followRef.current = true; window.requestAnimationFrame(() => { const element = scrollRef.current; if (!element) return; programmaticScroll.current = true; element.scrollTop = element.scrollHeight; window.requestAnimationFrame(() => { programmaticScroll.current = false; }); }); } }}><summary><ChevronRight size={14} /><Brain size={14} /><strong>Thinking</strong>{streaming && <span>· thinking…</span>}</summary>{pending && <button type="button" className="thinking-approval-trigger" onClick={focusApproval}>Требуется подтверждение{pendingApprovals.length > 1 ? ` · ${pendingApprovals.length}` : ''}</button>}<div ref={scrollRef} style={{ height: effectiveHeight }} className="thinking-content thinking-timeline" onScroll={updateFollow} onWheel={(event) => { if (event.deltaY < 0) { followRef.current = false; onReadingOlder?.(); } }}>{timeline.map((item) => item.kind === 'reasoning' ? <section className={`thinking-timeline-item reasoning${item.live ? ' live' : ''}`} key={item.id}><Markdown streaming={item.live}>{item.content}</Markdown></section> : <section data-activity-id={item.activity.id} className={`thinking-timeline-item activity${highlightedApprovalId === item.activity.id ? ' is-approval-target' : ''}`} key={item.id}><ToolActivityItem activity={item.activity} onApproval={onApproval} approvalSubmitting={approvalSubmitting} /></section>)}<div className="thinking-resize-handle" onPointerDown={beginResize} aria-label="Изменить высоту Thinking" role="separator" aria-orientation="horizontal" /></div></details>;
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

function ToolActivityItem({ activity, onApproval, approvalSubmitting = false }: { activity: ToolActivity; onApproval?: (decision: ApprovalDecision) => void; approvalSubmitting?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const approval = activity.approval;
  const approvalStatus = approval?.status === 'approved' ? '✓ Разрешено' : approval?.status === 'session-approved' ? '✓ Разрешено правилом сессии' : approval?.status === 'rejected' ? '✕ Отклонено пользователем' : null;
  const icon = activity.kind === 'progress' ? <CircleDot size={13} /> : activity.kind === 'planning' ? <ListTodo size={13} /> : activity.kind === 'notes' ? '▤' : activity.kind === 'context' ? '◌' : activity.kind === 'file_read' || activity.kind === 'directory' ? '↳' : activity.kind === 'search' ? '⌕' : activity.kind === 'terminal' ? '$' : activity.kind === 'mutation' ? '✎' : activity.kind === 'git' ? '⌁' : '•';
  const isPlan = activity.kind === 'planning' && Boolean(activity.plan);
  const isNotes = activity.kind === 'notes' && Boolean(activity.output);
  const hasDetails = !isPlan && !isNotes && Boolean((activity.metadata && Object.keys(activity.metadata).length) || activity.output);
  return <div className={`tool-action ${activity.kind === 'progress' ? 'progress' : ''} ${activity.kind ?? 'other'} ${activity.state ?? ''}`}>
    <p className="tool-action-row"><i>{icon}</i><span className="tool-action-copy"><span className="tool-action-label">{activity.label}</span>{activity.detail && <small className="tool-action-detail">{activity.detail}</small>}</span>{activity.state === 'completed' && <small className="tool-action-complete">Завершено</small>}{activity.state === 'error' && <small className="tool-action-error">Ошибка</small>}</p>
    {isPlan && <PlanCard plan={activity.plan!} title={activity.detail ?? 'Планирование'} compact />}
    {isNotes && <TaskNotesContent notes={activity.output!} />}
    {hasDetails && <details className="tool-action-details" open={detailsOpen} onToggle={(event) => { event.stopPropagation(); setDetailsOpen((event.currentTarget as HTMLDetailsElement).open); }}><summary>Детали</summary>{detailsOpen && <div>{activity.metadata && Object.entries(activity.metadata).map(([key, value]) => <p key={key}><span>{key}</span>{String(value)}</p>)}{activity.output && <pre>{activity.output}</pre>}</div>}</details>}
    {approval?.status === 'pending' && onApproval && <div className="tool-approval"><strong>Требуется подтверждение</strong><div><button disabled={approvalSubmitting} onClick={() => onApproval('reject')}>Отклонить</button><button disabled={approvalSubmitting} onClick={() => onApproval('once')}>Разрешить</button><button disabled={approvalSubmitting} onClick={() => onApproval('session')}>Всегда разрешать в этой сессии</button></div></div>}
    {approvalStatus && <small className={`tool-approval-status ${approval?.status}`}>{approvalStatus}</small>}
  </div>;
}

function durationLabel(start: string, end: string | null): string | null {
  if (!end) return null;
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}м ${seconds % 60}с` : `${seconds}с`;
}
function PlanCard({ plan, title = 'Последняя версия плана', compact = false }: { plan: AgentPlan; title?: string; compact?: boolean }) {
  const marker = (status: AgentPlan['steps'][number]['status']) => status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○';
  return <section className={`agent-plan ${compact ? 'compact' : ''}`} aria-label="План работы"><p><ListTodo size={14} /><strong>{title}</strong></p><ol>{plan.steps.map((step) => <li className={step.status} key={step.id}><i>{marker(step.status)}</i><span>{step.label}</span></li>)}</ol></section>;
}
function ActivityTrace({ activities, actionCount, status, createdAt, completedAt, active, onApproval, approvalSubmitting }: { activities: ToolActivity[]; actionCount: number; status: 'running' | 'completed' | 'error' | 'cancelled'; createdAt?: string; completedAt?: string | null; active: boolean; onApproval?: (decision: ApprovalDecision) => void; approvalSubmitting?: boolean }) {
  const [expanded, setExpanded] = useState(active); const wasActive = useRef(active);
  useEffect(() => { if (wasActive.current && !active) setExpanded(false); wasActive.current = active; }, [active]);
  const latestProgress = [...activities].reverse().find((activity) => activity.kind === 'progress')?.label;
  const stateLabel = status === 'completed' ? 'завершено' : status === 'cancelled' ? 'остановлено' : status === 'error' ? 'ошибка' : latestProgress ? `${latestProgress}…` : 'Работа агента';
  const duration = createdAt ? durationLabel(createdAt, completedAt ?? null) : null;
  const latestPlanActivity = [...activities].reverse().find((activity) => activity.kind === 'planning' && activity.plan);
  const visibleActivities = activities.filter((activity) => !(activity.kind === 'planning' && activity.plan));
  return <details className={`tool-activity activity-trace${active ? ' is-streaming' : ''}`} open={expanded} onToggle={(event) => { if (event.currentTarget !== event.target) return; setExpanded((event.currentTarget as HTMLDetailsElement).open); }}><summary><ChevronRight size={15} /><strong>{active && latestProgress ? latestProgress : 'Работа агента'}</strong><span>· {actionCount} действий{duration ? ` · ${duration}` : ''}{!active ? ` · ${stateLabel}` : ''}</span></summary><div>{latestPlanActivity?.plan && <PlanCard plan={latestPlanActivity.plan} title={latestPlanActivity.detail ?? 'Последняя версия плана'} />}{visibleActivities.map((activity) => <ToolActivityItem key={activity.id} activity={activity} onApproval={onApproval} approvalSubmitting={approvalSubmitting} />)}</div></details>;
}

export function App() {
  const { initialize, refreshHardware, handleStream, activeId, conversations, messages, error, isGenerating, generationState, toolActivities, toolActivityCount, analysisRuns, editMessage, regenerateMessage, continueGeneration, lastFinishReason, approveAction, approvalSubmitting } = useAppStore();
  const endRef = useRef<HTMLDivElement>(null); const conversationRef = useRef<HTMLElement>(null); const followStream = useRef(true);
  const [editingId, setEditingId] = useState<string | null>(null); const [editingText, setEditingText] = useState('');
  const active = conversations.find((item) => item.id === activeId);
  useEffect(() => { void initialize(); const timer = window.setInterval(() => void refreshHardware(), 2_000); const unlisten = window.localAi.chat.onStream(handleStream); return () => { window.clearInterval(timer); unlisten(); }; }, [initialize, refreshHardware, handleStream]);
  useLayoutEffect(() => { followStream.current = true; }, [activeId]);
  useLayoutEffect(() => { const conversation = conversationRef.current; if (!conversation || !followStream.current) return; conversation.scrollTo({ top: conversation.scrollHeight, behavior: isGenerating ? 'auto' : 'smooth' }); }, [messages, isGenerating, toolActivities]);
  const updateFollowState = () => { const element = conversationRef.current; if (element) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; };
  const runFor = (run: AnalysisRun) => <ActivityTrace key={run.id} activities={run.actions} actionCount={run.actionCount} status={run.status} createdAt={run.createdAt} completedAt={run.completedAt} active={false} />;
  return <div className="app-shell"><Sidebar /><main className="main"><Toolbar /><section ref={conversationRef} onScroll={updateFollowState} className="conversation">
    {active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> {active.workingDirectory ? 'Файловые инструменты ограничены выбранным проектом; terminal стартует в его корне и может работать с пользовательскими путями.' : 'Файловые инструменты проекта отключены; terminal стартует в домашней папке и может выполнять контролируемые системные задачи.'}{active.webMode === 'auto' ? ' Также доступен изолированный web.' : ''}</div>}
    {messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>Чем могу помочь?</h1><p>Выберите одну из локальных моделей и начните разговор.</p></div>}
    {messages.map((message) => {
      const run = analysisRuns.find((candidate) => candidate.assistantMessageId === message.id);
      const activities = message.id.startsWith('stream-') && isGenerating ? toolActivities : run?.actions ?? [];
      const body = editingId === message.id ? <MessageEditor text={editingText} onChange={setEditingText} onSave={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }} onCancel={() => setEditingId(null)} /> : <>{message.projectReferences?.length ? <MessageProjectReferences references={message.projectReferences} /> : null}{message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}{message.role === 'assistant' && (message.thinking || activities.length > 0) ? <ThinkingBlock content={message.thinking} timeline={message.thinkingTimeline} activities={activities} streaming={message.id.startsWith('stream-') && isGenerating} onApproval={(decision) => void approveAction(decision)} approvalSubmitting={approvalSubmitting} onReadingOlder={() => { followStream.current = false; }} /> : null}{message.content ? <Markdown streaming={message.id.startsWith('stream-') && isGenerating}>{message.content}</Markdown> : message.role === 'assistant' && isGenerating && !message.thinking ? <GenerationIndicator state={generationState} /> : null}{message.role === 'assistant' && message.generationStats ? <GenerationStatsView stats={message.generationStats} /> : null}</>;
      const editing = editingId === message.id;
      return <article className={`message ${message.role} ${editing ? 'is-editing' : ''} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}>{message.role === 'user' ? <div className="user-message-stack"><div className="message-content">{body}</div>{!editing && <UserMessageActions content={message.content} onEdit={() => { setEditingId(message.id); setEditingText(message.content); }} onRegenerate={() => { void regenerateMessage(message); }} regenerateDisabled={isGenerating} />}</div> : <div className="message-content">{body}</div>}</article>;
    })}
    {lastFinishReason === 'length' && !isGenerating && <button className="continue-button" onClick={() => void continueGeneration()}>Продолжить ответ</button>}
    {!isGenerating && toolActivities.length > 0 && (generationState === 'cancelled' || generationState === 'error') && <ActivityTrace activities={toolActivities} actionCount={toolActivityCount} status={generationState} active={false} onApproval={(decision) => void approveAction(decision)} approvalSubmitting={approvalSubmitting} />}
    {!isGenerating && analysisRuns.filter((run) => !run.assistantMessageId).map(runFor)}
    {error && <div className="error"><AlertCircle size={18} /><div><strong>Не удалось выполнить запрос</strong><br />{error}</div></div>}<div ref={endRef} />
  </section><Composer /></main></div>;
}
