import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, ChevronRight, CircleDot, File, Folder, ListTodo, Pencil, RotateCcw, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { Markdown } from './components/Markdown';
import { useAppStore } from './store/app-store';
import type { AgentPlan, AnalysisRun, ApprovalDecision, Attachment, ProjectReference, ToolActivity } from '../shared/types';

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
function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (attachment.kind !== 'image' || !attachment.storageRef) return; void window.localAi.attachments.dataUrl(attachment.id).then(setUrl); }, [attachment.id, attachment.kind, attachment.storageRef]);
  const imageNumber = Number(attachment.metadata?.imageNumber) || attachment.index + 1;
  const name = attachment.kind === 'image' ? `Image ${imageNumber}` : attachment.filename;
  const detail = attachment.status === 'ready' ? '✓ Готово' : attachment.status === 'processing' ? '◌ Обработка…' : attachment.status === 'ocr_required' ? 'OCR потребуется' : attachment.status === 'error' ? `✕ ${attachment.error ?? 'Ошибка'}` : attachment.status === 'cancelled' ? 'Отменено' : 'Ожидает обработки';
  return <div className={`message-attachment ${attachment.kind === 'image' ? 'image' : ''}`}>{url ? <img src={url} alt={name} /> : attachment.kind === 'image' ? <span className="attachment-image-placeholder">{imageNumber}</span> : <span className="attachment-file-icon">{attachment.filename.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span><strong>{name}</strong><small>{detail}</small></span></div>;
}

function ToolActivityItem({ activity, onApproval, approvalSubmitting = false }: { activity: ToolActivity; onApproval?: (decision: ApprovalDecision) => void; approvalSubmitting?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const approval = activity.approval;
  const approvalStatus = approval?.status === 'approved' ? '✓ Разрешено' : approval?.status === 'session-approved' ? '✓ Разрешено правилом сессии' : approval?.status === 'rejected' ? '✕ Отклонено пользователем' : null;
  const icon = activity.kind === 'progress' ? <CircleDot size={13} /> : activity.kind === 'planning' ? <ListTodo size={13} /> : activity.kind === 'file_read' || activity.kind === 'directory' ? '↳' : activity.kind === 'search' ? '⌕' : activity.kind === 'terminal' ? '$' : activity.kind === 'mutation' ? '✎' : activity.kind === 'git' ? '⌁' : '•';
  const hasDetails = Boolean((activity.metadata && Object.keys(activity.metadata).length) || activity.output);
  return <div className={`tool-action ${activity.kind === 'progress' ? 'progress' : ''} ${activity.state ?? ''}`}>
    <p className="tool-action-row"><i>{icon}</i><span className="tool-action-label">{activity.label}</span>{activity.detail && <small className="tool-action-detail">{activity.detail}</small>}{activity.state === 'error' && <small className="tool-action-error">Ошибка</small>}</p>
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
function PlanCard({ plan }: { plan: AgentPlan }) {
  const marker = (status: AgentPlan['steps'][number]['status']) => status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○';
  return <section className="agent-plan" aria-label="План работы"><p><ListTodo size={14} /><strong>Планирование</strong></p><ol>{plan.steps.map((step) => <li className={step.status} key={step.id}><i>{marker(step.status)}</i><span>{step.label}</span></li>)}</ol></section>;
}
function ActivityTrace({ activities, actionCount, status, createdAt, completedAt, active, onApproval, approvalSubmitting }: { activities: ToolActivity[]; actionCount: number; status: 'running' | 'completed' | 'error' | 'cancelled'; createdAt?: string; completedAt?: string | null; active: boolean; onApproval?: (decision: ApprovalDecision) => void; approvalSubmitting?: boolean }) {
  const [expanded, setExpanded] = useState(active); const wasActive = useRef(active);
  useEffect(() => { if (wasActive.current && !active) setExpanded(false); wasActive.current = active; }, [active]);
  const latestProgress = [...activities].reverse().find((activity) => activity.kind === 'progress')?.label;
  const stateLabel = status === 'completed' ? 'завершено' : status === 'cancelled' ? 'остановлено' : status === 'error' ? 'ошибка' : latestProgress ? `${latestProgress}…` : 'Работа агента';
  const duration = createdAt ? durationLabel(createdAt, completedAt ?? null) : null;
  const plan = [...activities].reverse().find((activity) => activity.kind === 'planning' && activity.plan)?.plan;
  const visibleActivities = activities.filter((activity) => activity.kind !== 'planning' || !activity.plan);
  return <details className="tool-activity activity-trace" open={expanded} onToggle={(event) => { if (event.currentTarget !== event.target) return; setExpanded((event.currentTarget as HTMLDetailsElement).open); }}><summary><ChevronRight size={15} /><strong>{active && latestProgress ? latestProgress : 'Работа агента'}</strong><span>· {actionCount} действий{duration ? ` · ${duration}` : ''}{!active ? ` · ${stateLabel}` : ''}</span></summary><div>{plan && <PlanCard plan={plan} />}{visibleActivities.map((activity) => <ToolActivityItem key={activity.id} activity={activity} onApproval={onApproval} approvalSubmitting={approvalSubmitting} />)}</div></details>;
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
    {active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> Агент использует {active.workingDirectory ? 'выбранную рабочую папку' : 'папку приложения по умолчанию'} и может запускать контролируемые terminal-команды{active.webMode === 'auto' ? ', а также использовать изолированный web.' : '.'}</div>}
    {messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>Чем могу помочь?</h1><p>Выберите одну из локальных моделей и начните разговор.</p></div>}
    {messages.map((message) => <article className={`message ${message.role} ${editingId === message.id ? 'is-editing' : ''} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}><div className="message-content">{editingId === message.id ? <MessageEditor text={editingText} onChange={setEditingText} onSave={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }} onCancel={() => setEditingId(null)} /> : <>{message.projectReferences?.length ? <MessageProjectReferences references={message.projectReferences} /> : null}{message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}{message.content ? <Markdown>{message.content}</Markdown> : message.role === 'assistant' && isGenerating ? <GenerationIndicator state={generationState} /> : null}{message.role === 'user' && <span className="message-actions"><button className="message-edit" title="Редактировать" aria-label="Редактировать сообщение" onClick={() => { setEditingId(message.id); setEditingText(message.content); }}><Pencil size={14} /></button><button className="message-regenerate" title="Сгенерировать ответ заново" aria-label="Сгенерировать ответ заново" disabled={isGenerating} onClick={() => { void regenerateMessage(message); }}><RotateCcw size={14} /></button></span>}</>}{message.role === 'assistant' && analysisRuns.filter((run) => run.assistantMessageId === message.id).map(runFor)}</div></article>)}
    {lastFinishReason === 'length' && !isGenerating && <button className="continue-button" onClick={() => void continueGeneration()}>Продолжить ответ</button>}
    {isGenerating && toolActivities.length > 0 && <ActivityTrace activities={toolActivities} actionCount={toolActivityCount} status="running" active onApproval={(decision) => void approveAction(decision)} approvalSubmitting={approvalSubmitting} />}
    {!isGenerating && toolActivities.length > 0 && (generationState === 'cancelled' || generationState === 'error') && <ActivityTrace activities={toolActivities} actionCount={toolActivityCount} status={generationState} active={false} onApproval={(decision) => void approveAction(decision)} approvalSubmitting={approvalSubmitting} />}
    {!isGenerating && analysisRuns.filter((run) => !run.assistantMessageId).map(runFor)}
    {error && <div className="error"><AlertCircle size={18} /><div><strong>Не удалось выполнить запрос</strong><br />{error}</div></div>}<div ref={endRef} />
  </section><Composer /></main></div>;
}
