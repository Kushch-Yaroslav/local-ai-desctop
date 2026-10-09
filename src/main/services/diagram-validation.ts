import { randomUUID } from 'node:crypto';

type Sender = { id: number; send(channel: string, request: { id: string; source: string }): void; isDestroyed(): boolean };
/** The existing renderer's Mermaid parser owns syntax checking; replies are bound to that renderer. */
export class DiagramValidationBridge {
  private readonly pending = new Map<string, { senderId: number; finish: (error?: string) => void }>();
  constructor(private readonly timeoutMs = 15_000) {}
  validate(sender: Sender, source: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || sender.isDestroyed()) return Promise.reject(new Error('Diagram validation cancelled.'));
    if (source.length > 16_000) return Promise.reject(new Error('mermaid exceeds the 16,000 character limit.'));
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const finish = (error?: string) => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(id); if (error) reject(new Error(error)); else resolve(); };
      const timer = setTimeout(() => finish('Mermaid syntax validation timed out. Try a smaller diagram.'), this.timeoutMs);
      const abort = () => finish('Diagram validation cancelled.');
      this.pending.set(id, { senderId: sender.id, finish }); signal.addEventListener('abort', abort, { once: true });
      try { sender.send('chat:validate-diagram', { id, source }); } catch { finish('Diagram validation renderer is unavailable.'); }
    });
  }
  reply(senderId: number, id: unknown, error: unknown): void {
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id); if (!pending || pending.senderId !== senderId) return;
    if (error !== undefined && typeof error !== 'string') return;
    pending.finish(typeof error === 'string' ? `Invalid mermaid syntax: ${error.slice(0, 700)}. Correct mermaid and retry; do not substitute a generic diagram.` : undefined);
  }
}
