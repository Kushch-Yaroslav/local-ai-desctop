import type { AgentPlan, DeliverableItem, PlanStepItem, ToolActivity, VerificationRecord } from './types';

/** Presentation only: the task-memory ledger is authoritative, including empty lists.
 * Older saved chats can still display their legacy model-todo/milestone plan. */
export type AgentStatusStep = Omit<PlanStepItem, 'status'> & { status: PlanStepItem['status'] | 'abandoned' };
export function agentStatus(plan: AgentPlan | null): { steps: AgentStatusStep[]; deliverables: DeliverableItem[]; warnings: VerificationRecord[]; checks: VerificationRecord[] } {
  const legacy = plan?.modelTodo?.phases.flatMap((phase) => phase.items)
    ?? plan?.milestones?.flatMap((milestone) => milestone.workPlan.tasks.map((task) => ({ id: task.id, content: task.label, status: task.status })))
    ?? plan?.steps?.map((step) => ({ id: step.id, content: step.label, status: step.status })) ?? [];
  const ledger = plan?.taskMemory?.verification;
  const checks = ledger?.records.filter((record) => record.kind === 'readback'
    ? (ledger.changed?.[record.check_key || record.subject] ?? 0) <= record.epoch : record.epoch === ledger.epoch) ?? [];
  const warnings = checks.filter((record, index) => !record.pass && !checks.slice(index + 1).some((later) => later.pass && later.kind === record.kind && (later.check_key || later.subject) === (record.check_key || record.subject)));
  return {
    steps: plan?.taskMemory?.plan?.steps ?? legacy.map((step) => ({ id: step.id, text: step.content, status: step.status })),
    deliverables: plan?.taskMemory?.deliverables?.items ?? [],
    checks,
    warnings,
  };
}

/** Successful status snapshots belong in the current panel, not a repeated timeline card.
 * Errors remain chronological so a rejected planning operation is still visible. */
export const isStatusSnapshot = (activity: ToolActivity): boolean => activity.kind === 'planning' && (activity.detail === 'plan' || activity.detail === 'deliverables');

/** Runtime semantics, not tool counts, determine whether task telemetry is useful. */
export function showAgentStatus(plan: AgentPlan | null, recovery = false): boolean {
  const { steps, deliverables, warnings } = agentStatus(plan);
  const budget = plan?.workBudget;
  return Boolean(steps.length || deliverables.length || warnings.length || (recovery && budget)
    || (budget && plan?.taskMemory?.verification?.code_changed)
    || (budget && (budget.extensions > 0 || budget.decision === 'denied' || budget.used >= budget.limit - 16)));
}
