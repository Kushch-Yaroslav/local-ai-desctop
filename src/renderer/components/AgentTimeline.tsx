import { memo, useState } from 'react';
import type { ChatMessage, DeliverableItem, TerminalExecution, ThinkingTimelineEvent, ToolActivity } from '../../shared/types';
import { Markdown } from './Markdown';
import { thinkingTimeline } from '../../shared/thinking-timeline';
import { formatDuration, pluralRu } from '../../shared/localization';

type Props = { timeline?: ThinkingTimelineEvent[]; activities: ToolActivity[]; messages: ChatMessage[]; reasoning?: string; streaming: boolean; now: number; error?: string; cancelled?: boolean };

const elapsed = (start?: string, end?: string, now = Date.now()) => {
  if (!start) return null; const seconds = Math.max(0, Math.round(((end ? new Date(end).getTime() : now) - new Date(start).getTime()) / 1000));
  return formatDuration(seconds);
};
const actionTitle = (activity: ToolActivity) => ({ file_read: 'Чтение', directory: 'Просмотр структуры проекта', mutation: activity.label, terminal: '$ Терминал', web: 'Браузер', context: 'Контекст сжат' } as Record<string, string>)[activity.kind ?? ''] ?? activity.label;

type StructuredEntry = { path?: unknown; name?: unknown; id?: unknown; status?: unknown; truncated?: unknown; message?: unknown };
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
function entryLine(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) return JSON.stringify(entry);
  if (!entry || typeof entry !== 'object') return entry === null ? 'entry' : String(entry);
  const value = entry as StructuredEntry;
  const label = text(value.path) ?? text(value.name) ?? text(value.id) ?? 'entry';
  const status = text(value.status);
  const message = text(value.message);
  return [label, status && status !== 'ok' ? status : undefined, value.truncated === true ? 'обрезано' : undefined, message].filter(Boolean).join(' · ');
}
function structuredEntries(result: unknown): unknown[] | undefined {
  return result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as { entries?: unknown }).entries) ? (result as { entries: unknown[] }).entries : undefined;
}
const deliverableMarker = { done: '✓', blocked: '⊘', pending: '○', dropped: '–' } as const;
/** The requested-deliverables list from a `deliverables` tool result, as a checklist. */
export function deliverablesChecklist(output: string | undefined): { lines: string[]; done: number; open: number; total: number } | undefined {
  if (!output) return undefined;
  try {
    const items = (JSON.parse(output) as { deliverables?: { items?: DeliverableItem[] } }).deliverables?.items;
    if (!Array.isArray(items)) return undefined;
    const live = items.filter((item) => item.status !== 'dropped');
    return {
      lines: live.map((item) => `${deliverableMarker[item.status] ?? '○'} ${item.text}${item.status === 'blocked' && item.reason ? ` — не выполнено: ${item.reason}` : ''}`),
      done: live.filter((item) => item.status === 'done').length, open: live.filter((item) => item.status === 'pending').length, total: live.length,
    };
  } catch { return undefined; }
}
export function toolResultSummary(activity: ToolActivity): string | undefined {
  const checklist = activity.detail === 'deliverables' ? deliverablesChecklist(activity.output) : undefined;
  if (checklist) return `выполнено ${checklist.done} из ${checklist.total}${checklist.open ? ` · осталось ${checklist.open}` : ''}`;
  if (activity.detail === 'project_knowledge_read') {
    try {
      const entries = structuredEntries(JSON.parse(activity.output ?? ''));
      if (entries) return `${entries.length} ${pluralRu(entries.length, 'запись', 'записи', 'записей')} знаний${entries.length ? ` · ${entries.slice(0, 2).map(entryLine).join(', ')}` : ''}`;
    } catch { /* Fall through to the event detail. */ }
  }
  if (activity.kind === 'directory') {
    try { const entries = structuredEntries(JSON.parse(activity.output ?? '')); return entries ? `${entries.length} ${pluralRu(entries.length, 'элемент', 'элемента', 'элементов')}` : activity.detail; } catch { return activity.detail; }
  }
  return activity.detail;
}
export function displayToolResult(activity: ToolActivity): string | undefined {
  if (!activity.output) return undefined;
  const checklist = activity.detail === 'deliverables' ? deliverablesChecklist(activity.output) : undefined;
  if (checklist) return checklist.lines.join('\n');
  try {
    const result = JSON.parse(activity.output) as { command?: string; stdout?: string; stderr?: string; exit_code?: number; status?: string; timed_out?: boolean; cancelled?: boolean; content?: string };
    if (activity.kind === 'terminal') return `${result.command ? `$ ${result.command}\n` : ''}${result.status === 'partial_success' ? '✓ частичный результат поиска (следующая команда закрыла канал после вывода)' : result.exit_code === 0 ? '✓ код выхода 0' : result.exit_code !== undefined ? `✗ код выхода ${result.exit_code}` : ''}${result.timed_out ? ' · превышено время' : ''}${result.cancelled ? ' · отменено' : ''}${result.stdout ? `\n${result.stdout}` : ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    if (typeof result.content === 'string') return result.content;
    const entries = structuredEntries(result);
    if (entries) return entries.map(entryLine).join('\n');
    return JSON.stringify(result, null, 2);
  } catch { /* Streaming tool output is already presentation text. */ }
  return activity.output;
}

function TerminalDetails({ terminal, fallback }: { terminal?: TerminalExecution; fallback?: string }) {
  if (!terminal) return fallback ? <><h4>Диагностика</h4><pre>{fallback}</pre></> : null;
  const status = terminal.status === 'completed' ? '✓ завершено' : terminal.status === 'partial_success' ? '✓ частичный результат поиска (следующая команда закрыла канал после вывода)' : terminal.status === 'cancelled' ? 'Отменено' : terminal.status === 'timed_out' ? 'Превышено время' : terminal.status === 'error' ? 'Ошибка' : 'Выполняется';
  return <>
    {terminal.command && <><h4>Команда</h4><pre>{terminal.command}</pre></>}
    <h4>Диагностика</h4><pre>{[terminal.cwd && `каталог: ${terminal.cwd}`, terminal.pid && `pid: ${terminal.pid} · pgid: ${terminal.pgid ?? '—'} · сессия: ${terminal.sessionId ?? '—'}`, terminal.startedAt && `начато: ${terminal.startedAt}`, terminal.finishedAt && `завершено: ${terminal.finishedAt}`, `статус: ${status}`, terminal.exitCode !== null && terminal.exitCode !== undefined && `код выхода: ${terminal.exitCode}`, terminal.timedOut && 'превышено время: да', terminal.cancelled && 'отменено: да'].filter(Boolean).join('\n')}</pre>
    {terminal.stdout && <><h4>Стандартный вывод</h4><pre>{terminal.stdout}</pre></>}
    {terminal.stderr && <><h4>Вывод ошибок</h4><pre>{terminal.stderr}</pre></>}
  </>;
}

const Action = memo(function Action({ activity }: { activity: ToolActivity }) {
  // A logical tool row is mounted on `started` then updated in place. Starting
  // it expanded made completed directory/read outputs remain giant cards; only
  // errors open themselves automatically.
  const [expanded, setExpanded] = useState(activity.state === 'error');
  const state = activity.state === 'error' ? '✗' : activity.state === 'completed' ? '✓' : '↳';
  const diff = activity.metadata?.diff;
  const output = displayToolResult(activity);
  const summary = toolResultSummary(activity);
  const hasBody = Boolean(output || diff || activity.terminal);
  return <section className={`agent-timeline-action ${activity.kind ?? 'other'} ${activity.state ?? 'running'} ${expanded ? 'expanded' : ''}`}><button type="button" className="agent-timeline-action-head" onClick={() => hasBody && setExpanded((value) => !value)} aria-expanded={hasBody ? expanded : undefined}><b>{state} {actionTitle(activity)}</b>{summary && <span>{summary}</span>}{activity.state === 'running' && <em>выполняется…</em>}</button>{expanded && <div className="agent-timeline-action-body">{activity.kind === 'terminal' ? <TerminalDetails terminal={activity.terminal} fallback={output} /> : output && <pre>{output}</pre>}{typeof diff === 'string' && <details><summary>Изменения</summary><pre>{diff}</pre></details>}</div>}</section>;
});

/** A finished thought never changes, so memoization on its primitive props skips it on every later frame. */
const Thought = memo(function Thought({ content, live, title, duration }: { content: string; live: boolean; title: string; duration: string | null }) {
  return <section className="agent-timeline-thought"><header><b>{title}</b>{live && duration && <span>· {duration}</span>}</header><Markdown streaming={live} lazy>{content}</Markdown></section>;
});

export const AgentTimeline = memo(function AgentTimeline({ timeline, activities, messages, reasoning, streaming, now, error, cancelled }: Props) {
  const items = thinkingTimeline(reasoning, activities, streaming, timeline, messages);
  if (!items.length && !error && !cancelled) return null;
  return <div className="agent-timeline">{items.map((item) => {
    if (item.kind === 'reasoning') {
      if (!item.content.trim()) return null;
      const duration = elapsed(item.startedAt, item.completedAt, now);
      // Only the paragraph still being written is live; later paragraphs of a finished thought carry no completion time.
      const live = streaming && item.live;
      return <Thought key={item.id} content={item.content} live={live} title={live ? 'Размышляет' : duration ? `Размышлял ${duration}` : 'Размышление'} duration={live ? duration : null} />;
    }
    if (item.kind === 'steering') return <section className={`agent-timeline-steering ${item.status}`} key={item.id}><header><b>{item.status === 'applied' ? 'Уточнение передано модели' : 'Уточнение принято'}</b></header><p>{item.message.content}</p></section>;
    return <Action key={item.id} activity={item.activity} />;
  })}{error && <section className="agent-timeline-terminal error" role="status"><b>Агент остановлен из-за ошибки</b><span>{error}</span></section>}{cancelled && <section className="agent-timeline-terminal cancelled" role="status"><b>Агент остановлен</b></section>}</div>;
});
