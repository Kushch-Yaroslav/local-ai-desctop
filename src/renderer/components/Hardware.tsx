import type { HardwareStats } from '../../shared/types';
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
export function Hardware({ value }: { value: HardwareStats | null }) {
  if (!value) return <div className="hardware">Мониторинг…</div>;
  return <div className="hardware"><span>RAM {gb(value.ramUsedBytes)} / {gb(value.ramTotalBytes)} GB</span>{value.available ? <><span>VRAM {gb(value.vramUsedBytes ?? 0)} / {gb(value.vramTotalBytes ?? 0)} GB</span><span>GPU {value.gpuUtilization}%</span></> : <span title="nvidia-smi недоступен">GPU недоступен</span>}</div>;
}
