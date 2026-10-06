import type { AgentPlan, DeliverableItem, PlanStepItem, ToolActivity } from './types';

/** Presentation only: the task-memory ledger is authoritative, including empty lists.
 * Older saved chats can still display their legacy model-todo/milestone plan. */
export type AgentStatusStep = Omit<PlanStepItem, 'status'> & { status: PlanStepItem['status'] | 'abandoned' };
export function agentStatus(plan: AgentPlan | null): { steps: AgentStatusStep[]; deliverables: DeliverableItem[] } {
  const legacy = plan?.modelTodo?.phases.flatMap((phase) => phase.items)
    ?? plan?.milestones?.flatMap((milestone) => milestone.workPlan.tasks.map((task) => ({ id: task.id, content: task.label, status: task.status })))
    ?? plan?.steps?.map((step) => ({ id: step.id, content: step.label, status: step.status })) ?? [];
  return {
    steps: plan?.taskMemory?.plan?.steps ?? legacy.map((step) => ({ id: step.id, text: step.content, status: step.status })),
    deliverables: plan?.taskMemory?.deliverables?.items ?? [],
  };
}

/** Successful status snapshots belong in the current panel, not a repeated timeline card.
 * Errors remain chronological so a rejected planning operation is still visible. */
export const isStatusSnapshot = (activity: ToolActivity): boolean => activity.kind === 'planning' && (activity.detail === 'plan' || activity.detail === 'deliverables');
