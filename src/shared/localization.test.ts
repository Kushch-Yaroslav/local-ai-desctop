import assert from 'node:assert/strict';
import { boundaryReasonLabel, formatCount, formatDuration, localizeProjectLabel, pluralRu, tokensWord } from './localization';

export function runLocalizationRegression(): void {
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111, 0].map(tokensWord), ['токен', 'токена', 'токенов', 'токенов', 'токенов', 'токен', 'токена', 'токенов', 'токенов', 'токенов']);
  assert.equal(pluralRu(3, 'запись', 'записи', 'записей'), 'записи');
  assert.equal(formatDuration(0), '0 с');
  assert.equal(formatDuration(45), '45 с');
  assert.equal(formatDuration(372), '6 мин 12 с');
  assert.equal(formatDuration(3725), '1 ч 02 мин');
  assert.equal(formatCount(28450).replace(/\s/g, ' '), '28 450');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount(Number.NaN), '—');
  assert.equal(localizeProjectLabel('Project 2 — Online-Shop'), 'Проект 2 — Online-Shop');
  assert.equal(localizeProjectLabel('Мой Project 1'), 'Мой Project 1', 'only a leading identity label is translated');
  for (const reason of ['model-limit', 'probe-failure', 'budget-guard', 'bounded-search']) assert.ok(boundaryReasonLabel[reason], reason);
}

if (require.main === module) runLocalizationRegression();
