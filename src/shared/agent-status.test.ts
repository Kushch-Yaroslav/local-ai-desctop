import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentStatus, showAgentStatus, isStatusSnapshot } from './agent-status';
import { agentStatusText } from './localization';
import { AgentStatusPanel } from '../renderer/components/AgentStatusPanel';
import { useAppStore } from '../renderer/store/app-store';
import type { AgentPlan, Conversation } from './types';
import type {} from '../renderer/env';

async function run(): Promise<void> {
  const memory: NonNullable<AgentPlan['taskMemory']> = { entries: [], plan: { steps: [
    { id: 'read', text: 'Read project', status: 'completed' }, { id: 'fix', text: 'Fix project', status: 'in_progress' }, { id: 'test', text: 'Test project', status: 'pending' },
  ] }, deliverables: { items: [
    { id: '1', text: 'Working build', status: 'verified' }, { id: '2', text: 'Theme', status: 'implemented' },
    { id: '3', text: 'Bot', status: 'pending' }, { id: '4', text: 'Browser', status: 'blocked', reason: 'Unavailable' }, { id: '5', text: 'Old request', status: 'dropped' },
  ] } };
  const plan: AgentPlan = { taskMemory: memory };
  const markup = renderToStaticMarkup(createElement(AgentStatusPanel, { plan, running: true }));
  assert.equal((markup.match(/class="agent-status-panel"/g) ?? []).length, 1);
  assert.match(markup, /aria-expanded="false"/); assert(!markup.includes('aria-current="step"'));
  assert.match(markup, /1\/3/); assert.match(markup, /1\/4/);
  for (const label of [agentStatusText.plan, agentStatusText.result]) assert(markup.includes(label));
  assert.equal(renderToStaticMarkup(createElement(AgentStatusPanel, { plan: null })), '');
  const stoppedMarkup = renderToStaticMarkup(createElement(AgentStatusPanel, { plan, running: false }));
  assert(stoppedMarkup.includes(agentStatusText.saved));
  assert(!stoppedMarkup.includes(agentStatusText.unfinishedStep), 'details start collapsed');
  assert(!stoppedMarkup.includes('aria-current="step"'));
  assert(!markup.includes(agentStatusText.saved));
  const workBudget = { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' };
  const budgetMarkup = renderToStaticMarkup(createElement(AgentStatusPanel, { plan: { workBudget }, running: true }));
  assert.match(budgetMarkup, /140\/160/);
  assert(budgetMarkup.includes('Максимум 256') && budgetMarkup.includes('продлений: 1'));
  assert.equal(memory.plan!.steps[1].status, 'in_progress', 'terminal presentation must not mutate the saved plan or invent completion');
  const evidencePlan: AgentPlan = { taskMemory: { entries: [], deliverables: { items: [
    { id: 'runtime', text: 'Automatic response', status: 'verified', proof: ['ev-pass'], verification_scope: 'acceptance' },
  ] }, verification: { epoch: 2, records: [
    { id: 'ev-pass', kind: 'browser', class: 'functional', subject: 'browser interaction', pass: true, epoch: 2, turn: 1, deliverable_ids: ['runtime'] },
    { id: 'ev-baseline', kind: 'test', class: 'functional', subject: 'project suite', pass: false, epoch: 0, turn: 0, baseline: true },
    { id: 'ev-warning', kind: 'test', class: 'functional', subject: 'project suite', pass: false, epoch: 2, turn: 2, baseline_failure: 'ev-baseline', detail: 'independent assertion' },
  ] } } };
  const evidenceMarkup = renderToStaticMarkup(createElement(AgentStatusPanel, { plan: evidencePlan }));
  assert(evidenceMarkup.includes(agentStatusText.result));
  assert(evidenceMarkup.includes(agentStatusText.warnings));
  assert(!evidenceMarkup.includes('independent assertion'), 'warning details start collapsed');
  assert.equal(agentStatus(evidencePlan).warnings.length, 1, 'stale baseline is not an active duplicate warning');
  evidencePlan.taskMemory!.verification!.records.push({ id: 'ev-resolved', kind: 'test', class: 'functional', subject: 'project suite', pass: true, epoch: 2, turn: 3 });
  assert.equal(agentStatus(evidencePlan).warnings.length, 0, 'a successful retry resolves the displayed warning');
  evidencePlan.taskMemory!.verification!.epoch = 3;
  assert.equal(agentStatus(evidencePlan).checks.length, 0, 'old checks are stale after a mutation');
  assert.equal(agentStatus({ ...plan, modelTodo: { phases: [{ name: 'old', items: [{ id: 'legacy', content: 'old', status: 'pending' }] }] }, taskMemory: { entries: [], plan: { steps: [] } } }).steps.length, 0, 'an explicitly cleared plan must not resurrect a legacy snapshot');
  assert.equal(agentStatus({ steps: [{ id: 'old', label: 'Legacy', status: 'in_progress' }] }).steps[0]?.text, 'Legacy');
  assert(isStatusSnapshot({ id: 'p', label: 'Plan', kind: 'planning', detail: 'plan' }));
  assert(isStatusSnapshot({ id: 'd', label: 'Deliverables', kind: 'planning', detail: 'deliverables' }));
  assert(!isStatusSnapshot({ id: 'm', label: 'Memory', kind: 'planning', detail: 'task_memory' }));
  assert(!isStatusSnapshot({ id: 't', label: 'Terminal', kind: 'terminal', detail: 'plan' }));

  const chat = (id: string): Conversation => ({ id, title: id, modelId: 'model', mode: 'agent', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 16384, thinkingEnabled: null, reasoningEffort: null, reasoningMode: 'fast', contextTokens: null, contextModelId: null, webMode: 'off', createdAt: '', updatedAt: '' });
  const saved = new Map<string, AgentPlan>([['A', plan]]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, localAi: {
    messages: { list: async () => [] }, analysis: { list: async () => [] }, agentPlans: { get: async (id: string) => saved.get(id) ?? null }, chat: { send: async () => {} },
  } } });
  useAppStore.setState({ conversations: [chat('A'), chat('B')], activeId: null, settings: { llamaServerPath: null, modelsPath: '', llamaRuntime: { status: 'ready', modelId: 'model', contextWindow: 16384 } } });
  await useAppStore.getState().selectConversation('A');
  assert.strictEqual(useAppStore.getState().agentPlan, plan);
  await useAppStore.getState().sendMessage('Continue');
  const generationId = useAppStore.getState().generationId!;
  const emit = (type: string, more = {}) => useAppStore.getState().handleStream({ type, conversationId: 'A', generationId, ...structuredClone(more) });
  const changed = structuredClone(memory);
  changed.plan!.steps[1].status = 'completed'; changed.deliverables!.items[1].status = 'verified';
  emit('task-memory', { memory: changed }); saved.set('A', { taskMemory: changed });
  assert.equal(agentStatus(useAppStore.getState().agentPlan).steps.filter((step) => step.status === 'completed').length, 2);
  assert.equal(agentStatus(useAppStore.getState().agentPlan).deliverables.filter((item) => item.status === 'verified').length, 2);
  const currentPlan = useAppStore.getState().agentPlan;
  emit('task-memory', { memory: { ...changed, entries: [{ id: 'knowledge', finding: 'New finding' }] } });
  assert.strictEqual(useAppStore.getState().agentPlan, currentPlan, 'unrelated knowledge/evidence updates must not redraw current status');
  changed.verification = evidencePlan.taskMemory!.verification;
  emit('task-memory', { memory: changed });
  assert.deepEqual(useAppStore.getState().agentPlan?.taskMemory?.verification, changed.verification, 'live evidence must reach the compact panel and persist through Continue');
  await useAppStore.getState().selectConversation('B');
  assert.equal(useAppStore.getState().agentPlan, null);
  changed.plan!.steps[2].status = 'in_progress';
  emit('task-memory', { memory: changed });
  assert.equal(useAppStore.getState().agentPlan, null, 'background plan updates must not leak into another chat');
  await useAppStore.getState().selectConversation('A');
  assert.equal(useAppStore.getState().agentPlan?.taskMemory?.plan?.steps[2].status, 'in_progress');
  emit('paused', { timelinePosition: 3 });
  emit('done');
  assert.deepEqual(useAppStore.getState().agentPlan?.taskMemory, changed, 'completion/pause must preserve the current panel');
  await useAppStore.getState().sendMessage('Continue after pause');
  const nextId = useAppStore.getState().generationId!;
  useAppStore.getState().handleStream({ type: 'work-budget', budget: workBudget, conversationId: 'A', generationId: nextId });
  useAppStore.getState().handleStream({ type: 'task-memory', memory: { ...changed, plan: { ...changed.plan!, revision: 99 } }, conversationId: 'A', generationId: nextId });
  assert.deepEqual(useAppStore.getState().agentPlan?.workBudget, workBudget, 'memory updates must preserve the runtime budget projection');
  useAppStore.getState().handleStream({ type: 'task-memory', memory: changed, conversationId: 'A', generationId: nextId });
  assert.deepEqual(useAppStore.getState().agentPlan?.taskMemory, changed, 'Continue retains canonical planning');
  useAppStore.getState().handleStream({ type: 'error', conversationId: 'A', generationId: nextId, message: 'HTTP 500' });
  assert.deepEqual(useAppStore.getState().agentPlan?.taskMemory, changed, 'terminal failure must keep status visible');
  await useAppStore.getState().selectConversation('B'); await useAppStore.getState().selectConversation('A');
  assert.deepEqual(useAppStore.getState().agentPlan?.taskMemory, changed);
  console.log('Agent Status projection, localization, live plan/results, chat isolation, pause/Continue/completion/failure regressions passed');
}
void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

const initialBudget = { used: 2, limit: 128, maximum: 256, extensions: 0, decision: 'initial', reason: 'initial' };
assert.equal(showAgentStatus({ workBudget: initialBudget }), false);
assert.equal(showAgentStatus({ workBudget: initialBudget }, true), true);
assert.equal(showAgentStatus(null, true), false);
assert.equal(showAgentStatus({ workBudget: { ...initialBudget, used: 112 } }), true);
assert.equal(showAgentStatus({ workBudget: { ...initialBudget, extensions: 1, limit: 160 } }), true);
assert.equal(showAgentStatus({ workBudget: initialBudget, taskMemory: { entries: [], verification: { code_changed: true, records: [] } } }), true);
assert.equal(showAgentStatus({ taskMemory: { entries: [{ id: '1', finding: 'read only' }] } }), false);
