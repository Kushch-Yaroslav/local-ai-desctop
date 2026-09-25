import assert from 'node:assert/strict';
import { agentTurnReasoning, nextAgentTurnKind } from './agent-turn-policy';

export function runAgentTurnPolicyRegression(): void {
  assert.equal(agentTurnReasoning('deep', 'planning'), 'deep');
  assert.equal(agentTurnReasoning('deep', 'execution'), 'fast');
  assert.equal(agentTurnReasoning('deep', 'repair'), 'fast');
  assert.equal(agentTurnReasoning('deep', 'synthesis'), 'deep');
  assert.equal(agentTurnReasoning('fast', 'planning'), 'fast');
  assert.equal(nextAgentTurnKind({ initial: false, recovery: false, taskIntent: 'greenfield', previousTool: 'list_directory' }), 'execution');
  assert.equal(nextAgentTurnKind({ initial: false, recovery: false, taskIntent: 'action', previousFailed: true }), 'repair');
}
if (require.main === module) runAgentTurnPolicyRegression();
