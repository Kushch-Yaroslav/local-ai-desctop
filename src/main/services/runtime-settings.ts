import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeConfiguration } from '../../shared/types';
import { expandPath, paths } from './paths';
import { modelRegistry } from '../models/model-registry';
import { verifyGgufArtifacts } from './gguf-artifacts';

export const modelFiles: Record<string, { modelPath: string; mmprojPath: string }> = {
  'qwen3.8:27b-q4_K_M': { modelPath: 'qwen3.8-27b-q4_K_M.gguf', mmprojPath: 'qwen3.8-27b-mmproj.gguf' },
  'qwen3.6:35b-a3b-ud-q4_k_m': { modelPath: 'Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', mmprojPath: 'Qwen3.6-35B-A3B-Q4_K_M/mmproj-BF16.gguf' },
  'huihui-qwen3.8:27b-ud-dw-q4_k_m': { modelPath: 'Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf', mmprojPath: 'huihui-qwen3.8-27b-mmproj-bf16.gguf' },
};
export const settingsFile = join(paths.configDirectory, 'runtime-settings.json');

export function executablePath(value: string): string {
  const candidate = value.includes('/') || value.startsWith('~') ? expandPath(value)
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, value)).find((path) => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
    });
  if (!candidate) throw new Error(`Не найден ${value} в PATH. Укажите путь к исполняемому файлу в «Настройка runtime».`);
  try { if (!statSync(candidate).isFile()) throw new Error('это не файл'); accessSync(candidate, constants.X_OK); }
  catch { throw new Error(`Нет исполняемого файла: ${candidate}. Проверьте путь и право на запуск (chmod +x).`); }
  return candidate;
}

export function normalizeConfiguration(raw: unknown): RuntimeConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Настройки runtime должны быть объектом.');
  const value = raw as Record<string, unknown>;
  if (typeof value.modelsPath !== 'string') throw new Error('Укажите каталог моделей.');
  if (value.llamaServerPath !== null && typeof value.llamaServerPath !== 'string') throw new Error('Укажите путь к llama-server или оставьте поле пустым.');
  if (!Number.isInteger(value.gpuLayers) || Number(value.gpuLayers) < 0 || Number(value.gpuLayers) > 999) throw new Error('Число GPU-слоёв должно быть целым от 0 до 999 (0 — CPU).');
  const modelsPath = expandPath(value.modelsPath);
  const models: RuntimeConfiguration['models'] = {};
  if (value.models !== undefined && (!value.models || typeof value.models !== 'object' || Array.isArray(value.models))) throw new Error('Некорректные пути моделей.');
  for (const [id, entry] of Object.entries(value.models ?? {})) {
    if (!Object.hasOwn(modelFiles, id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Неизвестный профиль модели: ${id}.`);
    const fields = entry as Record<string, unknown>;
    models[id] = {};
    for (const key of ['modelPath', 'mmprojPath'] as const) {
      if (fields[key] !== undefined) {
        if (typeof fields[key] !== 'string') throw new Error(`Путь ${id}/${key} должен быть строкой.`);
        models[id][key] = fields[key] ? expandPath(fields[key], modelsPath) : '';
      }
    }
  }
  return { llamaServerPath: value.llamaServerPath ? String(value.llamaServerPath) : null, modelsPath, gpuLayers: Number(value.gpuLayers), models };
}

export function loadRuntimeConfiguration(file = settingsFile): RuntimeConfiguration {
  const legacyServer = resolve(paths.root, '../llama.cpp/build-cuda/bin/llama-server');
  const defaults: RuntimeConfiguration = { llamaServerPath: process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? (existsSync(legacyServer) ? legacyServer : null), modelsPath: paths.models, gpuLayers: 999, models: {} };
  if (!existsSync(file)) return defaults;
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('ожидается объект настроек');
    return normalizeConfiguration({ ...defaults, ...saved });
  }
  catch (error) { throw new Error(`Не удалось прочитать ${file}: ${error instanceof Error ? error.message : String(error)}. Исправьте файл или переименуйте его, чтобы открыть настройку заново.`); }
}

export function effectiveRuntimeConfiguration(): RuntimeConfiguration {
  try { return loadRuntimeConfiguration(); }
  catch { return { llamaServerPath: null, modelsPath: paths.models, gpuLayers: 999, models: {} }; }
}

export function modelPaths(id: string, config = effectiveRuntimeConfiguration()): { modelPath: string; mmprojPath?: string } {
  const defaults = modelFiles[id];
  const override = config.models[id];
  const modelPath = override?.modelPath || join(config.modelsPath, defaults.modelPath);
  const projector = override?.mmprojPath ?? join(config.modelsPath, defaults.mmprojPath);
  // An absent optional projector is text-only; an explicit broken path stays
  // visible and is diagnosed rather than silently ignored.
  return { modelPath, ...(projector && (override?.mmprojPath || existsSync(projector)) ? { mmprojPath: projector } : {}) };
}

export function runtimeSetup() {
  let config: RuntimeConfiguration;
  const issues: string[] = [];
  try { config = loadRuntimeConfiguration(); }
  catch (error) {
    issues.push((error as Error).message);
    config = { llamaServerPath: null, modelsPath: paths.models, gpuLayers: 999, models: {} };
  }
  let server: string | null = null;
  try { server = executablePath(config.llamaServerPath ?? 'llama-server'); } catch (error) { issues.push((error as Error).message); }
  const models = modelRegistry.map((model) => {
    const files = modelPaths(model.id, config);
    let installed = false;
    try { verifyGgufArtifacts(files.modelPath); installed = true; } catch { /* Missing models are setup state, not startup errors. */ }
    if (files.mmprojPath && !existsSync(files.mmprojPath)) issues.push(`Не найден projector для ${model.displayName}: ${files.mmprojPath}. Выберите файл или очистите поле для текстового режима.`);
    return { id: model.id, name: model.displayName, ...files, installed };
  });
  if (!models.some((model) => model.installed)) issues.push('Модели не установлены. Выберите GGUF хотя бы для одного профиля; модели не входят в приложение.');
  return { config, server, models, issues, configPath: settingsFile, dataDirectory: paths.dataRoot };
}

export function saveRuntimeConfiguration(raw: unknown, file = settingsFile): RuntimeConfiguration {
  const config = normalizeConfiguration(raw);
  if (!statSync(config.modelsPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Каталог моделей не найден: ${config.modelsPath}. Выберите существующую папку.`);
  if (config.llamaServerPath) config.llamaServerPath = executablePath(config.llamaServerPath);
  for (const [id, files] of Object.entries(config.models)) {
    for (const key of ['modelPath', 'mmprojPath'] as const) {
      const path = files[key];
      if (path) {
        try {
          verifyGgufArtifacts(path);
          const descriptor = Buffer.alloc(4), fd = openSync(path, 'r');
          try { if (readSync(fd, descriptor, 0, 4, 0) !== 4 || descriptor.toString() !== 'GGUF') throw new Error('не GGUF'); }
          finally { closeSync(fd); }
        }
        catch { throw new Error(`Не найден читаемый GGUF ${id}/${key}: ${path}. Проверьте файл и все части split GGUF.`); }
      }
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return config;
}

if (require.main === module) {
  // Shell receives only generated, quoted values; never eval a user file.
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  try {
    const config = loadRuntimeConfiguration();
    let server = config.llamaServerPath ?? 'llama-server';
    try { server = executablePath(server); } catch { /* Idle UI must open before setup. */ }
    process.stdout.write(Object.entries({ LLAMA_BIN: server, STATE_DIR: paths.dataRoot, LOG_DIR: paths.logs, GPU_LAYERS: String(config.gpuLayers) }).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n');
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
