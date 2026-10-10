import assert from 'node:assert/strict';
import { validateRichArtifact, visualArtifactTool, type DiscoveredImage } from './rich-artifacts';

/** Deterministic visual acceptance fixtures. Data here is test-only. */
export function runRichResponseAcceptanceFixtures(): void {
  const flower: DiscoveredImage = { id: 'flower-fixture', url: 'https://images.example.test/peony.jpg', sourceUrl: 'https://garden.example.test/peonies', title: 'Peony photograph', alt: 'Pink peony in bloom' };
  const flowers = [flower, ...['pink', 'white', 'coral'].map((color, index) => ({ ...flower, id: `flower-${index}`, url: `https://images.example.test/${color}.jpg`, title: `${color} peony` }))];
  const gallery = validateRichArtifact({ version: 1, type: 'image_gallery', title: 'Peonies', images: flowers.map((image) => ({ discovery_id: image.id })) }, new Map(flowers.map((image) => [image.id, image])));
  assert(gallery.artifact?.type === 'image_gallery' && gallery.artifact.images.length === 4 && gallery.artifact.images[0]?.url === flower.url && gallery.artifact.images[0]?.sourceUrl === flower.sourceUrl, 'four-image flower fixture lost results or source attribution');

  const months = [
    { month: 'January', revenue: 100, orders: 4 },
    { month: 'February', revenue: 140, orders: 5 },
    { month: 'March', revenue: 180, orders: 6 },
  ];
  const report = validateRichArtifact({ version: 1, type: 'rich_report', title: 'Sales analysis', summary: 'Revenue increased across the fixture period.', metrics: [{ label: 'Revenue', value: 420, unit: 'USD' }], charts: [{ type: 'chart', chart: 'line', title: 'Revenue by month', xKey: 'month', series: [{ key: 'revenue', name: 'Revenue', unit: 'USD' }], data: months.map(({ month, revenue }) => ({ month, revenue })) }], tables: [{ version: 1, id: 'fixture-table', type: 'data_table', title: 'Monthly values', columns: [{ key: 'month', label: 'Month' }, { key: 'revenue', label: 'Revenue', kind: 'number' }], rows: months.map(({ month, revenue }) => ({ month, revenue })) }], findings: ['Revenue rose from 100 to 180 USD.'], recommendations: ['Compare the next period against these monthly values.'], sources: [{ label: 'sales-fixture.csv' }] });
  assert(report.artifact?.type === 'rich_report' && report.artifact.charts?.[0]?.data[2]?.revenue === 180 && report.artifact.tables?.[0]?.rows[1]?.revenue === 140, 'sales report changed fixture values or omitted report sections');

  const comparison = validateRichArtifact({ version: 1, type: 'rich_report', title: 'GPU comparison', charts: [{ type: 'chart', chart: 'bar', title: 'Memory bandwidth', xKey: 'gpu', series: [{ key: 'bandwidth', name: 'Bandwidth', unit: 'GB/s' }], data: [{ gpu: 'GPU A', bandwidth: 900 }, { gpu: 'GPU B', bandwidth: 1200 }, { gpu: 'GPU C', bandwidth: 1500 }] }], tables: [{ version: 1, id: 'gpu-table', type: 'data_table', columns: [{ key: 'gpu', label: 'GPU' }, { key: 'vram', label: 'VRAM', kind: 'number' }, { key: 'bandwidth', label: 'Bandwidth', kind: 'number' }], rows: [{ gpu: 'GPU A', vram: 16, bandwidth: 900 }, { gpu: 'GPU B', vram: 20, bandwidth: 1200 }, { gpu: 'GPU C', vram: 24, bandwidth: 1500 }] }], sources: [{ label: 'GPU spec fixture' }] });
  assert(comparison.artifact?.type === 'rich_report' && comparison.artifact.tables?.[0]?.rows.length === 3 && comparison.artifact.charts?.[0]?.data.length === 3, 'GPU comparison fixture needs both a table and chart');

  const gitGraph = 'gitGraph\n  commit id: "main start"\n  branch feature\n  checkout feature\n  commit id: "feature work"\n  checkout main\n  merge feature id: "merge feature"';
  const diagram = validateRichArtifact({ version: 1, type: 'diagram', title: 'Feature branch merge', syntax: 'mermaid', mermaid: gitGraph });
  assert(diagram.artifact?.type === 'diagram' && diagram.artifact.mermaid.includes('branch feature') && diagram.artifact.mermaid.includes('merge feature'), 'Git branching fixture lost named branch/merge semantics');

  const descriptions = visualArtifactTool.function.parameters.properties.artifact.properties;
  for (const chartType of ['bar', 'line', 'area', 'pie', 'scatter']) assert(descriptions.chart.description.includes(chartType), `model-facing chart guidance omitted ${chartType}`);
}

if (require.main === module) { runRichResponseAcceptanceFixtures(); console.log('rich-response acceptance fixtures: ok'); }
