import { readFile } from 'node:fs/promises';
import type { Attachment, ChatMessage, StreamEvent, ToolActivity } from '../../shared/types';
import { AttachmentService, attachmentDisplayName } from './attachment-service';
import { Database } from './database';

type Emit = (event: StreamEvent) => void;
/** This is per user turn, after document/vision results have been normalized. */
export const MAX_ATTACHMENT_CONTEXT_CHARACTERS = 40_000;

function activity(attachment: Attachment, detail: string): ToolActivity {
  return { id: `attachment-${attachment.id}`, label: attachmentDisplayName(attachment), detail, status: attachment.status, attachment };
}

/** The stage between persisting a user message and starting its normal chat/agent inference. */
export class AttachmentPipeline {
  constructor(private readonly database: Database, private readonly attachments: AttachmentService) {}

  /**
   * Documents are always extracted locally. Images use the selected model's native
   * vision input when the selected backend advertises it. There is no fallback model.
   */
  async preprocessCurrent(attachmentIds: string[], signal: AbortSignal, emit: Emit, useNativeVision = false): Promise<void> {
    const current = attachmentIds.map((id) => this.database.getAttachment(id)).filter((item): item is Attachment => Boolean(item));
    const documentAttachments = current.filter((item) => item.kind !== 'image');
    for (const initial of documentAttachments) {
      if (signal.aborted) { this.markCancelled(current); return; }
      emit({ type: 'attachment', activity: activity(initial, 'Извлечение…') });
      const finished = await this.attachments.preprocess(initial, signal);
      emit({ type: 'attachment', activity: activity(finished, attachmentStatusDetail(finished)) });
    }
    const images = current.filter((item) => item.kind === 'image');
    if (!images.length || signal.aborted) { if (signal.aborted) this.markCancelled(current); return; }
    if (useNativeVision) {
      for (const initial of images) {
        if (signal.aborted) { this.markCancelled(images); return; }
        const processing = this.database.updateAttachment(initial.id, { status: 'processing', error: undefined })!;
        emit({ type: 'attachment', activity: activity(processing, 'Анализ…') });
        // The original binary is intentionally kept for the selected model. Do not
        // synthesize a second textual description or route to a separate model here.
        const ready = this.database.updateAttachment(processing.id, { status: 'ready', visionAnalysis: undefined, metadata: { ...(processing.metadata ?? {}), nativeVision: true } })!;
        emit({ type: 'attachment', activity: activity(ready, '✓ Передано модели') });
      }
      return;
    }
    for (const image of images) { const failed = this.database.updateAttachment(image.id, { status: 'error', error: 'Выбранная модель не поддерживает изображения.' })!; emit({ type: 'attachment', activity: activity(failed, '✕ Модель не поддерживает изображения') }); }
  }

  /** Insert a temporary block directly before its owning user turn; never into global capability context. */
  buildContext(history: ChatMessage[], includeImageDescriptions = true): ChatMessage[] {
    const contextualized: ChatMessage[] = [];
    for (const message of history) {
      const attachments = this.database.listAttachments(message.id).filter((attachment) => includeImageDescriptions || attachment.kind !== 'image');
      if (attachments.length) contextualized.push({ id: `attachments-${message.id}`, conversationId: message.conversationId, role: 'system', createdAt: message.createdAt, content: attachmentTurnContext(attachments) });
      contextualized.push(message);
    }
    return contextualized;
  }

  /** Rehydrates image binaries only for a single request; SQLite stores references, never base64 payloads. */
  async prepareNativeImages(history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const prepared: ChatMessage[] = [];
    for (const message of history) {
      if (signal.aborted) throw new DOMException('Attachment preparation cancelled', 'AbortError');
      if (message.role !== 'user') { prepared.push(message); continue; }
      const images = this.database.listAttachments(message.id).filter((attachment) => attachment.kind === 'image');
      if (!images.length) { prepared.push(message); continue; }
      const encoded: string[] = [];
      for (const image of images) {
        if (signal.aborted) throw new DOMException('Attachment preparation cancelled', 'AbortError');
        try { encoded.push((await readFile(image.storageRef)).toString('base64')); }
        catch (error) { throw new Error(`Не удалось подготовить ${attachmentDisplayName(image)} для нативного vision: ${error instanceof Error ? error.message : String(error)}`); }
      }
      prepared.push({ ...message, images: encoded });
    }
    return prepared;
  }

  private markCancelled(attachments: Attachment[]): void { for (const attachment of attachments) if (attachment.status === 'pending' || attachment.status === 'processing') this.database.updateAttachment(attachment.id, { status: 'cancelled', error: 'Обработка отменена' }); }
}

function attachmentStatusDetail(attachment: Attachment): string {
  if (attachment.status === 'ready') return '✓ Извлечено';
  if (attachment.status === 'ocr_required') return 'OCR потребуется для сканированного PDF';
  if (attachment.status === 'cancelled') return 'Отменено';
  return attachment.error ? `✕ ${attachment.error}` : '✕ Ошибка обработки';
}
function normalizedAttachment(attachment: Attachment): string {
  const title = attachment.kind === 'image' ? attachmentDisplayName(attachment) : `Attachment: ${attachment.filename}`;
  if (attachment.status === 'error') return `### ${title}\nCould not be processed: ${attachment.error ?? 'unknown error'}`;
  if (attachment.status === 'cancelled') return `### ${title}\nProcessing was cancelled.`;
  if (attachment.status === 'ocr_required') return `### ${title}\n${attachment.extractedText ?? 'OCR is required.'}`;
  if (attachment.kind === 'image') return `### ${title}\n${attachment.visionAnalysis ?? 'Image analysis is unavailable.'}`;
  return `### ${title}\n${attachment.extractedText ?? 'No extracted text is available.'}`;
}

function attachmentTurnContext(attachments: Attachment[]): string {
  const intro = '## User attachments\nThese are attachments supplied with the following user message. Image descriptions were generated by the local vision worker from actual attachments. They are visual context, not claims written by the user.';
  let result = intro; let truncated = false;
  for (const attachment of attachments) {
    const full = normalizedAttachment(attachment); const available = MAX_ATTACHMENT_CONTEXT_CHARACTERS - result.length - 2;
    if (available <= 0) { truncated = true; break; }
    if (full.length <= available) { result += `\n\n${full}`; continue; }
    const included = truncateForContext(full, available);
    if (included) result += `\n\n${included}`;
    truncated = true; break;
  }
  if (truncated && !result.includes('[Attachment partially included]')) {
    const marker = '\n\n[Attachment partially included]\nIncluded: attachment context reached its per-message limit\nOriginal extracted size: remaining attachment content was omitted';
    result = `${result.slice(0, Math.max(0, MAX_ATTACHMENT_CONTEXT_CHARACTERS - marker.length))}${marker}`;
  }
  return result;
}

function truncateForContext(content: string, maximum: number): string {
  if (content.length <= maximum) return content;
  if (maximum < 180) return '';
  let included = maximum;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const marker = `\n\n[Attachment partially included]\nIncluded: ${included.toLocaleString('en-US')} characters\nOriginal extracted size: ${content.length.toLocaleString('en-US')} characters`;
    included = Math.max(0, maximum - marker.length);
    if (included + marker.length <= maximum) return `${content.slice(0, included)}${marker}`;
  }
  return content.slice(0, maximum);
}
