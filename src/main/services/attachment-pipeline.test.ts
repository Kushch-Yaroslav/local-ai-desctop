import assert from 'node:assert/strict';
import { Database } from './database';
import { AttachmentService, MAX_EXTRACTED_CHARACTERS, MAX_IMAGES_PER_MESSAGE, attachmentDataTool, attachmentDisplayName } from './attachment-service';
import { AttachmentPipeline, MAX_ATTACHMENT_CONTEXT_CHARACTERS } from './attachment-pipeline';
import type { ProjectReference } from '../../shared/types';
import { projectDirectoryName, removeProjectReferenceQuery } from '../../shared/project-references';
import { existingProjectDirectory } from './project-picker';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Focused persistence/pipeline regression coverage; run with `npm run test:attachments`. */
export async function runAttachmentPipelineRegression(): Promise<void> {
  assert(projectDirectoryName('/media/yaroslav/DATA/Projects/local-ai-desktop/') === 'local-ai-desktop', 'project selector basename did not trim a POSIX root');
  assert(projectDirectoryName('C:\\Projects\\platform_collectnpay') === 'platform_collectnpay', 'project selector basename did not support a Windows root');
  assert(await existingProjectDirectory('/tmp') === '/tmp' && await existingProjectDirectory('/this/project/does/not/exist') === undefined, 'folder picker default directory did not preserve valid selections or fall back for stale roots');
  const firstSelection = removeProjectReferenceQuery('Please inspect @git after this', 15, 19);
  assert(firstSelection.value === 'Please inspect  after this' && firstSelection.cursor === 15, 'reference selection did not remove only its autocomplete query');
  const secondSelection = removeProjectReferenceQuery(`${firstSelection.value} and @Input`, 31, 37);
  assert(secondSelection.value.includes('Please inspect  after this') && !secondSelection.value.includes('@Input'), 'sequential reference selection did not preserve surrounding text');
  const database = new Database(); const chat = database.createConversation('qwen3.8:27b-q4_K_M'); const message = database.addMessage(chat.id, 'user', 'Inspect attachments'); const service = new AttachmentService(database);
  try {
    const formats = [
      ['a.png', 'image/png', png],
      ['b.JPG', 'image/jpeg', new Uint8Array([255, 216, 255, 224, 12])],
      ['c.jpeg', 'image/jpeg', new Uint8Array([255, 216, 255, 225, 13])],
      ['d.webp', 'image/webp', new Uint8Array(Buffer.from('RIFF0000WEBPbytes'))],
    ] as const;
    const formatTurn = database.addMessage(chat.id, 'user', 'Inspect these images');
    for (const [filename, mimeType, data] of formats) {
      const imported = await service.import({ messageId: formatTurn.id, index: 0, filename, mimeType: 'image/png', data });
      assert(imported.mimeType === mimeType, 'original format MIME was lost');
    }
    const csvTurn = database.addMessage(chat.id, 'user', 'Analyze all rows');
    const csvRows = ['period,revenue,note', ...Array.from({ length: 2_000 }, (_, index) => `${index},${index * 10},"quarter ${index}, actual"`)].join('\n');
    const csv = await service.import({ messageId: csvTurn.id, index: 0, filename: 'sales.csv', mimeType: 'text/csv', data: new Uint8Array(Buffer.from(csvRows)) });
    const extractedCsv = await service.preprocess(csv, new AbortController().signal);
    assert(extractedCsv.metadata?.truncated === true, 'large CSV fixture should exceed the ordinary text preview');
    const dataTool = attachmentDataTool([extractedCsv]) as { function: { parameters: { properties: { attachment_id: { enum: string[] } } } } };
    assert.deepEqual(dataTool.function.parameters.properties.attachment_id.enum, [csv.id], 'bounded data tool exposed unrelated attachment IDs');
    const structuredPage = await service.readStructuredRows(csv.id, undefined, 1_000, 2) as { columns: Array<{ key: string }>; rows: Array<Record<string, unknown>>; next_start_row: number | null; total_rows: number };
    assert.equal(structuredPage.total_rows, 2_000, 'structured CSV extraction lost the full row count');
    assert.equal(structuredPage.rows.length, 2, 'structured CSV extraction did not return the requested bounded page');
    assert.equal(structuredPage.rows[0]?.c1, 1_000, 'CSV numeric values lost their numeric type or offset');
    assert.equal(structuredPage.rows[0]?.c2, 10_000, 'CSV values beyond the text preview were unavailable');
    assert.equal(structuredPage.rows[0]?.c3, 'quarter 1000, actual', 'quoted CSV delimiters were parsed incorrectly');
    assert.equal(structuredPage.next_start_row, 1_002, 'structured CSV pagination metadata is incorrect');
    await service.readStructuredRows('another-conversation-attachment').then(() => { throw new Error('arbitrary attachment ID was accepted'); }, (error: Error) => assert(error.message.includes('supported structured table'), 'unknown attachment ID returned an unclear error'));
    const formatPipeline = new AttachmentPipeline(database, service);
    const restored = database.listMessages(chat.id).find((entry) => entry.id === formatTurn.id)!;
    const nativeFormats = await formatPipeline.prepareNativeImages([restored], new AbortController().signal);
    assert(nativeFormats[0].images?.length === 4, 'multiple images missing after history restore');
    for (let index = 0; index < formats.length; index++) {
      const [, mime, data] = formats[index];
      assert(nativeFormats[0].images![index] === `data:${mime};base64,${Buffer.from(data).toString('base64')}`, 'MIME or original image bytes changed');
    }
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
    const repeatedNativeActivities: string[] = [];
    await nativePipeline.preprocessCurrent([nativeImage.id], new AbortController().signal, (event) => { if (event.type === 'attachment') repeatedNativeActivities.push(event.activity.detail ?? ''); }, true);
    assert(repeatedNativeActivities.length === 0, 'a ready native image was shown as passed to the model again on a later turn');
    const nativeOnlyHistory = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([nativeTurn], false), new AbortController().signal);
    assert(nativeOnlyHistory.length === 1 && nativeOnlyHistory[0].images?.length === 1, 'native image was not attached to its user turn');
    assert(!nativeOnlyHistory.some((entry) => entry.role === 'system' && entry.content.includes('Image 1')), 'native image was duplicated into attachment text context');

    const mixedNative = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([turn, nativeTurn], false), new AbortController().signal);
    const mixedDocumentBlock = mixedNative.find((entry) => entry.id === `attachments-${turn.id}`);
    assert(mixedDocumentBlock?.content.includes('Attachment: 0.txt'), 'documents were lost when native vision is active');
    assert(!mixedDocumentBlock?.content.includes('Image 1'), 'image descriptions leaked into native mixed attachment context');

    const nativeAssistant = database.addMessage(chat.id, 'assistant', 'Image described.');
    const unrelatedFollowUp = database.addMessage(chat.id, 'user', 'Спасибо, теперь объясни следующий шаг.');
    const unrelatedHistory = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([nativeTurn, nativeAssistant, unrelatedFollowUp], false), new AbortController().signal);
    assert(!unrelatedHistory.some((entry) => entry.id === nativeTurn.id && entry.images?.length), 'an old image was re-encoded for an unrelated later turn');
    const visualFollowUp = database.addMessage(chat.id, 'user', 'А что находится справа на той картинке?');
    const visualHistory = await nativePipeline.prepareNativeImages(nativePipeline.buildContext([nativeTurn, nativeAssistant, unrelatedFollowUp, visualFollowUp], false), new AbortController().signal);
    assert(visualHistory.some((entry) => entry.id === nativeTurn.id && entry.images?.length === 1), 'an explicit follow-up about an old image lost its native visual context');

    const regenerateUser = database.addMessage(chat.id, 'user', 'Regenerate this image answer');
    const regenerateImage = await service.import({ messageId: regenerateUser.id, index: 0, filename: 'regenerate.png', mimeType: 'image/png', data: png });
    const originalTimestamp = regenerateUser.createdAt;
    const oldAssistant = database.addMessage(chat.id, 'assistant', 'Old answer');
    const downstreamUser = database.addMessage(chat.id, 'user', 'Discard this branch');
    const downstreamAttachment = await service.import({ messageId: downstreamUser.id, index: 0, filename: 'downstream.txt', mimeType: 'text/plain', data: new Uint8Array(Buffer.from('discard')) });
    const retained = database.regenerateUserMessageAndTruncate(regenerateUser.id);
    assert(retained.filter((item) => item.id === regenerateUser.id).length === 1, 'regeneration duplicated the existing user message');
    const preservedUser = retained.find((item) => item.id === regenerateUser.id);
    assert(preservedUser?.content === 'Regenerate this image answer' && preservedUser.createdAt === originalTimestamp && preservedUser.attachments?.[0]?.id === regenerateImage.id, 'regeneration did not preserve the source user message and attachment');
    assert(!retained.some((item) => item.id === oldAssistant.id || item.id === downstreamUser.id) && database.getAttachment(downstreamAttachment.id) === null, 'regeneration did not prune the downstream branch');
    const afterInterruptedResponse = database.regenerateUserMessageAndTruncate(regenerateUser.id);
    assert(afterInterruptedResponse.filter((item) => item.id === regenerateUser.id).length === 1, 'regeneration after an interrupted response changed the preserved user turn');

    const oneProject = database.updateConversation(chat.id, { workingDirectory: '/project-one' });
    assert(oneProject.primaryProjectId && !oneProject.secondaryWorkingDirectory, 'single-project conversation compatibility was not preserved');
    const twoProjects = database.updateConversation(chat.id, { secondaryWorkingDirectory: '/project-two' });
    assert(twoProjects.primaryProjectId && twoProjects.secondaryProjectId, 'optional Project 2 was not persisted');
    const references: ProjectReference[] = [
      { id: 'project-two-file', projectId: twoProjects.secondaryProjectId!, projectSlot: 2, projectPath: '/project-two', projectLabel: 'Project 2', relativePath: 'src/components/Input.tsx', kind: 'file' },
      { id: 'project-one-folder', projectId: twoProjects.primaryProjectId!, projectSlot: 1, projectPath: '/project-one', projectLabel: 'Project 1', relativePath: 'src/components', kind: 'folder' },
    ];
    const referencedTurn = database.addMessage(chat.id, 'user', 'Use these resources.', undefined, references);
    const changedSecondProject = database.updateConversation(chat.id, { secondaryWorkingDirectory: '/project-three' });
    const storedReferences = database.getMessage(referencedTurn.id)?.projectReferences;
    assert(storedReferences?.[0]?.projectId === twoProjects.secondaryProjectId && storedReferences[0].projectPath === '/project-two' && changedSecondProject.secondaryProjectId !== twoProjects.secondaryProjectId, 'changing Project 2 reinterpreted a persisted reference');
    const editedReferences = database.editUserMessageAndTruncate(referencedTurn.id, 'Use these resources after editing.').find((message) => message.id === referencedTurn.id)?.projectReferences;
    assert(editedReferences?.length === 2 && editedReferences[1].kind === 'folder', 'editing a message discarded its structured references');
    const regeneratedReferences = database.regenerateUserMessageAndTruncate(referencedTurn.id).find((message) => message.id === referencedTurn.id)?.projectReferences;
    assert(regeneratedReferences?.[0]?.projectId === twoProjects.secondaryProjectId, 'regeneration changed a stored reference identity');

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
