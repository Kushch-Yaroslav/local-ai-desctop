import type { ChildProcess } from 'node:child_process';

/**
 * Terminal commands run in their own session and process group (`spawn(..., { detached: true })`).
 * This is the only place that signals such a group. It accepts a live ChildProcess handle,
 * never a bare PID, so identifiers from persisted state or another process can't become a target,
 * and it refuses 0, 1, negative, non-integer and our own/parent identifiers: `kill(-pid)` with those
 * would address init, every process of the user, or the application itself.
 */
export function ownedGroupId(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>): number | null {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) return null;
  if (pid === process.pid || pid === process.ppid) return null;
  // An exited leader's PID may already belong to another process.
  if (child.exitCode !== null || child.signalCode !== null) return null;
  return pid;
}

export function signalOwnedGroup(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  const pid = ownedGroupId(child);
  if (pid === null) return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}
