import assert from 'node:assert/strict';
import { isCurrentGenerationEvent } from './generation-guard';
import { executionMode } from './generation-mode';

export function runGenerationGuardRegression(): void {
  assert(isCurrentGenerationEvent('chat', 'new-generation', 'chat', 'new-generation'), 'active generation was rejected');
  assert(!isCurrentGenerationEvent('chat', 'old-generation', 'chat', 'new-generation'), 'stale generation could update a regenerated response');
  assert(!isCurrentGenerationEvent('other-chat', 'new-generation', 'chat', 'new-generation'), 'another conversation could update the active response');
  // A stopped Chat branch can be regenerated immediately after selecting Agent;
  // the outgoing request carries that current selection instead of stale history.
  assert(executionMode('chat', 'agent') === 'agent', 'Regenerate did not use the newly selected Agent mode');
  assert(executionMode('agent') === 'agent', 'generation did not preserve the stored mode without a new selection');
}

if (require.main === module) runGenerationGuardRegression();
