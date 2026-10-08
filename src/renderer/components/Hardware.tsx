import { useLocale } from '../use-locale';
import { t } from '../../shared/locale';
import type { HardwareStats } from '../../shared/types';
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
export function Hardware({ value }: { value: HardwareStats | null }) {
  useLocale();
  if (!value) return <div className="hardware">{t("Мониторинг…")}</div>;
  return <div className="hardware"><span>RAM {gb(value.ramUsedBytes)} / {gb(value.ramTotalBytes)} GB</span>{value.available ? <><span>VRAM {gb(value.vramUsedBytes ?? 0)} / {gb(value.vramTotalBytes ?? 0)} GB</span><span>GPU {value.gpuUtilization}%</span></> : <span title={t("nvidia-smi недоступен")}>{t("GPU недоступен")}</span>}</div>;
}
