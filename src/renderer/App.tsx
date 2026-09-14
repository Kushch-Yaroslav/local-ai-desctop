import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Pencil, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { Markdown } from './components/Markdown';
import { useAppStore } from './store/app-store';
import type { ApprovalDecision, Attachment, ToolActivity } from '../shared/types';

function GenerationIndicator({ state }: { state: string }) {
  const label = state === 'waiting-for-approval' ? 'Ожидает подтверждения' : state === 'using-tool' ? 'Обрабатываю вложения или использую инструмент' : state === 'running-terminal' ? 'Запускаю terminal' : state === 'stopping' ? 'Останавливаю' : state === 'generating' ? 'Пишу ответ' : 'Думаю';
  return <div className="generation-indicator" role="status" aria-label={label}><span className="generation-orb" /><span>{label}</span><i /><i /><i /></div>;
}

function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  return <div className="message-attachments">{attachments.map((attachment) => <MessageAttachment key={attachment.id} attachment={attachment} />)}</div>;
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
  const approval = activity.approval;
  const status = approval?.status === 'approved' ? '✓ Разрешено' : approval?.status === 'session-approved' ? '✓ Разрешено правилом сессии' : approval?.status === 'rejected' ? '✕ Отклонено пользователем' : null;
  return <div className="tool-action"><p className="tool-action-row"><i /><span className="tool-action-label">{activity.label}</span>{activity.detail && <small className="tool-action-detail">{activity.detail}</small>}</p>{approval?.status === 'pending' && onApproval && <div className="tool-approval"><strong>Требуется подтверждение</strong><div><button disabled={approvalSubmitting} onClick={() => onApproval('reject')}>Отклонить</button><button disabled={approvalSubmitting} onClick={() => onApproval('once')}>Разрешить</button><button disabled={approvalSubmitting} onClick={() => onApproval('session')}>Всегда разрешать в этой сессии</button></div></div>}{status && <small className={`tool-approval-status ${approval?.status}`}>{status}</small>}</div>;
}

export function App() {
  const { initialize, refreshHardware, handleStream, activeId, conversations, messages, error, isGenerating, generationState, toolActivities, toolActivityCount, analysisProgress, analysisRuns, editMessage, continueGeneration, lastFinishReason, approveAction, approvalSubmitting } = useAppStore();
  const endRef = useRef<HTMLDivElement>(null); const conversationRef = useRef<HTMLElement>(null); const followStream = useRef(true);
  const [editingId, setEditingId] = useState<string | null>(null); const [editingText, setEditingText] = useState('');
  const active = conversations.find((item) => item.id === activeId);
  useEffect(() => { void initialize(); const timer = window.setInterval(() => void refreshHardware(), 2_000); const unlisten = window.localAi.chat.onStream(handleStream); return () => { window.clearInterval(timer); unlisten(); }; }, [initialize, refreshHardware, handleStream]);
  useLayoutEffect(() => { followStream.current = true; }, [activeId]);
  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || !followStream.current) return;
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: isGenerating ? 'auto' : 'smooth' });
  }, [messages, isGenerating]);
  const updateFollowState = () => { const element = conversationRef.current; if (element) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; };
  const stageLabels = { reconnaissance: 'Изучение структуры', 'project-map': 'Построение карты проекта', prioritization: 'Выбор важных частей', investigation: 'Исследование важных частей', coverage: 'Проверка покрытия', synthesis: 'Подготовка ответа' };
  return <div className="app-shell"><Sidebar /><main className="main"><Toolbar /><section ref={conversationRef} onScroll={updateFollowState} className="conversation">{active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> Агент использует {active.workingDirectory ? 'выбранную рабочую папку' : 'папку приложения по умолчанию'} и может запускать контролируемые terminal-команды{active.webMode === 'auto' ? ', а также использовать изолированный web.' : '.'}</div>}{messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>Чем могу помочь?</h1><p>Выберите одну из локальных моделей и начните разговор.</p></div>}{messages.map((message) => <article className={`message ${message.role} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}><div className="message-content">{editingId === message.id ? <div className="message-editor"><textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} autoFocus /><button aria-label="Сохранить" onClick={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }}><Check size={15} /></button><button aria-label="Отмена" onClick={() => setEditingId(null)}><X size={15} /></button></div> : <>{message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}{message.content ? <Markdown>{message.content}</Markdown> : message.role === 'assistant' && isGenerating ? <GenerationIndicator state={generationState} /> : null}{message.role === 'user' && <button className="message-edit" title="Редактировать" aria-label="Редактировать сообщение" onClick={() => { setEditingId(message.id); setEditingText(message.content); }}><Pencil size={14} /></button>}</>}{message.role === 'assistant' && analysisRuns.filter((run) => run.assistantMessageId === message.id).map((run) => <details className="tool-activity persisted-analysis" key={run.id}><summary>Анализ проекта · {run.actionCount} действий <span>{run.depth === 'fast' ? 'Быстрый' : run.depth === 'enhanced' ? 'Повышенный' : run.depth === 'deep' ? 'Глубокий' : 'Обычный'} · {run.status === 'completed' ? 'готово' : run.status}</span></summary><div>{run.actions.map((activity) => <ToolActivityItem key={activity.id} activity={activity} />)}</div></details>)}</div></article>)}{lastFinishReason === 'length' && !isGenerating && <button className="continue-button" onClick={() => void continueGeneration()}>Продолжить ответ</button>}{analysisProgress.length > 0 && <div className="analysis-progress"><strong>Глубокий анализ · {toolActivityCount} действий</strong>{analysisProgress.map((progress) => <p key={progress.stage} className={progress.status}>{stageLabels[progress.stage]} {progress.status === 'complete' ? '✓' : '…'}</p>)}</div>}{toolActivities.length > 0 && <details className="tool-activity" open={isGenerating}><summary>Действия агента <span>· {toolActivityCount} действий</span></summary><div>{toolActivities.map((activity) => <ToolActivityItem key={activity.id} activity={activity} onApproval={(decision) => void approveAction(decision)} approvalSubmitting={approvalSubmitting} />)}</div></details>}{error && <div className="error"><AlertCircle size={18} /><div><strong>Не удалось выполнить запрос</strong><br />{error}</div></div>}<div ref={endRef} /></section><Composer /></main></div>;
}
