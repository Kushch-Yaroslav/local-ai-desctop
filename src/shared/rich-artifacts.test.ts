import assert from 'node:assert/strict';
import { visualArtifactExamples, visualChartExamples, validatePersistedRichArtifact } from './rich-artifacts';
import { validateRichArtifact, withAttachmentProvenance, type DiscoveredImage } from './rich-artifacts';

export function runRichArtifactSchemaRegression(): void {
  const exampleImage: DiscoveredImage = { id: 'returned-image-id', url: 'https://image.example.test/flower.png', sourceUrl: 'https://source.example.test/flower', title: 'Photograph', alt: 'Flower' };
  for (const [type, example] of Object.entries(visualArtifactExamples)) {
    const validated = validateRichArtifact(example, new Map([[exampleImage.id, exampleImage]]));
    assert(validated.artifact, `${type} model-facing example failed validation: ${validated.error}`);
    const restored = validatePersistedRichArtifact(JSON.parse(JSON.stringify(validated.artifact)));
    assert(restored.artifact, `${type} persisted artifact was lost: ${restored.error}`);
    assert.deepEqual(restored.artifact, validated.artifact);
  }
  for (const [kind, example] of Object.entries(visualChartExamples)) assert(validateRichArtifact(example).artifact, `${kind} documented chart example was rejected`);
  const diagramField = validateRichArtifact({ version: 1, type: 'diagram', diagram_source: 'flowchart LR\nA-->B' });
  assert.match(diagramField.error ?? '', /diagram.diagram_source.*mermaid/);

  const chart = validateRichArtifact({ version: 1, type: 'chart', chart: 'bar', title: 'Quarterly sales', xKey: 'quarter', series: [{ key: 'revenue', name: 'Revenue', unit: 'USD' }], data: [{ quarter: 'Q1', revenue: 12 }, { quarter: 'Q2', revenue: -3 }], source: { label: 'sales.csv' } });
  assert(chart.artifact && chart.artifact.type === 'chart', 'valid data-driven bar chart was rejected');
  assert.equal(chart.artifact.data[1]?.revenue, -3, 'negative source values were changed');
  for (const kind of ['line', 'area', 'pie', 'scatter'] as const) {
    const data = kind === 'scatter' ? [{ x: 1, y: 2 }] : [{ label: 'A', value: 2 }, { label: 'B', value: 3 }];
    const result = validateRichArtifact({ version: 1, type: 'chart', chart: kind, title: `${kind} data`, xKey: kind === 'scatter' ? 'x' : 'label', series: [{ key: kind === 'scatter' ? 'y' : 'value', name: 'Series' }], data });
    assert(result.artifact?.type === 'chart', `${kind} chart was rejected`);
  }
  const metricGroup = validateRichArtifact({ version: 1, type: 'metric_group', metrics: [{ label: 'Revenue', value: 12400, unit: 'USD', change: 2 }] });
  assert(metricGroup.artifact?.type === 'metric_group' && metricGroup.artifact.metrics[0]?.changePolarity === undefined, 'metric group lost change metadata or assumed positive change was favorable');
  assert(validateRichArtifact({ version: 1, type: 'data_table', columns: [{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count', kind: 'number' }], rows: [{ name: 'A', count: 2 }] }).artifact?.type === 'data_table', 'structured table was rejected');
  assert(validateRichArtifact({ version: 1, type: 'rich_report', title: 'Analysis', charts: [{ type: 'chart', chart: 'line', title: 'Revenue', xKey: 'month', series: [{ key: 'sales', name: 'Sales' }], data: [{ month: 'Jan', sales: 3 }] }], findings: ['Sales grew in the measured period.'] }).artifact?.type === 'rich_report', 'composite report with a valid chart was rejected');
  assert(validateRichArtifact({ version: 1, type: 'diagram', syntax: 'mermaid', mermaid: 'flowchart LR\nA --> B' }).artifact?.type === 'diagram', 'safe Mermaid diagram was rejected');

  assert('error' in validateRichArtifact({ version: 2, type: 'metric_group', metrics: [{ label: 'x', value: 1 }] }), 'unknown version was accepted');
  assert('error' in validateRichArtifact({ version: 1, type: 'metric_group', metrics: [{ label: 'x', value: 1 }], raw_html: '<script>run()</script>' }), 'unsupported executable field was accepted');
  assert('error' in validateRichArtifact({ version: 1, type: 'chart', chart: 'bar', title: 'Bad', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: 'a', y: Number.NaN }] }), 'non-finite numeric data was accepted');
  assert('error' in validateRichArtifact({ version: 1, type: 'chart', chart: 'scatter', title: 'Bad x', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: Number.POSITIVE_INFINITY, y: 1 }] }), 'infinite x coordinate was accepted');
  assert('error' in validateRichArtifact({ version: 1, type: 'chart', chart: 'line', title: 'Empty', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [] }), 'empty chart data was silently accepted');
  const missingMeasure = validateRichArtifact({ version: 1, type: 'chart', chart: 'line', title: 'Partial measurements', xKey: 'month', series: [{ key: 'sales', name: 'Sales' }], data: [{ month: 'Jan', sales: 10 }, { month: 'Feb' }] });
  assert(missingMeasure.artifact?.type === 'chart' && missingMeasure.artifact.data[1]?.sales === null, 'missing values were not represented explicitly as null');
  const stringMeasure = validateRichArtifact({ version: 1, type: 'chart', chart: 'bar', title: 'Bad', xKey: 'gpu', series: [{ key: 'bandwidth', name: 'Bandwidth' }], data: [{ gpu: 'A', bandwidth: '900 GB/s' }] });
  assert('error' in stringMeasure && /data\[0\]\.bandwidth.*finite number or null/.test(stringMeasure.error ?? ''), 'chart error did not identify the malformed numeric field');
  assert('error' in validateRichArtifact({ version: 1, type: 'chart', chart: 'pie', title: 'Invalid share', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: 'A', y: -1 }] }), 'pie chart accepted a negative magnitude');
  assert('error' in validateRichArtifact({ version: 1, type: 'diagram', syntax: 'mermaid', mermaid: 'flowchart LR\nclick A "javascript:alert(1)"' }), 'unsafe Mermaid link was accepted');
  assert('error' in validateRichArtifact({ version: 1, type: 'metric_group', metrics: [{ label: 'x', value: 1 }], extra: 'x'.repeat(260_000) }), 'oversized payload was accepted');

  const discovered: DiscoveredImage = { id: 'discovery-1', url: 'https://images.example.test/peony.jpg', sourceUrl: 'https://garden.example.test/peony', title: 'Peony photograph', alt: 'Pink peony' };
  const galleryInput = { version: 1, type: 'image_gallery', images: [{ discovery_id: discovered.id, title: 'Peony' }] };
  assert('error' in validateRichArtifact({ ...galleryInput, images: [{ ...galleryInput.images[0], url: 'https://invented.test/image.jpg' }] }, new Map([[discovered.id, discovered]])), 'model supplied a fabricated image URL');
  const gallery = validateRichArtifact(galleryInput, new Map([[discovered.id, discovered]]));
  assert(gallery.artifact?.type === 'image_gallery' && gallery.artifact.images[0]?.sourceUrl === discovered.sourceUrl && gallery.artifact.images[0]?.url === discovered.url, 'gallery lost actual image provenance');
  assert('error' in validateRichArtifact({ version: 1, type: 'image_gallery', images: [{ discovery_id: 'invented-id' }] }), 'gallery accepted an undiscovered image URL reference');
  const sourcedChart = { version: 1, type: 'chart', chart: 'bar', title: 'Sourced values', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: 'A', y: 1 }], source: { label: 'Search result', url: 'https://fabricated.example.test/data' } };
  assert('error' in validateRichArtifact(sourcedChart, new Map(), undefined, new Set(['https://observed.example.test/page'])), 'unobserved source URL was accepted as a citation');
  assert(validateRichArtifact({ ...sourcedChart, source: { label: 'Observed result', url: 'https://observed.example.test/page' } }, new Map(), undefined, new Set(['https://observed.example.test/page'])).artifact?.type === 'chart', 'a source observed through web tools was rejected');
  const fileSourceChart = { ...sourcedChart, source: { label: 'sales.csv' } };
  assert('error' in validateRichArtifact(fileSourceChart, new Map(), undefined, new Set(), new Set(['other.csv'])), 'unattached source label was accepted as provenance');
  assert(validateRichArtifact(fileSourceChart, new Map(), undefined, new Set(), new Set(['sales.csv'])).artifact?.type === 'chart', 'attached file source label was rejected');
  const measured = validateRichArtifact({ version: 1, type: 'chart', chart: 'bar', title: 'Measured', xKey: 'x', series: [{ key: 'y', name: 'Y' }], data: [{ x: 'A', y: 1 }] });
  const measuredWithSource = measured.artifact?.type === 'chart' ? withAttachmentProvenance(measured.artifact, [{ label: 'sales.csv' }]) : undefined;
  assert(measuredWithSource?.type === 'chart' && measuredWithSource.source?.label === 'sales.csv', 'attachment-derived charts did not retain trusted file provenance');
}

if (require.main === module) { runRichArtifactSchemaRegression(); console.log('rich-artifact schema regression: ok'); }
