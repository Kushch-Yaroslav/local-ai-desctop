import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applicationPaths, expandPath } from './paths';
import { dismissRuntimeSetup, loadRuntimeConfiguration, modelPaths, normalizeConfiguration, runtimeSetup, saveRuntimeConfiguration } from './runtime-settings';
import { getModelProfile, registeredModelProfiles } from '../models/model-registry';
import { llamaRuntimeProfilesList } from '../models/llama-runtime-policy';
import { builtinModelCatalog } from '../models/model-catalog';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const text = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
function gguf(architecture = 'fixture', context = 65_536, mtp = false): Buffer {
  const fields: Record<string, string | number> = { 'general.architecture': architecture, [`${architecture}.context_length`]: context, ...(mtp ? { [`${architecture}.nextn_predict_layers`]: 1 } : {}) };
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(fields).length), ...Object.entries(fields).flatMap(([key, value]) => [text(key), typeof value === 'string' ? Buffer.concat([u32(8), text(value)]) : Buffer.concat([u32(4), u32(value)])])]);
}

const root = mkdtempSync(join(tmpdir(), 'linux setup space '));
try {
  const home = join(root, 'new user'), app = join(root, 'relocated application');
  const defaults = applicationPaths(app, home, {}, () => false);
  assert.equal(defaults.dataRoot, join(home, '.local/share/local-ai-desktop'));
  assert.equal(defaults.cache, join(home, '.cache/local-ai-desktop'));
  assert.equal(defaults.configDirectory, join(home, '.config/local-ai-desktop'));
  assert.equal(defaults.logs, join(home, '.local/state/local-ai-desktop/logs'));
  const xdg = applicationPaths(app, home, { XDG_CONFIG_HOME: '/test/config', XDG_DATA_HOME: '/test/data', XDG_CACHE_HOME: '/test/cache', XDG_STATE_HOME: '/test/state' }, () => false);
  assert.equal(xdg.dataRoot, '/test/data/local-ai-desktop'); assert.equal(xdg.configDirectory, '/test/config/local-ai-desktop');
  assert.equal(applicationPaths(app, home, { XDG_DATA_HOME: 'relative' }, () => false).dataRoot, defaults.dataRoot);
  assert.equal(applicationPaths(app, home, { LOCAL_AI_RUNTIME_ROOT: '~/old data' }, () => false).dataRoot, join(home, 'old data'));
  const migrated = applicationPaths(app, home, {}, (path) => path === join(app, 'runtime/sqlite/local-ai-desktop.db'));
  assert.equal(migrated.dataRoot, join(app, 'runtime'), 'keep database, attachments and evidence together');
  assert.equal(migrated.userData, join(app, 'runtime/app-data'));
  assert.equal(expandPath('~/model files/a.gguf', '/', home), join(home, 'model files/a.gguf'));
  assert.equal(expandPath('a.gguf', root), join(root, 'a.gguf'));
  for (const bad of ['', '~another/file', 'path\nINJECT=1', 'path\0bad']) assert.throws(() => expandPath(bad));

  const server = join(root, "server 'space'"); writeFileSync(server, '#!/bin/sh\nexit 0\n'); chmodSync(server, 0o755);
  const weights = join(root, 'weights with spaces'); mkdirSync(weights);
  const original = join(weights, 'chosen model.gguf'), projector = join(weights, 'chosen vision.gguf');
  writeFileSync(original, gguf()); writeFileSync(projector, gguf('fixture_vision'));
  const qwen36 = 'qwen3.6:35b-a3b-ud-q4_k_m';
  const legacyFile = join(root, 'data/runtime-settings.json');
  mkdirSync(join(root, 'data'), { recursive: true });
  const legacy = { llamaServerPath: server, modelsPath: weights, gpuLayers: 32, models: { [qwen36]: { modelPath: original, mmprojPath: projector } } };
  writeFileSync(legacyFile, JSON.stringify(legacy));
  const firstMigration = loadRuntimeConfiguration(legacyFile);
  assert.equal(firstMigration.schemaVersion, 2); assert.equal(firstMigration.models.length, 3);
  assert.equal(firstMigration.models.find((model) => model.id === qwen36)?.modelPath, original);
  assert.equal(firstMigration.models.find((model) => model.id === qwen36)?.mmprojPath, projector);
  assert.equal(firstMigration.models.find((model) => model.id === qwen36)?.speculative, 'mtp');
  assert.equal(firstMigration.models.find((model) => model.id === qwen36)?.displayName, 'Qwen3.6-35B-A3B');
  const migratedConfig = saveRuntimeConfiguration(firstMigration, legacyFile);
  assert.equal(statSync(legacyFile).mode & 0o777, 0o600);
  assert.deepEqual(loadRuntimeConfiguration(legacyFile), migratedConfig, 'migration persists once and remains idempotent');
  assert.equal(modelPaths(qwen36, migratedConfig).modelPath, original, 'known chat model identity and custom file path remain stable');

  const customId = 'custom:123e4567-e89b-42d3-a456-426614174000';
  const custom = { id: customId, displayName: 'My Local Model', modelPath: original, mmprojPath: '', gpuLayers: 18,
    supportsTools: false, speculative: 'none' as const, builtin: false };
  const added = saveRuntimeConfiguration({ ...migratedConfig, models: [...migratedConfig.models, custom] }, legacyFile);
  assert.equal(getModelProfile(customId, added)?.displayName, 'My Local Model');
  assert.equal(getModelProfile(customId, added)?.supportsTools, false, 'unknown profile defaults to no tool-call assumptions');
  assert.equal(getModelProfile(customId, added)?.supportsReasoning, false, 'unknown profile does not inherit Qwen reasoning behavior');
  assert.equal(getModelProfile(customId, added)?.maxContext, 32_768, 'unknown models start with a conservative context ceiling');
  const localRegistry = registeredModelProfiles(added);
  assert.equal(localRegistry.length, 4); assert.equal(llamaRuntimeProfilesList(added).length, 4);
  const customRuntime = llamaRuntimeProfilesList(added).find((profile) => profile.id === customId);
  assert.equal(customRuntime?.speculative, 'none', 'runtime profile defaults to no MTP');
  assert.equal(customRuntime?.maxContext, 32_768, 'unknown runtime starts with a conservative context ceiling');
  assert.equal(modelPaths(customId, added).modelPath, original);

  const edited = { ...custom, displayName: 'Edited Local Model', supportsTools: true, gpuLayers: null };
  const afterEdit = saveRuntimeConfiguration({ ...added, models: added.models.map((model) => model.id === customId ? edited : model) }, legacyFile);
  assert.equal(loadRuntimeConfiguration(legacyFile).models.find((model) => model.id === customId)?.displayName, 'Edited Local Model');
  assert.equal(getModelProfile(customId, afterEdit)?.supportsTools, true);
  const afterRemove = saveRuntimeConfiguration({ ...afterEdit, models: afterEdit.models.filter((model) => model.id !== customId) }, legacyFile);
  assert.equal(getModelProfile(customId, afterRemove), undefined, 'deleting a profile leaves its stable ID available only in saved chats');
  assert.equal(afterRemove.models.some((model) => model.id === qwen36), true, 'removing a custom model preserves built-in identities');

  const setup = runtimeSetup(legacyFile);
  assert.equal(setup.ready, true, 'one valid GGUF and llama-server make the app usable');
  assert.equal(setup.autoOpen, false);
  const missingServer = saveRuntimeConfiguration({ ...afterRemove, llamaServerPath: null }, legacyFile);
  assert.equal(runtimeSetup(legacyFile).ready, false);
  assert(runtimeSetup(legacyFile).models.some((model) => model.status === 'missing-server'));
  const dismissed = dismissRuntimeSetup(legacyFile);
  assert.equal(dismissed.setupDismissed, true); assert.equal(runtimeSetup(legacyFile).autoOpen, false);
  assert.equal(missingServer.models.length, 3);
  const movedServer = saveRuntimeConfiguration({ ...dismissed, llamaServerPath: join(root, 'server was moved') }, legacyFile);
  assert.equal(movedServer.llamaServerPath, join(root, 'server was moved'));
  assert.equal(runtimeSetup(legacyFile).models.some((model) => model.status === 'missing-server'), true,
    'a moved server remains configured and visible as missing instead of blocking profile edits or setup dismissal');
  const missingDirectory = join(root, 'removed models directory'); mkdirSync(missingDirectory);
  const movedDirectoryFile = join(root, 'missing-directory/runtime-settings.json');
  const movedDirectoryConfig = saveRuntimeConfiguration({ ...movedServer, modelsPath: missingDirectory,
    models: movedServer.models.map((model) => ({ ...model, modelPath: original, mmprojPath: '' })) }, movedDirectoryFile);
  rmSync(missingDirectory, { recursive: true, force: true });
  const dismissedWithMovedDirectory = dismissRuntimeSetup(movedDirectoryFile);
  assert.equal(dismissedWithMovedDirectory.setupDismissed, true);
  assert.equal(dismissedWithMovedDirectory.modelsPath, movedDirectoryConfig.modelsPath,
    'setup dismissal preserves a moved models directory without resetting configuration');

  const badFile = join(weights, 'not-a-model.gguf'); writeFileSync(badFile, 'GGUFbut no metadata');
  assert.throws(() => saveRuntimeConfiguration({ ...afterRemove, models: [...afterRemove.models, { ...custom, modelPath: badFile }] }, legacyFile), /читаемый GGUF/);
  assert.throws(() => normalizeConfiguration({ ...afterRemove, gpuLayers: -1 }), /GPU/);
  assert.throws(() => normalizeConfiguration({ ...afterRemove, models: [...afterRemove.models, { ...custom, id: 'not safe id' }] }), /идентификатор/);
  assert.throws(() => normalizeConfiguration({ ...afterRemove, models: [...afterRemove.models, { ...custom, displayName: '' }] }), /название/);

  const invalidFile = join(root, 'invalid/runtime-settings.json');
  mkdirSync(join(root, 'invalid'), { recursive: true });
  for (const invalid of ['{ broken', 'null', '[]', '42']) { writeFileSync(invalidFile, invalid); assert.throws(() => loadRuntimeConfiguration(invalidFile), /Не удалось прочитать/); }
  writeFileSync(invalidFile, '{ broken');
  const repaired = saveRuntimeConfiguration({ ...dismissed, llamaServerPath: server }, invalidFile);
  assert.equal(repaired.schemaVersion, 2);
  assert(readdirSync(join(root, 'invalid')).some((name) => name.startsWith('runtime-settings.json.invalid-') && name.endsWith('.bak')),
    'an explicit repair preserves the malformed prior file for recovery');
  assert(!existsSync(`${legacyFile}.${process.pid}.tmp`));
  assert.equal(readFileSync(legacyFile, 'utf8'), JSON.stringify(movedServer, null, 2) + '\n');

  const freshFile = join(root, 'fresh/runtime-settings.json');
  mkdirSync(join(root, 'fresh'), { recursive: true });
  const freshModels = join(root, 'fresh models'); mkdirSync(freshModels);
  saveRuntimeConfiguration({ ...dismissed, llamaServerPath: null, modelsPath: freshModels,
    models: dismissed.models.map((model) => ({ ...model, modelPath: join(freshModels, builtinModelCatalog.find((entry) => entry.id === model.id)!.modelPath), mmprojPath: '' })),
    setupDismissed: false }, freshFile);
  const firstRun = runtimeSetup(freshFile);
  assert.equal(firstRun.ready, false); assert.equal(firstRun.autoOpen, true);
  assert(firstRun.models.every((model) => model.status === 'missing-model'));
  console.log('Linux model registry: first-run defaults, legacy migration/idempotence, known identities/capabilities, custom add/edit/delete, readiness, invalid GGUF, corruption backup, dismissal, XDG/tilde/spaces and persistence passed');
} finally { rmSync(root, { recursive: true, force: true }); }
