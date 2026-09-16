import type { AgentPlan, AgentPlanStep, AgentPlanStepStatus } from '../../shared/types';
import type { ProjectToolCall, ProjectToolDefinition } from '../tools/project-tools';

const maximumPlanSteps = 8;
const maximumStepLabelLength = 180;
const statuses = new Set<AgentPlanStepStatus>(['pending', 'in_progress', 'completed']);

export const agentPlanToolDefinition: ProjectToolDefinition = {
  type: 'function',
  function: {
    name: 'task_plan',
    description: 'Короткий план только для текущей сложной Agent-задачи. Используй при нескольких этапах, исследовании разных частей проекта или существенной проверке. action=create создаёт небольшой список шагов; action=update меняет статус одного шага; action=read показывает текущий план. Статусы: pending, in_progress, completed. План хранит этапы работы, а task_notes — найденные факты и решения. Не используй план для подробных рассуждений, исходников или tool outputs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'read'] },
        steps: { type: 'array', minItems: 1, maxItems: maximumPlanSteps, items: { type: 'object', properties: { id: { type: 'string', maxLength: 40 }, label: { type: 'string', maxLength: maximumStepLabelLength }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['id', 'label'] }, description: 'Небольшой список этапов только для action=create.' },
        step_id: { type: 'string', maxLength: 40, description: 'ID шага для action=update.' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Новый статус шага для action=update.' },
      },
      required: ['action'],
    },
  },
};

export function isAgentPlanCall(call: ProjectToolCall): boolean { return call.name === 'task_plan'; }

/** A bounded plan created anew for every Agent stream; it has no persistence path. */
export class AgentPlanState {
  private plan: AgentPlan | null = null;

  get hasPlan(): boolean { return this.plan !== null; }

  execute(call: ProjectToolCall): string {
    const action = call.arguments.action;
    if (action === 'read') return JSON.stringify({ plan: this.plan, empty: this.plan === null });
    if (action === 'create') return this.create(call.arguments.steps);
    if (action === 'update') return this.update(call.arguments.step_id, call.arguments.status);
    return JSON.stringify({ error: 'task_plan требует action=create, update или read' });
  }

  private create(rawSteps: unknown): string {
    if (this.plan) return JSON.stringify({ error: 'План уже создан; используй action=update или read', plan: this.plan });
    if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > maximumPlanSteps) return JSON.stringify({ error: `План должен содержать от 1 до ${maximumPlanSteps} шагов` });
    const steps: AgentPlanStep[] = [];
    const ids = new Set<string>();
    for (const raw of rawSteps) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return JSON.stringify({ error: 'Каждый шаг плана должен содержать id и label' });
      const step = raw as Record<string, unknown>;
      const id = typeof step.id === 'string' ? step.id.trim() : '';
      const label = typeof step.label === 'string' ? step.label.replace(/\s+/g, ' ').trim() : '';
      const status = step.status === undefined ? 'pending' : step.status;
      if (!id || id.length > 40 || !label || label.length > maximumStepLabelLength || typeof status !== 'string' || !statuses.has(status as AgentPlanStepStatus) || ids.has(id)) return JSON.stringify({ error: 'Шаги плана должны иметь уникальные короткие id, label и допустимый status' });
      ids.add(id); steps.push({ id, label, status: status as AgentPlanStepStatus });
    }
    if (steps.filter((step) => step.status === 'in_progress').length > 1) return JSON.stringify({ error: 'В плане может быть только один шаг in_progress' });
    this.plan = { steps };
    return JSON.stringify({ created: true, plan: this.plan });
  }

  private update(rawId: unknown, rawStatus: unknown): string {
    if (!this.plan) return JSON.stringify({ error: 'Сначала создай план через action=create' });
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || typeof rawStatus !== 'string' || !statuses.has(rawStatus as AgentPlanStepStatus)) return JSON.stringify({ error: 'Для action=update нужны step_id и допустимый status' });
    const step = this.plan.steps.find((candidate) => candidate.id === id);
    if (!step) return JSON.stringify({ error: `Шаг плана ${id} не найден`, plan: this.plan });
    const status = rawStatus as AgentPlanStepStatus;
    if (step.status === status) return JSON.stringify({ updated: false, plan: this.plan });
    const allowed = step.status === 'pending' ? status === 'in_progress' : step.status === 'in_progress' ? status === 'completed' : false;
    if (!allowed) return JSON.stringify({ error: `Недопустимый переход ${step.status} → ${status}`, plan: this.plan });
    if (status === 'in_progress' && this.plan.steps.some((candidate) => candidate.status === 'in_progress')) return JSON.stringify({ error: 'Сначала заверши текущий шаг in_progress', plan: this.plan });
    step.status = status;
    return JSON.stringify({ updated: true, plan: this.plan });
  }
}
