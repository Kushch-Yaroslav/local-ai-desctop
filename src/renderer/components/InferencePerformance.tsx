import type { GenerationDiagnostics } from '../../shared/types';

const compact = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const rate = (value: number) => `${value.toFixed(1)} tok/s`;

function tooltip(value: GenerationDiagnostics | null, isGenerating: boolean): string {
  if (!value) return isGenerating ? 'Скорость появится после завершения Ollama generation: runtime не передаёт точный live token count.' : 'Нет завершённой generation.';
  const lines = [value.tokensPerSecond !== undefined ? `Generation: ${rate(value.tokensPerSecond)}` : 'Generation: недоступно'];
  if (value.evalCount !== undefined) lines.push(`Generated: ${compact(value.evalCount)} tokens`);
  if (value.promptTokensPerSecond !== undefined) lines.push(`Prompt processing: ${rate(value.promptTokensPerSecond)}`);
  if (value.promptEvalCount !== undefined) lines.push(`Prompt tokens: ${compact(value.promptEvalCount)}`);
  if (value.timeToFirstTokenMs !== undefined) lines.push(`Time to first token: ${(value.timeToFirstTokenMs / 1000).toFixed(1)} s`);
  return lines.join('\n');
}

/** The primary value is authoritative: Ollama eval_count / eval_duration. Live output stays blank until that metric exists. */
export function InferencePerformance({ value, isGenerating }: { value: GenerationDiagnostics | null; isGenerating: boolean }) {
  const label = value?.tokensPerSecond !== undefined ? rate(value.tokensPerSecond) : '— tok/s';
  return <span className={`performance-indicator${isGenerating && !value ? ' pending' : ''}`} title={tooltip(value, isGenerating)} aria-label={`Скорость генерации: ${label}`}>Gen {label}</span>;
}
