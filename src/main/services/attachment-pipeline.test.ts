import { Database } from './database';
import { AttachmentService, MAX_EXTRACTED_CHARACTERS, MAX_IMAGES_PER_MESSAGE, attachmentDisplayName } from './attachment-service';
import { AttachmentPipeline, MAX_ATTACHMENT_CONTEXT_CHARACTERS } from './attachment-pipeline';
import type { OllamaBackend } from '../backends/ollama-backend';
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
    const fakeOllama = { findInstalledVisionModel: async () => null, isModelLoaded: async () => false, unloadModel: async () => undefined } as unknown as OllamaBackend;
    const pipeline = new AttachmentPipeline(database, service, fakeOllama);
    const history = database.listMessages(chat.id); const contextualized = pipeline.buildContext(history);
    const attachmentBlock = contextualized.find((item) => item.id === `attachments-${turn.id}`);
    assert(attachmentBlock && attachmentBlock.content.length <= MAX_ATTACHMENT_CONTEXT_CHARACTERS, 'total per-turn context cap exceeded');
    const attachmentIndex = contextualized.findIndex((item) => item.id === `attachments-${turn.id}`);
    assert(attachmentIndex >= 0 && contextualized[attachmentIndex + 1]?.id === turn.id, 'attachment context is not directly before its user turn');

    // A model that advertises vision must never invoke the MiniCPM fallback or
    // receive the same image again as a textual system block.
    const nativeTurn = database.addMessage(chat.id, 'user', 'Inspect Image 1 natively');
    const nativeImage = await service.import({ messageId: nativeTurn.id, index: 0, filename: 'native.png', mimeType: 'image/png', data: png });
    let fallbackCalls = 0;
    const nativeOllama = {
      findInstalledVisionModel: async () => { fallbackCalls += 1; return 'configured-minicpm-v-4.5'; },
      isModelLoaded: async () => false,
      unloadModel: async () => undefined,
      analyzeImageWithVision: async () => { fallbackCalls += 1; return 'must not be called'; },
    } as unknown as OllamaBackend;
    const nativePipeline = new AttachmentPipeline(database, service, nativeOllama);
    await nativePipeline.preprocessCurrent([nativeImage.id], new AbortController().signal, () => undefined, 'qwen3.8:27b-q4_K_M', true);
    const nativeStored = database.getAttachment(nativeImage.id)!;
    assert(nativeStored.status === 'ready' && !nativeStored.visionAnalysis && fallbackCalls === 0, 'native vision incorrectly invoked MiniCPM');
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

    // Text-only routing retains the MiniCPM textual fallback.
    const fallbackTurn = database.addMessage(chat.id, 'user', 'Use fallback');
    const fallbackImage = await service.import({ messageId: fallbackTurn.id, index: 0, filename: 'fallback.png', mimeType: 'image/png', data: png });
    let analyses = 0;
    const fallbackOllama = {
      findInstalledVisionModel: async () => 'configured-minicpm-v-4.5', isModelLoaded: async () => false, unloadModel: async () => undefined,
      analyzeImageWithVision: async () => { analyses += 1; return 'Summary: fallback result'; },
    } as unknown as OllamaBackend;
    await new AttachmentPipeline(database, service, fallbackOllama).preprocessCurrent([fallbackImage.id], new AbortController().signal, () => undefined, 'glm-4.7-flash:q4_K_M', false);
    assert(analyses === 1 && database.getAttachment(fallbackImage.id)?.visionAnalysis === 'Summary: fallback result', 'text-only model did not use MiniCPM fallback');

    const cancelledMessage = database.addMessage(chat.id, 'user', 'Stop vision'); const cancelled = await service.import({ messageId: cancelledMessage.id, index: 0, filename: 'cancel.png', mimeType: 'image/png', data: png });
    let resolveVision!: (value: string) => void;
    const lateVision = new Promise<string>((resolve) => { resolveVision = resolve; });
    const calls: string[] = [];
    const visionOllama = {
      findInstalledVisionModel: async () => 'configured-minicpm-v-4.5', isModelLoaded: async (model: string) => model === 'qwen3.8:27b-q4_K_M' && !calls.includes('unload:qwen3.8:27b-q4_K_M'),
      unloadModel: async (model: string) => { calls.push(`unload:${model}`); }, analyzeImageWithVision: async () => lateVision,
    } as unknown as OllamaBackend;
    const cancelPipeline = new AttachmentPipeline(database, service, visionOllama); const controller = new AbortController();
    const pending = cancelPipeline.preprocessCurrent([cancelled.id], controller.signal, () => undefined, 'qwen3.8:27b-q4_K_M'); controller.abort(); resolveVision('late vision result must never persist'); await pending;
    const cancelledStored = database.getAttachment(cancelled.id)!;
    assert(cancelledStored.status === 'cancelled' && !cancelledStored.visionAnalysis, 'stale vision result was persisted after Stop');
    assert(calls[0] === 'unload:qwen3.8:27b-q4_K_M' && calls.includes('unload:configured-minicpm-v-4.5'), 'main → vision VRAM lifecycle did not unload both models');
    console.log('attachment-pipeline regression: ok');
  } finally { await service.removeManagedFiles(database.deleteConversation(chat.id)); }
}

if (require.main === module) void runAttachmentPipelineRegression().catch((error) => { console.error(error); process.exitCode = 1; });
