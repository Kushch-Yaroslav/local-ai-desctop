import type { LlamaRuntimeState, LlamaSwitchResult } from './llama-runtime-controller';
export type VisionDevice = 'cpu' | 'gpu';
type Dependencies = {
  busy(): boolean;
  state(): Promise<LlamaRuntimeState>;
  save(device: VisionDevice): void;
  supportsProjector(state: LlamaRuntimeState): boolean;
  restart(state: LlamaRuntimeState, device: VisionDevice): Promise<LlamaSwitchResult>;
  changed(): void;
};
/** One pending preference, coalesced and serialized with other runtime selections. */
export class VisionDeviceController {
  pending?: VisionDevice;
  error?: string;
  private applying = false;
  constructor(private readonly deps: Dependencies) {}
  async select(device: VisionDevice): Promise<void> {
    this.deps.save(device);
    this.pending = device;
    this.error = undefined;
    this.deps.changed();
    await this.flush();
  }
  async flush(): Promise<void> {
    if (this.applying || this.deps.busy() || !this.pending) return;
    this.applying = true;
    try {
      while (this.pending && !this.deps.busy()) {
        const device = this.pending;
        const state = await this.deps.state();
        // Recheck after asynchronous state lookup; generation may have started.
        if (this.deps.busy()) break;
        this.pending = undefined;
        if (state.status !== 'ready' || !this.deps.supportsProjector(state) || state.projectorDevice === device) continue;
        const result = await this.deps.restart(state, device);
        if (!result.ok) {
          this.error = result.error;
          if (device === 'gpu' && !this.pending) {
            // A single explicit fallback. Never retry GPU automatically.
            this.deps.save('cpu');
            const fallback = await this.deps.restart(state, 'cpu');
            this.error = fallback.ok ? `GPU → CPU: ${result.error}` : `${result.error}; CPU: ${fallback.error}`;
          }
        }
      }
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.applying = false; this.deps.changed(); }
  }
}
