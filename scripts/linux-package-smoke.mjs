// Real .deb payload / Electron / preload / SQLite / Rust; no model weights,
// no personal application data and no changes to the installed system.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron } from 'playwright-core';

const release = resolve('release');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ggufText = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const ggufFixture = () => Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(2), ggufText('general.architecture'), u32(8), ggufText('fixture'), ggufText('fixture.context_length'), u32(4), u32(32_768)]);
const name = (await readdir(release)).find((name) => name.endsWith('_amd64.deb'));
assert(name, 'Build npm run package:linux first');
const fixture = await mkdtemp(join(tmpdir(), 'linux package smoke space '));
let application, provider;
try {
  const payload = join(fixture, 'payload');
  execFileSync('dpkg-deb', ['-x', join(release, name), payload]);
  const control = join(fixture, 'control'); await mkdir(control);
  execFileSync('dpkg-deb', ['-e', join(release, name), control]);
  const postInstall = await readFile(join(control, 'postinst'), 'utf8');
  assert(postInstall.includes("chmod 4755 '/opt/local-ai-desktop/chrome-sandbox'"));
  assert(postInstall.includes("chmod 0755 '/opt/local-ai-desktop/chrome-sandbox'"));
  assert(!postInstall.includes('/opt/Local AI Desktop/'));
  assert(!postInstall.includes('--no-sandbox'), 'the package installation must retain Chromium sandboxing');
  const packageIndex = execFileSync('dpkg-deb', ['-c', join(release, name)], { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 });
  const sandboxEntry = packageIndex.split('\n').find((line) => line.endsWith('./opt/local-ai-desktop/chrome-sandbox'));
  assert(sandboxEntry, 'the Electron chrome-sandbox helper must ship in the package');
  assert.match(sandboxEntry, /^-rwxr-xr-x 0\/0 /, 'the package must install a root-owned executable helper before the SUID post-install choice');
  const desktopDirectory = join(payload, 'usr/share/applications');
  const desktopFile = join(desktopDirectory, (await readdir(desktopDirectory))[0]);
  const desktopEntry = await readFile(desktopFile, 'utf8');
  assert(desktopEntry.includes('Name=Local AI Desktop'));
  assert(desktopEntry.includes('Exec=/opt/local-ai-desktop/local-ai-desktop %U'));
  const opt = join(payload, 'opt');
  const installationName = (await readdir(opt))[0];
  assert.equal(installationName, 'local-ai-desktop', 'the installed executable directory must not contain spaces');
  const installation = join(opt, installationName);
  const executable = join(installation, 'local-ai-desktop');
  // Unprivileged extraction cannot reproduce the installer's root-owned SUID
  // helper/AppArmor policy. Use a trusted configured/system helper here; never
  // pass --no-sandbox. This alters only the temporary extracted payload.
  execFileSync('bash', ['-c', 'source "$1/scripts/electron-sandbox.sh"; select_electron_sandbox "$2"', 'sandbox', join(installation, 'resources/app'), executable]);
  // Exported variables from the shell above cannot affect this Node process.
  // Pick the same optional trusted helper explicitly for the smoke launch.
  const candidates = [process.env.LOCAL_AI_CHROME_SANDBOX, '/usr/lib/chromium/chrome-sandbox', '/usr/lib/chromium-browser/chrome-sandbox', '/opt/google/chrome/chrome-sandbox'].filter(Boolean);
  let helper;
  for (const candidate of candidates) {
    try { if (execFileSync('stat', ['-Lc', '%u:%a', candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '0:4755') { helper = candidate; break; } } catch { /* Try next helper. */ }
  }
  const dataRoot = join(fixture, 'user data');
  const env = { ...process.env, LOCAL_AI_RUNTIME_ROOT: dataRoot, LOCAL_AI_LLAMA_SERVER_PATH: join(fixture, 'missing server'), LOCAL_AI_LLAMA_PORT: '18094',
    ...(helper ? { CHROME_DEVEL_SANDBOX: helper } : {}) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.LOCAL_AI_LAUNCHER_MANAGED; delete env.LOCAL_AI_DEV_SERVER_URL;
  const launch = async () => {
    application = await electron.launch({ executablePath: executable, cwd: fixture, env, timeout: 30_000 });
    const page = await application.firstWindow();
    await page.waitForSelector('.composer textarea');
    return page;
  };
  let page = await launch();
  const first = await page.evaluate(() => window.localAi.settings.get());
  assert(first.setup.issues.some((issue) => issue.includes('исполняемого')));
  assert(first.setup.models.every((model) => !model.installed));
  assert.equal(first.llamaRuntime.status, 'idle'); assert.equal(first.llamaRuntime.modelId, null);
  assert.equal((await page.evaluate(() => window.localAi.models.list())).length, 3);
  let setup = page.getByRole('dialog'); await setup.waitFor();
  assert((await setup.innerText()).includes('Добавьте GGUF'));
  const setupButton = page.getByRole('button', { name: /Настроить модели/ });
  await setupButton.waitFor();
  assert.notEqual(await setupButton.evaluate((element) => getComputedStyle(element).animationName), 'none', 'setup should draw attention before a usable model exists');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await setupButton.evaluate((element) => getComputedStyle(element).animationName), 'none', 'reduced motion disables attention pulse');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setup.getByRole('button', { name: 'Закрыть настройки' }).click();
  await setup.waitFor({ state: 'detached' });
  const dismissed = await page.evaluate(() => window.localAi.settings.dismissSetup());
  assert.equal(dismissed.setup.config.setupDismissed, true, 'dismissal persists and must not repeatedly reopen setup');
  await application.close(); application = undefined;
  page = await launch();
  assert.equal(await page.getByRole('dialog').count(), 0, 'dismissed incomplete setup stays closed after restart');
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.autoOpen, false);
  const openSetupButton = page.getByRole('button', { name: /Настроить модели/ });
  assert.equal(await openSetupButton.isDisabled(), false, 'incomplete setup entry remains available after dismissal');
  await openSetupButton.click();
  setup = page.getByRole('dialog');
  await setup.waitFor({ timeout: 5_000 });
  const weights = join(fixture, 'models with spaces'); await mkdir(weights);
  const server = join(fixture, "llama server 'fixture'");
  await writeFile(server, '#!/bin/sh\nexit 1\n'); await chmod(server, 0o755);
  await setup.getByLabel('Путь к llama-server').fill(server);
  await setup.getByLabel('Каталог моделей').fill(weights);
  await setup.getByLabel('GPU-слои по умолчанию').fill('0');
  await setup.getByRole('button', { name: 'Сохранить изменения' }).click();
  await setup.getByRole('status').filter({ hasText: 'Настройки сохранены' }).waitFor();
  const saved = JSON.parse(await readFile(first.setup.configPath, 'utf8'));
  assert.equal(saved.llamaServerPath, server); assert.equal(saved.modelsPath, weights); assert.equal(saved.gpuLayers, 0);
  const modelFile = join(weights, 'arbitrary model.gguf'); await writeFile(modelFile, ggufFixture());
  const customId = `custom:${crypto.randomUUID()}`;
  const withCustom = await page.evaluate(async ({ modelFile, customId }) => {
    const current = await window.localAi.settings.get();
    return window.localAi.settings.save({ ...current.setup.config, models: [...current.setup.config.models, {
      id: customId, displayName: 'Arbitrary Fixture', modelPath: modelFile, mmprojPath: '', gpuLayers: null,
      supportsTools: false, speculative: 'none', builtin: false,
    }] });
  }, { modelFile, customId });
  assert.equal(withCustom.setup.ready, true, 'arbitrary custom GGUF plus executable server is ready');
  assert.equal(withCustom.setup.models.find((model) => model.id === customId)?.status, 'ready');
  assert((await page.evaluate(() => window.localAi.models.list())).some((model) => model.id === customId));
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, cwd: process.cwd(), resources: process.resourcesPath }));
  assert(identity.packaged); assert.equal(identity.cwd, fixture);
  const binary = join(identity.resources, 'agent/local-ai-agent-runtime');
  assert.match(execFileSync('file', [binary], { encoding: 'utf8' }), /static(-pie)? linked/, 'shipped helper must not require the build host glibc');
  const code = await readFile(join(identity.resources, 'app/dist/main/services/paths.js'), 'utf8');
  assert(code.includes('agent/local-ai-agent-runtime'));
  await application.close(); application = undefined;
  page = await launch();
  const restored = await page.evaluate(() => window.localAi.settings.get());
  assert.equal(restored.setup.server, server); assert.equal(restored.setup.config.modelsPath, weights); assert.equal(restored.setup.config.gpuLayers, 0);
  assert.equal(restored.setup.ready, true); assert.equal(restored.setup.autoOpen, false);
  const readyButton = page.getByRole('button', { name: /Настройки моделей и runtime/ });
  assert.equal(await readyButton.evaluate((element) => getComputedStyle(element).animationName), 'none', 'a usable model stops the setup animation');
  assert((await page.evaluate(() => window.localAi.models.list())).some((model) => model.id === customId));
  assert.equal(restored.llamaRuntime.status, 'idle', 'saved configuration never autoloads a model');
  await application.close(); application = undefined;
  assert(!(await readdir(dataRoot)).includes('llama-cpp-mtp-launcher.pid'), 'owned supervisor must stop on application quit');
  // Execute the shipped Rust helper against a deterministic local provider.
  // This catches missing native libraries, executable permissions and protocol
  // errors without allocating a real model.
  provider = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: '+JSON.stringify({ choices: [{ delta: { content: 'Packaged runtime response.' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  await new Promise((done, reject) => {
    const worker = spawn(binary, [], { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { worker.kill(); reject(new Error(`Rust helper timed out: ${errors}`)); }, 15_000);
    worker.on('error', reject);
    worker.stderr.on('data', (data) => { errors += data.toString(); });
    worker.stdout.on('data', (data) => {
      output += data.toString();
      if (output.split('\n').some((line) => { try { return JSON.parse(line).type === 'final'; } catch { return false; } })) worker.stdin.end();
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      try { assert.equal(code, 0, errors); assert(output.includes('Packaged runtime response.')); assert(output.includes('"complete":true')); done(); } catch (error) { reject(error); }
    });
    worker.stdin.write(JSON.stringify({ type: 'run', run_id: 'package-smoke', endpoint: `http://127.0.0.1:${provider.address().port}`, model: 'fixture', system: 'Answer briefly.', user: 'Say hello.', history: [], context_limit: 32_768, reasoning_mode: 'fast', web_mode: 'off', policy: 'auto' })+'\n');
  });
  console.log('Real Debian payload smoke passed: safe install path, desktop entry, root-owned sandbox helper/postinst SUID choice, Electron/preload/SQLite, first-run setup, persistent custom model, reduced-motion attention state, settings restart and shipped Rust response');
} finally {
  if (application) await application.close();
  if (provider) await new Promise((done) => provider.close(done));
  await rm(fixture, { recursive: true, force: true });
}
