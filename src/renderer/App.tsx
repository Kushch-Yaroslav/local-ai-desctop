import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Pencil, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Composer } from './components/Composer';
import { Markdown } from './components/Markdown';
import { useAppStore } from './store/app-store';

function GenerationIndicator({ state }: { state: string }) {
  const label = state === 'using-tool' ? 'Использую инструмент' : state === 'running-terminal' ? 'Запускаю terminal' : state === 'stopping' ? 'Останавливаю' : state === 'generating' ? 'Пишу ответ' : 'Думаю';
  return <div className="generation-indicator" role="status" aria-label={label}><span className="generation-orb" /><span>{label}</span><i /><i /><i /></div>;
}

export function App() {
  const { initialize, refreshHardware, handleStream, activeId, conversations, messages, error, isGenerating, generationState, toolActivities, toolActivityCount, analysisProgress, analysisRuns, editMessage } = useAppStore();
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
  return <div className="app-shell"><Sidebar /><main className="main"><Toolbar /><section ref={conversationRef} onScroll={updateFollowState} className="conversation">{active?.mode === 'agent' && <div className="agent-notice"><Bot size={17} /> Агент использует {active.workingDirectory ? 'выбранную рабочую папку' : 'папку приложения по умолчанию'} и может запускать контролируемые terminal-команды{active.webMode === 'auto' ? ', а также использовать изолированный web.' : '.'}</div>}{messages.length === 0 && <div className="welcome"><Bot size={34} /><h1>Чем могу помочь?</h1><p>Выберите одну из локальных моделей и начните разговор.</p></div>}{messages.map((message) => <article className={`message ${message.role} ${message.id.startsWith('stream-') && isGenerating ? 'is-generating' : ''}`} key={message.id}><div className="message-content">{editingId === message.id ? <div className="message-editor"><textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} autoFocus /><button aria-label="Сохранить" onClick={() => { void (async () => { if (await editMessage(message, editingText)) setEditingId(null); })(); }}><Check size={15} /></button><button aria-label="Отмена" onClick={() => setEditingId(null)}><X size={15} /></button></div> : <>{message.content ? <Markdown>{message.content}</Markdown> : message.role === 'assistant' && isGenerating ? <GenerationIndicator state={generationState} /> : null}{message.role === 'user' && <button className="message-edit" title="Редактировать" aria-label="Редактировать сообщение" onClick={() => { setEditingId(message.id); setEditingText(message.content); }}><Pencil size={14} /></button>}</>}{message.role === 'assistant' && analysisRuns.filter((run) => run.assistantMessageId === message.id).map((run) => <details className="tool-activity persisted-analysis" key={run.id}><summary>Анализ проекта · {run.actionCount} действий <span>{run.depth === 'fast' ? 'Быстро' : run.depth === 'deep' ? 'Глубоко' : 'Обычно'} · {run.status === 'completed' ? 'готово' : run.status}</span></summary><div>{run.actions.map((activity) => <p key={run.id}><i />{activity.label}{activity.detail && <small>{activity.detail}</small>}</p>)}</div></details>)}</div></article>)}{analysisProgress.length > 0 && <div className="analysis-progress"><strong>Глубокий анализ · {toolActivityCount} действий</strong>{analysisProgress.map((progress) => <p key={progress.stage} className={progress.status}>{stageLabels[progress.stage]} {progress.status === 'complete' ? '✓' : '…'}</p>)}</div>}{toolActivities.length > 0 && <details className="tool-activity" open={isGenerating}><summary>Действия агента <span>· {toolActivityCount} действий</span></summary><div>{toolActivities.map((activity) => <p key={activity.id}><i />{activity.label}{activity.detail && <small>{activity.detail}</small>}</p>)}</div></details>}{error && <div className="error"><AlertCircle size={18} /><div><strong>Не удалось выполнить запрос</strong><br />{error}</div></div>}<div ref={endRef} /></section><Composer /></main></div>;
}
