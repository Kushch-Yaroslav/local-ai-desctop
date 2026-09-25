import assert from 'node:assert/strict';
import type { ChatMessage } from '../../shared/types';
import { isCompleteRuntimeFinal, shouldProjectToolResult, splitAgentRunHistory } from './rust-agent-runtime';

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `${role}-${content}`, conversationId: 'test', role, content, createdAt: '2026-01-01T00:00:00.000Z',
});

/** Regression coverage for the Electron→Rust ownership boundary. In each
 * sequence the current prompt must remain a real user node, never an adjacent
 * project/system/assistant record. */
export function runRustAgentRuntimeRegression(): void {
  const scenarios = [
    [message('system', 'Project 1'), message('user', 'first prompt')],
    [message('user', 'old prompt'), message('assistant', 'old answer'), message('user', 'next prompt')],
    [message('system', 'Project 1'), message('user', 'old'), message('assistant', 'answer'), message('system', 'Project 2'), message('user', 'switched project')],
    [message('user', 'regenerated prompt'), message('assistant', 'optimistic placeholder')],
    [message('user', 'completed prompt'), message('assistant', 'completed answer'), message('user', 'next after completion')],
    [message('user', 'old compacted prompt'), message('assistant', 'summary'), message('system', 'compaction context'), message('user', 'next after compaction')],
  ];
  for (const history of scenarios) {
    const split = splitAgentRunHistory(history);
    const expected = history.filter((entry) => entry.role === 'user').at(-1)!;
    assert.equal(split.user, expected.content);
    assert(!split.prior.includes(expected));
  }
  assert.throws(() => splitAgentRunHistory([message('system', 'no prompt')]));
  assert.equal(shouldProjectToolResult({ type: 'tool_result', name: 'task_notes', is_error: false }), false);
  assert.equal(shouldProjectToolResult({ type: 'tool_error', name: 'task_notes', is_error: true }), true);
  assert.equal(shouldProjectToolResult({ type: 'tool_result', name: 'read_file', is_error: false }), true);
  assert.equal(isCompleteRuntimeFinal({ type: 'final', complete: true }), true);
  assert.equal(isCompleteRuntimeFinal({ type: 'final' }), true);
  assert.equal(isCompleteRuntimeFinal({ type: 'final', complete: false }), false);
  assert.equal(isCompleteRuntimeFinal({ type: 'agent_error' }), false);
}

if (require.main === module) runRustAgentRuntimeRegression();
