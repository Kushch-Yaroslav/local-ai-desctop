import { memo, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentPlan } from '../../shared/types';
import { agentStatus } from '../../shared/agent-status';
import { agentStatusText, deliverableStatusLabel, planStatusLabel } from '../../shared/localization';
import { useAppStore } from '../store/app-store';

const planMarker = { pending: '○', in_progress: '●', completed: '✓', blocked: '⊘', abandoned: '–' } as const;
const resultMarker = { pending: '○', implemented: '◐', done: '◐', verified: '✓', blocked: '⊘', dropped: '–' } as const;

/** Subscribes only to the current chat's planning projection, never token/clock updates. */
export function CurrentAgentStatus() {
  const { activeId, plan, agent } = useAppStore(useShallow((state) => ({ activeId: state.activeId, plan: state.agentPlan, agent: state.conversations.find((chat) => chat.id === state.activeId)?.mode === 'agent' })));
  return agent && activeId ? <AgentStatusPanel plan={plan} /> : null;
}

export const AgentStatusPanel = memo(function AgentStatusPanel({ plan }: { plan: AgentPlan | null }) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const { steps, deliverables } = agentStatus(plan);
  if (!steps.length && !deliverables.length) return null;
  const completed = steps.filter((step) => step.status === 'completed').length;
  const verified = deliverables.filter((item) => item.status === 'verified').length;
  const total = deliverables.filter((item) => item.status !== 'dropped').length;
  return <section className="agent-status-panel" aria-label={agentStatusText.panel}>
    <button type="button" className="agent-status-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
      <ChevronDown size={16} aria-hidden="true" />
      {steps.length > 0 && <span><strong>{agentStatusText.plan}</strong> {completed}/{steps.length}</span>}
      {steps.length > 0 && deliverables.length > 0 && <span aria-hidden="true">·</span>}
      {deliverables.length > 0 && <span><strong>{agentStatusText.result}</strong> {verified}/{total}</span>}
    </button>
    {expanded && <div id={contentId} className="agent-status-content">
      {steps.length > 0 && <section aria-label={agentStatusText.plan}><h3>{agentStatusText.plan}<small>{completed}/{steps.length}</small></h3>
        <ol>{steps.map((step) => <li key={step.id} className={step.status} aria-current={step.status === 'in_progress' ? 'step' : undefined}>
          <i aria-hidden="true">{planMarker[step.status]}</i><span>{step.text}{step.note && <small>{step.note}</small>}</span><small className="agent-status-label">{planStatusLabel[step.status]}</small>
        </li>)}</ol>
      </section>}
      {deliverables.length > 0 && <section aria-label={agentStatusText.deliverables}><h3>{agentStatusText.deliverables}<small>{verified}/{total}</small></h3>
        <ul>{deliverables.map((item) => <li key={item.id} className={item.status}>
          <i aria-hidden="true">{resultMarker[item.status]}</i><span>{item.text}{(item.reason || item.failing) && <small>{item.reason || item.failing}</small>}</span><small className="agent-status-label">{deliverableStatusLabel[item.status]}</small>
        </li>)}</ul>
      </section>}
    </div>}
  </section>;
});
