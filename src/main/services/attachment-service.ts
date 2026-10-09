import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from '@keep-lts/xlsx';
import type { Attachment, AttachmentInput, AttachmentKind } from '../../shared/types';
import { Database } from './database';
import { paths } from './paths';

export const MAX_IMAGES_PER_MESSAGE = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Any one source is capped before persistence and before it can enter LLM context. */
export const MAX_EXTRACTED_CHARACTERS = 16_000;
export const MAX_STRUCTURED_ROWS = 100;
export const MAX_STRUCTURED_COLUMNS = 32;
export const MAX_STRUCTURED_CELL_CHARACTERS = 2_000;

const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.log', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.yaml', '.yml', '.xml']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const documentExtensions = new Set(['.docx']);
const spreadsheetExtensions = new Set(['.xlsx', '.xls']);

function kindFor(filename: string, mimeType: string): AttachmentKind | null {
  const ext = extname(filename).toLowerCase();
  if (imageExtensions.has(ext) && (mimeType.startsWith('image/') || !mimeType)) return 'image';
  if (textExtensions.has(ext)) return 'text';
  if (documentExtensions.has(ext)) return 'document';
  if (spreadsheetExtensions.has(ext)) return 'spreadsheet';
  if (ext === '.pdf') return 'pdf';
  return null;
}
function safeFilename(filename: string): string {
  const result = basename(filename).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180);
  return result || 'attachment';
}
export function imageMimeType(filename: string): string {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
function hasExpectedImageSignature(filename: string, bytes: Buffer): boolean {
  const ext = extname(filename).toLowerCase();
  if (ext === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (ext === '.webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return false;
}
export function clipAttachmentText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_EXTRACTED_CHARACTERS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_EXTRACTED_CHARACTERS)}\n\n[Attachment partially included]\nIncluded: ${MAX_EXTRACTED_CHARACTERS.toLocaleString('en-US')} characters\nOriginal extracted size: ${text.length.toLocaleString('en-US')} characters`, truncated: true };
}

/** Stores untrusted user bytes outside SQLite, and extracts only deterministic text. */
export class AttachmentService {
  constructor(private readonly database: Database) {}

  async import(input: AttachmentInput): Promise<Attachment> {
    const filename = safeFilename(input.filename);
    const kind = kindFor(filename, input.mimeType);
    if (!kind) throw new Error('Поддерживаются изображения PNG/JPG/WebP, текстовые файлы, DOCX, XLS/XLSX и PDF');
    const bytes = Buffer.from(input.data);
    const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!bytes.length) throw new Error('Пустой файл нельзя прикрепить');
    if (bytes.length > max) throw new Error(`Файл ${filename} превышает лимит ${Math.floor(max / 1024 / 1024)} MB`);
    if (kind === 'image' && !hasExpectedImageSignature(filename, bytes)) throw new Error(`Файл ${filename} не соответствует заявленному формату изображения`);
    if (!this.database.getMessage(input.messageId)) throw new Error('Сообщение для вложения не найдено');
    if (kind === 'image' && this.database.listAttachments(input.messageId).filter((item) => item.kind === 'image').length >= MAX_IMAGES_PER_MESSAGE) throw new Error(`К одному сообщению можно добавить не больше ${MAX_IMAGES_PER_MESSAGE} изображений`);
    const id = input.id ?? randomUUID(); const directory = join(paths.attachments, input.messageId); const storageRef = join(directory, `${id}-${filename}`);
    await mkdir(directory, { recursive: true }); await writeFile(storageRef, bytes, { flag: 'wx' });
    try {
      const imageNumber = kind === 'image' ? this.database.listAttachments(input.messageId).filter((item) => item.kind === 'image').length + 1 : undefined;
      return this.database.createAttachment({ id, messageId: input.messageId, index: input.index, kind, mimeType: kind === 'image' ? imageMimeType(filename) : input.mimeType || 'application/octet-stream', filename, size: bytes.length, storageRef, metadata: { originalSize: bytes.length, ...(imageNumber ? { imageNumber } : {}) } });
    } catch (error) { await rm(storageRef, { force: true }); throw error; }
  }

  async removeManagedFiles(attachments: Attachment[]): Promise<void> {
    await Promise.all(attachments.map(async (attachment) => {
      const absolute = resolve(attachment.storageRef); const root = `${resolve(paths.attachments)}/`;
      if (absolute.startsWith(root)) await rm(absolute, { force: true }).catch(() => undefined);
    }));
  }

  async preprocess(attachment: Attachment, signal: AbortSignal): Promise<Attachment> {
    if (attachment.status === 'ready' || attachment.status === 'ocr_required') return attachment;
    this.throwIfAborted(signal); this.database.updateAttachment(attachment.id, { status: 'processing', error: undefined });
    try {
      const result = attachment.kind === 'text' ? await this.extractText(attachment, signal)
        : attachment.kind === 'document' ? await this.extractDocx(attachment, signal)
          : attachment.kind === 'spreadsheet' ? await this.extractSpreadsheet(attachment, signal)
            : attachment.kind === 'pdf' ? await this.extractPdf(attachment, signal) : attachment;
      this.throwIfAborted(signal);
      return this.database.updateAttachment(attachment.id, result) ?? attachment;
    } catch (error) {
      if (signal.aborted) return this.database.updateAttachment(attachment.id, { status: 'cancelled', error: 'Обработка отменена' }) ?? attachment;
      return this.database.updateAttachment(attachment.id, { status: 'error', error: error instanceof Error ? error.message : String(error) }) ?? attachment;
    }
  }

  /** Returns a bounded, typed page from an attachment already owned by this app. Paths never come from the model. */
  async readStructuredRows(id: string, sheetName?: string, startRow = 0, requestedRows = 50): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(startRow) || startRow < 0 || startRow > 1_000_000) throw new Error('Row offset must be between 0 and 1,000,000.');
    const limit = Number.isSafeInteger(requestedRows) ? Math.min(MAX_STRUCTURED_ROWS, Math.max(1, requestedRows)) : 50;
    const attachment = this.database.getAttachment(id);
    if (!attachment || (attachment.kind !== 'spreadsheet' && !(attachment.kind === 'text' && ['.csv', '.tsv'].includes(extname(attachment.filename).toLowerCase())))) throw new Error('This attachment is not a supported structured table.');
    const bytes = await readFile(attachment.storageRef);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Attachment exceeds the structured extraction limit.');
    if (attachment.kind === 'text') return readDelimitedPage(bytes.toString('utf8'), attachment.filename, startRow, limit);
    const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true, cellDates: true, bookVBA: false });
    const sheets = workbook.SheetNames.slice(0, 64).map((name) => ({ name, hidden: Boolean(workbook.Workbook?.Sheets?.find((sheet) => sheet.name === name)?.Hidden) }));
    const selected = sheetName ? workbook.SheetNames.find((name) => name === sheetName) : workbook.SheetNames[0];
    if (!selected || workbook.SheetNames.length > 64) throw new Error('Choose a valid worksheet (workbooks are limited to the first 64 sheets).');
    const sheet = workbook.Sheets[selected];
    const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const width = Math.min(MAX_STRUCTURED_COLUMNS, range.e.c - range.s.c + 1);
    const header = Array.from({ length: width }, (_, offset) => cellValue(sheet[XLSX.utils.encode_cell({ r: range.s.r, c: range.s.c + offset })], true));
    const columns = header.map((value, index) => ({ key: `c${index + 1}`, label: String(value || `Column ${index + 1}`).slice(0, 120), kind: 'text' as 'text' | 'number' }));
    const first = range.s.r + 1 + startRow;
    const last = Math.min(range.e.r, first + limit - 1);
    const rows = first > range.e.r ? [] : Array.from({ length: last - first + 1 }, (_, offset) => Object.fromEntries(columns.map((column, index) => [column.key, cellValue(sheet[XLSX.utils.encode_cell({ r: first + offset, c: range.s.c + index })], false)])));
    for (const column of columns) if (rows.some((row) => row[column.key] !== null) && rows.every((row) => row[column.key] === null || typeof row[column.key] === 'number')) column.kind = 'number';
    return { attachment_id: id, filename: attachment.filename, sheet: selected, sheets, columns, rows, start_row: startRow, total_rows: Math.max(0, range.e.r - range.s.r), next_start_row: startRow + rows.length < Math.max(0, range.e.r - range.s.r) ? startRow + rows.length : null, limit, formula_note: 'Cached formula values are returned when present. Formula cells without a cached result are labeled as unavailable; formulas are not evaluated.' };
  }

  private async extractText(attachment: Attachment, signal: AbortSignal): Promise<Partial<Attachment>> {
    const raw = await readFile(attachment.storageRef, 'utf8'); this.throwIfAborted(signal);
    let text = raw; let warning = '';
    if (extname(attachment.filename).toLowerCase() === '.json') {
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { warning = '[JSON parse warning: invalid JSON; original text is shown below]\n'; }
    }
    const result = clipAttachmentText(`${warning}${text}`);
    return { status: 'ready', extractedText: result.text, metadata: { ...(attachment.metadata ?? {}), truncated: result.truncated, originalExtractedCharacters: text.length } };
  }

  private async extractDocx(attachment: Attachment, signal: AbortSignal): Promise<Partial<Attachment>> {
    const buffer = await readFile(attachment.storageRef); this.throwIfAborted(signal);
    const [raw, html] = await Promise.all([mammoth.extractRawText({ buffer }), mammoth.convertToHtml({ buffer })]); this.throwIfAborted(signal);
    // Preserve simple table rows and heading boundaries without executing document content.
    const structured = html.value
      .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n${'#'.repeat(Number(level))} `)
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<tr[^>]*>/gi, '\n| ')
      .replace(/<\/(?:tr)>/gi, ' |\n')
      .replace(/<t[dh][^>]*>/gi, '')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const source = structured || raw.value.trim(); const text = clipAttachmentText(source);
    return { status: 'ready', extractedText: text.text, metadata: { ...(attachment.metadata ?? {}), truncated: text.truncated, messages: [...raw.messages, ...html.messages].map((message) => message.message) } };
  }

  private async extractSpreadsheet(attachment: Attachment, signal: AbortSignal): Promise<Partial<Attachment>> {
    const buffer = await readFile(attachment.storageRef); this.throwIfAborted(signal);
    const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellDates: true, bookVBA: false });
    const sections = workbook.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: '', raw: false });
      const values = rows.map((row) => row.map((cell) => String(cell)).join(' | ')).join('\n');
      return `Sheet: ${name}\n${values}`;
    });
    const raw = sections.join('\n\n'); const text = clipAttachmentText(raw);
    return { status: 'ready', extractedText: text.text, structuredData: JSON.stringify({ sheets: workbook.SheetNames }), metadata: { ...(attachment.metadata ?? {}), truncated: text.truncated, sheetNames: workbook.SheetNames, originalExtractedCharacters: raw.length } };
  }

  private async extractPdf(attachment: Attachment, signal: AbortSignal): Promise<Partial<Attachment>> {
    const bytes = new Uint8Array(await readFile(attachment.storageRef)); this.throwIfAborted(signal);
    // pdfjs-dist is ESM-only. Function avoids CommonJS transpilation of import().
    const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ getDocument: (source: { data: Uint8Array }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> }> } }>;
    const pdfjs = await load('pdfjs-dist/legacy/build/pdf.mjs'); const document = await pdfjs.getDocument({ data: bytes }).promise;
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) { this.throwIfAborted(signal); const page = await document.getPage(index); const content = await page.getTextContent(); pages.push(`Page ${index}\n${content.items.map((item) => item.str ?? '').join(' ').trim()}`); }
    const raw = pages.join('\n\n');
    if (raw.replace(/\s+/g, '').length < 20) return { status: 'ocr_required', extractedText: 'This PDF appears to be scanned or contains no extractable text. OCR is not available yet.', metadata: { ...(attachment.metadata ?? {}), pageCount: document.numPages } };
    const text = clipAttachmentText(raw);
    return { status: 'ready', extractedText: text.text, metadata: { ...(attachment.metadata ?? {}), pageCount: document.numPages, truncated: text.truncated, originalExtractedCharacters: raw.length } };
  }

  private throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); }
}

/** A model sees only IDs already attached to this conversation; Electron resolves IDs to managed files. */
export function attachmentDataTool(attachments: Attachment[]): unknown | undefined {
  const supported = attachments.filter((attachment) => attachment.kind === 'spreadsheet' || (attachment.kind === 'text' && ['.csv', '.tsv'].includes(extname(attachment.filename).toLowerCase())));
  if (!supported.length) return undefined;
  const files = supported.slice(0, 100).map((attachment) => `${attachment.id} (${attachment.filename})`).join(', ');
  return { type: 'function', function: { name: 'read_attachment_data', description: `Read a bounded page of actual rows from a spreadsheet or CSV attached to this conversation. Available attachments: ${files}. Use start_row to page through values; maximum 100 rows and 32 columns per call. It does not read arbitrary paths. Formula cells are never evaluated.`, parameters: { type: 'object', properties: { attachment_id: { type: 'string', enum: supported.slice(0, 100).map((attachment) => attachment.id) }, sheet_name: { type: 'string' }, start_row: { type: 'integer', minimum: 0, maximum: 1000000 }, max_rows: { type: 'integer', minimum: 1, maximum: MAX_STRUCTURED_ROWS } }, required: ['attachment_id'] } } };
}

function cellValue(cell: XLSX.CellObject | undefined, header: boolean): string | number | boolean | null {
  if (!cell) return null;
  if (cell.f && cell.v === undefined) return header ? `[formula: ${cell.f}]` : `[calculated value unavailable; formula ${cell.f}]`;
  const value = cell.v;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.slice(0, MAX_STRUCTURED_CELL_CHARACTERS);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return value === null || value === undefined ? null : String(value).slice(0, MAX_STRUCTURED_CELL_CHARACTERS);
}

function readDelimitedPage(raw: string, filename: string, startRow: number, limit: number): Record<string, unknown> {
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = extname(filename).toLowerCase() === '.tsv' || (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let rowIndex = 0; let totalRows = 0;
  const finishRow = () => {
    row.push(field); field = '';
    if (rowIndex === 0) rows.push(row.map((cell) => cell.slice(0, MAX_STRUCTURED_CELL_CHARACTERS)));
    else { totalRows += 1; if (totalRows > startRow && totalRows <= startRow + limit) rows.push(row.map((cell) => cell.slice(0, MAX_STRUCTURED_CELL_CHARACTERS))); }
    row = []; rowIndex += 1;
  };
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '"') { if (quoted && raw[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted; }
    else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && raw[index + 1] === '\n') index += 1; finishRow(); }
    else if (field.length < MAX_STRUCTURED_CELL_CHARACTERS) field += char;
  }
  if (field || row.length) finishRow();
  const header = rows.shift() ?? [];
  const columns = header.slice(0, MAX_STRUCTURED_COLUMNS).map((label, index) => ({ key: `c${index + 1}`, label: label || `Column ${index + 1}`, kind: 'text' as 'text' | 'number' }));
  const page = rows.map((values) => Object.fromEntries(columns.map((column, index) => [column.key, parseCsvValue(values[index] ?? '')])));
  for (const column of columns) if (page.some((row) => row[column.key] !== null) && page.every((row) => row[column.key] === null || typeof row[column.key] === 'number')) column.kind = 'number';
  return { filename, sheet: 'CSV', sheets: [{ name: 'CSV', hidden: false }], columns, rows: page, start_row: startRow, total_rows: totalRows, next_start_row: startRow + page.length < totalRows ? startRow + page.length : null, limit, formula_note: 'CSV values are parsed as numbers only when their syntax is unambiguous; formulas are not calculated.' };
}
function parseCsvValue(value: string): string | number | null {
  const trimmed = value.trim(); if (!trimmed) return null;
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$|^-?(?:[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const number = Number(trimmed); if (Number.isFinite(number)) return number;
  }
  return value;
}

export function attachmentDisplayName(attachment: Attachment): string { return attachment.kind === 'image' ? `Image ${Number(attachment.metadata?.imageNumber) || attachment.index + 1}` : attachment.filename; }
export function attachmentRelativePath(attachment: Attachment): string { return relative(paths.attachments, attachment.storageRef); }
