import { app, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureAppDirectories, paths } from './services/paths';
import { log } from './services/logger';
import { startRuntimeSupervisor, stopRuntimeSupervisor } from './services/runtime-supervisor';

let mainWindow: BrowserWindow | null = null;
let shutdownStarted = false;

try { ensureAppDirectories(); }
catch (error) {
  dialog.showErrorBox('Local AI Desktop — каталог данных', `Не удалось создать каталоги данных: ${String(error)}. Укажите доступный каталог через LOCAL_AI_RUNTIME_ROOT.`);
  app.exit(1);
}
app.setPath('userData', paths.userData);
app.setPath('cache', paths.cache);
app.setPath('logs', paths.logs);
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
process.env.LOCAL_AI_LLAMA_CPP_URL ??= `http://127.0.0.1:${process.env.LOCAL_AI_LLAMA_PORT ?? '8081'}`;

function createWindow(): void {
  const preloadPath = join(__dirname, '../preload/index.js');
  const rendererPath = join(__dirname, '../renderer/index.html');
  // This variable is set exclusively by `npm run dev`. A normal local launch
  // must always use the already-built file renderer, even though it is not a
  // packaged Electron binary yet.
  const devServerUrl = app.isPackaged ? undefined : process.env.LOCAL_AI_DEV_SERVER_URL;
  if (!devServerUrl && !existsSync(rendererPath)) throw new Error(`Не найден production renderer: ${rendererPath}`);
  if (!existsSync(preloadPath)) throw new Error(`Не найден preload: ${preloadPath}`);
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 640,
    backgroundColor: '#111318',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => log('renderer.load.failed', { code, description, url }));
  mainWindow.webContents.on('did-finish-load', () => log('renderer.loaded', { source: devServerUrl ? 'development-server' : 'local-build' }));
  if (process.env.LOCAL_AI_DIAGNOSTICS === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void mainWindow?.webContents.executeJavaScript(`
          Promise.resolve().then(async () => {
            const api = window.localAi;
            const hardware = api ? await api.hardware.get() : null;
            return {
              url: window.location.href,
              preloadBridge: typeof api,
              rootText: document.getElementById('root')?.innerText.slice(0, 200) ?? '',
              hardwareAvailable: hardware !== null,
            };
          })
        `).then((result) => log('renderer.diagnostics', result)).catch((error: unknown) => log('renderer.diagnostics.failed', error instanceof Error ? { message: error.message } : undefined));
      }, 500);
    });
  }
  if (devServerUrl) void mainWindow.loadURL(devServerUrl); else void mainWindow.loadFile(rendererPath);
}

app.whenReady().then(async () => {
  await startRuntimeSupervisor();
  const { registerIpc } = await import('./ipc/register-ipc');
  registerIpc(); createWindow(); log('application.started');
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  // Electron exits synchronously by default. Keep the process alive just long
  // enough to abort requests and release models loaded through this app.
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void import('./ipc/register-ipc')
    .then(({ shutdownRuntime }) => shutdownRuntime())
    .then(() => stopRuntimeSupervisor())
    .catch((error: unknown) => log('runtime.shutdown.failed', error instanceof Error ? { message: error.message } : { error: String(error) }))
    .finally(() => {
      log('application.stopped');
      app.exit(0);
    });
});
