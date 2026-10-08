import { tokensWord } from '../../shared/localization';
import { useLocale } from '../use-locale';
import { t, tr } from '../../shared/locale';
import type { GenerationDiagnostics } from '../../shared/types';

const compact = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const rate = (value: number) => tr`${value.toFixed(1)} ток/с`;
const tokens = tokensWord;

function tooltip(value: GenerationDiagnostics | null, isGenerating: boolean): string {
  if (!value) return isGenerating ? t("Скорость появится после завершения генерации: движок не передаёт точное число токенов в реальном времени.") : t("Нет завершённой генерации.");
  const lines = [value.tokensPerSecond !== undefined ? tr`Генерация: ${rate(value.tokensPerSecond)}` : t("Генерация: недоступно")];
  if (value.evalCount !== undefined) lines.push(tr`Сгенерировано: ${compact(value.evalCount)} ${tokens(value.evalCount)}`);
  if (value.promptTokensPerSecond !== undefined) lines.push(tr`Обработка промпта: ${rate(value.promptTokensPerSecond)}`);
  if (value.promptEvalCount !== undefined) lines.push(tr`Токенов промпта: ${compact(value.promptEvalCount)}`);
  if (value.timeToFirstTokenMs !== undefined) lines.push(tr`Первый токен: ${(value.timeToFirstTokenMs / 1000).toFixed(1)} с`);
  return lines.join('\n');
}

/** The primary value is authoritative: llama.cpp's reported completion metrics. Live output stays blank until that metric exists. */
export function InferencePerformance({ value, isGenerating }: { value: GenerationDiagnostics | null; isGenerating: boolean }) {
  useLocale();
  const label = value?.tokensPerSecond !== undefined ? rate(value.tokensPerSecond) : t("— ток/с");
  return <span className={`performance-indicator${isGenerating && !value ? ' pending' : ''}`} title={tooltip(value, isGenerating)} aria-label={tr`Скорость генерации: ${label}`}>{t("Ген. ")}{label}</span>;
}
