import { useState } from 'react';
import { useAppStore } from '../store/app-store';
import { formatContextTokens } from '../../shared/context-format';

export { formatContextTokens } from '../../shared/context-format';

export function ContextUsage() {
  const [open, setOpen] = useState(false);
  const { conversations, activeId, activeContextWindow, agentTelemetry } = useAppStore();
  const chat = conversations.find((item) => item.id === activeId);
  if (!chat) return null;
  const maximum = activeContextWindow ?? chat.contextWindow;
  const current = chat.contextModelId === chat.modelId ? chat.contextTokens : null;
  const used = Math.min(current ?? 0, maximum); const percent = current === null ? 0 : Math.min(100, used / maximum * 100);
  const tone = percent >= 90 ? 'danger' : percent >= 80 ? 'warning' : percent >= 60 ? 'cool' : 'calm';
  const status = current === null ? 'Будет измерен после следующего ответа модели.' : percent >= 100 ? 'Старые сообщения уже начинают вытесняться.' : 'После достижения лимита самые ранние сообщения начнут вытесняться.';
  const elapsed = agentTelemetry ? Math.max(0, Math.round(((agentTelemetry.finishedAt ? new Date(agentTelemetry.finishedAt).getTime() : Date.now()) - new Date(agentTelemetry.startedAt).getTime()) / 1000)) : null;
  return <div className={`context-usage ${tone}`}><button type="button" title="Контекст и telemetry" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`Контекст: ${percent.toFixed(1)}%`}><svg viewBox="0 0 36 36" aria-hidden="true"><circle className="context-track" cx="18" cy="18" r="15.5" /><circle className="context-progress" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} /></svg><span>{current === null ? '—' : `${Math.round(percent)}%`}</span></button>{open && <section className="context-usage-popover"><strong>Context</strong><p>{formatContextTokens(used)} / {formatContextTokens(maximum)} · {percent.toFixed(0)}%</p><p>Input tokens <b>{agentTelemetry?.inputTokens ?? '—'}</b></p><p>Output tokens <b>{agentTelemetry?.outputTokens ?? '—'}</b></p><p>Total run <b>{agentTelemetry ? agentTelemetry.inputTokens + agentTelemetry.outputTokens : '—'}</b></p><p>Generation speed <b>{agentTelemetry?.tokensPerSecond ? `${agentTelemetry.tokensPerSecond.toFixed(1)} tok/s` : '—'}</b></p><p>Elapsed <b>{elapsed === null ? '—' : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</b></p><p>Turn <b>{agentTelemetry?.turn ?? '—'}</b> · actions <b>{agentTelemetry?.actions ?? '—'}</b> · compactions <b>{agentTelemetry?.compactions ?? 0}</b></p><small>{status}</small></section>}</div>;
}
