import assert from 'node:assert/strict';
import type { GenerationDiagnostics } from '../../shared/types';
import { saveGenerationDiagnosticsBestEffort } from './generation-diagnostics';

const diagnostics: GenerationDiagnostics = {
  generationId: 'generation', conversationId: 'conversation', reasoningPreset: 'normal', requestedMaxOutputTokens: 1, effectiveMaxOutputTokens: 1,
  contextLimit: 1, inputTokens: 1, agentStepCount: 0, finishReason: 'stop', createdAt: new Date().toISOString(),
};

export function runGenerationDiagnosticsRegression(): void {
  let attempts = 0;
  saveGenerationDiagnosticsBestEffort(() => { attempts += 1; throw new Error('SQLite write failed'); }, diagnostics);
  assert.equal(attempts, 1, 'a diagnostics storage failure escaped its best-effort boundary');

  let saved: GenerationDiagnostics | undefined;
  saveGenerationDiagnosticsBestEffort((value) => { saved = value; }, diagnostics);
  assert.equal(saved, diagnostics, 'successful diagnostics were not forwarded to storage');
}

if (require.main === module) runGenerationDiagnosticsRegression();
