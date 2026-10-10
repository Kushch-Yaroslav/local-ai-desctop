// Mermaid has global parser/theme configuration. Preserve serialization across validation and legacy rendering.
let queue = Promise.resolve();
export function queueMermaidTask(task: () => Promise<void>): Promise<void> {
  const result = queue.then(task); queue = result.catch(() => undefined); return result;
}
export async function validateMermaidSource(source: string): Promise<void> {
  if (source.length > 16_000) throw new Error('Diagram exceeds the size limit.');
  await queueMermaidTask(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true });
    await mermaid.parse(source);
  });
}
