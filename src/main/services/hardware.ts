import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { HardwareStats } from '../../shared/types';

const execFileAsync = promisify(execFile);

export async function getHardwareStats(): Promise<HardwareStats> {
  const memory = await readFile('/proc/meminfo', 'utf8');
  const fields = Object.fromEntries([...memory.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(([, key, value]) => [key, Number(value) * 1024]));
  const ramTotalBytes = fields.MemTotal ?? 0;
  const ramUsedBytes = ramTotalBytes - (fields.MemAvailable ?? 0);
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 1_000 });
    const [used, total, utilization] = stdout.trim().split(',').map((item) => Number(item.trim()));
    return { ramUsedBytes, ramTotalBytes, vramUsedBytes: used * 1024 * 1024, vramTotalBytes: total * 1024 * 1024, gpuUtilization: utilization, available: true };
  } catch { return { ramUsedBytes, ramTotalBytes, vramUsedBytes: null, vramTotalBytes: null, gpuUtilization: null, available: false }; }
}
