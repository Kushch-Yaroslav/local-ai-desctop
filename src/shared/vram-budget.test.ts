import assert from 'node:assert/strict';
import { createVramBudget, vramBudgetStillFits, vramEstimatorMarginBytes } from './vram-budget';
const MiB = 1024 ** 2;
const budget = (background: number, llm: number, total = 24576) => createVramBudget(total * MiB, (background + llm) * MiB, (total - background - llm - 458) * MiB, llm * MiB);
export function runVramBudgetRegression() {
  const value = budget(1100, 20000);
  const desktop750 = budget(750, 20000);
  assert.equal(desktop750.nonLlmBytes / MiB, 750);
  assert.equal(desktop750.availableLlmBytes / MiB, 22642, '750 used is part of the 1550 absolute cap; do not subtract it twice');
  assert.equal(desktop750.marginBytes / MiB, 384, 'the emergency startup floor is not another additive reserve');
  assert.equal(value.llmBudgetBytes / MiB, 24576 - 1550 - 384, '1550 must be total background budget, not added to 1100 used');
  assert.equal(budget(900, 20000).llmBudgetBytes, value.llmBudgetBytes);
  assert.equal(budget(1100, 15000, 22000).llmBudgetBytes / MiB, 22000 - 1550 - 384, 'must use actual total');
  assert(vramEstimatorMarginBytes >= 150 * MiB && vramEstimatorMarginBytes <= 800 * MiB);
  assert.equal(budget(2000, 20000).availableLlmBytes / MiB, 24576 - 2000 - 458 - 384, 'actual free memory binds with over-budget background');
  assert.equal(vramBudgetStillFits(value, budget(1250, 2000)), true);
  assert.equal(vramBudgetStillFits(value, budget(1400, 2000)), false, 'material background change invalidates');
  assert.equal(vramBudgetStillFits(budget(1000, 22640), budget(1100, 2000)), false, 'budget violation invalidates even a small background change');
  assert.throws(() => createVramBudget(10, 8, 5, 2), /Некорректные данные о памяти VRAM/);
}
if (require.main === module) runVramBudgetRegression();
