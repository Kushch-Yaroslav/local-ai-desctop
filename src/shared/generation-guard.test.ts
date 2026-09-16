import assert from 'node:assert/strict';
import { isCurrentGenerationEvent } from './generation-guard';

export function runGenerationGuardRegression(): void {
  assert(isCurrentGenerationEvent('chat', 'new-generation', 'chat', 'new-generation'), 'active generation was rejected');
  assert(!isCurrentGenerationEvent('chat', 'old-generation', 'chat', 'new-generation'), 'stale generation could update a regenerated response');
  assert(!isCurrentGenerationEvent('other-chat', 'new-generation', 'chat', 'new-generation'), 'another conversation could update the active response');
}

if (require.main === module) runGenerationGuardRegression();
