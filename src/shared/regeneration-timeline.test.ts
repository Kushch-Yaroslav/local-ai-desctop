import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../main/services/database';
import { useAppStore } from '../renderer/store/app-store';
import { withRunHistory } from './run-history';
import type { ChatRequest, ThinkingTimelineEvent } from './types';
import type {} from '../renderer/env';

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'regenerate-timeline-'));
  const database = new Database(join(root, 'fixture.db'));
  try {
    const chat = database.createConversation('qwen3.8:27b-q4_K_M');
    database.updateConversation(chat.id, { mode: 'agent', thinkingEnabled: false });
    database.addMessage(chat.id, 'user', 'Earlier request');
    const earlier = database.addMessage(chat.id, 'assistant', 'Earlier answer');
    const earlierRun = database.createAnalysisRun(chat.id, 'fast');
    database.finishAnalysisRun(earlierRun.id, 'completed', earlier.id);
    const user = database.addMessage(chat.id, 'user', 'Current task');
    const stopped = database.createAnalysisRun(chat.id, 'fast');
    database.addAnalysisAction(stopped.id, { id: 'old-tool', label: 'Old observation', kind: 'file_read', state: 'completed', output: 'old observation' });
    const oldTimeline: ThinkingTimelineEvent[] = [{ id: 'old-action', kind: 'activity', activityId: 'old-tool', position: 1 }];
    database.finishAnalysisRun(stopped.id, 'cancelled', null, { timeline: oldTimeline });
    const oldPlan = { steps: [{ id: 'old-step', label: 'Stopped plan', status: 'in_progress' as const }] };
    database.saveAgentPlan(chat.id, oldPlan);
    let sent!: ChatRequest, finish!: () => void;
    const frames: Array<() => void> = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      requestAnimationFrame: (callback: () => void) => { frames.push(callback); return 1; }, cancelAnimationFrame() {},
      localAi: {
        messages: { regenerate: async (id: string) => database.regenerateUserMessageAndTruncate(id) },
        analysis: { list: async (id: string) => database.listAnalysisRuns(id) },
        agentPlans: { get: async (id: string) => database.getAgentPlan(id) },
        conversations: { update: async (id: string, patch: object) => database.updateConversation(id, patch) },
        chat: { send: async (request: ChatRequest) => { sent = request; await new Promise<void>(resolve => { finish = resolve; }); } },
      },
    } });
    useAppStore.setState({ activeId: chat.id, conversations: [database.getConversation(chat.id)!], messages: database.listMessages(chat.id), analysisRuns: database.listAnalysisRuns(chat.id), agentPlan: oldPlan, settings: { llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: chat.modelId, contextWindow: chat.contextWindow } } });
    assert(withRunHistory(useAppStore.getState().messages, useAppStore.getState().analysisRuns).some(message => message.agentCancelled));
    await useAppStore.getState().updateConversation(chat.id, { thinkingEnabled: true });
    const pending = useAppStore.getState().regenerateMessage(user);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.mode, 'agent');
    assert.equal(database.getConversation(chat.id)!.thinkingEnabled, true);
    assert.equal(useAppStore.getState().agentPlan, null);
    assert.deepEqual(useAppStore.getState().analysisRuns.map(run => run.id), [earlierRun.id], 'keep earlier answers, drop only the regenerated attempt');
    assert(!withRunHistory(useAppStore.getState().messages, useAppStore.getState().analysisRuns).some(message => message.agentCancelled));
    const newRun = database.createAnalysisRun(chat.id, 'fast');
    const emit = (event: Omit<Parameters<ReturnType<typeof useAppStore.getState>['handleStream']>[0], 'conversationId' | 'generationId'>) => useAppStore.getState().handleStream({ conversationId: chat.id, generationId: sent.generationId, ...event });
    emit({ type: 'analysis-run', run: newRun });
    emit({ type: 'thinking', content: 'New actual reasoning', timelinePosition: 1 });
    while (frames.length) frames.shift()!();
    useAppStore.getState().handleStream({ type: 'analysis-run', conversationId: chat.id, generationId: 'stale-generation', run: stopped });
    assert(!useAppStore.getState().analysisRuns.some(run => run.id === stopped.id), 'late events cannot restore an old attempt');
    assert.equal(useAppStore.getState().messages.at(-1)!.thinking, 'New actual reasoning');
    const assistant = database.addMessage(chat.id, 'assistant', 'New final answer', undefined, [], { thinking: 'New actual reasoning' });
    const completed = database.finishAnalysisRun(newRun.id, 'completed', assistant.id);
    emit({ type: 'analysis-run', run: completed }); emit({ type: 'done', assistant });
    finish(); await pending;
    const visible = withRunHistory(database.listMessages(chat.id), database.listAnalysisRuns(chat.id));
    assert(!visible.some(message => message.agentCancelled));
    assert.equal(visible.at(-1)!.thinking, 'New actual reasoning');
    assert(!database.listAnalysisRuns(chat.id).flatMap(run => run.actions).some(action => action.id === 'old-tool'));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}
void run().then(() => console.log('Stopped → Thinking ON → Regenerate: fresh timeline/plan, earlier answers retained, stale events rejected and persisted attempts separated'), error => { console.error(error); process.exitCode = 1; });
