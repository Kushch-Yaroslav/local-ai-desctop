import type { ChatMessage, ThinkingTimelineEvent, ToolActivity } from './types';

export type ThinkingTimelineItem =
  | { id: string; kind: 'reasoning'; content: string; live: boolean; position?: number; startedAt?: string; completedAt?: string }
  | { id: string; kind: 'activity'; activity: ToolActivity; position?: number }
  | { id: string; kind: 'steering'; message: ChatMessage; status: 'accepted' | 'applied'; position: number };

/**
 * Applies a batch of streamed reasoning fragments to a timeline.
 *
 * Fragments are batched until the next animation frame, while tool events are applied at once, so a tool call
 * normally lands in the timeline *before* the last reasoning fragments of the turn that preceded it. A fragment
 * therefore has to be merged into the entry that already holds its position, wherever that entry now sits; appending a
 * new entry whenever the last one is not reasoning split one thought into several entries with the same id (duplicate
 * React keys, so nodes could not be reused and the DOM kept growing) and broke sentences into separate blocks.
 *
 * Entries that did not change keep their identity, which the render-side caches rely on.
 */
export function appendReasoningFragments(entries: ThinkingTimelineEvent[], fragments: ReadonlyArray<{ content: string; timelinePosition?: number }>): ThinkingTimelineEvent[] {
  let next = entries;
  for (const fragment of fragments) {
    if (fragment.timelinePosition === undefined) continue;
    if (next === entries) next = [...entries];
    let index = -1;
    // A position's entry is always among the most recent ones; never scan the whole history.
    for (let candidate = next.length - 1; candidate >= Math.max(0, next.length - 8); candidate -= 1) {
      const entry = next[candidate]!;
      if (entry.kind === 'reasoning' && entry.position === fragment.timelinePosition) { index = candidate; break; }
    }
    const existing = index >= 0 ? next[index] : undefined;
    if (existing?.kind === 'reasoning') next[index] = { ...existing, content: existing.content + fragment.content };
    else next.push({ id: `reasoning-${fragment.timelinePosition}`, kind: 'reasoning', content: fragment.content, position: fragment.timelinePosition });
  }
  return next;
}

export function steeringMessageIds(messages: ChatMessage[]): Set<string> {
  const userMessageIds = new Set(messages.filter((message) => message.role === 'user').map((message) => message.id));
  return new Set(messages.flatMap((message) => message.role === 'assistant'
    ? (message.thinkingTimeline ?? []).flatMap((event) => event.kind === 'steering' && userMessageIds.has(event.messageId) ? [event.messageId] : [])
    : []));
}

type ReasoningEvent = Extract<ThinkingTimelineEvent, { kind: 'reasoning' }>;
function splitReasoning(event: ReasoningEvent, live: boolean): ThinkingTimelineItem[] {
  return event.content.split(/\n\s*\n/).map((content) => content.trim()).filter(Boolean).map((content, index, sections) => ({ id: `${event.id}-${index}`, kind: 'reasoning' as const, content, live: live && index === sections.length - 1, position: event.position, ...(index === 0 ? { startedAt: event.startedAt, completedAt: event.completedAt } : {}) }));
}

/**
 * Timeline events are replaced immutably while they stream and are never mutated afterwards, so a finished
 * event's paragraphs are split once and the same item objects are reused on every later render. Only the live
 * event is re-split per update; otherwise each frame would re-split the whole history of the run.
 */
const completedReasoning = new WeakMap<ReasoningEvent, ThinkingTimelineItem[]>();
function reasoningItems(event: ReasoningEvent, live: boolean): ThinkingTimelineItem[] {
  if (live) return splitReasoning(event, true);
  const cached = completedReasoning.get(event);
  if (cached) return cached;
  const items = splitReasoning(event, false);
  completedReasoning.set(event, items);
  return items;
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
