import type { RichChart } from './rich-artifacts';
export function chartNumber(value: unknown, language: 'ru' | 'en', compact = false): string {
  if (typeof value !== 'number') return String(value ?? '');
  return new Intl.NumberFormat(language === 'ru' ? 'ru-RU' : 'en-US', compact && Math.abs(value) >= 10_000
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: 20 }).format(value);
}
export function showChartLegend(chart: Pick<RichChart, 'chart' | 'title'> & { series: readonly RichChart['series'][number][] }): boolean {
  return chart.chart === 'pie' || chart.series.length > 1 || !chart.title.toLocaleLowerCase().includes(chart.series[0].name.toLocaleLowerCase());
}
