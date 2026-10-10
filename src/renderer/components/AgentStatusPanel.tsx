import { useLocale } from '../use-locale';
import { t, tr } from '../../shared/locale';
import { memo, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentPlan } from '../../shared/types';
import { agentStatus, showAgentStatus } from '../../shared/agent-status';
import { agentStatusText, deliverableStatusLabel, planStatusLabel, budgetReasonLabel } from '../../shared/localization';
import { useAppStore } from '../store/app-store';

const planMarker = { pending: '○', in_progress: '●', completed: '✓', blocked: '⊘', abandoned: '–' } as const;
const resultMarker = { pending: '○', implemented: '◐', done: '◐', verified: '✓', blocked: '⊘', dropped: '–' } as const;

/** Subscribes only to the current chat's planning projection, never token/clock updates. */
export function CurrentAgentStatus() {
  useLocale();
  const { activeId, plan, agent, running, recovery } = useAppStore(useShallow((state) => ({ activeId: state.activeId, plan: state.agentPlan, running: state.isGenerating, recovery: state.messages.at(-1)?.thinkingTimeline?.at(-1)?.kind === 'paused' || state.generationState === 'cancelled' || state.generationState === 'error' || state.analysisRuns.filter(run => run.conversationId === state.activeId).at(-1)?.status === 'interrupted', agent: state.conversations.find((chat) => chat.id === state.activeId)?.mode === 'agent' })));
  return agent && activeId ? <AgentStatusPanel plan={plan} running={running} recovery={recovery} /> : null;
}

export const AgentStatusPanel = memo(function AgentStatusPanel({ plan, running = false, recovery = false }: { plan: AgentPlan | null; running?: boolean; recovery?: boolean }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { steps, deliverables, checks, warnings } = agentStatus(plan);
  const budget = plan?.workBudget;
  const budgetImportant = budget && (budget.extensions > 0 || budget.decision === 'denied' || budget.used >= budget.limit - 16);
  if (!showAgentStatus(plan, recovery)) return null;
  const completed = steps.filter((step) => step.status === 'completed').length;
  const verified = deliverables.filter((item) => item.status === 'verified').length;
  const total = deliverables.filter((item) => item.status !== 'dropped').length;
  return <section className="agent-status-panel" aria-label={agentStatusText.panel}>
    <button type="button" className="agent-status-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
      <ChevronDown size={16} aria-hidden="true" />
      {!running && <span>{agentStatusText.saved}</span>}
      {budgetImportant && budget && <span title={tr`Максимум ${budget.maximum}; продлений: ${budget.extensions}. ${budgetReasonLabel[budget.reason] ?? budget.reason}`}><strong>{t("Рабочие ходы")}</strong> {budget.used}/{budget.limit}{budget.extensions > 0 ? tr` · продлений: ${budget.extensions}` : ''}{budget.decision === 'denied' ? t(" · Лимит") : ''}</span>}
      {!steps.length && !deliverables.length && !warnings.length && !budgetImportant && <span>{t("Работа над задачей")}</span>}
      {steps.length > 0 && <span><strong>{agentStatusText.plan}</strong> {completed}/{steps.length}</span>}
      {steps.length > 0 && deliverables.length > 0 && <span aria-hidden="true">·</span>}
      {deliverables.length > 0 && <span><strong>{agentStatusText.result}</strong> {verified}/{total}</span>}
      {warnings.length > 0 && <span>{agentStatusText.warnings}: {warnings.length}</span>}
    </button>
    {expanded && <div id={contentId} className="agent-status-content">
      {budget && <small>{t("Рабочие ходы")} {budget.used}/{budget.limit} · {t("Максимум ")}{budget.maximum} {t(" · продлений: ")}{budget.extensions} · {budgetReasonLabel[budget.reason] ?? budget.reason}</small>}
      {steps.length > 0 && <section aria-label={agentStatusText.plan}><h3>{agentStatusText.plan}<small>{completed}/{steps.length}</small></h3>
        <ol>{steps.map((step) => <li key={step.id} className={step.status} aria-current={running && step.status === 'in_progress' ? 'step' : undefined}>
          <i aria-hidden="true">{planMarker[step.status]}</i><span>{step.text}{step.note && <small>{step.note}</small>}</span><small className="agent-status-label">{!running && step.status === 'in_progress' ? agentStatusText.unfinishedStep : planStatusLabel[step.status]}</small>
        </li>)}</ol>
      </section>}
      {deliverables.length > 0 && <section aria-label={agentStatusText.deliverables}><h3>{agentStatusText.deliverables}<small>{verified}/{total}</small></h3>
        <ul>{deliverables.map((item) => <li key={item.id} className={item.status}>
          <i aria-hidden="true">{resultMarker[item.status]}</i><span>{item.text}{(item.reason || item.failing) && <small>{item.reason || item.failing}</small>}{item.status === 'verified' && checks.filter((record) => record.pass && item.proof?.includes(record.id)).map((record) => <small key={record.id}>{record.subject} — {agentStatusText.passed}</small>)}</span><small className="agent-status-label">{deliverableStatusLabel[item.status]}</small>
        </li>)}</ul>
      </section>}
      {warnings.length > 0 && <section aria-label={agentStatusText.warnings}><h3>{agentStatusText.warnings}<small>{warnings.length}</small></h3><ul>{warnings.map((record) => <li key={record.id} className="implemented"><i aria-hidden="true">!</i><span>{record.subject}<small>{record.baseline_failure ? agentStatusText.preExisting : record.baseline ? agentStatusText.baseline : agentStatusText.failed}{record.deliverable_ids?.length ? ` · ${record.deliverable_ids.join(', ')}` : ''}{record.detail ? ` · ${record.detail}` : ''}</small></span><small className="agent-status-label">{record.id}</small></li>)}</ul></section>}
    </div>}
  </section>;
});
