import { memo, useState } from 'react';
import type { TerminalExecution, ThinkingTimelineEvent, ToolActivity } from '../../shared/types';
import { Markdown } from './Markdown';

type Props = { timeline?: ThinkingTimelineEvent[]; activities: ToolActivity[]; streaming: boolean; now: number; error?: string; cancelled?: boolean };

const elapsed = (start?: string, end?: string, now = Date.now()) => {
  if (!start) return null; const seconds = Math.max(0, Math.round(((end ? new Date(end).getTime() : now) - new Date(start).getTime()) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}м ${seconds % 60}с` : `${seconds}с`;
};
const actionTitle = (activity: ToolActivity) => ({ file_read: 'Read', directory: 'Viewed project structure', mutation: activity.label.includes('Изменение') ? 'Edited' : activity.label, terminal: '$ Terminal', web: 'Browser', context: 'Context optimized' } as Record<string, string>)[activity.kind ?? ''] ?? activity.label;

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
  return [label, status && status !== 'ok' ? status : undefined, value.truncated === true ? 'truncated' : undefined, message].filter(Boolean).join(' · ');
}
function structuredEntries(result: unknown): unknown[] | undefined {
  return result && typeof result === 'object' && !Array.isArray(result) && Array.isArray((result as { entries?: unknown }).entries) ? (result as { entries: unknown[] }).entries : undefined;
}
export function toolResultSummary(activity: ToolActivity): string | undefined {
  if (activity.detail === 'project_knowledge_read') {
    try {
      const entries = structuredEntries(JSON.parse(activity.output ?? ''));
      if (entries) return `${entries.length} knowledge ${entries.length === 1 ? 'entry' : 'entries'}${entries.length ? ` · ${entries.slice(0, 2).map(entryLine).join(', ')}` : ''}`;
    } catch { /* Fall through to the event detail. */ }
  }
  if (activity.kind === 'directory') {
    try { const entries = structuredEntries(JSON.parse(activity.output ?? '')); return entries ? `${entries.length} items` : activity.detail; } catch { return activity.detail; }
  }
  return activity.detail;
}
export function displayToolResult(activity: ToolActivity): string | undefined {
  if (!activity.output) return undefined;
  try {
    const result = JSON.parse(activity.output) as { command?: string; stdout?: string; stderr?: string; exit_code?: number; timed_out?: boolean; cancelled?: boolean; content?: string };
    if (activity.kind === 'terminal') return `${result.command ? `$ ${result.command}\n` : ''}${result.exit_code === 0 ? '✓ exit 0' : result.exit_code !== undefined ? `✗ exit ${result.exit_code}` : ''}${result.timed_out ? ' · timed out' : ''}${result.cancelled ? ' · cancelled' : ''}${result.stdout ? `\n${result.stdout}` : ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    if (typeof result.content === 'string') return result.content;
    const entries = structuredEntries(result);
    if (entries) return entries.map(entryLine).join('\n');
    return JSON.stringify(result, null, 2);
  } catch { /* Streaming tool output is already presentation text. */ }
  return activity.output;
}

function TerminalDetails({ terminal, fallback }: { terminal?: TerminalExecution; fallback?: string }) {
  if (!terminal) return fallback ? <><h4>Diagnostics</h4><pre>{fallback}</pre></> : null;
  const status = terminal.status === 'completed' ? '✓ completed' : terminal.status === 'cancelled' ? 'Cancelled' : terminal.status === 'timed_out' ? 'Timed out' : terminal.status === 'error' ? 'Error' : 'Running';
  return <>
    {terminal.command && <><h4>Command</h4><pre>{terminal.command}</pre></>}
    <h4>Diagnostics</h4><pre>{[terminal.cwd && `cwd: ${terminal.cwd}`, terminal.pid && `pid: ${terminal.pid} · pgid: ${terminal.pgid ?? '—'} · session: ${terminal.sessionId ?? '—'}`, terminal.startedAt && `started: ${terminal.startedAt}`, terminal.finishedAt && `finished: ${terminal.finishedAt}`, `status: ${status}`, terminal.exitCode !== null && terminal.exitCode !== undefined && `exit: ${terminal.exitCode}`, terminal.timedOut && 'timed_out: true', terminal.cancelled && 'cancelled: true'].filter(Boolean).join('\n')}</pre>
    {terminal.stdout && <><h4>Stdout</h4><pre>{terminal.stdout}</pre></>}
    {terminal.stderr && <><h4>Stderr</h4><pre>{terminal.stderr}</pre></>}
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
  return <section className={`agent-timeline-action ${activity.kind ?? 'other'} ${activity.state ?? 'running'} ${expanded ? 'expanded' : ''}`}><button type="button" className="agent-timeline-action-head" onClick={() => hasBody && setExpanded((value) => !value)} aria-expanded={hasBody ? expanded : undefined}><b>{state} {actionTitle(activity)}</b>{summary && <span>{summary}</span>}{activity.state === 'running' && <em>running…</em>}</button>{expanded && <div className="agent-timeline-action-body">{activity.kind === 'terminal' ? <TerminalDetails terminal={activity.terminal} fallback={output} /> : output && <pre>{output}</pre>}{typeof diff === 'string' && <details><summary>Diff</summary><pre>{diff}</pre></details>}</div>}</section>;
});

export const AgentTimeline = memo(function AgentTimeline({ timeline = [], activities, streaming, now, error, cancelled }: Props) {
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  const items = [...timeline].sort((a, b) => a.position - b.position);
  if (!items.length && !error && !cancelled) return null;
  return <div className="agent-timeline">{items.map((item) => {
    if (item.kind === 'reasoning') {
      if (!item.content.trim()) return null;
      const duration = elapsed(item.startedAt, item.completedAt, now);
      const live = streaming && !item.completedAt;
      return <section className="agent-timeline-thought" key={item.id}><header><b>{live ? 'Thinking' : duration ? `Thought for ${duration}` : 'Thought'}</b>{live && duration && <span>· {duration}</span>}</header><Markdown streaming={live}>{item.content}</Markdown></section>;
    }
    const activity = activityById.get(item.activityId);
    return activity ? <Action key={item.id} activity={activity} /> : null;
  })}{error && <section className="agent-timeline-terminal error" role="status"><b>Agent stopped with an error</b><span>{error}</span></section>}{cancelled && <section className="agent-timeline-terminal cancelled" role="status"><b>Agent stopped</b></section>}</div>;
});
