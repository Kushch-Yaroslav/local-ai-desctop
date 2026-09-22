import type { GenerationDiagnostics } from '../../shared/types';

const compact = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const rate = (value: number) => `${value.toFixed(1)} ток/с`;
const tokens = (value: number) => {
  const rounded = Math.round(Math.abs(value)); const lastTwo = rounded % 100; const last = rounded % 10;
  return lastTwo >= 11 && lastTwo <= 14 ? 'токенов' : last === 1 ? 'токен' : last >= 2 && last <= 4 ? 'токена' : 'токенов';
};

function tooltip(value: GenerationDiagnostics | null, isGenerating: boolean): string {
  if (!value) return isGenerating ? 'Скорость появится после завершения генерации: движок не передаёт точное число токенов в реальном времени.' : 'Нет завершённой генерации.';
  const lines = [value.tokensPerSecond !== undefined ? `Генерация: ${rate(value.tokensPerSecond)}` : 'Генерация: недоступно'];
  if (value.evalCount !== undefined) lines.push(`Сгенерировано: ${compact(value.evalCount)} ${tokens(value.evalCount)}`);
  if (value.promptTokensPerSecond !== undefined) lines.push(`Обработка промпта: ${rate(value.promptTokensPerSecond)}`);
  if (value.promptEvalCount !== undefined) lines.push(`Токенов промпта: ${compact(value.promptEvalCount)}`);
  if (value.timeToFirstTokenMs !== undefined) lines.push(`Первый токен: ${(value.timeToFirstTokenMs / 1000).toFixed(1)} с`);
  return lines.join('\n');
}

/** The primary value is authoritative: Ollama eval_count / eval_duration. Live output stays blank until that metric exists. */
export function InferencePerformance({ value, isGenerating }: { value: GenerationDiagnostics | null; isGenerating: boolean }) {
  const label = value?.tokensPerSecond !== undefined ? rate(value.tokensPerSecond) : '— ток/с';
  return <span className={`performance-indicator${isGenerating && !value ? ' pending' : ''}`} title={tooltip(value, isGenerating)} aria-label={`Скорость генерации: ${label}`}>Ген. {label}</span>;
}
