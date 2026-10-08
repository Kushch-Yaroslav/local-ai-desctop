import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { applicationPaths, expandPath, paths } from './paths';
import { executablePath, loadRuntimeConfiguration, modelPaths, normalizeConfiguration, saveRuntimeConfiguration } from './runtime-settings';

const root = mkdtempSync(join(tmpdir(), 'linux setup space '));
try {
  const home = join(root, 'new user'), app = join(root, 'relocated application');
  const defaults = applicationPaths(app, home, {}, () => false);
  assert.equal(defaults.dataRoot, join(home, '.local/share/local-ai-desktop'));
  assert.equal(defaults.cache, join(home, '.cache/local-ai-desktop'));
  assert.equal(defaults.configDirectory, join(home, '.config/local-ai-desktop'));
  assert.equal(defaults.logs, join(home, '.local/state/local-ai-desktop/logs'));
  const xdg = applicationPaths(app, home, { XDG_CONFIG_HOME: '/test/config', XDG_DATA_HOME: '/test/data', XDG_CACHE_HOME: '/test/cache', XDG_STATE_HOME: '/test/state' }, () => false);
  assert.equal(xdg.dataRoot, '/test/data/local-ai-desktop');
  assert.equal(xdg.configDirectory, '/test/config/local-ai-desktop');
  assert.equal(applicationPaths(app, home, { XDG_DATA_HOME: 'relative' }, () => false).dataRoot, defaults.dataRoot);
  assert.equal(applicationPaths(app, home, { LOCAL_AI_RUNTIME_ROOT: '~/old data' }, () => false).dataRoot, join(home, 'old data'));
  const migrated = applicationPaths(app, home, {}, (path) => path === join(app, 'runtime/sqlite/local-ai-desktop.db'));
  assert.equal(migrated.dataRoot, join(app, 'runtime'), 'keep database, attachments and evidence together, without copying/renaming');
  assert.equal(migrated.userData, join(app, 'runtime/app-data'));
  assert.equal(expandPath('~/model files/a.gguf', '/', home), join(home, 'model files/a.gguf'));
  assert.equal(expandPath('a.gguf', root), join(root, 'a.gguf'));
  for (const bad of ['', '~another/file', 'path\nINJECT=1', 'path\0bad']) assert.throws(() => expandPath(bad));
  const server = join(root, "server 'space'");
  writeFileSync(server, '#!/bin/sh\nexit 0\n'); chmodSync(server, 0o755);
  assert.equal(executablePath(server), server);
  chmodSync(server, 0o644); assert.throws(() => executablePath(server), /исполняемого/); chmodSync(server, 0o755);
  assert.throws(() => executablePath(join(root, 'missing server')), /исполняемого/);
  const weights = join(root, 'weights with spaces'); mkdirSync(weights);
  writeFileSync(join(weights, 'main.gguf'), 'GGUFtest metadata');
  writeFileSync(join(weights, 'vision.gguf'), 'GGUFtest projector');
  const id = 'qwen3.6:35b-a3b-ud-q4_k_m';
  const file = join(root, 'data/runtime-settings.json');
  const config = { llamaServerPath: server, modelsPath: weights, gpuLayers: 0, models: { [id]: { modelPath: 'main.gguf', mmprojPath: 'vision.gguf' } } };
  const normalized = saveRuntimeConfiguration(config, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadRuntimeConfiguration(file), normalized, 'restart restores the same sole configuration');
  assert.equal(normalized.models[id].modelPath, join(weights, 'main.gguf'));
  assert.deepEqual(modelPaths(id, normalized), { modelPath: join(weights, 'main.gguf'), mmprojPath: join(weights, 'vision.gguf') });
  assert.equal(modelPaths(id, { ...normalized, models: { [id]: { modelPath: 'chosen.gguf', mmprojPath: '' } } }).mmprojPath, undefined);
  assert.throws(() => saveRuntimeConfiguration({ ...config, models: { [id]: { modelPath: 'missing.gguf' } } }, file), /читаемый GGUF/);
  assert.throws(() => saveRuntimeConfiguration({ ...config, modelsPath: join(root, 'missing directory') }, file), /Каталог моделей/);
  assert.throws(() => normalizeConfiguration({ ...config, gpuLayers: -1 }), /GPU/);
  assert.throws(() => normalizeConfiguration({ ...config, models: { unknown: {} } }), /Неизвестный/);
  assert.throws(() => normalizeConfiguration({ ...config, models: JSON.parse('{"__proto__":{}}') }), /Неизвестный/);
  assert.throws(() => normalizeConfiguration({ ...config, models: { [id]: { modelPath: 12 } } }));
  assert(!existsSync(`${file}.${process.pid}.tmp`));
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(normalized, null, 2) + '\n', 'invalid updates do not alter saved settings');
  writeFileSync(file, '{ broken'); assert.throws(() => loadRuntimeConfiguration(file), /Не удалось прочитать/);
  for (const invalid of ['null', '[]', '42']) { writeFileSync(file, invalid); assert.throws(() => loadRuntimeConfiguration(file), /Не удалось прочитать/); }
  // Relocated workers do not depend on CWD. Missing resources still return a
  // readable setup state and all three supported model choices.
  const text = execFileSync(process.execPath, ['-e', `const p=require(${JSON.stringify(join(paths.root, 'dist/main/services/paths.js'))});const s=require(${JSON.stringify(join(paths.root, 'dist/main/services/runtime-settings.js'))});console.log(JSON.stringify({paths:p.paths,setup:s.runtimeSetup()}));`], {
    cwd: root, env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: join(root, 'fresh data'), LOCAL_AI_LLAMA_SERVER_PATH: join(root, 'missing runtime') }, encoding: 'utf8',
  });
  const result = JSON.parse(text);
  assert.equal(result.paths.root, paths.root);
  assert.equal(result.setup.models.length, 3);
  assert(result.setup.issues.some((issue: string) => issue.includes('исполняемого')));
  assert.equal(result.setup.server, null);
  console.log('Linux setup: XDG defaults, legacy data/evidence retention, tilde/spaces, missing/executable paths, atomic settings/restart, GGUF validation, relocation and first-run diagnostics passed');
} finally { rmSync(root, { recursive: true, force: true }); }
