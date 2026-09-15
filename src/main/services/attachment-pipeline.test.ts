import { Database } from './database';
import { AttachmentService, MAX_EXTRACTED_CHARACTERS, MAX_IMAGES_PER_MESSAGE, attachmentDisplayName } from './attachment-service';
import { AttachmentPipeline, MAX_ATTACHMENT_CONTEXT_CHARACTERS } from './attachment-pipeline';
import { ProjectChatService } from './project-chat';
import { WebBrowserService } from '../web/web-tools';
import type { ToolMessage } from '../backends/types';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Focused persistence/pipeline regression coverage; run with `npm run test:attachments`. */
export async function runAttachmentPipelineRegression(): Promise<void> {
  const database = new Database(); const chat = database.createConversation('qwen3.8:27b-q4_K_M'); const message = database.addMessage(chat.id, 'user', 'Inspect attachments'); const service = new AttachmentService(database);
  try {
    const images = [];
    for (let index = 0; index < MAX_IMAGES_PER_MESSAGE; index += 1) images.push(await service.import({ messageId: message.id, index, filename: `${index}.png`, mimeType: 'image/png', data: png }));
    await service.import({ messageId: message.id, index: 10, filename: 'eleven.png', mimeType: 'image/png', data: png }).then(() => { throw new Error('11th image was accepted'); }, (error: Error) => assert(error.message.includes('10'), '11th image returned the wrong error'));
    assert(database.listAttachments(message.id).length === 10, '11th image changed persisted attachments');

    // Mirrors A, B, C in the draft composer followed by deleting B before Send:
    // only A/C are imported, so their persisted numbering is contiguous.
    const renumbered = database.addMessage(chat.id, 'user', 'A and C only');
    const imageA = await service.import({ messageId: renumbered.id, index: 0, filename: 'A.png', mimeType: 'image/png', data: png });
    const imageC = await service.import({ messageId: renumbered.id, index: 1, filename: 'C.png', mimeType: 'image/png', data: png });
    assert(attachmentDisplayName(imageA) === 'Image 1' && attachmentDisplayName(imageC) === 'Image 2', 'draft deletion did not produce contiguous image numbers');

    const turn = database.addMessage(chat.id, 'user', 'Large attachments');
    for (let index = 0; index < 3; index += 1) {
      const attachment = await service.import({ messageId: turn.id, index, filename: `${index}.txt`, mimeType: 'text/plain', data: new Uint8Array(Buffer.from(String(index).repeat(MAX_EXTRACTED_CHARACTERS + 200))) });
      const processed = await service.preprocess(attachment, new AbortController().signal);
      assert(processed.extractedText?.includes('[Attachment partially included]'), 'per-attachment cap marker is missing');
      assert((processed.extractedText?.length ?? 0) > MAX_EXTRACTED_CHARACTERS, 'per-attachment cap marker was not persisted');
    }
    const pipeline = new AttachmentPipeline(database, service);
    const history = database.listMessages(chat.id); const contextualized = pipeline.buildContext(history);
    const attachmentBlock = contextualized.find((item) => item.id === `attachments-${turn.id}`);
    assert(attachmentBlock && attachmentBlock.content.length <= MAX_ATTACHMENT_CONTEXT_CHARACTERS, 'total per-turn context cap exceeded');
    const attachmentIndex = contextualized.findIndex((item) => item.id === `attachments-${turn.id}`);
    assert(attachmentIndex >= 0 && contextualized[attachmentIndex + 1]?.id === turn.id, 'attachment context is not directly before its user turn');

    // Native vision binds the original image only to its owning user turn.
    const nativeTurn = database.addMessage(chat.id, 'user', 'Inspect Image 1 natively');
    const nativeImage = await service.import({ messageId: nativeTurn.id, index: 0, filename: 'native.png', mimeType: 'image/png', data: png });
    const nativePipeline = new AttachmentPipeline(database, service);
    await nativePipeline.preprocessCurrent([nativeImage.id], new AbortController().signal, () => undefined, true);
    const nativeStored = database.getAttachment(nativeImage.id)!;
    assert(nativeStored.status === 'ready' && !nativeStored.visionAnalysis, 'native vision did not preserve the original image');
    const nativeOnlyHistory = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([nativeTurn], false), new AbortController().signal);
    assert(nativeOnlyHistory.length === 1 && nativeOnlyHistory[0].images?.length === 1, 'native image was not attached to its user turn');
    assert(!nativeOnlyHistory.some((entry) => entry.role === 'system' && entry.content.includes('Image 1')), 'native image was duplicated into attachment text context');

    // Agent transport must preserve the same turn-bound native image input while
    // retaining its independent project-tool registry.
    const agentRequests: ToolMessage[][] = [];
    const captureBackend = { chatWithTools: async (_model: string, messages: ToolMessage[]) => {
      agentRequests.push(messages);
      return { role: 'assistant' as const, content: 'Native vision is available.', prompt_eval_count: 1, finish_reason: 'stop' as const };
    } };
    const agent = new ProjectChatService(captureBackend, new WebBrowserService());
    for await (const event of agent.stream('qwen3.8:27b-q4_K_M', nativeOnlyHistory, process.cwd(), new AbortController().signal, 16_384, 'fast', 'off', async () => ({ approved: false, reason: 'cancelled' }))) { void event; }
    assert(agentRequests[0]?.some((entry) => entry.role === 'user' && entry.images?.length === 1), 'Agent mode dropped the native image input');

    const mixedNative = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([turn, nativeTurn], false), new AbortController().signal);
    const mixedDocumentBlock = mixedNative.find((entry) => entry.id === `attachments-${turn.id}`);
    assert(mixedDocumentBlock?.content.includes('Attachment: 0.txt'), 'documents were lost when native vision is active');
    assert(!mixedDocumentBlock?.content.includes('Image 1'), 'image descriptions leaked into native mixed attachment context');

    // A text-only model is a controlled unsupported state; there is no hidden
    // second model or unload/reload routing any more.
    const unsupportedTurn = database.addMessage(chat.id, 'user', 'Unsupported image');
    const unsupportedImage = await service.import({ messageId: unsupportedTurn.id, index: 0, filename: 'unsupported.png', mimeType: 'image/png', data: png });
    await new AttachmentPipeline(database, service).preprocessCurrent([unsupportedImage.id], new AbortController().signal, () => undefined, false);
    const unsupportedStored = database.getAttachment(unsupportedImage.id)!;
    assert(unsupportedStored.status === 'error' && unsupportedStored.error?.includes('не поддерживает'), 'unsupported image did not produce a controlled error');
    console.log('attachment-pipeline regression: ok');
  } finally { await service.removeManagedFiles(database.deleteConversation(chat.id)); }
}

if (require.main === module) void runAttachmentPipelineRegression().catch((error) => { console.error(error); process.exitCode = 1; });
