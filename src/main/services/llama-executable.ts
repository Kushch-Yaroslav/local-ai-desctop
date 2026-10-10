import { execFile } from 'node:child_process';
import { access, realpath, stat, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { ExecutableResolution, ExecutableValidation } from '../../shared/types';
import { expandPath } from './paths';

/** A bounded --help probe checks server options without loading a model.
 * This executes user-selected local software, not a security/authenticity check. */
export async function validateLlamaExecutable(value: string, signal?: AbortSignal): Promise<ExecutableValidation> {
  if (!value.trim()) return { status: 'not-configured' };
  let candidates: string[];
  try {
    if (/[\0\r\n]/.test(value)) return { status: 'unsupported' };
    const input = value.trim();
    candidates = input.includes('/') || input.startsWith('~') ? [expandPath(input)]
      : (process.env.PATH ?? '').split(':').filter(Boolean).map((directory) => join(directory, input));
  } catch { return { status: 'unsupported' }; }
  let path: string | undefined;
  let nonExecutable = false;
  for (const candidate of candidates) {
    if (signal?.aborted) return { status: 'failed' };
    try {
      if (!(await stat(candidate)).isFile()) { nonExecutable = true; continue; }
      try { await access(candidate, constants.X_OK); } catch { nonExecutable = true; continue; }
      path = await realpath(candidate); break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { status: 'failed' };
    }
  }
  if (!path) return { status: nonExecutable ? 'not-executable' : 'missing' };
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(path!, ['--help'], { timeout: 2_000, maxBuffer: 256 * 1024, signal, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
        if (error) reject(error); else resolve(stdout + stderr);
      });
    });
    return { status: ['--model', '--ctx-size', '--port'].every((option) => output.includes(option)) ? 'valid' : 'unsupported', path };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return { status: failure.killed || failure.name === 'AbortError' ? 'failed' : 'unsupported', path };
  }
}

/** Search only the supplied root. Symlink directories are deliberately not followed. */
export async function resolveLlamaExecutable(input: string, selected?: string, options: { signal?: AbortSignal; timeoutMs?: number; maxDepth?: number; maxEntries?: number; maxCandidates?: number } = {}): Promise<ExecutableResolution> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; cancel(); }, options.timeoutMs ?? 10_000);
  const candidates = new Set<string>(); const reasons = new Set<string>();
  let kind: 'file' | 'directory' | undefined;
  let selectedMissing = false;
  // Network-mounted filesystem calls are not all interruptible. Release the
  // IPC/UI at the deadline, while ensuring the outstanding operation is handled.
  const bounded = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(new Error('resolution cancelled'));
    controller.signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    if (controller.signal.aborted) abort();
  });
  const result = (status: ExecutableResolution['status'], path?: string): ExecutableResolution => ({ status, ...(path ? { path } : {}), candidates: [...candidates].sort(), kind, incomplete: reasons.size > 0, reasons: [...reasons], selectedMissing });
  try {
    if (!input.trim()) return result('not-configured');
    if (/[\0\r\n]/.test(input)) return result('unsupported');
    const value = input.trim();
    // Keep old PATH-command configurations compatible. New folders are explicit.
    if (!value.includes('/') && !value.startsWith('~')) {
      kind = 'file'; const validation = await bounded(validateLlamaExecutable(value, controller.signal));
      if (validation.status === 'valid' && validation.path) candidates.add(validation.path);
      return result(validation.status, validation.path);
    }
    const target = expandPath(value);
    let info;
    try { info = await bounded(stat(target)); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { reasons.add('permissions'); return result('failed'); }
      return result('missing');
    }
    if (!info.isDirectory()) {
      kind = 'file'; const validation = await bounded(validateLlamaExecutable(target, controller.signal));
      if (validation.status === 'valid' && validation.path) candidates.add(validation.path);
      return result(validation.status, validation.path);
    }
    kind = 'directory';
    const root = await bounded(realpath(target));
    const within = (path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
    if (selected) {
      let selectedPath: string | undefined;
      try { selectedPath = await bounded(realpath(expandPath(selected))); } catch { /* Recover through a new explicit selection. */ }
      if (selectedPath && within(selectedPath)) {
        const validation = await bounded(validateLlamaExecutable(selectedPath, controller.signal));
        if (validation.status === 'valid' && validation.path) { candidates.add(validation.path); return result('valid', validation.path); }
      }
      selectedMissing = true;
    }
    const maxDepth = options.maxDepth ?? 6, maxEntries = options.maxEntries ?? 10_000, maxCandidates = options.maxCandidates ?? 16;
    let entries = 0, examined = 0;
    const tested = new Set<string>();
    const probe = async (path: string) => {
      if (examined >= maxCandidates) { reasons.add('candidate-limit'); return; }
      let actual: string;
      try { actual = await bounded(realpath(path)); } catch { return; }
      if (!within(actual)) { reasons.add('symlinks'); return; }
      if (tested.has(actual)) return;
      tested.add(actual); examined += 1;
      const validation = await bounded(validateLlamaExecutable(actual, controller.signal));
      if (validation.status === 'valid' && validation.path) candidates.add(validation.path);
      if (validation.status === 'failed') reasons.add('validation');
    };
    // Prioritize common layouts before the general bounded breadth-first walk.
    for (const layout of ['', 'bin', 'build/bin', 'build-cuda/bin', 'build-vulkan/bin', 'llama.cpp/build/bin', 'llama.cpp/build-cuda/bin']) await probe(join(root, layout, 'llama-server'));
    const queue = [{ path: root, depth: 0 }];
    const priority = (name: string) => ['llama.cpp', 'bin', 'build-cuda', 'build', 'build-vulkan'].indexOf(name) < 0 ? 10 : ['llama.cpp', 'bin', 'build-cuda', 'build', 'build-vulkan'].indexOf(name);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (examined >= maxCandidates || entries >= maxEntries) { reasons.add('limit'); break; }
      const directory = queue[cursor];
      const children: Array<{ path: string; depth: number; name: string }> = [];
      try {
        const handle = await bounded(opendir(directory.path).then((opened) => {
          if (controller.signal.aborted) { void opened.close().catch(() => undefined); throw new Error('resolution cancelled'); }
          return opened;
        }));
        try {
          while (true) {
            const entry = await bounded(handle.read()); if (!entry) break;
            entries += 1;
            if (entry.isDirectory()) {
              if (directory.depth < maxDepth) children.push({ path: join(directory.path, entry.name), depth: directory.depth + 1, name: entry.name });
              else reasons.add('depth');
            } else if (entry.isSymbolicLink()) {
              if (entry.name === 'llama-server') await probe(join(directory.path, entry.name));
              else reasons.add('symlinks');
            } else if (entry.name === 'llama-server' && entry.isFile()) await probe(join(directory.path, entry.name));
            if (entries >= maxEntries || examined >= maxCandidates) { reasons.add('limit'); break; }
          }
        } finally { void handle.close().catch(() => undefined); }
      } catch (error) { if (controller.signal.aborted) throw error; reasons.add('permissions'); }
      children.sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
      queue.push(...children);
    }
    if (candidates.size > 1 || (selectedMissing || reasons.size > 0) && candidates.size) return result('multiple');
    if (candidates.size === 1) return result('valid', [...candidates][0]);
    return result(reasons.size ? 'incomplete' : 'not-found');
  } catch {
    if (controller.signal.aborted) { if (timeout) reasons.add('time'); return result(timeout ? candidates.size ? 'multiple' : 'incomplete' : 'cancelled'); }
    return result('failed');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
}
