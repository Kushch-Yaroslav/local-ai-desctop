import { readFileSync } from 'node:fs';
import { defaultContextHostReserveBytes, resolveContextReserve } from './context-estimate';

/** CPU-resident weights must fit before allocation, with the same host reserve used by discovery. */
export function validateHostMemory(availableBytes: number | null, residentBudgetBytes: number, reserveBytes: number): void {
  if (!Number.isSafeInteger(residentBudgetBytes) || residentBudgetBytes <= 0 || !Number.isSafeInteger(reserveBytes) || reserveBytes < defaultContextHostReserveBytes) throw new Error('Некорректный бюджет системной памяти runtime.');
  if (availableBytes === null || !Number.isFinite(availableBytes) || availableBytes < 0) throw new Error('Не удалось проверить доступную системную память перед загрузкой модели.');
  const required = residentBudgetBytes + reserveBytes;
  if (availableBytes < required) throw new Error(`Недостаточно системной памяти для CPU offload: доступно ${(availableBytes / 1024 ** 3).toFixed(1)} GiB, требуется ${(required / 1024 ** 3).toFixed(1)} GiB с резервом ${(reserveBytes / 1024 ** 3).toFixed(1)} GiB.`);
}

export function verifyHostMemory(residentBudgetBytes: number): void {
  const reserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  if (reserve.bytes === null) throw new Error(reserve.error);
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  validateHostMemory(available ? Number(available[1]) * 1024 : null, residentBudgetBytes, reserve.bytes);
}
