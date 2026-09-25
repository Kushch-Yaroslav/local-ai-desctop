import type { ReasoningMode } from '../../shared/types';

/** A small semantic vocabulary replaces per-step token ceilings. The selected
 * mode only controls provider-native thinking effort; output safety budgeting
 * remains the backend's responsibility. */
export type AgentTurnKind = 'planning' | 'execution' | 'investigation' | 'repair' | 'synthesis';

export function agentTurnReasoning(preference: ReasoningMode, kind: AgentTurnKind): ReasoningMode {
  if (preference === 'fast') return kind === 'synthesis' ? 'fast' : 'fast';
  if (preference === 'auto') return kind === 'repair' || kind === 'execution' ? 'fast' : 'auto';
  // Deep remains deep for ambiguous work and final explanation. Mechanical
  // continuations use the provider's low effort instead of xhigh.
  return kind === 'execution' || kind === 'repair' ? 'fast' : 'deep';
}

export function nextAgentTurnKind(input: { initial: boolean; recovery: boolean; taskIntent: 'chat' | 'analysis' | 'action' | 'greenfield'; previousTool?: string; previousFailed?: boolean; final?: boolean }): AgentTurnKind {
  if (input.final) return 'synthesis';
  if (input.recovery || input.previousFailed) return 'repair';
  if (input.initial) return input.taskIntent === 'greenfield' || input.taskIntent === 'action' ? 'planning' : 'investigation';
  if (input.taskIntent === 'analysis') return 'investigation';
  // Directory/list/read success normally makes the next filesystem operation
  // concrete; preserve deep reasoning only where the task remains ambiguous.
  if (['list_directory', 'read_file', 'inspect_package_json'].includes(input.previousTool ?? '')) return 'execution';
  return 'execution';
}
