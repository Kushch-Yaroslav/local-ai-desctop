import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeConfiguration, RuntimeModelConfiguration, RuntimeDraftAvailability } from '../../shared/types';
import { searchPreference } from '../../shared/search-settings';
import { expandPath, paths } from './paths';
import { builtinModelCatalog } from '../models/model-catalog';
import { verifyGgufArtifacts } from './gguf-artifacts';
import { readGgufSpeculativeMetadata } from './gguf-speculative';

export const settingsFile = join(paths.configDirectory, 'runtime-settings.json');
const builtins = new Map(builtinModelCatalog.map((model) => [model.id, model]));
const idPattern = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function seededModels(modelsPath: string): RuntimeModelConfiguration[] {
  return builtinModelCatalog.map((model) => ({ id: model.id, displayName: model.displayName,
    modelPath: join(modelsPath, model.modelPath), mmprojPath: model.mmprojPath ? join(modelsPath, model.mmprojPath) : '',
    gpuLayers: null, supportsTools: model.supportsTools, speculative: 'mtp', builtin: true }));
}

export function executablePath(value: string): string {
  const candidate = value.includes('/') || value.startsWith('~') ? expandPath(value)
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, value)).find((path) => {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
    });
  if (!candidate) throw new Error(`Не найден ${value} в PATH. Укажите путь к исполняемому файлу в настройке runtime.`);
  try { if (!statSync(candidate).isFile()) throw new Error('это не файл'); accessSync(candidate, constants.X_OK); }
  catch { throw new Error(`Нет исполняемого файла: ${candidate}. Проверьте путь и право на запуск.`); }
  return candidate;
}

function normalizeModel(raw: unknown, modelsPath: string): RuntimeModelConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Некорректный профиль модели.');
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : '';
  const builtin = builtins.get(id);
  if (!builtin && !idPattern.test(id)) throw new Error(`Недопустимый идентификатор модели: ${id}.`);
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
  if (!displayName || displayName.length > 80 || /[\0\r\n]/.test(displayName)) throw new Error('Укажите название модели длиной до 80 символов.');
  if (typeof value.modelPath !== 'string' || !value.modelPath.trim()) throw new Error(`Выберите GGUF для «${displayName}».`);
  if (value.mmprojPath !== undefined && typeof value.mmprojPath !== 'string') throw new Error(`Некорректный путь projector для «${displayName}».`);
  const gpuLayers = value.gpuLayers === undefined || value.gpuLayers === null ? null : Number(value.gpuLayers);
  if (gpuLayers !== null && (!Number.isInteger(gpuLayers) || gpuLayers < 0 || gpuLayers > 999)) throw new Error(`Число GPU-слоёв для «${displayName}» должно быть от 0 до 999.`);
  const projectorDevice = value.projectorDevice ?? 'auto';
  if (!['auto', 'gpu', 'cpu'].includes(String(projectorDevice))) throw new Error('Некорректное устройство projector.');
  const supportsTools = builtin ? builtin.supportsTools : value.supportsTools === true;
  const speculative = value.speculative === 'none' ? 'none' : builtin || value.speculative === 'mtp' ? 'mtp' : 'none';
  if (value.speculative !== undefined && value.speculative !== 'none' && value.speculative !== 'mtp') throw new Error(`Некорректный режим MTP для «${displayName}».`);
  return { id, displayName, modelPath: expandPath(value.modelPath, modelsPath),
    mmprojPath: value.mmprojPath ? expandPath(String(value.mmprojPath), modelsPath) : '',
    gpuLayers, projectorDevice: projectorDevice as 'auto' | 'gpu' | 'cpu', supportsTools, speculative, builtin: Boolean(builtin) };
}

function normalizeModels(raw: unknown, modelsPath: string): RuntimeModelConfiguration[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error('Список моделей должен содержать не более 64 профилей.');
  const models = raw.map((entry) => normalizeModel(entry, modelsPath));
  const ids = new Set<string>();
  for (const model of models) { if (ids.has(model.id)) throw new Error(`Модель «${model.displayName}» добавлена дважды.`); ids.add(model.id); }
  return models;
}

export function normalizeConfiguration(raw: unknown): RuntimeConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Настройки runtime должны быть объектом.');
  const value = raw as Record<string, unknown>;
  if (typeof value.modelsPath !== 'string') throw new Error('Укажите каталог моделей.');
  if (value.llamaServerPath !== null && typeof value.llamaServerPath !== 'string') throw new Error('Укажите путь к llama-server или оставьте поле пустым.');
  if (!Number.isInteger(value.gpuLayers) || Number(value.gpuLayers) < 0 || Number(value.gpuLayers) > 999) throw new Error('Число GPU-слоёв должно быть целым от 0 до 999 (0 — CPU).');
  if (value.setupDismissed !== undefined && typeof value.setupDismissed !== 'boolean') throw new Error('Некорректное состояние окна первой настройки.');
  if (value.imageProcessingDevice !== undefined && value.imageProcessingDevice !== 'cpu' && value.imageProcessingDevice !== 'gpu') throw new Error('Invalid image processing device');
  const modelsPath = expandPath(value.modelsPath);
  let models: RuntimeModelConfiguration[];
  if (Array.isArray(value.models)) {
    models = normalizeModels(value.models, modelsPath);
    // Valid v2 profiles are the source of truth; don't silently reseed edits/removals.
    if (value.schemaVersion !== 2) throw new Error('Неизвестная версия реестра моделей.');
  } else if (value.models && typeof value.models === 'object') {
    // One-way, idempotent migration from the previous keyed path map. Stable
    // built-in IDs preserve existing conversations and their capability policy.
    const old = value.models as Record<string, unknown>;
    models = seededModels(modelsPath).map((model) => {
      const entry = old[model.id];
      if (entry === undefined) return model;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Некорректные старые пути модели ${model.id}.`);
      const paths = entry as Record<string, unknown>;
      return normalizeModel({ ...model, ...paths }, modelsPath);
    });
    for (const id of Object.keys(old)) if (!builtins.has(id)) throw new Error(`Неизвестная модель в старых настройках: ${id}.`);
  } else if (value.models === undefined) models = seededModels(modelsPath);
  else throw new Error('Некорректный список моделей.');
  if (value.llamaServerInput !== undefined && (typeof value.llamaServerInput !== 'string' || value.llamaServerInput.length > 4096 || /[\0\r\n]/.test(value.llamaServerInput))) throw new Error('Некорректный путь к llama-server или папке.');
  const server = typeof value.llamaServerPath === 'string' ? value.llamaServerPath.trim() : '';
  return { llamaServerPath: server ? (server.includes('/') || server.startsWith('~') ? expandPath(server) : server) : null,
    ...(typeof value.llamaServerInput === 'string' ? { llamaServerInput: value.llamaServerInput.trim() } : {}),
    modelsPath, gpuLayers: Number(value.gpuLayers), setupDismissed: value.setupDismissed === true,
    searchProvider: searchPreference(value.searchProvider), allowBingFallback: value.allowBingFallback === true,
    schemaVersion: 2, language: value.language === 'ru' ? 'ru' : 'en', ...(value.imageProcessingDevice ? { imageProcessingDevice: value.imageProcessingDevice } : {}), models } as RuntimeConfiguration;
}

export function loadRuntimeConfiguration(file = settingsFile): RuntimeConfiguration {
  const legacyServer = resolve(paths.root, '../llama.cpp/build-cuda/bin/llama-server');
  const defaults = { llamaServerPath: process.env.LOCAL_AI_LLAMA_SERVER_PATH ?? (existsSync(legacyServer) ? legacyServer : null),
    modelsPath: paths.models, gpuLayers: 999, setupDismissed: false, models: seededModels(paths.models) };
  if (!existsSync(file)) return normalizeConfiguration({ ...defaults, schemaVersion: 2, imageProcessingDevice: 'cpu' });
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('ожидается объект настроек');
    const value = saved as Record<string, unknown>;
    if (Array.isArray(value.models)) return normalizeConfiguration({ ...defaults, ...value });
    return normalizeConfiguration({ ...defaults, ...value, models: { ...(value.models as object ?? {}) } });
  } catch (error) { throw new Error(`Не удалось прочитать ${file}: ${error instanceof Error ? error.message : String(error)}. Исправьте файл или переименуйте его, чтобы открыть настройку заново.`); }
}

export function effectiveRuntimeConfiguration(): RuntimeConfiguration {
  try { return loadRuntimeConfiguration(); }
  catch { return normalizeConfiguration({ llamaServerPath: null, modelsPath: paths.models, gpuLayers: 999, setupDismissed: false, schemaVersion: 2, models: seededModels(paths.models) }); }
}

export function configuredModel(id: string, config = effectiveRuntimeConfiguration()): RuntimeModelConfiguration | undefined { return config.models.find((model) => model.id === id); }
export function modelPaths(id: string, config = effectiveRuntimeConfiguration()): { modelPath: string; mmprojPath?: string } {
  const model = configuredModel(id, config);
  return model ? { modelPath: model.modelPath, ...(model.mmprojPath && existsSync(model.mmprojPath) ? { mmprojPath: model.mmprojPath } : {}) } : { modelPath: '' };
}

export function isValidGgufModel(path: string): boolean {
  try {
    verifyGgufArtifacts(path);
    return typeof readGgufSpeculativeMetadata(path).values['general.architecture'] === 'string';
  } catch { return false; }
}
const validGguf = isValidGgufModel;

/** Inspect draft paths without persisting or requiring a complete valid form. */
export function runtimeDraftAvailability(raw: unknown): RuntimeDraftAvailability {
  if (!raw || typeof raw !== 'object') throw new Error('Некорректные настройки моделей.');
  const value = raw as Record<string, unknown>;
  if (typeof value.modelsPath !== 'string' || value.modelsPath.length > 4096 || !Array.isArray(value.models) || value.models.length > 64) throw new Error('Некорректные настройки моделей.');
  let base: string | undefined;
  try { base = expandPath(value.modelsPath); } catch { /* An incomplete folder is normal while typing. */ }
  const check = (path: unknown) => {
    if (typeof path !== 'string' || !path || path.length > 4096) return false;
    // Absolute paths stay independent of an incomplete/changed base folder.
    if (!base && !path.startsWith('/') && !path.startsWith('~')) return false;
    try { return validGguf(expandPath(path, base)); } catch { return false; }
  };
  let folderExists = false;
  try { folderExists = Boolean(base && statSync(base, { throwIfNoEntry: false })?.isDirectory()); } catch { /* Unreadable folder. */ }
  return { folderExists, models: value.models.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') throw new Error('Некорректные настройки моделей.');
    return { id: entry.id, installed: check(entry.modelPath), projectorMissing: Boolean(entry.mmprojPath && !check(entry.mmprojPath)) };
  }) };
}


export function runtimeSetup(file = settingsFile) {
  let config: RuntimeConfiguration;
  const issues: string[] = [];
  try { config = loadRuntimeConfiguration(file); }
  catch (error) { issues.push((error as Error).message); config = effectiveRuntimeConfiguration(); }
  let server: string | null = null;
  try { server = executablePath(config.llamaServerPath ?? 'llama-server'); } catch (error) { issues.push((error as Error).message); }
  const models = config.models.map((model) => {
    const installed = validGguf(model.modelPath);
    const projectorMissing = Boolean(model.mmprojPath && !validGguf(model.mmprojPath));
    const modelIssue = installed ? undefined : `Не найден читаемый GGUF-файл: ${model.modelPath}`;
    const issue = [modelIssue, !server ? 'Сначала выберите исполняемый llama-server.' : undefined,
      projectorMissing ? 'Projector не найден; модель сможет работать без изображений, если очистить это поле.' : undefined].filter(Boolean).join(' ');
    const status = !installed ? 'missing-model' : !server ? 'missing-server' : projectorMissing ? 'invalid-projector' : 'ready';
    return { id: model.id, name: model.displayName, modelPath: model.modelPath, ...(model.mmprojPath ? { mmprojPath: model.mmprojPath } : {}), installed,
      status: status as 'ready' | 'missing-model' | 'missing-server' | 'invalid-projector', issue: issue || undefined, builtin: model.builtin };
  });
  const ready = Boolean(server && models.some((model) => model.installed));
  if (!server) issues.push('Укажите путь к llama-server, чтобы запускать модели.');
  if (!config.models.length) issues.push('Добавьте GGUF-модель для начала работы.');
  return { config, server, models, issues, ready, autoOpen: !ready && !config.setupDismissed,
    configPath: settingsFile, dataDirectory: paths.dataRoot };
}

export function saveRuntimeConfiguration(raw: unknown, file = settingsFile): RuntimeConfiguration {
  const config = normalizeConfiguration(raw);
  if (!statSync(config.modelsPath, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Каталог моделей не найден: ${config.modelsPath}. Выберите существующую папку.`);
  let prior: RuntimeConfiguration | undefined;
  let corruptExistingFile = false;
  try { prior = loadRuntimeConfiguration(file); }
  catch { corruptExistingFile = existsSync(file); }
  for (const model of config.models) {
    for (const key of ['modelPath', 'mmprojPath'] as const) {
      const path = model[key];
      if (!path || validGguf(path)) continue;
      const previous = prior?.models.find((saved) => saved.id === model.id)?.[key];
      const builtinDefault = model.builtin && key === 'modelPath' && path === join(config.modelsPath, builtinModelCatalog.find((item) => item.id === model.id)!.modelPath);
      if (path === previous || builtinDefault || key === 'mmprojPath') continue;
      throw new Error(`Не найден читаемый GGUF ${key === 'modelPath' ? 'модели' : 'projector'}: ${path}. Проверьте выбранный файл и все части split GGUF.`);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // Preserve malformed user data before an explicit save repairs the settings.
  // Valid legacy/v2 configurations are migrated in place and never backed up.
  if (corruptExistingFile) renameSync(file, `${file}.invalid-${Date.now()}.bak`);
  renameSync(temporary, file);
  return config;
}

export function dismissRuntimeSetup(file = settingsFile): RuntimeConfiguration {
  const config = loadRuntimeConfiguration(file);
  config.setupDismissed = true;
  // Closing first-run guidance must work even when an old server or models
  // directory has since moved; dismissal changes only this persisted flag.
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return config;
}

if (require.main === module) {
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  try {
    const config = loadRuntimeConfiguration();
    let server = config.llamaServerPath ?? 'llama-server';
    try { server = executablePath(server); } catch { server = ''; /* Never pass an unresolved directory/command to the supervisor. */ }
    process.stdout.write(Object.entries({ LLAMA_BIN: server, STATE_DIR: paths.dataRoot, LOG_DIR: paths.logs, GPU_LAYERS: String(config.gpuLayers) }).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n');
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}

export function saveLanguage(language: 'ru' | 'en', file = settingsFile): void {
  if (language !== 'ru' && language !== 'en') throw new Error('Invalid language');
  const config = loadRuntimeConfiguration(file);
  config.language = language;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

/** Preserve legacy per-model choices until a user explicitly selects the menu preference. */
export function saveImageProcessingDevice(device: 'cpu' | 'gpu', file = settingsFile): void {
  if (device !== 'cpu' && device !== 'gpu') throw new Error('Invalid image processing device');
  const config = loadRuntimeConfiguration(file);
  config.imageProcessingDevice = device;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}
