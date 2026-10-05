/**
 * Russian presentation of runtime labels. Internal values (modes, statuses, model ids, protocol fields) are never
 * changed; they are mapped to text only where they are shown.
 */
export const reasoningModeLabel = { fast: 'Быстро', deep: 'Глубоко' } as const;
export const chatModeLabel = { chat: 'Чат', agent: 'Агент' } as const;

/** Why a Max Context search stopped at its boundary. */
export const boundaryReasonLabel: Record<string, string> = {
  'model-limit': 'предел модели',
  'probe-failure': 'сбой пробного запуска',
  'budget-guard': 'защитный порог памяти',
  'bounded-search': 'ограниченный поиск',
};

export function pluralRu(count: number, one: string, few: string, many: string): string {
  const rounded = Math.round(Math.abs(count));
  const lastTwo = rounded % 100;
  const last = rounded % 10;
  return lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
}

export const tokensWord = (count: number) => pluralRu(count, 'токен', 'токена', 'токенов');

const grouping = new Intl.NumberFormat('ru-RU');
/** 28450 -> "28 450" (non-breaking spaces); missing values show a dash. */
export const formatCount = (value: number | null | undefined): string => typeof value === 'number' && Number.isFinite(value) ? grouping.format(value) : '—';

/** 45 -> "45 с", 372 -> "6 мин 12 с", 3725 -> "1 ч 02 мин". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
  return `${Math.floor(seconds / 3600)} ч ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} мин`;
}

/** Project identity labels are built for the model ("Project 1 — name"); the UI shows them in Russian. */
export const localizeProjectLabel = (label: string): string => label.replace(/^Project (\d)\b/, 'Проект $1');

/** Text of the steering message sent by the «Пауза» control; the pause itself is a structured intent, not parsed from this text. */
export const pauseRequestText = 'Поставь работу на паузу: сохрани контрольную точку и остановись.';
