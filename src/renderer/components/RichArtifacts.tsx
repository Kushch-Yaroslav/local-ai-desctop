import { useLocale } from '../use-locale';
import { getLanguage, t } from '../../shared/locale';
import type { ArtifactSource, Metric, RichArtifact, RichChart } from '../../shared/rich-artifacts';
import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { chartNumber, showChartLegend } from '../../shared/chart-presentation';
import { downloadSvg } from '../svg-export';
import { Markdown } from './Markdown';

const palette = ['#ff8a3d', '#67c7b5', '#8ca7ff', '#e9bd62', '#c78cff', '#ff6f91', '#8fce75', '#67b6e8'];
const number = (value: unknown) => typeof value === 'number' ? new Intl.NumberFormat(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 3 }).format(value) : String(value ?? '');
function Source({ source }: { source?: ArtifactSource }) { useLocale(); return source ? <div className="rich-source">{source.url ? <a href={source.url} onClick={(event) => { event.preventDefault(); void window.localAi.webImages.openSource(source.url!); }}>{source.label}</a> : <span>{source.label}</span>}{source.detail && <small>{source.detail}</small>}</div> : null; }

function Metrics({ metrics, title }: { metrics: Metric[]; title?: string }) {
  useLocale();
  return <section className="rich-metrics">{title && <h3>{title}</h3>}<div className="rich-metric-grid">{metrics.map((metric) => { const polarity = metric.changePolarity ?? 'neutral'; const favorable = polarity === 'higher_is_better' ? metric.change! >= 0 : polarity === 'lower_is_better' ? metric.change! <= 0 : false; const unfavorable = polarity !== 'neutral' && !favorable; return <article key={`${metric.label}-${metric.unit ?? ''}`} className="rich-metric"><span>{metric.label}</span><strong>{number(metric.value)}{metric.unit && <small> {metric.unit}</small>}</strong>{metric.change !== undefined && <em className={polarity === 'neutral' ? 'neutral' : favorable ? 'positive' : 'negative'}>{metric.change > 0 ? '+' : ''}{number(metric.change)}%{metric.comparison ? ` · ${metric.comparison}` : ''}{unfavorable ? ` · ${t('снижение показателя')}` : ''}</em>}{metric.description && <p>{metric.description}</p>}</article>; })}</div></section>;
}

function ChartView({ chart }: { chart: RichChart }) {
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const axis = { fill: 'var(--text-muted)', stroke: 'none', fontSize: 13 };
  const axisNumber = (value: unknown) => chartNumber(value, getLanguage(), true);
  const shortLabel = (value: unknown) => { const text = String(value ?? ''); return text.length > 22 ? `${text.slice(0, 21)}…` : text; };
  const legend = chart.chart === 'pie' ? chart.data.map((row) => ({ name: String(row[chart.xKey]), unit: undefined })) : chart.series;
  const tooltip = <Tooltip formatter={(value: unknown, name: unknown) => { const series = chart.chart === 'pie' ? chart.series[0] : chart.series.find(item => item.name === String(name) || item.key === String(name)); return [`${chartNumber(value, getLanguage())}${series?.unit ? ` ${series.unit}` : ''}`, String(name)]; }} contentStyle={{ background: 'var(--surface)' , borderColor: 'var(--border)', borderRadius: 8, color: 'var(--text)' }} labelStyle={{ color: 'var(--text)', fontWeight: 600 }} itemStyle={{ color: 'var(--text)' }} wrapperStyle={{ zIndex: 4 }} />;
  const keys = chart.series.map(item => item.key);
  const exportChart = () => { const svg = root.current?.querySelector('svg'); if (svg) downloadSvg(svg, chart.title, [
    ...((chart.xLabel || chart.yLabel) ? [{ label: [chart.yLabel, chart.xLabel].filter(Boolean).join(' · ') }] : []),
    ...legend.map((item, index) => ({ label: `${item.name}${item.unit ? ` (${item.unit})` : ''}`, color: palette[index % palette.length] })),
  ]); };
  return <section className="rich-chart"><header><h3>{chart.title}</h3><button type="button" onClick={exportChart}>{t('Экспорт SVG')}</button></header><div ref={root} className="rich-chart-canvas" role="img" aria-label={chart.title}>
    <ResponsiveContainer width="100%" height="100%">
      {chart.chart === 'bar' ? chart.orientation === 'horizontal' ? <BarChart data={chart.data} layout="vertical" margin={{ left: 12, right: 18, top: 8, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} /><XAxis type="number" tick={axis} tickFormatter={axisNumber} /><YAxis dataKey={chart.xKey} type="category" width={120} tickFormatter={shortLabel} tick={axis} /><Tooltip {...tooltip.props} />{chart.series.map((item, index) => <Bar key={item.key} dataKey={item.key} name={item.name} fill={palette[index % palette.length]} radius={[0, 4, 4, 0]} />)}</BarChart> : <BarChart data={chart.data} margin={{ left: 8, right: 20, top: 12, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} /><XAxis dataKey={chart.xKey} tickFormatter={shortLabel} tick={axis} interval="preserveStartEnd" minTickGap={20} angle={chart.data.length > 8 ? -20 : 0} textAnchor={chart.data.length > 8 ? 'end' : 'middle'} height={chart.data.length > 8 ? 55 : 34}  /><YAxis width={76} tick={axis} tickFormatter={axisNumber}  /><Tooltip {...tooltip.props} />{chart.series.map((item, index) => <Bar key={item.key} dataKey={item.key} name={item.name} fill={palette[index % palette.length]} radius={[4, 4, 0, 0]} />)}</BarChart>
      : chart.chart === 'line' ? <LineChart data={chart.data} margin={{ left: 8, right: 20, top: 12, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} /><XAxis dataKey={chart.xKey} tickFormatter={shortLabel} tick={axis} interval="preserveStartEnd" minTickGap={20} /><YAxis width={76} tick={axis} tickFormatter={axisNumber} /><Tooltip {...tooltip.props} />{chart.series.map((item, index) => <Line key={item.key} dataKey={item.key} name={item.name} stroke={palette[index % palette.length]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} />)}</LineChart>
      : chart.chart === 'area' ? <AreaChart data={chart.data} margin={{ left: 8, right: 20, top: 12, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} /><XAxis dataKey={chart.xKey} tickFormatter={shortLabel} tick={axis} interval="preserveStartEnd" minTickGap={20} /><YAxis width={76} tick={axis} tickFormatter={axisNumber} /><Tooltip {...tooltip.props} />{chart.series.map((item, index) => <Area key={item.key} dataKey={item.key} name={item.name} stroke={palette[index % palette.length]} fill={palette[index % palette.length]} fillOpacity={.16} strokeWidth={2} connectNulls={false} />)}</AreaChart>
      : chart.chart === 'pie' ? <PieChart><Tooltip {...tooltip.props} /><Pie data={chart.data} dataKey={keys[0]} nameKey={chart.xKey} cx="50%" cy="50%" outerRadius="72%">{chart.data.map((row, cellIndex) => <Cell key={String(row[chart.xKey])} fill={palette[cellIndex % palette.length]} />)}</Pie></PieChart>
      : <ScatterChart margin={{ left: 8, right: 16, top: 8, bottom: 24 }}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} /><XAxis type="number" dataKey={chart.xKey} name={chart.xLabel ?? chart.xKey} tick={axis} /><YAxis type="number" dataKey={keys[0]} name={chart.series[0]?.name} tick={axis} /><Tooltip {...tooltip.props} />{chart.series.map((item, index) => <Scatter key={item.key} data={chart.data} dataKey={item.key} name={item.name} fill={palette[index % palette.length]} />)}</ScatterChart>}
    </ResponsiveContainer>
  </div>{(chart.xLabel || chart.yLabel || (chart.series.length === 1 && chart.series[0].unit)) && <div className="rich-chart-axis-titles"><span>{chart.yLabel ?? (chart.series.length === 1 ? chart.series[0].unit : undefined)}</span><span>{chart.xLabel}</span></div>}{showChartLegend(chart) && <ul className="rich-chart-legend" aria-label={t('Легенда графика')}>{legend.map((item, index) => <li key={`${item.name}-${index}`}><i style={{ background: palette[index % palette.length] }} /><span>{item.name}{item.unit && <small> · {item.unit}</small>}</span></li>)}</ul>}<Source source={chart.source} /></section>;
}

function TableView({ artifact }: { artifact: Extract<RichArtifact, { type: 'data_table' }> }) {
  useLocale(); const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const rows = sort ? [...artifact.rows].sort((a, b) => { const left = a[sort.key]; const right = b[sort.key]; return (typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''), getLanguage())) * sort.direction; }) : artifact.rows;
  const csv = [artifact.columns.map(col => col.label), ...rows.map(row => artifact.columns.map(col => row[col.key] ?? ''))].map(line => line.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const copy = async () => { await navigator.clipboard.writeText(csv).catch(() => undefined); };
  return <section className="rich-table"><header><h3>{artifact.title ?? t('Данные')}</h3><button type="button" onClick={() => { void copy(); }}>{t('Копировать таблицу')}</button><button type="button" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'data.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }}>{t('Скачать CSV')}</button></header><div className="rich-table-scroll"><table><thead><tr>{artifact.columns.map(column => <th key={column.key} className={column.kind === 'number' ? 'numeric' : ''}><button type="button" onClick={() => setSort(current => current?.key === column.key ? { key: column.key, direction: current.direction === 1 ? -1 : 1 } : { key: column.key, direction: 1 })}>{column.label}{sort?.key === column.key ? sort.direction === 1 ? ' ↑' : ' ↓' : ''}</button></th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{artifact.columns.map(column => <td key={column.key} className={column.kind === 'number' ? 'numeric' : ''}>{number(row[column.key])}</td>)}</tr>)}</tbody></table></div><Source source={artifact.source} /></section>;
}

function ImageGallery({ artifact }: { artifact: Extract<RichArtifact, { type: 'image_gallery' }> }) {
  useLocale();
  const [images, setImages] = useState<Record<string, string>>({}); const [failed, setFailed] = useState<Set<string>>(new Set()); const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all(artifact.images.map(async (image) => {
      try { return [image.discoveryId, (await window.localAi.webImages.load(image.url)).dataUrl] as const; }
      catch { return [image.discoveryId, null] as const; }
    })).then((results) => {
      if (!live) return;
      setImages(Object.fromEntries(results.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
      setFailed(new Set(results.filter((entry) => entry[1] === null).map(([id]) => id)));
    });
    return () => { live = false; };
  }, [artifact]);
  useEffect(() => { if (!selected) return; const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [selected]);
  const selectedImage = artifact.images.find(image => image.discoveryId === selected);
  return <section className="rich-gallery"><h3>{artifact.title ?? t('Изображения из интернета')}</h3>{artifact.summary && <p>{artifact.summary}</p>}<div className={`rich-gallery-grid gallery-count-${Math.min(artifact.images.length, 5)}`}>{artifact.images.map(image => <article key={image.discoveryId} className="rich-gallery-item"><button type="button" className="rich-gallery-preview" onClick={() => setSelected(image.discoveryId)} aria-label={`${t('Открыть изображение')}: ${image.title}`}>{images[image.discoveryId] ? <img loading="lazy" src={images[image.discoveryId]} alt={image.alt} /> : <span>{failed.has(image.discoveryId) ? t('Изображение недоступно') : t('Загрузка изображения…')}</span>}</button><strong>{image.title}</strong><button type="button" className="rich-source-link" onClick={() => { void window.localAi.webImages.openSource(image.sourceUrl); }}>{image.sourceDomain} · {t('Источник')}</button></article>)}</div>{selected && <div className="rich-image-modal" role="dialog" aria-modal="true" aria-label={t('Просмотр изображения')} onClick={() => setSelected(null)}><div className="rich-image-modal-content" onClick={event => event.stopPropagation()}><button type="button" onClick={() => setSelected(null)}>{t('Закрыть')}</button>{images[selected] && <img src={images[selected]} alt={selectedImage?.alt ?? ''} />}{selectedImage && <footer><span>{selectedImage.title}</span><button type="button" onClick={() => { void window.localAi.webImages.openSource(selectedImage.sourceUrl); }}>{selectedImage.sourceDomain} · {t('Открыть источник')}</button></footer>}</div></div>}</section>;
}

function ArtifactBody({ artifact }: { artifact: RichArtifact }) {
  if (artifact.type === 'metric_group') return <Metrics title={artifact.title} metrics={artifact.metrics} />;
  if (artifact.type === 'chart') return <ChartView chart={artifact} />;
  if (artifact.type === 'data_table') return <TableView artifact={artifact} />;
  if (artifact.type === 'image_gallery') return <ImageGallery artifact={artifact} />;
  if (artifact.type === 'diagram') return <section className="rich-diagram">{artifact.title && <h3>{artifact.title}</h3>}<Markdown>{`\`\`\`mermaid\n${artifact.mermaid}\n\`\`\``}</Markdown></section>;
  return <article className="rich-report"><header><h2>{artifact.title}</h2>{artifact.summary && <p>{artifact.summary}</p>}</header>{artifact.metrics?.length ? <Metrics metrics={artifact.metrics} /> : null}{artifact.charts?.map((chart, index) => <ChartView key={`${artifact.id}-chart-${index}`} chart={chart} />)}{artifact.tables?.map((table, index) => <TableView key={`${artifact.id}-table-${index}`} artifact={{ ...table, id: `${artifact.id}-table-${index}` }} />)}{artifact.findings?.length ? <section><h3>{t('Основные выводы')}</h3><ul>{artifact.findings.map(item => <li key={item}>{item}</li>)}</ul></section> : null}{artifact.recommendations?.length ? <section><h3>{t('Рекомендации')}</h3><ul>{artifact.recommendations.map(item => <li key={item}>{item}</li>)}</ul></section> : null}{artifact.sources?.map(source => <Source key={`${source.label}-${source.url ?? ''}`} source={source} />)}</article>;
}

export function RichArtifacts({ artifacts }: { artifacts?: RichArtifact[] }) {
  useLocale();
  useEffect(() => { const frame = requestAnimationFrame(() => { for (const artifact of artifacts ?? []) { const start = `rich.received.${artifact.id}`; if (performance.getEntriesByName(start).length) { performance.clearMeasures('rich.artifact.dom_committed'); performance.measure('rich.artifact.dom_committed', start); performance.clearMarks(start); } } }); return () => cancelAnimationFrame(frame); }, [artifacts]);
  if (!artifacts?.length) return null;
  return <div className="rich-artifacts">{artifacts.map(artifact => <ArtifactBody key={artifact.id} artifact={artifact} />)}</div>;
}
