import type { GenerationDiagnostics } from '../../shared/types';
import { log } from './logger';

/** Diagnostics are telemetry: a failed write must never fail an already-successful generation. */
export function saveGenerationDiagnosticsBestEffort(save: (diagnostics: GenerationDiagnostics) => void, diagnostics: GenerationDiagnostics): void {
  try { save(diagnostics); }
  catch (error) {
    try {
      log('generation.diagnostics.save.failed', {
        generationId: diagnostics.generationId,
        conversationId: diagnostics.conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch { /* Logging must not turn telemetry failure into a generation failure. */ }
  }
}
