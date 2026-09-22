import assert from 'node:assert/strict';
import { formatContextTokens } from './context-format';

export function runContextUsageRegression(): void {
  const formatted = formatContextTokens(18_571, 'uk-UA');
  assert.equal(formatted.replace(/\u00a0|\u202f/g, ' '), '18 571', 'context tooltip did not use locale-aware exact token formatting');
  assert.equal(formatContextTokens(32_768, 'en-US'), '32,768', 'number formatter did not retain exact context value');
}

if (require.main === module) runContextUsageRegression();
