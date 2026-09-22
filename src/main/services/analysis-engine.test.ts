import assert from 'node:assert/strict';
import { ABSOLUTE_MAX_AGENT_STEPS_PER_GENERATION, AgentActionBudget, MAX_AGENT_STEPS_PER_GENERATION } from './analysis-engine';

export function runAgentActionBudgetRegression(): void {
  const simple = new AgentActionBudget();
  assert.equal(simple.assess({ actions: 12, planComplete: false, stalled: false, recentProgress: true }).limit, MAX_AGENT_STEPS_PER_GENERATION, 'simple run changed its base budget');

  const productive = new AgentActionBudget();
  const first = productive.assess({ actions: 100, planComplete: false, stalled: false, recentProgress: true });
  assert(first.extended && first.limit === 150, 'productive incomplete run did not receive the first extension');
  const second = productive.assess({ actions: 150, planComplete: false, stalled: false, recentProgress: true });
  assert(second.extended && second.limit === 200, 'productive incomplete run did not receive the second extension');

  const stalled = new AgentActionBudget();
  const stalledDecision = stalled.assess({ actions: 100, planComplete: false, stalled: true, recentProgress: true });
  assert(!stalledDecision.extended && stalledDecision.shouldFinalize, 'stalled exploration received more action budget');

  const complete = new AgentActionBudget();
  const completeDecision = complete.assess({ actions: 99, planComplete: true, stalled: false, recentProgress: true });
  assert(completeDecision.shouldFinalize && !completeDecision.extended, 'completed Plan near cap did not select finalization');

  const capped = new AgentActionBudget();
  let decision = capped.assess({ actions: 100, planComplete: false, stalled: false, recentProgress: true });
  while (decision.extended) decision = capped.assess({ actions: decision.limit, planComplete: false, stalled: false, recentProgress: true });
  assert(decision.shouldFinalize && decision.atAbsoluteCap && decision.limit === ABSOLUTE_MAX_AGENT_STEPS_PER_GENERATION, 'absolute Agent safety cap was bypassed');
}

if (require.main === module) runAgentActionBudgetRegression();
