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
  const profileHome = join(fixture, 'home'); await mkdir(profileHome);
  const portProbe = createServer();
  await new Promise((done) => portProbe.listen(0, '127.0.0.1', done));
  const runtimePort = portProbe.address().port;
  await new Promise((done) => portProbe.close(done));
  const env = { ...process.env, HOME: profileHome, LOCAL_AI_RUNTIME_ROOT: dataRoot, LOCAL_AI_LLAMA_SERVER_PATH: '', LOCAL_AI_LLAMA_PORT: String(runtimePort), LOCAL_AI_LLAMA_CPP_URL: `http://127.0.0.1:${runtimePort}`,
    ...(helper ? { CHROME_DEVEL_SANDBOX: helper } : {}) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.LOCAL_AI_LAUNCHER_MANAGED; delete env.LOCAL_AI_DEV_SERVER_URL;
  const launch = async (overrides = {}) => {
    application = await electron.launch({ executablePath: executable, cwd: fixture, env: { ...env, ...overrides }, timeout: 30_000 });
    const page = await application.firstWindow();
    await page.waitForSelector('.composer textarea');
    return page;
  };
  const chooseLanguage = async (label) => application.evaluate(({ Menu }, label) => {
    const entry = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === label);
    if (!entry) throw new Error('Language menu entry missing');
    entry.click();
  }, label);
  const checkedLanguage = () => application.evaluate(({ Menu }) => {
    const options = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []);
    return options.find((item) => item.label === 'English')?.checked ? 'en' : options.find((item) => item.label === 'Русский')?.checked ? 'ru' : null;
  });
  let page = await launch();
  const first = await page.evaluate(() => window.localAi.settings.get());
  assert.equal(first.setup.config.llamaServerPath, null);
  assert.equal(first.setup.config.language, 'en');
  assert.equal(await checkedLanguage(), 'en');
  assert(first.setup.issues.some((issue) => issue.includes('llama-server')));
  assert(first.setup.models.every((model) => !model.installed));
  assert.equal(first.llamaRuntime.status, 'idle'); assert.equal(first.llamaRuntime.modelId, null);
  assert.equal((await page.evaluate(() => window.localAi.models.list())).length, 3);
  let setup = page.getByRole('dialog'); await setup.waitFor();
  await setup.getByRole('heading', { name: 'Models and runtime', exact: true }).waitFor();
  const languageSelect = setup.getByTestId('setup-language');
  assert.deepEqual(await languageSelect.locator('option').allTextContents(), ['English (EN)', 'Русский (RU)']);
  assert.equal(await languageSelect.inputValue(), 'en');
  assert.equal(await setup.getByTestId('executable-helper').innerText(), 'Enter the llama-server executable or a folder to search.');
  const examples = setup.getByTestId('executable-examples').locator('small');
  assert.deepEqual(await examples.allTextContents(), ['File: /DATA/llama/bin/llama-server', 'Folder: /DATA']);
  const firstExample = await examples.nth(0).boundingBox(), secondExample = await examples.nth(1).boundingBox();
  assert(secondExample.y >= firstExample.y + firstExample.height, 'examples must occupy separate lines');
  assert.equal(await setup.getByTestId('executable-result').getAttribute('data-tone'), 'neutral');
  const draftExecutable = join(fixture, 'unsaved executable');
  const draftModels = join(fixture, 'unsaved models');
  const draftGguf = join(fixture, 'unsaved model.gguf');
  await setup.getByLabel('Path to llama-server or its folder').fill(draftExecutable);
  await setup.getByLabel('Models directory').fill(draftModels);
  await setup.getByRole('button', { name: `Edit ${first.setup.config.models[0].displayName}`, exact: true }).click();
  await setup.getByLabel('Model GGUF file').fill(draftGguf);
  assert(!(await setup.locator('.runtime-model-editor').innerText()).includes('Vision projector device'));
  assert(!(await setup.locator('.runtime-model-editor').innerText()).includes('Choose CPU or GPU in the Image Processing menu'));
  await setup.getByTestId('executable-validation').filter({ hasText: 'File does not exist' }).waitFor();
  await languageSelect.selectOption('ru');
  await setup.getByRole('heading', { name: 'Модели и runtime', exact: true }).waitFor();
  assert.equal(await checkedLanguage(), 'ru');
  assert.equal(await setup.getByLabel('Путь к llama-server или папке с ним').inputValue(), draftExecutable);
  assert.equal(await setup.getByLabel('Каталог моделей').inputValue(), draftModels);
  assert.equal(await setup.getByLabel('Файл модели GGUF').inputValue(), draftGguf);
  assert(!(await setup.locator('.runtime-model-editor').innerText()).includes('Устройство vision projector'));
  assert(!(await setup.locator('.runtime-model-editor').innerText()).includes('Выберите CPU или GPU в меню'));
  assert((await setup.getByTestId('executable-validation').innerText()).includes('Файл не существует'));
  assert.equal(JSON.parse(await readFile(first.setup.configPath, 'utf8')).language, 'ru', 'language persists without Save');
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.llamaServerPath, null);
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.modelsPath, first.setup.config.modelsPath);
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.models[0].modelPath, first.setup.config.models[0].modelPath, 'language changes must not save draft GGUF edits');
  await languageSelect.selectOption('en');
  await setup.getByRole('heading', { name: 'Models and runtime', exact: true }).waitFor();
  assert.equal(await checkedLanguage(), 'en');
  assert.equal(await setup.getByLabel('Path to llama-server or its folder').inputValue(), draftExecutable);
  assert.equal(await setup.getByLabel('Models directory').inputValue(), draftModels);
  assert.equal(await setup.getByLabel('Model GGUF file').inputValue(), draftGguf);
  assert.equal(JSON.parse(await readFile(first.setup.configPath, 'utf8')).language, 'en');
  await chooseLanguage('Русский');
  await setup.getByRole('heading', { name: 'Модели и runtime', exact: true }).waitFor();
  assert.equal(await languageSelect.inputValue(), 'ru', 'existing menu synchronizes setup dropdown');
  assert((await setup.innerText()).includes('Проверьте пути и сохраните настройки'));
  console.log('PASS: fresh English default, setup language selector, immediate EN/RU switching, menu synchronization and language-only persistence with unsaved runtime/model inputs');
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
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.language, 'ru');
  assert.equal(await checkedLanguage(), 'ru');
  const openSetupButton = page.getByRole('button', { name: /Настроить модели/ });
  assert.equal(await openSetupButton.isDisabled(), false, 'incomplete setup entry remains available after dismissal');
  await openSetupButton.click();
  setup = page.getByRole('dialog');
  await setup.waitFor({ timeout: 5_000 });
  assert.equal(await setup.getByTestId('setup-language').inputValue(), 'ru');
  const weights = join(fixture, 'models with spaces'); await mkdir(weights);
  // This fake server confirms launcher behavior without allocating a model.
  const server = join(fixture, "llama server 'fixture'");
  await writeFile(server, `#!${process.execPath}
const { createServer } = require('node:http');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--model --ctx-size --port'); process.exit(0); }
const value = (flag) => args[args.indexOf(flag) + 1];
const model = value('--alias'); const context = Number(value('--ctx-size'));
console.log('llama_kv_cache: size = 1 K (f16): 1 V (f16):');
createServer((request, response) => {
 response.setHeader('content-type', 'application/json');
 response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: model, n_ctx: context, object: 'model' }] } : { status: 'ok' }));
}).listen(Number(value('--port')), '127.0.0.1');
`); await chmod(server, 0o755);
  const pathInput = setup.getByLabel('Путь к llama-server или папке с ним');
  const banner = setup.locator('.runtime-readiness');
  const validation = setup.getByTestId('executable-validation');
  const result = setup.getByTestId('executable-result');
  const rgb = async (locator, property = 'color') => locator.evaluate((element, property) => getComputedStyle(element)[property].match(/\d+/g).slice(0, 3).map(Number), property);
  const green = async (locator) => { const [r, g, b] = await rgb(locator); assert(g > r && g > b, 'verified text/icon must be green'); };
  const amber = async (locator, property = 'color') => { const [r, g, b] = await rgb(locator, property); assert(r > g && g > b, 'unsaved/search warning must be amber'); };
  const red = async (locator) => { const [r, g, b] = await rgb(locator); assert(r > g && r > b, 'invalid status must be red'); };
  await pathInput.fill(''); await validation.filter({ hasText: 'Не настроен' }).waitFor();
  assert.equal(await result.getAttribute('data-tone'), 'neutral');
  assert.equal(await setup.getByTestId('resolved-executable').count(), 0);
  assert.equal(await setup.getByTestId('executable-helper').innerText(), 'Укажите исполняемый файл llama-server или папку, в которой его нужно найти.');
  assert.deepEqual(await setup.getByTestId('executable-examples').locator('small').allTextContents(), ['Файл: /DATA/llama/bin/llama-server', 'Папка: /DATA']);
  await pathInput.fill(join(fixture, 'does not exist')); await validation.filter({ hasText: 'Файл не существует' }).waitFor();
  assert.equal(await result.getAttribute('data-tone'), 'danger'); await red(validation.locator('strong'));
  assert.equal(await banner.getAttribute('data-state'), 'invalid');
  const notExecutable = join(fixture, 'not executable'); await writeFile(notExecutable, 'fixture');
  await pathInput.fill(notExecutable); await validation.filter({ hasText: 'Файл не является исполняемым' }).waitFor();
  const unsupported = join(fixture, 'unsupported'); await writeFile(unsupported, '#!/bin/sh\necho unrelated\n'); await chmod(unsupported, 0o755);
  await pathInput.fill(unsupported); await validation.filter({ hasText: 'Некорректный или неподдерживаемый' }).waitFor();
  const slow = join(fixture, 'slow validation');
  await writeFile(slow, `#!${process.execPath}\nsetTimeout(() => console.log('unrelated'), 1200);\n`); await chmod(slow, 0o755);
  await pathInput.fill(slow); await page.waitForTimeout(450);
  await pathInput.fill(server); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  await page.waitForTimeout(1400);
  assert((await validation.innerText()).includes('llama-server найден и проверен'), 'an old unsupported result must not override the current path');
  assert(!(await setup.innerText()).includes('Не найден llama-server в PATH'), 'validated explicit path must suppress the stale PATH warning');
  assert(!(await banner.innerText()).includes('Не выбран llama-server'), 'banner must describe the validated draft path');
  assert.equal(await result.getAttribute('data-tone'), 'success'); await green(validation.locator('strong'));
  assert.equal(await validation.locator('svg').count(), 1);
  assert((await setup.getByTestId('resolved-executable').innerText()).includes(server));
  assert.equal(await setup.getByTestId('resolved-executable').locator('input').count(), 0);
  assert.equal(await setup.getByTestId('resolved-executable').locator('code').evaluate((element) => getComputedStyle(element).userSelect), 'text');
  assert.equal(await banner.getAttribute('data-state'), 'unsaved'); await amber(banner.locator('strong')); await amber(banner, 'borderLeftColor');
  assert.equal(await setup.getByTestId('executable-examples').count(), 0);
  assert((await banner.innerText()).includes('не сохранены'));
  assert.notEqual((await page.evaluate(() => window.localAi.settings.get())).setup.config.llamaServerPath, server, 'draft is not persisted by validation');

  await pathInput.fill(''); await validation.filter({ hasText: 'Не настроен' }).waitFor();
  assert((await banner.innerText()).includes('Не настроен'));
  await pathInput.fill(join(fixture, 'does not exist')); await validation.filter({ hasText: 'Файл не существует' }).waitFor();
  assert((await banner.innerText()).includes('Файл не существует'));
  await pathInput.fill(server); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();

  console.log('PASS: packaged file validation and stale-response suppression');
  // Smart path input resolves only the supplied directory tree.
  assert.equal(await setup.getByRole('button', { name: 'Найти llama-server автоматически' }).count(), 0);
  const emptyFolder = join(fixture, 'empty folder'); await mkdir(emptyFolder);
  await pathInput.fill(emptyFolder); await validation.filter({ hasText: 'В указанной папке не найден llama-server.' }).waitFor();
  const slowFolder = join(fixture, 'slow search folder'); await mkdir(slowFolder);
  const probeLog = join(fixture, 'help-probes.log');
  await writeFile(join(slowFolder, 'llama-server'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(probeLog)}, 'probe\\n');\nsetTimeout(() => console.log('--model --ctx-size --port'), 5000);\n`);
  await chmod(join(slowFolder, 'llama-server'), 0o755);
  await pathInput.fill(slowFolder); await validation.filter({ hasText: 'Проверка файла или поиск' }).waitFor();
  await page.waitForTimeout(450);
  await pathInput.fill(server); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  await page.waitForTimeout(2100);
  assert((await validation.innerText()).includes('llama-server найден и проверен'), 'cancelled directory search cannot replace newer validation');
  await pathInput.fill(slowFolder);
  await validation.filter({ hasText: 'Проверка файла или поиск' }).waitFor(); await page.waitForTimeout(450);
  const probesBeforeLanguage = await readFile(probeLog, 'utf8');
  await setup.getByTestId('setup-language').selectOption('en');
  await validation.filter({ hasText: 'Checking file or searching' }).waitFor();
  assert.equal(await setup.getByLabel('Path to llama-server or its folder').inputValue(), slowFolder);
  await validation.filter({ hasText: 'Could not finish searching this folder' }).waitFor();
  assert.equal(await readFile(probeLog, 'utf8'), probesBeforeLanguage, 'language switch must not restart the in-flight executable probe');
  await setup.getByTestId('setup-language').selectOption('ru');
  await validation.filter({ hasText: 'Не удалось завершить поиск в этой папке' }).waitFor();
  assert(!(await validation.innerText()).includes('не найден llama-server'), 'failed probes must not be presented as a complete empty search');
  assert.equal(await result.getAttribute('data-tone'), 'warning'); await amber(validation.locator('strong'));
  assert.equal(await setup.getByTestId('resolved-executable').count(), 0);
  // A depth-limited search with one verified match must still require a choice.
  const partialFolder = join(fixture, 'partial folder');
  const partialCandidate = join(partialFolder, 'llama-server');
  await mkdir(join(partialFolder, 'a/b/c/d/e/f/g'), { recursive: true });
  await writeFile(partialCandidate, await readFile(server)); await chmod(partialCandidate, 0o755);
  const unsearchedCandidate = join(partialFolder, 'a/b/c/d/e/f/g/llama-server');
  await writeFile(unsearchedCandidate, await readFile(server)); await chmod(unsearchedCandidate, 0o755);
  await pathInput.fill(partialFolder);
  await validation.filter({ hasText: 'Выберите один из найденных' }).waitFor();
  const partialNote = setup.getByTestId('incomplete-search-note');
  assert.equal(await partialNote.innerText(), 'Найден подходящий llama-server. Поиск остальных файлов не завершён.');
  assert.equal(await setup.getByRole('group', { name: 'Найденные исполняемые файлы' }).count(), 1);
  const choice = setup.getByRole('button', { name: partialCandidate, exact: true });
  await choice.waitFor(); assert.equal(await choice.getAttribute('aria-pressed'), 'false'); await green(choice.locator('svg'));
  assert.equal(await setup.getByTestId('resolved-executable').count(), 0, 'partial single candidate must not auto-select');
  assert.equal(await setup.getByRole('button', { name: 'Сохранить изменения' }).isDisabled(), true);
  assert.equal(await setup.getByRole('button', { name: unsearchedCandidate, exact: true }).count(), 0);
  await amber(partialNote);
  await setup.getByTestId('setup-language').selectOption('en');
  await validation.filter({ hasText: 'Choose one of the executables' }).waitFor();
  assert.equal(await partialNote.innerText(), 'A suitable llama-server was found. The search for other files is incomplete.');
  await setup.getByTestId('setup-language').selectOption('ru');
  await choice.click(); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert.equal(await choice.getAttribute('aria-pressed'), 'true'); assert((await choice.innerText()).includes('Выбрано'));
  await green(validation.locator('strong'));
  assert.equal(await partialNote.count(), 0, 'verified selection hides the partial-search warning');
  assert.equal(await pathInput.inputValue(), partialFolder);
  assert.equal(await banner.getAttribute('data-state'), 'unsaved');
  assert((await setup.getByTestId('resolved-executable').innerText()).includes(partialCandidate));
  await setup.getByTestId('setup-language').selectOption('en');
  await validation.filter({ hasText: 'llama-server found and verified' }).waitFor();
  assert.equal(await partialNote.count(), 0, 'verified selection stays free of redundant warnings in English');
  assert((await setup.getByTestId('resolved-executable').innerText()).startsWith('Executable:'));
  await setup.getByTestId('setup-language').selectOption('ru');
  await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  if (process.env.LOCAL_AI_PACKAGE_SMOKE_SCREENSHOTS === '1') {
    const review = await mkdtemp(join(tmpdir(), 'local-ai-setup-ux-'));
    await setup.evaluate((element) => { element.scrollTop = 0; });
    const screenshot = join(review, 'partial-selected.png');
    await setup.screenshot({ path: screenshot });
    console.log(`Setup UX screenshot: ${screenshot}`);
  }
  console.log('PASS: localized profile editor without projector instruction; partial-search feedback before selection, green verified selection without redundant warning, amber unsaved state');
  await mkdir(join(profileHome, 'tilde folder'));
  const tildeExecutable = join(profileHome, 'tilde folder/llama-server');
  await writeFile(tildeExecutable, await readFile(server)); await chmod(tildeExecutable, 0o755);
  await pathInput.fill('~/tilde folder'); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert((await setup.getByTestId('resolved-executable').innerText()).includes(tildeExecutable));
  const ancestor = join(fixture, 'smart folder with spaces');
  const candidateOne = join(ancestor, 'llama.cpp/build-cuda/bin/llama-server');
  const candidateTwo = join(ancestor, 'other build/bin/llama-server');
  await mkdir(join(ancestor, 'llama.cpp/build-cuda/bin'), { recursive: true });
  await writeFile(candidateOne, await readFile(server)); await chmod(candidateOne, 0o755);
  await pathInput.fill(join(ancestor, 'llama.cpp/build-cuda/bin'));
  await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert((await setup.getByTestId('resolved-executable').innerText()).includes(candidateOne));
  await pathInput.fill(ancestor); await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert.equal(await setup.locator('.runtime-executable-choice').count(), 0, 'unique complete result must auto-select without a second click');
  assert.equal(await result.getAttribute('data-tone'), 'success');
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.llamaServerPath, null, 'auto-selected result remains draft until Save');
  assert.equal(await pathInput.inputValue(), ancestor, 'resolving must preserve the entered folder');
  await mkdir(join(ancestor, 'other build/bin'), { recursive: true });
  await writeFile(candidateTwo, await readFile(server)); await chmod(candidateTwo, 0o755);
  // Change away and back to invalidate the previous single-candidate resolution.
  await pathInput.fill(emptyFolder); await validation.filter({ hasText: 'В указанной папке' }).waitFor();
  await pathInput.fill(ancestor);
  await validation.filter({ hasText: 'Выберите один из найденных' }).waitFor();
  await setup.getByRole('button', { name: candidateOne, exact: true }).waitFor();
  await setup.getByRole('button', { name: candidateTwo, exact: true }).waitFor();
  await setup.getByTestId('setup-language').selectOption('en');
  await validation.filter({ hasText: 'Choose one of the executables found' }).waitFor();
  assert.equal(await setup.getByLabel('Path to llama-server or its folder').inputValue(), ancestor);
  await setup.getByTestId('setup-language').selectOption('ru');
  await validation.filter({ hasText: 'Выберите один из найденных' }).waitFor();
  assert.equal(await setup.getByRole('button', { name: 'Сохранить изменения' }).isDisabled(), true);
  await setup.getByRole('button', { name: candidateTwo, exact: true }).click();
  await validation.filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert.equal(await pathInput.inputValue(), ancestor);
  assert((await setup.getByTestId('resolved-executable').innerText()).includes(candidateTwo));
  assert.equal(await setup.getByRole('button', { name: candidateTwo, exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await setup.getByRole('button', { name: candidateOne, exact: true }).getAttribute('aria-pressed'), 'false');
  const expectedExecutable = candidateTwo;

  console.log('PASS: packaged file/folder/tilde resolution, cancellation and explicit candidate selection');
  // Model availability must also follow draft paths before Save.
  const modelFile = join(weights, 'arbitrary model.gguf'); await writeFile(modelFile, ggufFixture());
  await setup.getByLabel('Каталог моделей').fill(weights);
  await setup.getByLabel('GPU-слои по умолчанию').fill('0');
  await setup.getByRole('button', { name: `Редактировать ${first.setup.config.models[0].displayName}`, exact: true }).click();
  await setup.getByLabel('Файл модели GGUF').fill(modelFile);
  await setup.getByLabel('Проектор GGUF').fill('');
  await banner.filter({ hasText: 'Доступных GGUF в текущих настройках: 1' }).waitFor();
  assert((await banner.innerText()).includes('сохраните для запуска'));
  assert((await setup.locator('.runtime-model-list').innerText()).includes('Файл доступен — сохраните настройки'));
  assert(!(await setup.innerText()).includes('Не найден llama-server в PATH'));
  // A failed save must preserve inputs and the distinction from saved settings.
  const absentFolder = join(fixture, 'absent models folder');
  await setup.getByLabel('Каталог моделей').fill(absentFolder);
  await setup.getByRole('status').filter({ hasText: 'Папка моделей не найдена — выберите существующую папку' }).waitFor();
  assert(!(await banner.innerText()).includes('Проверено — сохраните для запуска'));
  await setup.getByRole('button', { name: 'Сохранить изменения' }).click();
  await setup.locator('.runtime-setup-message').filter({ hasText: 'Каталог моделей не найден' }).waitFor();
  assert.equal(await setup.getByLabel('Каталог моделей').inputValue(), absentFolder);
  assert.equal(await pathInput.inputValue(), ancestor);
  assert((await banner.innerText()).includes('не сохранены'));
  assert.notEqual((await page.evaluate(() => window.localAi.settings.get())).setup.config.llamaServerPath, expectedExecutable);
  await setup.getByLabel('Каталог моделей').fill(weights);
  assert.equal(await setup.getByLabel('Файл модели GGUF').inputValue(), modelFile, 'base folder edits must not rewrite absolute GGUF paths');
  await setup.getByRole('button', { name: 'Сохранить изменения' }).click();
  await setup.locator('.runtime-setup-message').filter({ hasText: 'Настройки сохранены' }).waitFor();
  await banner.filter({ hasText: 'Сохранено — готово к запуску' }).waitFor();
  assert(!(await banner.innerText()).includes('не сохранены'));
  assert.equal(await banner.getAttribute('data-state'), 'ready'); await green(banner.locator('strong'));
  assert((await banner.innerText()).includes('Доступных GGUF в текущих настройках: 1'));
  console.log('PASS: packaged draft model counts, failed save preservation and saved readiness');
  // Exercise localized visible states via the application's real language menu.
  await chooseLanguage('English');
  await banner.filter({ hasText: 'Saved — ready to launch' }).waitFor();
  assert.equal(await setup.getByTestId('setup-language').inputValue(), 'en');
  assert((await banner.innerText()).includes('GGUF files available in current settings: 1'));
  assert.equal(await setup.getByLabel('Path to llama-server or its folder').inputValue(), ancestor);
  assert.equal(await setup.getByRole('button', { name: 'Find llama-server automatically', exact: true }).count(), 0);
  assert((await setup.getByLabel('Models directory').locator('..').locator('..').innerText()).includes('Models folder (GGUF)'));
  await chooseLanguage('Русский');
  await banner.filter({ hasText: 'Сохранено — готово к запуску' }).waitFor();
  assert.equal(await setup.getByTestId('setup-language').inputValue(), 'ru');
  const saved = JSON.parse(await readFile(first.setup.configPath, 'utf8'));
  assert.equal(saved.llamaServerInput, ancestor); assert.equal(saved.llamaServerPath, expectedExecutable); assert.equal(saved.modelsPath, weights); assert.equal(saved.gpuLayers, 0);
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
  console.log('PASS: packaged localized labels and persisted input/resolved path');
  // Save -> select -> start in the SAME Electron process, the original regression.
  const processBefore = await application.evaluate(() => process.pid);
  const chat = await page.evaluate(() => window.localAi.conversations.create());
  const selectedChat = await page.evaluate(({ id, modelId }) => window.localAi.conversations.update(id, { modelId }), { id: chat.id, modelId: customId });
  assert.equal(selectedChat.modelId, customId);
  const launched = await page.evaluate(() => window.localAi.runtime.state());
  assert.equal(launched.status, 'ready'); assert.equal(launched.modelId, customId);
  assert.equal(await application.evaluate(() => process.pid), processBefore, 'settings apply without Electron restart');
  const serverArgs = (await readFile(`/proc/${launched.serverPid}/cmdline`, 'utf8')).split('\0');
  assert(serverArgs.includes(expectedExecutable)); assert(!serverArgs.includes(ancestor), 'runtime must receive the executable, never its ancestor folder'); assert(serverArgs.includes(modelFile));
  assert.equal(serverArgs[serverArgs.indexOf('--gpu-layers') + 1], '0', 'default layers also refresh');
  const unchanged = await page.evaluate(async () => { const state = await window.localAi.settings.get(); await window.localAi.settings.save({ ...state.setup.config, allowBingFallback: true }); return window.localAi.runtime.state(); });
  assert.equal(unchanged.serverPid, launched.serverPid, 'unrelated settings do not restart an active server');
  console.log('PASS: packaged model launch without restart and stable PID on unrelated save');
  const identity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, cwd: process.cwd(), resources: process.resourcesPath }));
  assert(identity.packaged); assert.equal(identity.cwd, fixture);
  const binary = join(identity.resources, 'agent/local-ai-agent-runtime');
  assert.match(execFileSync('file', [binary], { encoding: 'utf8' }), /static(-pie)? linked/, 'shipped helper must not require the build host glibc');
  const code = await readFile(join(identity.resources, 'app/dist/main/services/paths.js'), 'utf8');
  assert(code.includes('agent/local-ai-agent-runtime'));
  await application.close(); application = undefined;
  page = await launch();
  const restored = await page.evaluate(() => window.localAi.settings.get());
  assert.equal(restored.setup.server, expectedExecutable); assert.equal(restored.setup.config.modelsPath, weights); assert.equal(restored.setup.config.gpuLayers, 0);
  assert.equal(restored.setup.ready, true); assert.equal(restored.setup.autoOpen, false);
  const readyButton = page.getByRole('button', { name: /Настройки моделей и runtime/ });
  assert.equal(await readyButton.evaluate((element) => getComputedStyle(element).animationName), 'none', 'a usable model stops the setup animation');
  assert((await page.evaluate(() => window.localAi.models.list())).some((model) => model.id === customId));
  assert.equal(restored.llamaRuntime.status, 'idle', 'saved configuration never autoloads a model');
  await readyButton.click();
  const reopened = page.getByRole('dialog');
  await reopened.locator('.runtime-readiness').filter({ hasText: 'Сохранено — готово к запуску' }).waitFor();
  assert.equal(await reopened.getByLabel('Путь к llama-server или папке с ним').inputValue(), ancestor);
  assert((await reopened.locator('.runtime-readiness').innerText()).includes('Доступных GGUF в текущих настройках: 2'));
  assert(!(await reopened.innerText()).includes('Не найден llama-server в PATH'));

  console.log('PASS: packaged persistence and settings UI after restart');
  // A moved/deleted saved candidate must require an explicit replacement.
  await rm(expectedExecutable);
  await reopened.getByRole('button', { name: 'Закрыть настройки' }).click();
  await page.getByRole('button', { name: /Настроить модели|Настройки моделей и runtime/ }).click();
  const recovery = page.getByRole('dialog');
  await recovery.getByTestId('executable-validation').filter({ hasText: 'Выберите один из найденных' }).waitFor();
  assert((await recovery.innerText()).includes('Ранее выбранный файл недоступен'));
  assert.equal(await recovery.getByLabel('Путь к llama-server или папке с ним').inputValue(), ancestor);
  await recovery.getByRole('button', { name: candidateOne, exact: true }).click();
  await recovery.getByTestId('executable-validation').filter({ hasText: 'llama-server найден и проверен' }).waitFor();
  assert((await recovery.getByTestId('resolved-executable').innerText()).includes(candidateOne));
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.llamaServerPath, expectedExecutable, 'recovery selection also requires Save');
  await recovery.getByTestId('setup-language').selectOption('en');
  await recovery.getByRole('heading', { name: 'Models and runtime', exact: true }).waitFor();
  await application.close(); application = undefined;
  page = await launch();
  assert.equal(await checkedLanguage(), 'en');
  assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.language, 'en');
  await page.getByRole('button', { name: /Configure models/ }).click();
  const englishRestored = page.getByRole('dialog');
  await englishRestored.getByRole('heading', { name: 'Models and runtime', exact: true }).waitFor();
  assert.equal(await englishRestored.getByTestId('setup-language').inputValue(), 'en');
  assert.equal(await englishRestored.getByLabel('Path to llama-server or its folder').inputValue(), ancestor);
  console.log('PASS: setup-selected English persists across restart without saving the runtime draft');

  await application.close(); application = undefined;
  assert(!(await readdir(dataRoot)).includes('llama-cpp-mtp-launcher.pid'), 'owned supervisor must stop on application quit');
  console.log('PASS: packaged missing-candidate recovery');
  // Simulate saved-language profiles, without editing SQLite or user data.
  for (const [name, preference, expected] of [['missing', undefined, 'en'], ['invalid', 'unknown', 'en'], ['russian', 'ru', 'ru'], ['english', 'en', 'en']]) {
    const profileRoot = join(fixture, `language-${name}`);
    await mkdir(join(profileRoot, 'app-data'), { recursive: true });
    const profileFile = join(profileRoot, 'app-data/runtime-settings.json');
    const config = { ...saved, language: preference, setupDismissed: false, llamaServerPath: null, llamaServerInput: '' };
    const original = JSON.stringify(config); await writeFile(profileFile, original);
    page = await launch({ LOCAL_AI_RUNTIME_ROOT: profileRoot });
    const profileSetup = page.getByRole('dialog');
    await profileSetup.getByRole('heading', { name: expected === 'en' ? 'Models and runtime' : 'Модели и runtime', exact: true }).waitFor();
    assert.equal(await profileSetup.getByTestId('setup-language').inputValue(), expected);
    assert.equal(await checkedLanguage(), expected);
    assert.equal((await page.evaluate(() => window.localAi.settings.get())).setup.config.language, expected);
    assert.equal(await readFile(profileFile, 'utf8'), original, 'startup must not rewrite existing preferences');
    await application.close(); application = undefined;
  }
  console.log('PASS: packaged missing/invalid language falls back to English; existing EN/RU profiles retain their language without rewriting settings');
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
  console.log('Extracted Debian payload smoke passed: Electron/preload/SQLite, visible draft/saved readiness, stale-path suppression, draft GGUF counts, failed save preserves edits, smart file/immediate/ancestor folder resolution, visible zero/multiple candidates and explicit selection, first-run settings -> actual fixture server launch without Electron restart, unchanged server on unrelated save, persistence/restart and shipped Rust fixture response. No system installation or real model inference.');
} finally {
  if (application) await application.close();
  if (provider) await new Promise((done) => provider.close(done));
  await rm(fixture, { recursive: true, force: true });
}
