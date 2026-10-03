import type { ChatMessage, ThinkingTimelineEvent, ToolActivity } from './types';

export type ThinkingTimelineItem =
  | { id: string; kind: 'reasoning'; content: string; live: boolean; position?: number; startedAt?: string; completedAt?: string }
  | { id: string; kind: 'activity'; activity: ToolActivity; position?: number }
  | { id: string; kind: 'steering'; message: ChatMessage; status: 'accepted' | 'applied'; position: number };

export function steeringMessageIds(messages: ChatMessage[]): Set<string> {
  const userMessageIds = new Set(messages.filter((message) => message.role === 'user').map((message) => message.id));
  return new Set(messages.flatMap((message) => message.role === 'assistant'
    ? (message.thinkingTimeline ?? []).flatMap((event) => event.kind === 'steering' && userMessageIds.has(event.messageId) ? [event.messageId] : [])
    : []));
}

function reasoningItems(event: Extract<ThinkingTimelineEvent, { kind: 'reasoning' }>, live: boolean): ThinkingTimelineItem[] {
  return event.content.split(/\n\s*\n/).map((content) => content.trim()).filter(Boolean).map((content, index, sections) => ({ id: `${event.id}-${index}`, kind: 'reasoning' as const, content, live: live && index === sections.length - 1, position: event.position, ...(index === 0 ? { startedAt: event.startedAt, completedAt: event.completedAt } : {}) }));
}

/**
 * New Agent turns retain coordinator-assigned event order. Older messages only
 * persisted aggregate Thinking and action rows, so their established readable
 * fallback remains instead of inventing chronology that was never recorded.
 */
export function thinkingTimeline(reasoning: string | undefined, activities: ToolActivity[] = [], streaming = false, events?: ThinkingTimelineEvent[], messages: ChatMessage[] = []): ThinkingTimelineItem[] {
  if (events?.length) {
    const activityById = new Map(activities.map((activity) => [activity.id, activity]));
    const messageById = new Map(messages.filter((message) => message.role === 'user').map((message) => [message.id, message]));
    const ordered = [...events].sort((left, right) => left.position - right.position);
    const last = ordered.at(-1);
    const renderedActivities = new Set<string>();
    const renderedSteeringMessages = new Set<string>();
    return ordered.flatMap((event) => {
      if (event.kind === 'reasoning') return reasoningItems(event, streaming && last?.id === event.id);
      if (event.kind === 'steering') {
        const message = messageById.get(event.messageId);
        if (!message || renderedSteeringMessages.has(event.messageId)) return [];
        renderedSteeringMessages.add(event.messageId);
        return [{ id: event.id, kind: 'steering' as const, message, status: event.status, position: event.position }];
      }
      if (!activityById.has(event.activityId) || renderedActivities.has(event.activityId)) return [];
      renderedActivities.add(event.activityId);
      return [{ id: event.id, kind: 'activity' as const, activity: activityById.get(event.activityId)!, position: event.position }];
    });
  }
  const sections = (reasoning ?? '').split(/\n\s*\n/).map((section) => section.trim()).filter(Boolean);
  return [...activities.map((activity) => ({ id: `activity-${activity.id}`, kind: 'activity' as const, activity })), ...sections.map((content, index) => ({ id: `reasoning-${index}`, kind: 'reasoning' as const, content, live: streaming && index === sections.length - 1 }))];
}

export function pendingTimelineActivities(items: ThinkingTimelineItem[]): Array<Extract<ThinkingTimelineItem, { kind: 'activity' }>> {
  return items.filter((item): item is Extract<ThinkingTimelineItem, { kind: 'activity' }> => item.kind === 'activity' && item.activity.approval?.status === 'pending');
}
