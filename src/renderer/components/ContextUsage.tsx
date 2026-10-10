import { useLocale } from '../use-locale';
import { t, tr } from '../../shared/locale';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/app-store';
import { formatContextTokens } from '../../shared/context-format';
import { effectiveModes, effectiveReasoning } from '../../shared/conversation-settings';
import { chatModeLabel, formatCount, formatDuration, reasoningControlText, reasoningEffortLabel, reasoningModeLabel, thinkingLabel, tokensWord } from '../../shared/localization';

export { formatContextTokens } from '../../shared/context-format';

const reasoningLabel = reasoningModeLabel;
const modeLabel = chatModeLabel;
const number = formatCount;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  useLocale();
  return <div className="ctx-stat"><span>{label}</span><b title={hint ?? value}>{value}</b></div>;
}

export function ContextUsage({ initiallyOpen = false }: { initiallyOpen?: boolean } = {}) {
  useLocale();
  const [open, setOpen] = useState(initiallyOpen);
  const { conversations, activeId, activeContextWindow, agentTelemetry, models, settings, modeTransitions } = useAppStore(useShallow((state) => ({ conversations: state.conversations, activeId: state.activeId, activeContextWindow: state.activeContextWindow, agentTelemetry: state.agentTelemetry, models: state.models, settings: state.settings, modeTransitions: state.modeTransitions })));
  const chat = conversations.find((item) => item.id === activeId);
  // Elapsed time advances on its own. The ticker lives here, runs only while the popover is open during a run, and
  // re-renders only this component; it never goes through the store.
  const running = Boolean(agentTelemetry && !agentTelemetry.finishedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !running) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, running]);
  if (!chat) return null;
  const maximum = activeContextWindow ?? chat.contextWindow;
  const current = chat.contextModelId === chat.modelId ? chat.contextTokens : null;
  const used = Math.min(current ?? 0, maximum); const percent = current === null ? 0 : Math.min(100, used / maximum * 100);
  const tone = percent >= 90 ? 'danger' : percent >= 80 ? 'warning' : percent >= 60 ? 'cool' : 'calm';
  const status = current === null ? t("Будет измерен после следующего ответа модели.") : percent >= 100 ? t("Старые сообщения уже начинают вытесняться.") : t("После достижения лимита самые ранние сообщения начнут вытесняться.");
  const elapsed = agentTelemetry ? Math.max(0, Math.round(((agentTelemetry.finishedAt ? new Date(agentTelemetry.finishedAt).getTime() : now) - new Date(agentTelemetry.startedAt).getTime()) / 1000)) : null;
  const cachedTokens = agentTelemetry?.cachedTokens;
  const cacheRate = typeof cachedTokens === 'number' && (agentTelemetry?.inputTokens ?? 0) > 0 ? Math.min(100, cachedTokens / agentTelemetry!.inputTokens * 100) : null;
  const model = models.find((item) => item.id === chat.modelId);
  const modes = effectiveModes(chat, true, modeTransitions[chat.id]);
  const reasoning = effectiveReasoning(chat, model?.reasoning, modeTransitions[chat.id]);
  const llama = settings?.llamaRuntime;
  const runtimeState = !chat.modelId ? null : llama?.status === 'switching' || llama?.status === 'starting' ? t("llama.cpp запускается…") : llama && llama.status !== 'ready' ? t("llama.cpp не запущен") : llama?.modelId && llama.modelId !== chat.modelId ? t("Загружена другая модель") : null;
  return <div className={`context-usage ${tone}`}><button type="button" title={t("Контекст и telemetry")} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={tr`Контекст: ${percent.toFixed(1)}%`}><svg viewBox="0 0 36 36" aria-hidden="true"><circle className="context-track" cx="18" cy="18" r="15.5" /><circle className="context-progress" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} /></svg><span>{current === null ? '—' : `${Math.round(percent)}%`}</span></button>{open && <section className={`context-usage-popover ${tone}`} aria-label={t("Контекст")}>
    <header className="ctx-head"><div><span className="ctx-kicker">{t("Контекст")}</span><strong className="ctx-percent">{current === null ? '—' : `${percent.toFixed(0)}%`}</strong></div><span className="ctx-amount">{formatContextTokens(used)} / {formatContextTokens(maximum)}</span></header>
    <div className="ctx-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><i style={{ width: `${percent}%` }} /></div>
    <div className="ctx-modes">
      <div className="ctx-mode"><span>{reasoningControlText.thinking}</span>{reasoning.thinking !== null ? <b className={`ctx-chip thinking-${reasoning.thinking ? 'on' : 'off'}`}>{reasoning.thinking ? thinkingLabel.on : thinkingLabel.off}</b> : <b className="ctx-chip muted" title={reasoningControlText.thinkingUnavailable}>{reasoningControlText.unavailable}</b>}{reasoning.pendingThinking !== null && <em className="ctx-pending" title={reasoningControlText.pending}>→ {reasoning.pendingThinking ? thinkingLabel.on : thinkingLabel.off}</em>}</div>
      <div className="ctx-mode"><span>{reasoningControlText.effort}</span>{reasoning.effort !== null ? <b className={`ctx-chip effort-${reasoning.effort}${reasoning.effortApplies ? '' : ' muted'}`} title={reasoning.effortApplies ? undefined : reasoningControlText.effortInactive}>{reasoningEffortLabel[reasoning.effort]}</b> : <b className="ctx-chip muted" title={reasoningControlText.effortUnavailable}>{reasoningControlText.unavailable}</b>}{reasoning.pendingEffort !== null && <em className="ctx-pending" title={reasoningControlText.pending}>→ {reasoningEffortLabel[reasoning.pendingEffort]}</em>}</div>
      <div className="ctx-mode"><span>{reasoningControlText.strategy}</span>{modes.reasoning ? <b className={`ctx-chip reasoning-${modes.reasoning}`}>{reasoningLabel[modes.reasoning]}</b> : <b className="ctx-chip muted">—</b>}{modes.pendingReasoning && <em className="ctx-pending" title={reasoningControlText.pending}>→ {reasoningLabel[modes.pendingReasoning]}</em>}</div>
      <div className="ctx-mode"><span>{t("Режим")}</span><b className={`ctx-chip mode-${modes.mode}`}>{modeLabel[modes.mode]}</b>{modes.pendingMode && <em className="ctx-pending" title={t("Выбрано, ещё не подтверждено runtime")}>→ {modeLabel[modes.pendingMode]}</em>}</div>
    </div>
    {runtimeState && <p className="ctx-runtime" role="status">{runtimeState}</p>}
    <div className="ctx-grid">
      <Stat label={t("Входные токены")} value={number(agentTelemetry?.inputTokens)} />
      <Stat label={t("Выходные токены")} value={number(agentTelemetry?.outputTokens)} />
      <Stat label={t("Всего за запуск")} value={agentTelemetry ? number(agentTelemetry.inputTokens + agentTelemetry.outputTokens) : '—'} />
    </div>
    {typeof cachedTokens === 'number' && <div className="ctx-row"><span>{t("Кэш промпта")}</span><b>{cacheRate === null ? `${number(cachedTokens)} ${tokensWord(cachedTokens)}` : `${cacheRate.toFixed(0)}% · ${number(cachedTokens)} ${tokensWord(cachedTokens)}`}</b></div>}
    {typeof agentTelemetry?.cacheWriteTokens === 'number' && <div className="ctx-row"><span>{t("Запись в кэш")}</span><b>{number(agentTelemetry.cacheWriteTokens)} {tokensWord(agentTelemetry.cacheWriteTokens)}</b></div>}
    <div className="ctx-grid ctx-grid-wide">
      {typeof agentTelemetry?.tokensPerSecond === 'number' && <Stat label={t("Скорость")} value={tr`${agentTelemetry.tokensPerSecond.toFixed(1).replace(".", ",")} ток/с`} hint={t("Скорость генерации")} />}
      <Stat label={t("Прошло")} value={elapsed === null ? '—' : formatDuration(elapsed)} />
      <Stat label={t("Ход")} value={String(agentTelemetry?.turn ?? '—')} />
      <Stat label={t("Действия")} value={String(agentTelemetry?.actions ?? '—')} />
      <Stat label={t("Сжатия")} value={String(agentTelemetry?.compactions ?? 0)} />
    </div>
    <small>{status}</small>
  </section>}</div>;
}
