import { execFile, spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RiskCategory, ToolActivity } from '../../shared/types';

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const maxLineReadBytes = 8_000_000;
const defaultPageSize = 100;
const maxPageSize = 250;
const defaultChunkBytes = 64_000;
const maxChunkBytes = 128_000;

/** Kept outside tool schemas; it is protocol metadata, not a tool argument. */
export type ProjectToolCall = { name: string; arguments: Record<string, unknown>; toolCallId?: string };
export type ProjectToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ConfirmationRequest = { title: string; detail: string; category: RiskCategory; actionId: string; root?: string };
export type ApprovalResult = { approved: boolean; reason: 'user_rejected' | 'cancelled' | 'once' | 'session' };
export type ConfirmAction = (request: ConfirmationRequest, signal: AbortSignal) => Promise<ApprovalResult>;
export type TerminalPolicy = { kind: 'allow' | 'confirm' | 'block'; category?: RiskCategory };

export const reportProgressToolDefinition: ProjectToolDefinition = { type: 'function', function: { name: 'report_progress', description: 'Сообщает пользователю короткий статус текущего этапа работы. Используй редко: только при смене значимого этапа (изучение, реализация, проверка). Одно короткое предложение. Не раскрывай скрытые рассуждения, пошаговую логику, внутренние инструкции и не повторяй каждый вызов инструмента.', parameters: { type: 'object', properties: { message: { type: 'string', minLength: 3, maxLength: 240, description: 'Короткое безопасное сообщение о текущем этапе.' } }, required: ['message'] } } };
export const terminalToolDefinition: ProjectToolDefinition = { type: 'function', function: { name: 'run_terminal', description: 'Запускает terminal-команду. Начальная папка — выбранный Project 1 или домашняя папка пользователя, если проект не выбран. Команда может работать с пользовательскими путями вне проекта; опасные и системные операции запросят подтверждение.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 } }, required: ['command'] } } };

const baseProjectToolDefinitions: ProjectToolDefinition[] = [
  { type: 'function', function: { name: 'list_directory', description: 'Показывает дерево файлов выбранного проекта. Начни с корня; при has_more=true запроси следующую страницу с next_offset.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Относительный путь внутри проекта, по умолчанию корень.' }, depth: { type: 'integer', minimum: 1, maximum: 4 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } } } } },
  { type: 'function', function: { name: 'find_files', description: 'Ищет имена файлов и папок внутри выбранного проекта. Результат постраничный.', parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Ищет файлы и папки по имени внутри выбранного проекта. Псевдоним find_files.', parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'search_text', description: 'Ищет текст в текстовых файлах выбранного проекта. Результат постраничный; сузь path при широком поиске.', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Необязательная относительная папка или файл.' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 250 } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Читает текстовый файл. Сначала используй search_text, затем read_file с start_line/end_line для нужного фрагмента большого файла. Без диапазона возвращается байтовый блок с has_more/next_offset; для небольших файлов полный read допустим.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: 128000 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, required: ['path'] } } },
  { type: 'function', function: { name: 'inspect_package_json', description: 'Читает package.json в корне выбранного проекта, если он есть.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_status', description: 'Показывает read-only статус Git выбранного проекта.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'git_diff', description: 'Показывает read-only git diff выбранного проекта.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'apply_patch', description: 'Основной инструмент точечного редактирования. Принимает patch в формате *** Begin Patch / *** Update File / *** Add File / *** Delete File. Все пути относительны корню проекта. Для большого нового файла сначала создай короткий рабочий каркас, затем расширяй его несколькими небольшими точечными patch и после этого прочитай/проверь результат.', parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Создаёт новый текстовый файл внутри проекта. Не перезаписывает существующие файлы; для изменений используй apply_patch. Для существенного исходного файла сначала создай минимальный каркас, затем добавляй части небольшими apply_patch и прочитай/проверь файл. Не помещай длинный документ в один хрупкий JSON-аргумент без необходимости.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'create_file', description: 'Создаёт новый текстовый файл внутри проекта. Псевдоним write_file. Для существенного исходного файла сначала создай минимальный каркас, затем добавляй части небольшими apply_patch и прочитай/проверь файл.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Удаляет один файл внутри проекта только после подтверждения пользователя.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const projectScopeProperties = {
  project_slot: { type: 'integer', enum: [1, 2], description: 'Слот проекта. По умолчанию Project 1.' },
  project_id: { type: 'string', description: 'Явный идентификатор проекта из runtime context; используй для ссылок из прошлых сообщений.' },
};
export const projectToolDefinitions: ProjectToolDefinition[] = baseProjectToolDefinitions.map((definition) => ({
  ...definition,
  function: { ...definition.function, parameters: { ...definition.function.parameters, properties: { ...(definition.function.parameters.properties as Record<string, unknown>), ...projectScopeProperties } } },
}));

function requestedRange(argumentsObject: Record<string, unknown>): string | undefined {
  const start = typeof argumentsObject.start_line === 'number' ? argumentsObject.start_line : undefined;
  const end = typeof argumentsObject.end_line === 'number' ? argumentsObject.end_line : undefined;
  if (start !== undefined) return end === undefined || end === start ? `строка ${start}` : `строки ${start}–${end}`;
  const offset = typeof argumentsObject.offset === 'number' ? argumentsObject.offset : undefined;
  return offset !== undefined ? `с байта ${offset}` : undefined;
}

export function activityForTool(call: ProjectToolCall): Pick<ToolActivity, 'label' | 'detail' | 'kind' | 'state'> {
  const path = typeof call.arguments.path === 'string' ? call.arguments.path : undefined;
  if (call.name === 'report_progress') return { label: String(call.arguments.message ?? '').trim(), kind: 'progress', state: 'completed' };
  if (call.name === 'task_notes') return { label: call.arguments.action === 'read' ? 'Чтение Task Notes' : 'Обновление Task Notes', kind: 'notes', state: 'running' };
  if (call.name === 'task_plan') return { label: 'Планирование', kind: 'planning', state: 'running' };
  if (call.name === 'list_directory') return { label: 'Просмотр структуры проекта', detail: path || undefined, kind: 'directory', state: 'running' };
  if (call.name === 'find_files' || call.name === 'search_files') return { label: 'Поиск файлов', detail: String(call.arguments.query ?? ''), kind: 'search', state: 'running' };
  if (call.name === 'search_text') return { label: 'Поиск текста в проекте', detail: `«${String(call.arguments.query ?? '')}»`, kind: 'search', state: 'running' };
  if (call.name === 'read_file') return { label: 'Чтение файла', detail: [path, requestedRange(call.arguments)].filter(Boolean).join(' · '), kind: 'file_read', state: 'running' };
  if (call.name === 'inspect_package_json') return { label: 'Чтение package.json', kind: 'file_read', state: 'running' };
  if (call.name === 'git_status') return { label: 'Проверка статуса Git', kind: 'git', state: 'running' };
  if (call.name === 'git_diff') return { label: 'Просмотр Git diff', kind: 'git', state: 'running' };
  if (call.name === 'apply_patch') return { label: 'Применение patch', kind: 'mutation', state: 'running' };
  if (call.name === 'write_file' || call.name === 'create_file') return { label: 'Создание файла', detail: String(call.arguments.path ?? ''), kind: 'mutation', state: 'running' };
  if (call.name === 'delete_file') return { label: 'Удаление файла', detail: String(call.arguments.path ?? ''), kind: 'mutation', state: 'running' };
  if (call.name === 'run_terminal') return { label: 'Запуск terminal', detail: String(call.arguments.command ?? ''), kind: 'terminal', state: 'running' };
  return { label: 'Действие агента', kind: 'other', state: 'running' };
}

export class ReadonlyProjectTools {
  private constructor(private readonly root: string, private readonly confirm: ConfirmAction) {}

  static async open(root: string, confirm: ConfirmAction): Promise<ReadonlyProjectTools> {
    const resolved = await realpath(root); const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('Рабочая папка не является каталогом');
    return new ReadonlyProjectTools(resolved, confirm);
  }

  /** Compact composer search. It exposes only paths below an already-authorized root. */
  static async findResources(root: string, query: string, limit = 40): Promise<Array<{ relativePath: string; kind: 'file' | 'folder' }>> {
    const resolved = await realpath(root); const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('Рабочая папка не является каталогом');
    const needle = query.toLowerCase(); const results: Array<{ relativePath: string; kind: 'file' | 'folder' }> = [];
    const walk = async (directory: string, level: number): Promise<void> => {
      if (results.length >= limit || level > 8) return;
      const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= limit || entry.isSymbolicLink()) continue;
        const full = resolve(directory, entry.name); const kind = entry.isDirectory() ? 'folder' as const : 'file' as const;
        const relativePath = relative(resolved, full).replaceAll(sep, '/');
        if (!needle || entry.name.toLowerCase().includes(needle) || relativePath.toLowerCase().includes(needle)) results.push({ relativePath, kind });
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await walk(full, level + 1);
      }
    };
    await walk(resolved, 1);
    return results;
  }

  async execute(call: ProjectToolCall, signal: AbortSignal, actionId: string): Promise<string> {
    try {
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      if (call.name === 'list_directory') return await this.listDirectory(this.text(call.arguments.path), this.number(call.arguments.depth, 2, 1, 4), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'find_files' || call.name === 'search_files') return await this.findFiles(this.requiredText(call.arguments.query, 'query'), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'search_text') return await this.searchText(this.requiredText(call.arguments.query, 'query'), this.text(call.arguments.path), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'read_file') return await this.readTextFile(call);
      if (call.name === 'inspect_package_json') return await this.readTextFile({ name: 'read_file', arguments: { path: 'package.json', max_bytes: maxChunkBytes } });
      if (call.name === 'git_status') return await this.gitStatus();
      if (call.name === 'git_diff') return await this.gitDiff();
      if (call.name === 'apply_patch') return await this.applyPatch(this.requiredText(call.arguments.patch, 'patch'), signal, actionId);
      if (call.name === 'write_file' || call.name === 'create_file') return await this.createFile(this.requiredText(call.arguments.path, 'path'), this.requiredContent(call.arguments.content), signal);
      if (call.name === 'delete_file') return await this.deleteFile(this.requiredText(call.arguments.path, 'path'), signal, actionId);
      return JSON.stringify({ error: `Неизвестный инструмент проекта: ${call.name}` });
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
    const path = this.requiredText(call.arguments.path, 'path'); const file = await this.resolveExisting(path); const info = await stat(file);
    if (!info.isFile()) throw new Error('Указанный путь не является файлом');
    const startLine = typeof call.arguments.start_line === 'number' ? this.number(call.arguments.start_line, 1, 1, 10_000_000) : null;
    if (startLine !== null && info.size <= maxLineReadBytes) {
      const endLine = this.number(call.arguments.end_line, startLine + 399, startLine, startLine + 799);
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const lines = content.split(/\r?\n/); const from = Math.min(startLine, Math.max(lines.length, 1)); const to = Math.min(endLine, lines.length);
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}`, start_line: from, end_line: to, content: lines.slice(from - 1, to).join('\n'), has_more: to < lines.length, next_start_line: to < lines.length ? to + 1 : null });
    }
    const offset = this.number(call.arguments.offset, 0, 0, info.size); const maxBytes = this.number(call.arguments.max_bytes, defaultChunkBytes, 1, maxChunkBytes);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size - offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const content = buffer.subarray(0, bytesRead).toString('utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const end = offset + bytesRead;
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}`, byte_start: offset, byte_end: end, content, has_more: end < info.size, next_offset: end < info.size ? end : null });
    } finally { await handle.close(); }
  }

  private async gitStatus(): Promise<string> {
    try { const { stdout } = await execFileAsync('/usr/bin/git', ['-C', this.root, 'status', '--short', '--branch'], { timeout: 5_000, maxBuffer: 100_000 }); return JSON.stringify({ status: stdout || 'Рабочее дерево чистое' }); }
    catch { return JSON.stringify({ status: 'Git-репозиторий не обнаружен или статус недоступен' }); }
  }

  private async gitDiff(): Promise<string> {
    try { const { stdout } = await execFileAsync('/usr/bin/git', ['-C', this.root, 'diff', '--no-ext-diff'], { timeout: 5_000, maxBuffer: 200_000 }); return JSON.stringify({ diff: stdout || 'Нет незакоммиченных изменений' }); }
    catch { return JSON.stringify({ error: 'Git diff недоступен' }); }
  }

  private async createFile(path: string, content: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
    const candidate = await this.resolveWritePath(path); const exists = await stat(candidate).then(() => true).catch(() => false);
    if (exists) return JSON.stringify({ error: 'Файл уже существует. Для изменения существующего файла используй apply_patch.' });
    await writeFile(candidate, content, { encoding: 'utf8', flag: 'wx' });
    return JSON.stringify({ path, created: true, bytes: Buffer.byteLength(content) });
  }

  private async deleteFile(path: string, signal: AbortSignal, actionId: string): Promise<string> {
    const file = await this.resolveExisting(path); const info = await stat(file);
    if (!info.isFile()) return JSON.stringify({ error: 'Можно удалить только один файл, не каталог.' });
    const approval = await this.confirm({ title: 'Удалить файл?', detail: path, category: 'file_delete', actionId, root: this.root }, signal);
    if (!approval.approved) return JSON.stringify({ approved: false, reason: approval.reason });
    if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
    await unlink(file); return JSON.stringify({ path, deleted: true });
  }

  private async applyPatch(patch: string, signal: AbortSignal, actionId: string): Promise<string> {
    const lines = patch.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '*** Begin Patch' || !lines.includes('*** End Patch')) return JSON.stringify({ error: 'Ожидается patch в формате *** Begin Patch ... *** End Patch.' });
    const changed: string[] = []; let index = 1;
    while (index < lines.length && lines[index] !== '*** End Patch') {
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      const header = lines[index++]; const update = header.match(/^\*\*\* Update File: (.+)$/); const add = header.match(/^\*\*\* Add File: (.+)$/); const remove = header.match(/^\*\*\* Delete File: (.+)$/);
      const body: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ') && lines[index] !== '*** End Patch') body.push(lines[index++]);
      if (add) {
        const file = await this.resolveWritePath(add[1]); const exists = await stat(file).then(() => true).catch(() => false);
        if (exists) return JSON.stringify({ error: `Файл уже существует: ${add[1]}` });
        await writeFile(file, body.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n'), 'utf8'); changed.push(add[1]); continue;
      }
      if (remove) {
        const file = await this.resolveExisting(remove[1]); const info = await stat(file); if (!info.isFile()) return JSON.stringify({ error: `Можно удалить только файл: ${remove[1]}` });
        const approval = await this.confirm({ title: 'Удалить файл?', detail: remove[1], category: 'file_delete', actionId, root: this.root }, signal);
        if (!approval.approved) return JSON.stringify({ approved: false, reason: approval.reason });
        await unlink(file); changed.push(remove[1]); continue;
      }
      if (!update) return JSON.stringify({ error: `Неизвестная секция patch: ${header}` });
      const file = await this.resolveExisting(update[1]); let content = await readFile(file, 'utf8');
      const hunks = body.join('\n').split('\n@@\n');
      for (const rawHunk of hunks) {
        const hunk = rawHunk.replace(/^@@\n?/, '').split('\n').filter((line) => line !== '\\ No newline at end of file');
        const before = hunk.filter((line) => line.startsWith(' ') || line.startsWith('-')).map((line) => line.slice(1)).join('\n');
        const after = hunk.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1)).join('\n');
        if (!before) return JSON.stringify({ error: `Patch для ${update[1]} не содержит контекста удаления/замены.` });
        const position = content.indexOf(before); if (position < 0) return JSON.stringify({ error: `Patch не совпадает с текущим содержимым: ${update[1]}` });
        content = `${content.slice(0, position)}${after}${content.slice(position + before.length)}`;
      }
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      await writeFile(file, content, 'utf8'); changed.push(update[1]);
    }
    return JSON.stringify({ applied: true, files: changed });
  }

  private async resolveWritePath(input: string): Promise<string> {
    if (isAbsolute(input)) throw new Error('Разрешены только относительные пути внутри рабочей папки');
    const candidate = resolve(this.root, input); const rel = relative(this.root, candidate);
    if (!input || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Выход за пределы рабочей папки запрещён');
    const actualParent = await realpath(dirname(candidate)); const parentRel = relative(this.root, actualParent);
    if (parentRel === '..' || parentRel.startsWith(`..${sep}`)) throw new Error('Символическая ссылка ведёт за пределы рабочей папки');
    return candidate;
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
  private requiredText(value: unknown, field: string): string { const text = this.text(value).trim(); if (!text) throw new Error(`Не указан обязательный параметр "${field}"`); return text; }
  private requiredContent(value: unknown): string { if (typeof value !== 'string') throw new Error('Не указан обязательный параметр "content"'); return value; }
  private number(value: unknown, fallback: number, min: number, max: number): number { const number = typeof value === 'number' ? Math.floor(value) : fallback; return Math.max(min, Math.min(max, number)); }
  private pageSize(argumentsObject: Record<string, unknown>): number { return this.number(argumentsObject.limit ?? argumentsObject.max_results, defaultPageSize, 1, maxPageSize); }
}

/** Terminal access is deliberately independent of the project filesystem scope. */
export class TerminalTools {
  private constructor(public readonly cwd: string, private readonly confirm: ConfirmAction) {}

  static async open(initialCwd: string, confirm: ConfirmAction): Promise<TerminalTools> {
    const cwd = await realpath(initialCwd); const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error('Начальная папка terminal не является каталогом');
    return new TerminalTools(cwd, confirm);
  }

  async execute(call: ProjectToolCall, signal: AbortSignal, actionId: string): Promise<string> {
    try {
      if (call.name !== 'run_terminal') return JSON.stringify({ error: `Неизвестный terminal-инструмент: ${call.name}` });
      const command = typeof call.arguments.command === 'string' ? call.arguments.command.trim() : '';
      if (!command) return JSON.stringify({ error: 'Не указан обязательный параметр "command"' });
      const timeout = typeof call.arguments.timeout_ms === 'number' ? Math.max(1_000, Math.min(120_000, Math.floor(call.arguments.timeout_ms))) : 60_000;
      const policy = terminalPolicy(command);
      if (policy.kind === 'block') return JSON.stringify({ error: 'Команда заблокирована terminal policy.' });
      if (policy.kind === 'confirm') {
        const approval = await this.confirm({ title: 'Разрешить terminal command?', detail: command, category: policy.category!, actionId, root: this.cwd }, signal);
        if (!approval.approved) return JSON.stringify({ approved: false, reason: approval.reason });
      }
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      return await runTerminal(command, timeout, this.cwd, signal);
    } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Ошибка terminal' }); }
  }
}

/**
 * Safety policy is intentionally separate from project path validation. The
 * terminal may work in a user's home directory and elsewhere, while commands
 * that can change the system still require explicit confirmation.
 */
export function terminalPolicy(command: string): TerminalPolicy {
  const value = command.trim();
  if (!value || value.includes('\0')) return { kind: 'block' };
  if (/[`$][(]|`|\n|;|&&|\|\||[<>]|(?:^|[^&])&(?!&)/.test(value)) return { kind: 'confirm', category: /[<>]/.test(value) ? 'shell_redirection' : 'shell_chaining' };
  const stages = splitPipeline(value);
  if (!stages) return { kind: 'confirm', category: 'shell_chaining' };
  const classifications = stages.map(classifyTerminalStage);
  if (!stages.length || classifications.some((classification) => !classification) || (stages.length > 1 && classifications.includes('trusted_project_execution'))) return { kind: 'confirm', category: 'system_command' };
  return { kind: 'allow' };
}

/** Split only unquoted pipe stages. Anything shell-like we cannot classify is rejected. */
function splitPipeline(command: string): string[] | null {
  const stages: string[] = []; let value = ''; let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) { value += char; if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') { quote = char; value += char; continue; }
    if (char === '\\') { const next = command[++index]; if (next === undefined) return null; value += `\\${next}`; continue; }
    if (char === '|') { stages.push(value.trim()); value = ''; continue; }
    value += char;
  }
  if (quote) return null;
  stages.push(value.trim());
  return stages;
}

function words(stage: string): string[] | null {
  const tokens: string[] = []; let value = ''; let quote = '';
  for (let index = 0; index < stage.length; index += 1) { const char = stage[index]; if (quote) { if (char === quote) quote = ''; else value += char; continue; } if (char === "'" || char === '"') { quote = char; continue; } if (/\s/.test(char)) { if (value) { tokens.push(value); value = ''; } continue; } if (char === '\\') { const next = stage[++index]; if (next === undefined) return null; value += next; continue; } value += char; }
  if (quote) return null; if (value) tokens.push(value); return tokens;
}
type TerminalStageClassification = 'read_only' | 'trusted_project_execution' | null;
function classifyTerminalStage(stage: string): TerminalStageClassification {
  return readOnlyStage(stage) ? 'read_only' : trustedProjectExecutionStage(stage) ? 'trusted_project_execution' : null;
}
function readOnlyGitBranch(args: string[]): boolean {
  if (!args.length) return true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--show-current' || argument === '--list' || argument === '-l' || argument.startsWith('--list=')) continue;
    if (argument === '--contains' || argument === '--merged' || argument === '--no-merged') { if (args[index + 1] && !args[index + 1].startsWith('-')) index += 1; continue; }
    if (argument.startsWith('--contains=') || argument.startsWith('--merged=') || argument.startsWith('--no-merged=')) continue;
    return false;
  }
  return true;
}
function readOnlyStage(stage: string): boolean {
  const tokens = words(stage); if (!tokens?.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const [bin, ...args] = tokens; const command = bin.replace(/^.*\//, '');
  if (['pwd', 'whoami', 'uname', 'echo', 'printf', 'ls', 'find', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'sort', 'uniq'].includes(command)) return command !== 'find' || !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0'].includes(arg));
  if (command === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'));
    const subcommand = args[subcommandIndex];
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand ?? '')) return true;
    return subcommand === 'branch' && readOnlyGitBranch(args.slice(subcommandIndex + 1));
  }
  if (command === 'nvidia-smi' || (command === 'gsettings' && args[0] === 'get')) return true;
  if (command === 'systemctl' && args[0] === '--user' && ['status', 'is-active', 'is-enabled', 'show'].includes(args[1] ?? '')) return true;
  if (command === 'xargs') { let index = 0; while (index < args.length && args[index].startsWith('-')) { if (['-n', '-P', '-I', '-d', '-E'].includes(args[index])) index += 2; else index += 1; } return index < args.length && readOnlyStage(args.slice(index).join(' ')); }
  return false;
}
/** Project scripts may be auto-allowed for compatibility, but they are not read-only. */
function trustedProjectExecutionStage(stage: string): boolean {
  const tokens = words(stage); if (!tokens?.length) return false;
  const [bin, ...args] = tokens; const command = bin.replace(/^.*\//, ''); const safeScripts = new Set(['lint', 'typecheck', 'test', 'build']);
  return ['npm', 'pnpm', 'yarn'].includes(command) && ((args[0] === 'run' && safeScripts.has(args[1] ?? '')) || (command !== 'npm' && safeScripts.has(args[0] ?? '')));
}

function runTerminal(command: string, timeout: number, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    // The assistant call already retains the full command. Repeating a large
    // heredoc in the tool result can consume the entire Agent context without
    // adding evidence, so retain only a bounded diagnostic echo here.
    const commandDiagnostic = command.length > 1_200 ? `${command.slice(0, 1_200)}\n[command diagnostic truncated]` : command;
    const child = spawn('/bin/bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let stdoutTruncated = false; let stderrTruncated = false; let finished = false;
    const append = (current: string, chunk: string, limit: number): string => { if (current.length >= limit) return current; const next = `${current}${chunk}`; return next.length > limit ? next.slice(0, limit) : next; };
    const finish = (result: Record<string, unknown>) => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); clearTimeout(timer); resolve(JSON.stringify(result)); };
    const terminate = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Process already exited. */ } }, 2_000).unref(); } catch { child.kill('SIGTERM'); } } };
    const abort = () => { terminate(); finish({ cancelled: true, reason: 'Generation cancelled' }); };
    const timer = setTimeout(() => { terminate(); finish({ timed_out: true, error: `Terminal command exceeded timeout of ${timeout}ms`, command: commandDiagnostic, cwd, stdout: stdoutTruncated ? `${stdout}\n[diagnostic output truncated]` : stdout, stderr: stderrTruncated ? `${stderr}\n[diagnostic output truncated]` : stderr }); }, timeout);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdoutTruncated ||= stdout.length + text.length > 80_000; stdout = append(stdout, text, 80_000); }); child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderrTruncated ||= stderr.length + text.length > 20_000; stderr = append(stderr, text, 20_000); });
    child.on('error', (error) => finish({ error: error.message, cwd })); child.on('close', (code, signalName) => finish({ command: commandDiagnostic, cwd, exit_code: code, signal: signalName, stdout: stdoutTruncated ? `${stdout}\n[diagnostic output truncated]` : stdout, stderr: stderrTruncated ? `${stderr}\n[diagnostic output truncated]` : stderr }));
  });
}
