import type { AnalysisRun, ChatMessage } from './types';

export const runTurnId = (runId: string): string => `run-${runId}`;

/** A finished Agent run without a saved assistant message (Stop, failure,
 * crash, or a completion with no final text) is shown from its persisted
 * history: timeline, actions, partial output and terminal state. */
export function runHistoryTurn(run: AnalysisRun): ChatMessage | null {
  if (run.status === 'running' || run.assistantMessageId) return null;
  const hasHistory = Boolean(run.timeline?.length || run.actions.length || run.partialOutput?.trim() || run.richArtifacts?.length);
  if (!hasHistory && run.status !== 'cancelled' && run.status !== 'error') return null;
  return {
    id: runTurnId(run.id), conversationId: run.conversationId, role: 'assistant', content: run.partialOutput ?? '', createdAt: run.createdAt,
    ...(run.timeline?.length ? { thinkingTimeline: run.timeline } : {}),
    ...(run.richArtifacts?.length ? { richArtifacts: run.richArtifacts } : {}),
    ...(run.status === 'cancelled' ? { agentCancelled: true } : {}),
    ...(run.status === 'error' ? { agentError: run.error ?? 'Генерация завершилась с ошибкой.' } : {}),
    ...(run.completedAt ? { agentFinishedAt: run.completedAt } : {}),
  };
}

/** Render-only merge: synthetic run turns are never sent as model history. */
export function withRunHistory(messages: ChatMessage[], runs: AnalysisRun[]): ChatMessage[] {
  const turns = runs.flatMap((run) => runHistoryTurn(run) ?? []);
  if (!turns.length) return messages;
  const result = [...messages];
  for (const turn of turns) {
    // A run starts right after the user message that requested it; later
    // messages (steering, the next request, a live stream) follow it.
    let index = result.length;
    while (index > 0 && result[index - 1].createdAt > turn.createdAt) index -= 1;
    result.splice(index, 0, turn);
  }
  return result;
}

export const runForMessage = (runs: AnalysisRun[], messageId: string): AnalysisRun | undefined => runs.find((run) => run.assistantMessageId === messageId || runTurnId(run.id) === messageId);
