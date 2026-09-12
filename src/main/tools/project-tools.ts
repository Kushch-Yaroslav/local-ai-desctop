import { execFile } from 'node:child_process';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const maxLineReadBytes = 8_000_000;
const defaultPageSize = 100;
const maxPageSize = 250;
const defaultChunkBytes = 64_000;
const maxChunkBytes = 128_000;

export type ProjectToolCall = { name: string; arguments: Record<string, unknown> };
export type ProjectToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

export const projectToolDefinitions: ProjectToolDefinition[] = [
  { type: 'function', function: { name: 'list_directory', description: 'Показывает дерево файлов выбранного проекта. Начни с корня; при has_more=true запроси следующую страницу с next_offset.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Относительный путь внутри проекта, по умолчанию корень.' }, depth: { type: 'integer', minimum: 1, maximum: 4 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } } } } },
  { type: 'function', function: { name: 'find_files', description: 'Ищет имена файлов и папок внутри выбранного проекта. Результат постраничный.', parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Ищет текст в текстовых файлах выбранного проекта. Результат постраничный; сузь path при широком поиске.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Необязательная относительная папка или файл.' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Читает текстовый файл. По умолчанию возвращает байтовый блок; при has_more=true запроси следующий с next_offset. Для небольших файлов можно указать start_line/end_line.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: 128000 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, required: ['path'] } } },
  { type: 'function', function: { name: 'inspect_package_json', description: 'Читает package.json в корне выбранного проекта, если он есть.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_status', description: 'Показывает read-only статус Git выбранного проекта.', parameters: { type: 'object', properties: {} } } },
];

export function activityForTool(call: ProjectToolCall): { label: string; detail?: string } {
  const path = typeof call.arguments.path === 'string' ? call.arguments.path : undefined;
  if (call.name === 'list_directory') return { label: 'Просмотр структуры проекта', detail: path || undefined };
  if (call.name === 'find_files') return { label: 'Поиск файлов', detail: String(call.arguments.query ?? '') };
  if (call.name === 'search_text') return { label: 'Поиск текста в проекте', detail: String(call.arguments.query ?? '') };
  if (call.name === 'read_file') return { label: 'Чтение файла', detail: path };
  if (call.name === 'inspect_package_json') return { label: 'Чтение package.json' };
  if (call.name === 'git_status') return { label: 'Проверка статуса Git' };
  return { label: 'Анализ проекта' };
}

export class ReadonlyProjectTools {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<ReadonlyProjectTools> {
    const resolved = await realpath(root); const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('Рабочая папка не является каталогом');
    return new ReadonlyProjectTools(resolved);
  }

  async execute(call: ProjectToolCall): Promise<string> {
    try {
      if (call.name === 'list_directory') return await this.listDirectory(this.text(call.arguments.path), this.number(call.arguments.depth, 2, 1, 4), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'find_files') return await this.findFiles(this.requiredText(call.arguments.query), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'search_text') return await this.searchText(this.requiredText(call.arguments.query), this.text(call.arguments.path), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'read_file') return await this.readTextFile(call);
      if (call.name === 'inspect_package_json') return await this.readTextFile({ name: 'read_file', arguments: { path: 'package.json', max_bytes: maxChunkBytes } });
      if (call.name === 'git_status') return await this.gitStatus();
      return JSON.stringify({ error: `Неизвестный read-only инструмент: ${call.name}` });
    } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Ошибка чтения проекта' }); }
  }

  private async listDirectory(path: string, depth: number, offset: number, limit: number): Promise<string> {
    const directory = await this.resolveExisting(path || '.'); const output: string[] = []; const collectionLimit = offset + limit + 1;
    const walk = async (current: string, level: number): Promise<void> => {
      if (output.length >= collectionLimit) return;
      const entries = await readdir(current, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (output.length >= collectionLimit) return;
        const display = relative(this.root, resolve(current, entry.name)) || '.';
        if (entry.isSymbolicLink()) { output.push(`${display} [symlink skipped]`); continue; }
        output.push(`${display}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory() && level < depth && !ignoredDirectories.has(entry.name)) await walk(resolve(current, entry.name), level + 1);
      }
    };
    await walk(directory, 1);
    const entries = output.slice(offset, offset + limit); const hasMore = output.length > offset + limit;
    return JSON.stringify({ root: path || '.', depth, offset, entries, has_more: hasMore, next_offset: hasMore ? offset + entries.length : null });
  }

  private async findFiles(query: string, offset: number, limit: number): Promise<string> {
    const matches: string[] = []; const needle = query.toLowerCase(); const collectionLimit = offset + limit + 1;
    const walk = async (directory: string, level: number): Promise<void> => {
      if (matches.length >= collectionLimit || level > 8) return;
      const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= collectionLimit) return;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(directory, entry.name); const display = relative(this.root, full);
        if (entry.name.toLowerCase().includes(needle)) matches.push(`${display}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await walk(full, level + 1);
      }
    };
    await walk(this.root, 1); const page = matches.slice(offset, offset + limit); const hasMore = matches.length > offset + limit;
    return JSON.stringify({ query, offset, matches: page, has_more: hasMore, next_offset: hasMore ? offset + page.length : null });
  }

  private async searchText(query: string, path: string, offset: number, limit: number): Promise<string> {
    const target = await this.resolveExisting(path || '.'); const matches: Array<{ path: string; line: number; text: string }> = []; const needle = query.toLowerCase(); const collectionLimit = offset + limit + 1;
    const inspect = async (file: string): Promise<void> => {
      if (matches.length >= collectionLimit) return;
      const info = await stat(file); if (!info.isFile() || info.size > maxLineReadBytes) return;
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) return;
      content.split(/\r?\n/).forEach((line, index) => { if (matches.length < collectionLimit && line.toLowerCase().includes(needle)) matches.push({ path: relative(this.root, file), line: index + 1, text: line.slice(0, 300) }); });
    };
    const walk = async (current: string, level: number): Promise<void> => {
      const info = await stat(current);
      if (info.isFile()) { await inspect(current); return; }
      if (level > 8 || matches.length >= collectionLimit) return;
      const entries = await readdir(current, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= collectionLimit || entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        await walk(resolve(current, entry.name), level + 1);
      }
    };
    await walk(target, 1); const page = matches.slice(offset, offset + limit); const hasMore = matches.length > offset + limit;
    return JSON.stringify({ query, path: path || '.', offset, matches: page, has_more: hasMore, next_offset: hasMore ? offset + page.length : null });
  }

  private async readTextFile(call: ProjectToolCall): Promise<string> {
    const path = this.requiredText(call.arguments.path); const file = await this.resolveExisting(path); const info = await stat(file);
    if (!info.isFile()) throw new Error('Указанный путь не является файлом');
    const startLine = typeof call.arguments.start_line === 'number' ? this.number(call.arguments.start_line, 1, 1, 10_000_000) : null;
    if (startLine !== null && info.size <= maxLineReadBytes) {
      const endLine = this.number(call.arguments.end_line, startLine + 399, startLine, startLine + 799);
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const lines = content.split(/\r?\n/); const from = Math.min(startLine, Math.max(lines.length, 1)); const to = Math.min(endLine, lines.length);
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, start_line: from, end_line: to, content: lines.slice(from - 1, to).join('\n'), has_more: to < lines.length, next_start_line: to < lines.length ? to + 1 : null });
    }
    const offset = this.number(call.arguments.offset, 0, 0, info.size); const maxBytes = this.number(call.arguments.max_bytes, defaultChunkBytes, 1, maxChunkBytes);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size - offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const content = buffer.subarray(0, bytesRead).toString('utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const end = offset + bytesRead;
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, byte_start: offset, byte_end: end, content, has_more: end < info.size, next_offset: end < info.size ? end : null });
    } finally { await handle.close(); }
  }

  private async gitStatus(): Promise<string> {
    try { const { stdout } = await execFileAsync('/usr/bin/git', ['-C', this.root, 'status', '--short', '--branch'], { timeout: 5_000, maxBuffer: 100_000 }); return JSON.stringify({ status: stdout || 'Рабочее дерево чистое' }); }
    catch { return JSON.stringify({ status: 'Git-репозиторий не обнаружен или статус недоступен' }); }
  }

  private async resolveExisting(input: string): Promise<string> {
    if (isAbsolute(input)) throw new Error('Разрешены только относительные пути внутри рабочей папки');
    const candidate = resolve(this.root, input || '.'); const rel = relative(this.root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Выход за пределы рабочей папки запрещён');
    const actual = await realpath(candidate); const actualRel = relative(this.root, actual);
    if (actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new Error('Символическая ссылка ведёт за пределы рабочей папки');
    return actual;
  }
  private text(value: unknown): string { return typeof value === 'string' ? value : ''; }
  private requiredText(value: unknown): string { const text = this.text(value).trim(); if (!text) throw new Error('Не указан поисковый запрос или путь'); return text; }
  private number(value: unknown, fallback: number, min: number, max: number): number { const number = typeof value === 'number' ? Math.floor(value) : fallback; return Math.max(min, Math.min(max, number)); }
  private pageSize(argumentsObject: Record<string, unknown>): number { return this.number(argumentsObject.limit ?? argumentsObject.max_results, defaultPageSize, 1, maxPageSize); }
}
