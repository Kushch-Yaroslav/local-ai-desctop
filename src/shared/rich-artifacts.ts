/** Versioned, data-only visual response protocol. It never accepts executable markup. */
export type ArtifactSource = { label: string; url?: string; detail?: string };
export type Metric = { label: string; value: string | number; unit?: string; change?: number; changePolarity?: 'higher_is_better' | 'lower_is_better' | 'neutral'; comparison?: string; description?: string };
export type RichChart = {
  type: 'chart'; chart: 'bar' | 'line' | 'area' | 'pie' | 'scatter'; title: string;
  data: Array<Record<string, string | number | null>>; xKey: string; series: Array<{ key: string; name: string; unit?: string }>;
  orientation?: 'vertical' | 'horizontal'; xLabel?: string; yLabel?: string; source?: ArtifactSource;
};
export type RichArtifact =
  | { version: 1; id: string; type: 'metric_group'; title?: string; metrics: Metric[]; source?: ArtifactSource }
  | { version: 1; id: string; type: 'data_table'; title?: string; columns: Array<{ key: string; label: string; kind?: 'text' | 'number' | 'date' }>; rows: Array<Record<string, string | number | null>>; source?: ArtifactSource }
  | (RichChart & { version: 1; id: string })
  | { version: 1; id: string; type: 'image_gallery'; title?: string; summary?: string; images: Array<{ discoveryId: string; url: string; sourceUrl: string; sourceDomain: string; title: string; alt: string }> }
  | { version: 1; id: string; type: 'diagram'; title?: string; syntax: 'mermaid'; mermaid: string }
  | { version: 1; id: string; type: 'rich_report'; title: string; summary?: string; metrics?: Metric[]; charts?: RichChart[]; tables?: Array<Extract<RichArtifact, { type: 'data_table' }>>; findings?: string[]; recommendations?: string[]; sources?: ArtifactSource[] };

export type DiscoveredImage = { id: string; url: string; sourceUrl: string; title: string; alt: string };
export type ArtifactResult = { artifact: RichArtifact; error?: never } | { error: string; code?: string; field?: string; received?: unknown; retrySameArguments?: false; validDiscoveryIds?: string[]; artifact?: never };
export const MAX_GALLERY_IMAGES = 8;
export class ArtifactToolError extends Error { constructor(readonly result: Record<string, unknown>) { super(String(result.error)); } }
export function galleryFailureWarning(activities: import('./types').ToolActivity[], artifacts?: RichArtifact[]): boolean {
  return !artifacts?.some(artifact => artifact.type === 'image_gallery') && activities.some(activity => activity.state === 'error' && activity.metadata?.artifactType === 'image_gallery');
}

export function artifactFailure(result: ArtifactResult) { return { ...result, accepted: false, stage: 'validation' }; }
export function artifactAcknowledgment(artifact: RichArtifact, reused = false) { return { accepted: true, artifact_id: artifact.id, type: artifact.type, stage: 'emitted_to_ui', ...(artifact.type === 'image_gallery' ? { image_count: artifact.images.length } : {}), presentation: 'Artifact accepted and emitted to the conversation UI. This is not a renderer acknowledgement. Do not repeat it in Markdown or claim a failed gallery succeeded.', ...(reused ? { reused: true } : {}) }; }

const MAX_ARTIFACT_BYTES = 256_000;
const MAX_ROWS = 300;
const MAX_COLUMNS = 32;
const MAX_SERIES = 8;
const MAX_CATEGORIES = 300;
const MAX_TEXT = 2_000;
const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalText = (value: unknown, max = MAX_TEXT) => value === undefined || value === null || (typeof value === 'string' && value.length <= max);
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const source = (value: unknown, allowedUrls?: ReadonlySet<string>, allowedLabels?: ReadonlySet<string>): value is ArtifactSource => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && exactKeys(value as Record<string, unknown>, ['label', 'url', 'detail']) && text((value as ArtifactSource).label, 200)
  && optionalText((value as ArtifactSource).url, 2_000) && optionalText((value as ArtifactSource).detail, 500)
  && (!(value as ArtifactSource).url ? allowedUrls === undefined || Boolean(allowedLabels?.has((value as ArtifactSource).label)) : safeHttpUrl((value as ArtifactSource).url!) && (!allowedUrls || allowedUrls.has((value as ArtifactSource).url!))));
function safeHttpUrl(value: string): boolean { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && Boolean(url.hostname); } catch { return false; } }
const metric = (value: unknown): value is Metric => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && exactKeys(value as Record<string, unknown>, ['label', 'value', 'unit', 'change', 'changePolarity', 'comparison', 'description']) && text((value as Metric).label, 160) && (typeof (value as Metric).value === 'string' || (typeof (value as Metric).value === 'number' && Number.isFinite((value as Metric).value)))
  && ((value as Metric).changePolarity === undefined || ['higher_is_better', 'lower_is_better', 'neutral'].includes((value as Metric).changePolarity!))
  && optionalText((value as Metric).unit, 80) && ((value as Metric).change === undefined || Number.isFinite((value as Metric).change)) && optionalText((value as Metric).comparison, 160) && optionalText((value as Metric).description, 500));
const table = (value: unknown, allowedSourceUrls?: ReadonlySet<string>, allowedSourceLabels?: ReadonlySet<string>): value is Extract<RichArtifact, { type: 'data_table' }> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { type?: unknown; columns?: unknown; rows?: unknown; source?: unknown };
  if (!exactKeys(value as Record<string, unknown>, ['version', 'id', 'type', 'title', 'columns', 'rows', 'source']) || candidate.type !== 'data_table' || !optionalText((value as { title?: unknown }).title, 200) || !Array.isArray(candidate.columns) || candidate.columns.length < 1 || candidate.columns.length > MAX_COLUMNS || !Array.isArray(candidate.rows) || candidate.rows.length > MAX_ROWS || (candidate.source !== undefined && !source(candidate.source, allowedSourceUrls, allowedSourceLabels))) return false;
  const keys = new Set<string>();
  if (!candidate.columns.every((column) => {
    if (!column || typeof column !== 'object' || !exactKeys(column as Record<string, unknown>, ['key', 'label', 'kind']) || !text((column as { key?: unknown }).key, 80) || !text((column as { label?: unknown }).label, 120)) return false;
    const item = column as { key: string; kind?: unknown };
    if (keys.has(item.key) || (item.kind !== undefined && !['text', 'number', 'date'].includes(String(item.kind)))) return false;
    keys.add(item.key); return true;
  })) return false;
  return candidate.rows.every((row) => row && typeof row === 'object' && !Array.isArray(row) && Object.entries(row).every(([key, cell]) => keys.has(key) && (cell === null || typeof cell === 'string' && cell.length <= 4_000 || typeof cell === 'number' && Number.isFinite(cell))));
};
const chart = (value: unknown, standalone = true, allowedSourceUrls?: ReadonlySet<string>, allowedSourceLabels?: ReadonlySet<string>): value is RichChart => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as RichChart;
  const allowed = ['type', 'chart', 'title', 'data', 'xKey', 'series', 'orientation', 'xLabel', 'yLabel', 'source', ...(standalone ? ['version', 'id'] : [])];
  if (!exactKeys(value as Record<string, unknown>, allowed) || c.type !== 'chart' || !['bar', 'line', 'area', 'pie', 'scatter'].includes(c.chart) || !text(c.title, 200) || !text(c.xKey, 80) || !Array.isArray(c.data) || c.data.length < 1 || c.data.length > MAX_CATEGORIES || !Array.isArray(c.series) || c.series.length < 1 || c.series.length > MAX_SERIES || !optionalText(c.xLabel, 120) || !optionalText(c.yLabel, 120) || (c.orientation !== undefined && !['vertical', 'horizontal'].includes(c.orientation)) || (c.source !== undefined && !source(c.source, allowedSourceUrls, allowedSourceLabels))) return false;
  const keys = new Set([c.xKey]);
  if (!c.series.every((item) => item && exactKeys(item as unknown as Record<string, unknown>, ['key', 'name', 'unit']) && text(item.key, 80) && text(item.name, 120) && optionalText(item.unit, 80) && !keys.has(item.key) && Boolean(keys.add(item.key)))) return false;
  if (c.chart === 'scatter' && (c.data.some((row) => typeof row[c.xKey] !== 'number') || c.series.some((item) => c.data.some((row) => typeof row[item.key] !== 'number')))) return false;
  if (c.chart === 'pie' && c.series.length !== 1) return false;
  if (c.chart === 'pie' && c.data.some((row) => typeof row[c.series[0].key] === 'number' && (row[c.series[0].key] as number) < 0)) return false;
  return c.data.every((row) => row && typeof row === 'object' && Object.keys(row).every((key) => keys.has(key)) && typeof row[c.xKey] !== 'undefined' && c.series.every((item) => row[item.key] === null || typeof row[item.key] === 'number' && Number.isFinite(row[item.key])) && (typeof row[c.xKey] === 'string' || typeof row[c.xKey] === 'number' && Number.isFinite(row[c.xKey])));
};

function normalizeMissingChartValues(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.type !== 'chart' || !Array.isArray(record.series) || !Array.isArray(record.data)) return value;
  const seriesKeys = record.series.flatMap((item) => item && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string' ? [(item as { key: string }).key] : []);
  return { ...record, data: record.data.map((row) => row && typeof row === 'object' && !Array.isArray(row) ? { ...(row as Record<string, unknown>), ...Object.fromEntries(seriesKeys.filter((key) => !Object.hasOwn(row, key)).map((key) => [key, null])) } : row) };
}

function chartError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected a chart object.';
  const c = value as Record<string, unknown>;
  const allowed = new Set(['version', 'id', 'type', 'chart', 'title', 'data', 'xKey', 'series', 'orientation', 'xLabel', 'yLabel', 'source']);
  const extra = Object.keys(c).find((key) => !allowed.has(key));
  if (extra) return `Unexpected chart field "${extra}". Use xKey, series, and data row keys as defined below.`;
  if (!['bar', 'line', 'area', 'pie', 'scatter'].includes(String(c.chart))) return 'chart must be one of: bar, line, area, pie, scatter.';
  if (typeof c.title !== 'string' || !c.title.trim()) return 'title must be a non-empty string.';
  if (typeof c.xKey !== 'string' || !c.xKey.trim()) return 'xKey must name the category or x-coordinate field.';
  if (!Array.isArray(c.series) || c.series.length < 1 || c.series.length > MAX_SERIES) return `series must contain 1–${MAX_SERIES} items shaped as {"key":"revenue","name":"Revenue","unit":"USD"}.`;
  if (!Array.isArray(c.data) || c.data.length < 1 || c.data.length > MAX_CATEGORIES) return `data must contain 1–${MAX_CATEGORIES} rows shaped like {"${c.xKey}":"Jan","${(c.series[0] as { key?: string })?.key ?? 'value'}":12}; use null for unavailable measurements.`;
  const seriesKeys = c.series.flatMap((item) => item && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string' ? [(item as { key: string }).key] : []);
  for (const [index, row] of c.data.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return `data[${index}] must be an object keyed by xKey and series keys.`;
    const record = row as Record<string, unknown>;
    if (!(c.xKey in record) || !(typeof record[c.xKey as string] === 'string' || typeof record[c.xKey as string] === 'number' && Number.isFinite(record[c.xKey as string]))) return `data[${index}].${String(c.xKey)} must be a string or finite number.`;
    const unknown = Object.keys(record).find((key) => key !== c.xKey && !seriesKeys.includes(key));
    if (unknown) return `data[${index}] has undeclared field "${unknown}". Declare it in series[].key or remove it.`;
    for (const key of seriesKeys) if (record[key] !== null && (typeof record[key] !== 'number' || !Number.isFinite(record[key]))) return `data[${index}].${key} must be a finite number or null; use null for missing/unverified data, never a formatted numeric string.`;
  }
  return 'Check chart keys: each row uses xKey plus series[].key, with finite numbers or null. Do not include undeclared fields.';
}

/** Strict normalization boundary used by both Chat and Agent host dispatch. */
export function validateRichArtifact(input: unknown, discovered: ReadonlyMap<string, DiscoveredImage> = new Map(), id: string = crypto.randomUUID(), allowedSourceUrls?: ReadonlySet<string>, allowedSourceLabels?: ReadonlySet<string>): ArtifactResult {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_ARTIFACT_BYTES) return { error: 'Artifact payload exceeds 256 KB.' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Artifact must be a JSON object.' };
    const value = input as Record<string, unknown>;
    if (value.version !== 1 || typeof value.type !== 'string') return { error: 'Unsupported artifact version or type.' };
    let artifact: RichArtifact;
    if (value.type === 'metric_group') {
      if (!exactKeys(value, ['version', 'type', 'title', 'metrics', 'source']) || !optionalText(value.title, 200) || !Array.isArray(value.metrics) || value.metrics.length < 1 || value.metrics.length > 12 || !value.metrics.every(metric) || (value.source !== undefined && !source(value.source, allowedSourceUrls, allowedSourceLabels))) return { error: 'Invalid metric group.' };
      artifact = { version: 1, id, type: 'metric_group', ...(value.title ? { title: value.title as string } : {}), metrics: value.metrics, ...(value.source ? { source: value.source as ArtifactSource } : {}) };
    } else if (value.type === 'data_table') {
      if (!table(value, allowedSourceUrls, allowedSourceLabels)) return { error: 'Invalid data table. Limit: 32 columns and 300 rows.' };
      artifact = { ...value, version: 1, id } as RichArtifact;
    } else if (value.type === 'chart') {
      const normalized = normalizeMissingChartValues(value);
      if (!chart(normalized, true, allowedSourceUrls, allowedSourceLabels)) return { error: `Invalid chart: ${chartError(normalized)}` };
      artifact = { ...normalized, version: 1, id } as RichArtifact;
    } else if (value.type === 'image_gallery') {
      const invalid = (code: string, field: string, received: unknown, error: string): Exclude<ArtifactResult, { artifact: RichArtifact }> => ({ error, code, field, received, retrySameArguments: false });
      const extra = Object.keys(value).find(key => !['version', 'type', 'title', 'summary', 'images'].includes(key));
      if (extra) return invalid('ARTIFACT_SCHEMA_INVALID', extra, 'unsupported field', `Gallery field "${extra}" is unsupported. Use version, type, title, summary and images. Remove this field; additional searches cannot fix the schema.`);
      if (!optionalText(value.title, 200)) return invalid('ARTIFACT_SCHEMA_INVALID', 'title', typeof value.title, 'Gallery title must be a string of at most 200 characters.');
      if (!optionalText(value.summary, 2000)) return invalid('ARTIFACT_SCHEMA_INVALID', 'summary', typeof value.summary, 'Gallery summary must be a string of at most 2000 characters.');
      if (!Array.isArray(value.images)) return invalid('ARTIFACT_SCHEMA_INVALID', 'images', typeof value.images, 'Gallery images must be an array of {"discovery_id":"ID from web_image_search"}.');
      if (value.images.length < 1 || value.images.length > MAX_GALLERY_IMAGES) return invalid('GALLERY_ITEM_LIMIT', 'images', value.images.length, `Gallery accepts 1–${MAX_GALLERY_IMAGES} selected images. Received ${value.images.length}. This limit applies to this gallery, not the session discovery registry.`);
      for (const [index, entry] of value.images.entries()) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry as Record<string, unknown>, ['discovery_id', 'title', 'alt'])) return invalid('ARTIFACT_SCHEMA_INVALID', `images[${index}]`, 'invalid image reference', `images[${index}] accepts only discovery_id, title and alt. Do not supply image URLs or source URLs.`);
        const item = entry as Record<string, unknown>;
        if (typeof item.discovery_id !== 'string' || !discovered.has(item.discovery_id)) return { ...invalid('INVALID_DISCOVERY_ID', `images[${index}].discovery_id`, typeof item.discovery_id === 'string' ? item.discovery_id.slice(0, 80) : typeof item.discovery_id, `Gallery item count ${value.images.length} is valid. images[${index}].discovery_id is unavailable in this request. Use a valid ID returned by any web_image_search in this request; do not repeat these arguments.`), validDiscoveryIds: [...discovered.keys()].slice(0, 128) };
        if (!optionalText(item.title, 200) || !optionalText(item.alt, 300)) return invalid('ARTIFACT_SCHEMA_INVALID', `images[${index}]`, 'invalid title or alt', 'Image title/alt must be strings of at most 200/300 characters.');
      }
      const images = value.images.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry as Record<string, unknown>, ['discovery_id', 'title', 'alt'])) throw new Error('Invalid image result reference.');
        const discoveryId = entry && typeof entry === 'object' ? (entry as { discovery_id?: unknown }).discovery_id : undefined;
        const found = typeof discoveryId === 'string' ? discovered.get(discoveryId) : undefined;
        if (!found) throw new Error('Gallery images must reference results returned by web_image_search.');
        const title = optionalText((entry as { title?: unknown }).title, 200) && (entry as { title?: string }).title ? (entry as { title: string }).title : found.title;
        const alt = optionalText((entry as { alt?: unknown }).alt, 300) && (entry as { alt?: string }).alt ? (entry as { alt: string }).alt : found.alt;
        return { discoveryId: found.id, url: found.url, sourceUrl: found.sourceUrl, sourceDomain: new URL(found.sourceUrl).hostname, title, alt };
      });
      artifact = { version: 1, id, type: 'image_gallery', ...(value.title ? { title: value.title as string } : {}), ...(value.summary ? { summary: value.summary as string } : {}), images };
    } else if (value.type === 'diagram') {
      const extra = Object.keys(value).find((key) => !['version', 'id', 'type', 'title', 'syntax', 'mermaid'].includes(key));
      if (extra) return { error: `diagram.${extra} is unsupported. Put source text in mermaid, with syntax="mermaid". Example: ${JSON.stringify(visualArtifactExamples.diagram)}` };
      if (value.syntax !== 'mermaid') return { error: 'diagram.syntax must equal "mermaid".' };
      if (!text(value.mermaid, 16_000)) return { error: 'diagram.mermaid must be a non-empty string of at most 16000 characters. Use actual newlines, not a diagram/source/diagram_source field.' };
      if (!optionalText(value.title, 200) || /<|javascript:|data:text\/html|\bclick\s+[\w-]+|\bhref\b|%%\s*\{/i.test(value.mermaid)) return { error: 'diagram.mermaid contains unsupported HTML, links, or configuration directives. Supply data-only Mermaid source.' };
      artifact = { version: 1, id, type: 'diagram', syntax: 'mermaid', mermaid: value.mermaid as string, ...(value.title ? { title: value.title as string } : {}) };
    } else if (value.type === 'rich_report') {
      const validMetrics = value.metrics === undefined || (Array.isArray(value.metrics) && value.metrics.length <= 12 && value.metrics.every(metric));
      const invalidChartIndex = Array.isArray(value.charts) ? value.charts.findIndex((item) => !chart(normalizeMissingChartValues(item), false, allowedSourceUrls, allowedSourceLabels)) : -1;
      const validCharts = value.charts === undefined || (Array.isArray(value.charts) && value.charts.length <= 8 && invalidChartIndex < 0);
      const validTables = value.tables === undefined || (Array.isArray(value.tables) && value.tables.length <= 4 && value.tables.every((item) => table(item, allowedSourceUrls, allowedSourceLabels)));
      const validFindings = value.findings === undefined || (Array.isArray(value.findings) && value.findings.length <= 20 && value.findings.every((item) => text(item, 1_000)));
      const validRecommendations = value.recommendations === undefined || (Array.isArray(value.recommendations) && value.recommendations.length <= 20 && value.recommendations.every((item) => text(item, 1_000)));
      const validSources = value.sources === undefined || (Array.isArray(value.sources) && value.sources.length <= 20 && value.sources.every((item) => source(item, allowedSourceUrls, allowedSourceLabels)));
      if (!exactKeys(value, ['version', 'type', 'title', 'summary', 'metrics', 'charts', 'tables', 'findings', 'recommendations', 'sources']) || !text(value.title, 200) || !optionalText(value.summary, 2_000) || !validMetrics || !validCharts || !validTables || !validFindings || !validRecommendations || !validSources) return { error: invalidChartIndex >= 0 ? `Invalid rich_report.charts[${invalidChartIndex}]: ${chartError(normalizeMissingChartValues((value.charts as unknown[])[invalidChartIndex]))}` : 'Invalid rich report.' };
      artifact = { version: 1, id, type: 'rich_report', title: value.title as string, ...(value.summary ? { summary: value.summary as string } : {}), ...(value.metrics ? { metrics: value.metrics as Metric[] } : {}), ...(value.charts ? { charts: (value.charts as unknown[]).map((item) => normalizeMissingChartValues(item) as RichChart) } : {}), ...(value.tables ? { tables: value.tables as Extract<RichArtifact, { type: 'data_table' }>[] } : {}), ...(value.findings ? { findings: value.findings as string[] } : {}), ...(value.recommendations ? { recommendations: value.recommendations as string[] } : {}), ...(value.sources ? { sources: value.sources as ArtifactSource[] } : {}) };
    } else return { error: 'Unsupported artifact type.' };
    return { artifact };
  } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid artifact.' }; }
}

/** Re-validates normalized stored artifacts while keeping model-authored URLs forbidden. */
export function validatePersistedRichArtifact(input: unknown): ArtifactResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Artifact must be a JSON object.' };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_ARTIFACT_BYTES) return { error: 'Artifact payload exceeds 256 KB.' };
  const value = input as Record<string, unknown>;
  if (value.type !== 'image_gallery') { const { id: storedId, ...shape } = value; return validateRichArtifact(shape, new Map(), typeof storedId === 'string' ? storedId : crypto.randomUUID()); }
  if (!exactKeys(value, ['version', 'id', 'type', 'title', 'summary', 'images']) || !text(value.id, 200) || !optionalText(value.title, 200) || !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 8) return { error: 'Invalid persisted image gallery.' };
  const discovered = new Map<string, DiscoveredImage>();
  for (const image of value.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || !exactKeys(image as Record<string, unknown>, ['discoveryId', 'url', 'sourceUrl', 'sourceDomain', 'title', 'alt'])) return { error: 'Invalid persisted image result.' };
    const candidate = image as Record<string, unknown>;
    if (!text(candidate.discoveryId, 200) || !text(candidate.url, 2_000) || !text(candidate.sourceUrl, 2_000) || !text(candidate.sourceDomain, 255) || !text(candidate.title, 200) || !text(candidate.alt, 300) || !safeHttpUrl(candidate.url) || !safeHttpUrl(candidate.sourceUrl)) return { error: 'Invalid persisted image URL or metadata.' };
    if (new URL(candidate.sourceUrl).hostname !== candidate.sourceDomain) return { error: 'Persisted image source domain does not match its URL.' };
    discovered.set(candidate.discoveryId, { id: candidate.discoveryId, url: candidate.url, sourceUrl: candidate.sourceUrl, title: candidate.title, alt: candidate.alt });
  }
  const modelShape = { version: value.version, type: value.type, ...(value.title === undefined ? {} : { title: value.title }), ...(value.summary === undefined ? {} : { summary: value.summary }), images: value.images.map((image) => ({ discovery_id: (image as Record<string, unknown>).discoveryId, title: (image as Record<string, unknown>).title, alt: (image as Record<string, unknown>).alt })) };
  return validateRichArtifact(modelShape, discovered, typeof value.id === 'string' ? value.id : crypto.randomUUID());
}

/** These are protocol documentation fixtures, never renderer fallbacks. Every example is validator-tested. */
export const visualArtifactExamples = {
  metric_group: { version: 1, type: 'metric_group', metrics: [{ label: 'Demo revenue', value: 10, unit: 'USD' }] },
  data_table: { version: 1, type: 'data_table', columns: [{ key: 'quarter', label: 'Quarter' }, { key: 'revenue', label: 'Revenue', kind: 'number' }], rows: [{ quarter: 'Q1', revenue: 10 }] },
  chart: { version: 1, type: 'chart', chart: 'bar', title: 'Demo revenue', xKey: 'quarter', series: [{ key: 'revenue', name: 'Revenue', unit: 'USD' }], data: [{ quarter: 'Q1', revenue: 10 }, { quarter: 'Q2', revenue: null }] },
  image_gallery: { version: 1, type: 'image_gallery', summary: 'Source links are provided; licenses have not been checked.', images: [{ discovery_id: 'returned-image-id' }] },
  diagram: { version: 1, type: 'diagram', title: 'Illustrative branches', syntax: 'mermaid', mermaid: 'gitGraph\n  commit id: "main start"\n  branch "v2-migration"\n  checkout "v2-migration"\n  branch "feat/rich-responses"\n  commit id: "visual tools"\n  checkout "v2-migration"\n  merge "feat/rich-responses" id: "merge feature"\n  checkout main\n  merge "v2-migration" id: "merge migration"' },
  rich_report: { version: 1, type: 'rich_report', title: 'Fictional sales', summary: 'Illustrative data only.', metrics: [{ label: 'Revenue', value: 10, unit: 'USD' }], charts: [{ type: 'chart', chart: 'bar', title: 'Revenue', xKey: 'quarter', series: [{ key: 'revenue', name: 'Revenue', unit: 'USD' }], data: [{ quarter: 'Q1', revenue: 10 }] }], tables: [{ type: 'data_table', columns: [{ key: 'quarter', label: 'Quarter' }, { key: 'revenue', label: 'Revenue', kind: 'number' }], rows: [{ quarter: 'Q1', revenue: 10 }] }] },
} as const;

export const visualChartExamples = {
  bar: visualArtifactExamples.chart,
  line: { ...visualArtifactExamples.chart, chart: 'line' },
  area: { ...visualArtifactExamples.chart, chart: 'area' },
  pie: { ...visualArtifactExamples.chart, chart: 'pie', data: [{ quarter: 'Q1', revenue: 10 }, { quarter: 'Q2', revenue: 15 }] },
  scatter: { version: 1, type: 'chart', chart: 'scatter', title: 'Demo coordinates', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: 1, y: 2 }] },
} as const;

export const visualArtifactTool = {
  type: 'function',
  function: {
    name: 'create_visual_artifact',
    description: 'Create a validated data-only visual element only when it materially improves the answer. Never invent factual values, image URLs, or source links. Explicitly requested fictional/demo data is allowed when labeled fictional. Charts use data rows keyed by xKey and each series[].key; numeric values must be JSON numbers and unavailable values null. For comparisons, keep metrics, chart and table on the same values and units; use separate charts for incompatible units. Use type=chart, image_gallery with discovery_id from web_image_search, diagram with meaningful safe Mermaid, or concise rich_report. No HTML/CSS/JS/SVG. Limits: 300 rows/categories, 32 columns, 8 series, 8 images, 256 KB.',
    parameters: {
      type: 'object', properties: { artifact: {
        type: 'object', description: `Use exactly one canonical artifact shape. Full examples (replace fixture values; image IDs must come from the tool): ${JSON.stringify(visualArtifactExamples)}`,
        properties: {
          version: { type: 'integer', enum: [1] },
          type: { type: 'string', enum: ['metric_group', 'data_table', 'chart', 'image_gallery', 'diagram', 'rich_report'] },
          title: { type: 'string' }, summary: { type: 'string' },
          chart: { type: 'string', enum: ['bar', 'line', 'area', 'pie', 'scatter'], description: `Full validator-tested chart examples (use actual data or explicitly requested fictional data): ${JSON.stringify(visualChartExamples)}` },
          xKey: { type: 'string' }, xLabel: { type: 'string' }, yLabel: { type: 'string' }, orientation: { type: 'string', enum: ['vertical', 'horizontal'] },
          data: { type: 'array', description: 'Rows are objects: each row has the exact xKey field and one field per series[].key, e.g. [{"gpu":"A","vram":10},{"gpu":"B","vram":null}]. Missing values are null; do not use formatted strings.', items: { type: 'object' } },
          series: { type: 'array', description: '1–8 numeric series. Each key must match a numeric (or null) field in every data row.', items: { type: 'object', properties: { key: { type: 'string', description: 'Data row field key.' }, name: { type: 'string' }, unit: { type: 'string' } }, required: ['key', 'name'] } },
          metrics: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: ['string', 'number'] }, unit: { type: 'string' }, change: { type: 'number' }, changePolarity: { type: 'string', enum: ['higher_is_better', 'lower_is_better', 'neutral'], description: 'Optional direction for interpreting change; omit or use neutral unless the source makes desirability explicit.' }, comparison: { type: 'string' }, description: { type: 'string' } }, required: ['label', 'value'] } },
          columns: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['text', 'number', 'date'] } }, required: ['key', 'label'] } },
          rows: { type: 'array', items: { type: 'object' } },
          images: { type: 'array', minItems: 1, maxItems: MAX_GALLERY_IMAGES, description: 'Select 1–8 items. IDs from different searches in this same request can be combined. Unselected discovered candidates do not count against this gallery limit. Do not supply URLs.', items: { type: 'object', additionalProperties: false, properties: { discovery_id: { type: 'string' }, title: { type: 'string' }, alt: { type: 'string' } }, required: ['discovery_id'] } },
          syntax: { type: 'string', enum: ['mermaid'] }, mermaid: { type: 'string', description: 'Safe Mermaid source. Use descriptive node/branch names, not generic A/B/C. Git example: gitGraph\\n  commit id: "main start"\\n  branch feature\\n  checkout feature\\n  commit id: "feature work"\\n  checkout main\\n  merge feature id: "merge feature". Flowchart example: flowchart LR\\n  request[User request] --> work[Feature work] --> review[Review and merge]. No HTML, click, or links.' }, source: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' }, detail: { type: 'string' } }, description: 'Data provenance for a chart, table, or metric group.' }, findings: { type: 'array', items: { type: 'string' } }, recommendations: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' }, detail: { type: 'string' } } } }, charts: { type: 'array', items: { type: 'object' } }, tables: { type: 'array', items: { type: 'object' } },
        }, required: ['version', 'type'],
      } }, required: ['artifact'],
    },
  },
} as const;

export function richArtifactToolError(result: ArtifactResult): string | undefined { return 'error' in result ? result.error : undefined; }

export function richArtifactFingerprint(artifact: RichArtifact): string {
  return JSON.stringify(artifact, (key, value: unknown) => key === 'id' ? undefined : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : key === 'mermaid' && typeof value === 'string' ? value.trim() : value);
}

export function withAttachmentProvenance(artifact: RichArtifact, sources: ArtifactSource[]): RichArtifact {
  if (!sources.length) return artifact;
  const attachedSource: ArtifactSource = sources.length === 1 ? sources[0] : { label: sources.map((source) => source.label).join(', ') };
  if (artifact.type === 'rich_report') return {
    ...artifact,
    charts: artifact.charts?.map((chart) => ({ ...chart, source: attachedSource })),
    tables: artifact.tables?.map((table) => ({ ...table, source: attachedSource })),
    sources: [...(artifact.sources ?? []), ...sources].slice(0, 20),
  };
  if (artifact.type === 'chart' || artifact.type === 'data_table' || artifact.type === 'metric_group') return { ...artifact, source: attachedSource };
  return artifact;
}
