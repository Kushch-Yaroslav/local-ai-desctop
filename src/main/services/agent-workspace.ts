import { realpath, stat } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';

/**
 * Directories the user named explicitly, as absolute paths in their own messages.
 * They extend what file tools may touch and give the terminal a working directory when
 * no project is selected. Only text the user typed is considered: never model output,
 * tool results or file contents, so a document cannot grant itself access.
 */
const systemRoots = new Set(['bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'proc', 'root', 'run', 'sbin', 'snap', 'sys', 'usr', 'var', 'lost+found']);
const minimumDepth: Record<string, number> = { home: 3, media: 3, Users: 3 };
const sensitiveHomeDirectories = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker']);
export const maxWorkspaceRoots = 4;

const trailingPunctuation = /[.,;:!?)\]}»”’"'`…]+$/u;
const quotedPath = /(["'`«“])((?:\/|~\/)[^"'`»”\n]+)(?:["'`»”])/gu;
const barePath = /(?:^|[\s([{>])((?:\/|~\/)[^\s"'`«»“”<>]*)/gu;

export function extractAbsolutePaths(text: string): string[] {
  const found: Array<{ index: number; value: string }> = [];
  const quoted = new Set<number>();
  for (const match of text.matchAll(quotedPath)) {
    found.push({ index: match.index, value: match[2]!.trim() });
    for (let offset = 0; offset < match[0].length; offset += 1) quoted.add(match.index + offset);
  }
  for (const match of text.matchAll(barePath)) {
    const start = match.index + match[0].length - match[1]!.length;
    if (quoted.has(start)) continue;
    const value = match[1]!.replace(trailingPunctuation, '');
    if (value.length > 1) found.push({ index: start, value });
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.value);
}

export function isGrantablePath(path: string, home: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (!posix.isAbsolute(path) || parts.length < (minimumDepth[parts[0] ?? ''] ?? 2)) return false;
  if (systemRoots.has(parts[0] ?? '')) return false;
  const homeParts = home.split('/').filter(Boolean);
  if (parts.length <= homeParts.length && parts.every((part, index) => part === homeParts[index])) return false;
  const insideHome = homeParts.length > 0 && homeParts.every((part, index) => parts[index] === part);
  if (insideHome && sensitiveHomeDirectories.has(parts[homeParts.length] ?? '')) return false;
  return true;
}

async function existingKind(path: string): Promise<'directory' | 'file' | null> {
  try { const info = await stat(path); return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null; } catch { return null; }
}

/** An existing directory is granted itself; a file or a not-yet-created path grants the directory that holds it. */
async function grantFor(raw: string, home: string): Promise<string | null> {
  const expanded = raw.startsWith('~/') ? resolve(home, raw.slice(2)) : resolve(raw);
  if (!isGrantablePath(expanded, home)) return null;
  const kind = await existingKind(expanded);
  const directory = kind === 'directory' ? expanded : dirname(expanded);
  if (kind !== 'directory' && (await existingKind(directory)) !== 'directory') return null;
  let real: string;
  try { real = await realpath(directory); } catch { return null; }
  return isGrantablePath(real, home) ? real : null;
}

/** Most recent mention first: the first root is the terminal's working directory. */
export async function explicitWorkspaceRoots(userTexts: readonly string[], home: string): Promise<string[]> {
  const roots: string[] = [];
  for (const text of [...userTexts].reverse()) {
    for (const raw of extractAbsolutePaths(text).reverse()) {
      const grant = await grantFor(raw, home);
      if (grant && !roots.includes(grant)) roots.push(grant);
      if (roots.length >= maxWorkspaceRoots) return roots;
    }
  }
  return roots;
}

const executionTools = ['apply_patch', 'create_file', 'delete_file', 'list_directory', 'read_file', 'run_terminal', 'write_file'];
const knowledgeTools = ['project_knowledge_index', 'project_knowledge_read', 'project_knowledge_update'];
const alwaysAvailableAgentTools = ['observation_index', 'observation_read', 'task_memory'];

/**
 * Tools a generation exposes, by mode and scope. Chat never receives Agent-only capabilities.
 * Agent receives file/terminal tools whenever it has a scope: a selected project, or directories the
 * user named explicitly. It never receives them without one. Reasoning mode plays no part.
 * Mirrors the Rust runtime's `ToolScope`, which is authoritative.
 */
export function enabledAgentTools(mode: 'chat' | 'agent', scope: { hasProject: boolean; workspaceRootCount: number }, webMode: 'off' | 'auto'): string[] {
  if (mode !== 'agent') return webMode === 'auto' ? ['web'] : [];
  const scoped = scope.hasProject ? [...executionTools, ...knowledgeTools] : scope.workspaceRootCount > 0 ? executionTools : [];
  return [...scoped, ...alwaysAvailableAgentTools].sort();
}
