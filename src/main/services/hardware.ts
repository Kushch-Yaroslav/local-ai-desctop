import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { HardwareStats } from '../../shared/types';
import { createVramBudget } from '../../shared/vram-budget';

const execFileAsync = promisify(execFile);

export async function getOwnedServerVramBudget(pid: number) {
  const hardware = await getHardwareStats();
  if (!hardware.available || hardware.vramTotalBytes === null || hardware.vramUsedBytes === null || hardware.vramAvailableBytes === null) throw new Error('GPU telemetry unavailable.');
  const { stdout } = await execFileAsync('nvidia-smi', ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits'], { timeout: 2000 });
  const rows = stdout.trim().split(/\r?\n/).map((row) => row.split(',').map((field) => field.trim()));
  const owned = rows.filter(([processId]) => Number(processId) === pid);
  if (owned.length !== 1 || !/^\d+$/.test(owned[0][1] ?? '')) throw new Error('Owned llama-server GPU process accounting unavailable.');
  return createVramBudget(hardware.vramTotalBytes, hardware.vramUsedBytes, hardware.vramAvailableBytes, Number(owned[0][1]) * 1024 ** 2);
}
export function parseNvidiaMemorySnapshot(text: string) {
  const rows = text.trim().split(/\r?\n/);
  // The estimator needs per-device accounting before it can support multiple GPUs.
  if (rows.length !== 1) return null;
  const fields = rows[0].split(',').map((item) => item.trim());
  if (fields.some((field) => !field)) return null;
  const values = fields.map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const [used, total, free, utilization] = values;
  if (total <= 0 || used + free > total || utilization > 100) return null;
  return { vramUsedBytes: used * 1024 ** 2, vramTotalBytes: total * 1024 ** 2,
    vramAvailableBytes: free * 1024 ** 2, gpuUtilization: utilization };
}

export async function getHardwareStats(): Promise<HardwareStats> {
  const memory = await readFile('/proc/meminfo', 'utf8');
  const fields = Object.fromEntries([...memory.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(([, key, value]) => [key, Number(value) * 1024]));
  const ramTotalBytes = fields.MemTotal ?? 0;
  const ramUsedBytes = ramTotalBytes - (fields.MemAvailable ?? 0);
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.used,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 1_000 });
    const gpu = parseNvidiaMemorySnapshot(stdout);
    if (gpu) return { ramUsedBytes, ramTotalBytes, ...gpu, available: true };
  } catch { /* Unavailable GPU telemetry is surfaced as unavailable evidence. */ }
  return { ramUsedBytes, ramTotalBytes, vramUsedBytes: null, vramTotalBytes: null, vramAvailableBytes: null, gpuUtilization: null, available: false };
}
