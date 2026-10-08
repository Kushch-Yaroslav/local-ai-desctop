import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function expandPath(value: string, base = homedir(), home = homedir()): string {
  if (!value.trim() || /[\0\r\n]/.test(value)) throw new Error('Укажите непустой путь без переводов строк.');
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) throw new Error('Используйте ~ или ~/папка; ~username не поддерживается.');
  return resolve(base, value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
}

export function applicationPaths(root: string, home: string, env: NodeJS.ProcessEnv, exists = existsSync) {
  const legacy = join(root, 'runtime');
  const xdg = (name: string, fallback: string) => env[name] && isAbsolute(env[name]!) ? env[name]! : join(home, fallback);
  // Existing source installations keep their whole database/evidence lineage
  // in place. New installs never write into the application bundle.
  const dataRoot = env.LOCAL_AI_RUNTIME_ROOT ? expandPath(env.LOCAL_AI_RUNTIME_ROOT, home, home)
    : exists(join(legacy, 'sqlite/local-ai-desktop.db')) ? legacy : join(xdg('XDG_DATA_HOME', '.local/share'), 'local-ai-desktop');
  const legacyLayout = dataRoot === legacy || Boolean(env.LOCAL_AI_RUNTIME_ROOT);
  const oldModels = resolve(root, '../llama-models');
  return { root, dataRoot, userData: join(dataRoot, 'app-data'),
    configDirectory: legacyLayout ? join(dataRoot, 'app-data') : join(xdg('XDG_CONFIG_HOME', '.config'), 'local-ai-desktop'),
    cache: legacyLayout ? join(dataRoot, 'cache') : join(xdg('XDG_CACHE_HOME', '.cache'), 'local-ai-desktop'),
    logs: legacyLayout ? join(dataRoot, 'logs') : join(xdg('XDG_STATE_HOME', '.local/state'), 'local-ai-desktop/logs'),
    attachments: join(dataRoot, 'attachments'), database: join(dataRoot, 'sqlite/local-ai-desktop.db'),
    models: exists(oldModels) ? oldModels : join(dataRoot, 'models') };
}

// dist/main/services in both a source build and resources/app (asar:false).
const root = resolve(__dirname, '../../..');

export const paths = applicationPaths(root, homedir(), process.env);

export function agentRuntimePath(): string {
  if (process.env.LOCAL_AI_AGENT_RUNTIME) return expandPath(process.env.LOCAL_AI_AGENT_RUNTIME);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = resources && join(resources, 'agent/local-ai-agent-runtime');
  return bundled && existsSync(bundled) ? bundled : join(root, 'rust-agent/target/debug/local-ai-agent-runtime');
}

export function ensureAppDirectories(): void {
  [paths.dataRoot, paths.userData, paths.configDirectory, paths.cache, paths.logs, paths.attachments, paths.models, join(paths.dataRoot, 'sqlite')]
    .forEach((directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }));
}
