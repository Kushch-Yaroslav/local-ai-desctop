import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', 'src');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const sources = walk(root).filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.ts$/.test(file));
const cyrillic = /[а-яё]/i;
// Technical words and product terms that stay as they are in Russian text.
const technical = new Set(['llama', 'cpp', 'ram', 'vram', 'gpu', 'cpu', 'kv', 'mtp', 'fp16', 'q8', 'gguf', 'rust', 'agent', 'runtime', 'mermaid', 'local', 'desktop', 'markdown', 'task', 'memory', 'pid', 'pgid', 'stderr', 'stdout', 'json', 'html', 'css', 'http', 'url', 'ok', 'api', 'git', 'draft', 'launcher', 'inference', 'diff', 'tok']);
const latinWords = (text: string) => (text.match(/[A-Za-z]{3,}/g) ?? []).filter((word) => !technical.has(word.toLowerCase()));

export function runLocalizationCoverageRegression(): void {
  // 1. Text a user reads in the renderer: JSX text nodes and the labels passed to titles/aria/placeholders.
  const offenders: string[] = [];
  for (const file of sources.filter((path) => path.includes(`${join('src', 'renderer')}`) && path.endsWith('.tsx'))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/>([^<>{}]*[A-Za-z]{3,}[^<>{}]*)</g)) {
        const text = match[1]!.trim();
        if (cyrillic.test(text) || /[=;()&|?:]/.test(text)) continue; // code between tags, or already Russian
        if (latinWords(text).length >= 1 && /\s/.test(text)) offenders.push(`${file}:${index + 1}: "${text}"`);
      }
      for (const match of line.matchAll(/(?:title|aria-label|placeholder|alt)="([^"{}]+)"/g)) {
        const text = match[1]!.trim();
        if (!cyrillic.test(text) && latinWords(text).length >= 1) offenders.push(`${file}:${index + 1}: ${match[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `English text in the UI:\n${offenders.join('\n')}`);

  // 2. Labels that were English before and must stay Russian.
  const banned = ['Input tokens', 'Output tokens', 'Prompt cache', 'Total run', 'Cache writes', 'Elapsed', 'Compactions', 'Generation speed', 'Task Planning', 'Thought for', 'Agent stopped', 'Viewed project structure', 'Context optimized', 'Найти Max Context', 'Max Context:', 'Discovery не завершён', 'runtime не загружен', 'non-LLM', 'safety limit'];
  const rendererText = sources.filter((path) => path.includes(`${join('src', 'renderer')}`)).map((path) => readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')).join('\n');
  for (const phrase of banned) assert.ok(!rendererText.includes(phrase), `"${phrase}" is back in the UI`);

  // 3. Messages that exist only to be shown to the user (Max Context discovery, memory estimates, hardware and GGUF errors).
  const messageSources = ['src/main/ipc/register-ipc.ts', 'src/main/services/context-discovery.ts', 'src/main/services/context-estimate.ts', 'src/shared/context-estimator.ts', 'src/shared/vram-budget.ts', 'src/main/services/hardware.ts', 'src/main/services/gguf-context.ts'];
  const untranslated: string[] = [];
  for (const relative of messageSources) {
    const text = readFileSync(join(__dirname, '..', '..', relative), 'utf8');
    for (const pattern of [/unknownReasons\.push\(\s*(?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g, /\breason:\s*(?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g, /new Error\(\s*(?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g, /\? \['((?:\\.|[^'\\])*)'\] : \[\]/g]) {
      for (const match of text.matchAll(pattern)) {
        const message = match[1] ?? match[2] ?? '';
        if (/^[a-z_]+$/.test(message)) continue; // protocol values (user_stop) are never translated
        if (!cyrillic.test(message) && latinWords(message).length >= 2) untranslated.push(`${relative}: ${message}`);
      }
    }
  }
  const displayNames = readFileSync(join(__dirname, '..', '..', 'src/shared/context-estimator.ts'), 'utf8').match(/const displayNames[\s\S]*?\n};/)?.[0] ?? '';
  for (const match of displayNames.matchAll(/:\s*'([^']+)'/g)) if (!cyrillic.test(match[1]!)) untranslated.push(`displayNames: ${match[1]}`);
  assert.deepEqual(untranslated, [], `Display-only messages still in English:\n${untranslated.join('\n')}`);
}

if (require.main === module) runLocalizationCoverageRegression();
