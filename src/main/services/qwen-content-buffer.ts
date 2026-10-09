type ParseProtocol = (source: string) => { calls: Array<{ name: string }>; visibleContent: string };

/** Hold only ambiguous protocol/code spans across chunks. Never execute streaming fragments. */
export class QwenContentBuffer {
  private pending = '';
  constructor(private readonly parse: ParseProtocol, private readonly diagrams: ReadonlySet<string> = new Set()) {}
  push(content: string): string { this.pending += content; return this.drain(false); }
  finish(): string { return this.drain(true); }

  private drain(flush: boolean): string {
    let visible = '';
    while (this.pending) {
      const first = this.pending[0];
      // Code spans and fenced blocks are literal. Hold their opening until the
      // closing delimiter is known, including delimiters split over chunks.
      if (first === '`' || first === '~' && this.pending.startsWith('~~~')) {
        const delimiter = this.pending.match(first === '`' ? /^`+/ : /^~+/)![0];
        if (!flush && delimiter.length === this.pending.length) break;
        const end = this.pending.indexOf(delimiter, delimiter.length);
        if (end < 0) { if (!flush) break; visible += this.pending; this.pending = ''; break; }
        const block = this.pending.slice(0, end + delimiter.length);
        const source = delimiter.length >= 3 ? block.slice(delimiter.length, -delimiter.length).match(/^mermaid\s*\n([\s\S]*)$/i)?.[1]?.trim() : undefined;
        if (!source || !this.diagrams.has(source)) visible += block;
        this.pending = this.pending.slice(block.length); continue;
      }
      const lower = this.pending.toLowerCase();
      if (first === '<') {
        const possible = ['<tool_call>', '<function='];
        if (!flush && possible.some((open) => open.startsWith(lower))) break;
        const close = lower.startsWith('<tool_call>') ? '</tool_call>' : lower.startsWith('<function=') ? '</function>' : undefined;
        if (close) {
          const end = lower.indexOf(close);
          if (end < 0) {
            if (!flush) break;
            // A truncated known protocol attempt is not assistant prose.
            const completed = `${this.pending}${close}`;
            if (!this.parse(completed).calls.length) visible += this.pending;
            this.pending = ''; break;
          }
          const block = this.pending.slice(0, end + close.length);
          const parsed = this.parse(block); visible += parsed.calls.length ? parsed.visibleContent : block;
          this.pending = this.pending.slice(block.length); continue;
        }
      }
      visible += first; this.pending = this.pending.slice(1);
    }
    return visible;
  }
}
