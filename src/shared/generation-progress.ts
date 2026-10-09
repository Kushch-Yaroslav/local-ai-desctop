import type { ToolActivity } from './types';

/** Presentation follows the current round, never accumulated message length. */
export function progressIndicatorLabel(state: string, activities: ToolActivity[], agent = false): string | null {
  if (state === 'thinking') return 'Ожидаю ответ модели…';
  if (state === 'stopping') return 'Останавливаю';
  if (state === 'waiting-for-approval') return agent ? null : 'Ожидает подтверждения';
  if (state === 'using-tool' || state === 'running-terminal') {
    // Agent already presents running tools in its timeline.
    if (agent) return null;
    return activities.findLast((activity) => activity.state === 'running' && activity.kind !== 'progress')?.label ?? 'Использую инструмент';
  }
  return null;
}
