import assert from 'node:assert/strict';
import { VisionDeviceController, type VisionDevice } from './vision-device-controller';
import type { LlamaRuntimeState } from './llama-runtime-controller';

async function run() {
  let busy = false, supported = true, failure = false, changes = 0;
  let saved: VisionDevice = 'cpu';
  let state: LlamaRuntimeState = { status: 'ready', modelId: 'fixture', contextWindow: 32768, kvCacheType: 'q8_0', kvOffload: true, projectorDevice: 'cpu' };
  const restarted: VisionDevice[] = [];
  const controller = new VisionDeviceController({
    busy: () => busy, state: async () => state,
    supportsProjector: () => supported, save: device => { saved = device; }, changed: () => { changes++; },
    restart: async (before, device) => {
      assert.equal(before.contextWindow, 32768); assert.equal(before.kvCacheType, 'q8_0'); assert.equal(before.kvOffload, true);
      restarted.push(device);
      if (failure && device === 'gpu') return { ok: false, state, error: 'fixture VRAM exhausted' };
      state = { ...state, projectorDevice: device }; return { ok: true, state };
    },
  });
  await controller.select('cpu'); assert.deepEqual(restarted, [], 'same effective placement does not restart');
  busy = true;
  await controller.select('gpu'); assert.equal(saved, 'gpu'); assert.equal(controller.pending, 'gpu');
  assert.deepEqual(restarted, [], 'active generation is never cancelled');
  await controller.flush(); assert.deepEqual(restarted, []);
  busy = false; await controller.flush(); assert.deepEqual(restarted, ['gpu']); assert.equal(controller.pending, undefined);
  supported = false;
  await controller.select('cpu'); assert.deepEqual(restarted, ['gpu'], 'text-only and incompatible MTP profiles do not restart');
  supported = true; await controller.select('cpu');
  failure = true; await controller.select('gpu');
  assert.deepEqual(restarted, ['gpu', 'cpu', 'gpu', 'cpu']);
  assert.equal(saved, 'cpu'); assert.equal(state.projectorDevice, 'cpu'); assert.match(controller.error!, /GPU → CPU.*VRAM/);
  await controller.flush(); assert.equal(restarted.length, 4, 'GPU fallback has no retry loop');
  assert(changes > 0);
  // A rapid menu selection is coalesced while blocked, rather than queuing obsolete restarts.
  busy = true; await controller.select('gpu'); await controller.select('cpu'); busy = false; await controller.flush();
  assert.equal(restarted.length, 4);
  // Also recheck generation state after an asynchronous process-state read.
  const racing = new VisionDeviceController({ busy: () => busy, state: async () => { busy = true; return state; }, save: () => {}, supportsProjector: () => true, restart: async () => { throw new Error('must not restart'); }, changed: () => {} });
  await racing.select('gpu'); assert.equal(racing.pending, 'gpu');
}
void run().then(() => console.log('Vision device restart/defer/fallback regressions passed'), error => { console.error(error); process.exitCode = 1; });
