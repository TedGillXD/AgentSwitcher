import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LocalBridge } from './bridge';
import { CodexProcess } from './platform/codex-process';
import { ProfileService } from './service';
import { defaultSettings, LocalStore } from './store';
import { AppError, errorCode } from './errors';
import type { AppState, Result, View } from '../shared/types';
import { version as packageVersion } from '../package.json';
import { getPanelBounds } from './panel-position';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
app.setName('AgentSwitcher');
app.setAppUserModelId('dev.agentswitcher.desktop');
// Dev/test isolation only; the packaged app always uses the OS application-data location.
if (!app.isPackaged && process.env.AGENT_SWITCHER_USER_DATA) app.setPath('userData', process.env.AGENT_SWITCHER_USER_DATA);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

let window: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let settingsReady: Promise<void> | null = null;
const trustedWindows = new Map<number, string>();
let tray: Tray | null = null;
let service: ProfileService | null = null;
let store: LocalStore | null = null;
let exiting = false;
let nativeDialog = false;
let initialError: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
interface PanelAnchor { point: Electron.Point; trayBounds?: Electron.Rectangle }
let lastPanelAnchor: PanelAnchor | null = null;
let panelDisplayId: number | null = null;
const bridge = new LocalBridge();
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererUrl = developmentUrl ?? pathToFileURL(join(mainDirectory, '../renderer/index.html')).href;

function positionPanel(anchor: PanelAnchor, display = screen.getDisplayNearestPoint(anchor.point)): void {
  if (!window || window.isDestroyed()) return;
  const bounds = getPanelBounds({ workArea: display.workArea, displayBounds: display.bounds,
    point: anchor.point, trayBounds: anchor.trayBounds, platform: process.platform });
  // Let a small or heavily scaled display fit the entire panel, including its close button.
  window.setMinimumSize(Math.min(340, bounds.width), Math.min(400, bounds.height));
  window.setBounds(bounds);
  lastPanelAnchor = anchor;
  panelDisplayId = display.id;
}

function showPanel(view?: View, anchor?: PanelAnchor): void {
  if (view === 'settings') { void showSettings(); return; }
  if (exiting || !window || window.isDestroyed()) return;
  positionPanel(anchor ?? { point: screen.getCursorScreenPoint(), trayBounds: tray?.getBounds() });
  window.show();
  window.focus();
  if (view) window.webContents.send('switcher:navigate', view);
  void publishState();
}

function secureWindow(target: BrowserWindow, url: string): void {
  trustedWindows.set(target.webContents.id, url);
  const id = target.webContents.id;
  target.on('closed', () => trustedWindows.delete(id));
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event, next) => { if (next !== url) event.preventDefault(); });
  target.webContents.on('will-attach-webview', (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

async function showSettings(profileId?: string): Promise<void> {
  if (profileId !== undefined && (typeof profileId !== 'string' || profileId.length > 64)) throw new AppError('INVALID_PROFILE');
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    await settingsReady;
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    settingsWindow.show();
    settingsWindow.focus();
    if (profileId !== undefined) settingsWindow.webContents.send('switcher:edit-profile', profileId || null);
    await publishState();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(960, area.width - 32);
  const height = Math.min(760, area.height - 32);
  const target = new BrowserWindow({
    width, height, minWidth: Math.min(800, width), minHeight: Math.min(620, height),
    x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2),
    frame: false, show: false, resizable: true, fullscreenable: false,
    backgroundColor: '#14151b', title: 'AgentSwitcher',
    icon: join(app.getAppPath(), 'resources/tray.png'),
    webPreferences: { preload: join(mainDirectory, '../preload/index.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  settingsWindow = target;
  const url = new URL(rendererUrl);
  url.searchParams.set('window', 'settings');
  if (profileId !== undefined) url.searchParams.set('profile', profileId);
  secureWindow(target, url.href);
  target.on('close', (event) => { if (!exiting) { event.preventDefault(); target.hide(); } });
  target.on('closed', () => { if (settingsWindow === target) settingsWindow = null; });
  settingsReady = target.loadURL(url.href);
  try { await settingsReady; } finally { settingsReady = null; }
  target.show();
  target.focus();
  await publishState();
}

function zh(): boolean { return store?.settings.language !== 'en'; }

async function requestQuit(confirm = true): Promise<void> {
  if (exiting || service?.isBusy || nativeDialog) return;
  if (confirm && bridge.isRunning()) {
    nativeDialog = true;
    try {
      const result = await dialog.showMessageBox({
        type: 'question', title: 'AgentSwitcher',
        message: zh() ? '退出后，API 连接将中断' : 'Quitting disconnects the API connection',
        detail: zh() ? '可以先切回 ChatGPT，或保持 AgentSwitcher 在托盘运行。' : 'Switch back to ChatGPT first, or keep AgentSwitcher running in the tray.',
        buttons: zh() ? ['留在托盘', '退出'] : ['Keep running', 'Quit'], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) return;
    } finally { nativeDialog = false; }
  }
  exiting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  await bridge.stop();
  app.quit();
}

function updateTray(state: AppState): void {
  if (!tray) return;
  const isZh = state.settings.language === 'zh-CN';
  const text = (cn: string, en: string) => isZh ? cn : en;
  const activeName = state.profiles.find(profile => profile.id === state.activeProfile)?.name;
  tray.setToolTip(`AgentSwitcher · ${activeName ?? (state.activeProfile === 'chatgpt' ? 'ChatGPT' : text('其他配置', 'Other profile'))}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text('打开 AgentSwitcher', 'Open AgentSwitcher'), click: () => showPanel() },
    { type: 'separator' },
    { label: 'ChatGPT', type: 'radio', checked: state.activeProfile === 'chatgpt', enabled: !service?.isBusy, click: () => void traySwitch('chatgpt') },
    ...state.profiles.map(profile => ({ label: profile.name.replace(/&/g, '&&'), type: 'radio' as const,
      checked: state.activeProfile === profile.id, enabled: profile.hasApiKey && state.encryptionAvailable && !service?.isBusy,
      click: () => void traySwitch(profile.id) })),
    { type: 'separator' },
    { label: text('设置…', 'Settings…'), click: () => showPanel('settings') },
    { label: text('退出', 'Quit'), enabled: !service?.isBusy, click: () => void requestQuit() },
  ]));
}

async function traySwitch(profile: string): Promise<void> {
  if (!service) return;
  nativeDialog = true;
  try {
    const result = await dialog.showMessageBox({
      type: 'question', title: 'AgentSwitcher',
      message: zh() ? '切换配置并重启 Codex？' : 'Switch profile and restart Codex?',
      detail: zh() ? '若 5 秒内未退出，将强制终止桌面进程。未保存的任务可能丢失，请先保存工作。' : 'If the desktop does not exit within 5 seconds, it will be force stopped. Unsaved work may be lost. Save your work first.',
      buttons: zh() ? ['取消', '切换并重启'] : ['Cancel', 'Switch & restart'], defaultId: 0, cancelId: 0,
    });
    if (result.response !== 1) return;
    await service.switchProfile(profile);
  } catch (error) {
    showPanel();
    await dialog.showMessageBox({ type: 'error', title: 'AgentSwitcher', message: zh() ? '切换未完成' : 'Switch failed', detail: errorCode(error) });
  } finally { nativeDialog = false; await publishState(); }
}

async function publishState(): Promise<void> {
  if (!service || exiting) return;
  const state = await service.getState();
  if (initialError) state.lastError = initialError;
  broadcastState(state);
  updateTray(state);
}

function broadcastState(state: AppState): void {
  for (const target of [window, settingsWindow]) {
    if (target && !target.isDestroyed()) target.webContents.send('switcher:changed', state);
  }
}

function registerIpc(): void {
  const handle = <T>(channel: string, action: (...args: any[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
      const frame = event.senderFrame;
      const trustedUrl = trustedWindows.get(event.sender.id);
      if (!trustedUrl || !frame || frame !== event.sender.mainFrame ||
          frame.url !== trustedUrl && frame.url !== `${trustedUrl}/`) return { ok: false, error: 'ACCESS_DENIED' };
      try { return { ok: true, value: await action(...args) }; }
      catch (error) { return { ok: false, error: errorCode(error) }; }
    });
  };
  const ready = (): ProfileService => {
    if (initialError || !service) throw new AppError(initialError ?? 'OPERATION_FAILED');
    return service;
  };
  handle('switcher:state', async () => {
    const state = await service!.getState();
    if (initialError) state.lastError = initialError;
    return state;
  });
  handle('switcher:save', (input) => ready().saveSettings(input));
  handle('switcher:save-profile', (input) => ready().saveProfile(input));
  handle('switcher:delete-profile', (id) => ready().deleteProfile(id));
  handle('switcher:open-settings', (id) => showSettings(id));
  handle('switcher:close-settings', () => { settingsWindow?.hide(); });
  handle('switcher:switch', (profile) => ready().switchProfile(profile));
  handle('switcher:restart', () => ready().restartCodex());
  handle('switcher:test', (input) => ready().testConnection(input));
  handle('switcher:choose-app', async () => {
    nativeDialog = true;
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? settingsWindow ?? window!, {
        title: zh() ? '选择 Codex 桌面应用' : 'Choose Codex Desktop',
        properties: ['openFile'],
        filters: [{ name: 'Desktop application', extensions: process.platform === 'darwin' ? ['app'] : ['exe'] }],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    } finally { nativeDialog = false; }
  });
  handle('switcher:choose-home', async () => {
    nativeDialog = true;
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() ?? settingsWindow ?? window!, {
        title: zh() ? '选择 Codex 配置目录' : 'Choose Codex configuration folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    } finally { nativeDialog = false; }
  });
  handle('switcher:open-config', async () => {
    await mkdir(store!.settings.codexHome, { recursive: true });
    if (await shell.openPath(store!.settings.codexHome)) throw new AppError('OPEN_FOLDER_FAILED');
  });
  handle('switcher:hide', () => { window?.hide(); });
  // Renderer has its own interruption confirmation; OS menu/quit uses native confirmation.
  handle('switcher:quit', () => { setImmediate(() => void requestQuit(false)); });
}

if (hasLock) app.whenReady().then(async () => {
  const codec = {
    isEncryptionAvailable: () => ['win32', 'darwin'].includes(process.platform) && safeStorage.isEncryptionAvailable(),
    encryptString: (value: string) => safeStorage.encryptString(value),
    decryptString: (value: Buffer) => safeStorage.decryptString(value),
  };
  store = new LocalStore(join(app.getPath('userData'), 'settings.json'), codec, defaultSettings());
  try { await store.load(); } catch (error) { initialError = errorCode(error); }
  service = new ProfileService({
    store, bridge, processes: new CodexProcess(), version: app.isPackaged ? app.getVersion() : packageVersion,
    onChange: (state) => {
      broadcastState(state);
      updateTray(state);
    },
    onLoginPreference: (enabled) => {
      if (!app.isPackaged && enabled) throw new AppError('LOGIN_REQUIRES_INSTALL');
      app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}) });
    },
  });
  if (!initialError) await service.initialize();
  if (process.platform === 'darwin') app.dock?.hide();
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' },
  ]) : null);
  window = new BrowserWindow({
    width: 460, height: 740, minWidth: 340, minHeight: 400, frame: false,
    show: false, resizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#14151b',
    icon: join(app.getAppPath(), 'resources/tray.png'),
    webPreferences: {
      preload: join(mainDirectory, '../preload/index.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false,
    },
  });
  registerIpc();
  window.on('close', (event) => { if (!exiting) { event.preventDefault(); window?.hide(); } });
  secureWindow(window, rendererUrl);
  const openedAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  window.once('ready-to-show', () => { if (!process.argv.includes('--hidden') && !openedAtLogin) showPanel(); });
  const trayImage = nativeImage.createFromPath(join(app.getAppPath(), 'resources', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.on('click', (_event, bounds, position) => {
    // Windows supplies a global DIP point; macOS may supply an icon-local point.
    const point = process.platform === 'darwin' ? screen.getCursorScreenPoint() : position ?? screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    if (window?.isVisible() && panelDisplayId === display.id) window.hide();
    else showPanel(undefined, { point, trayBounds: bounds });
  });
  tray.on('double-click', (_event, bounds) => showPanel(undefined, { point: screen.getCursorScreenPoint(), trayBounds: bounds }));
  screen.on('display-metrics-changed', (_event, display) => {
    if (window?.isVisible() && display.id === panelDisplayId && lastPanelAnchor) positionPanel(lastPanelAnchor, display);
  });
  screen.on('display-removed', (_event, display) => {
    if (window?.isVisible() && display.id === panelDisplayId) positionPanel({ point: screen.getCursorScreenPoint() });
  });
  await window.loadURL(rendererUrl);
  await publishState();
  refreshTimer = setInterval(() => { if ((window?.isVisible() || settingsWindow?.isVisible()) && !service?.isBusy) void publishState(); }, 15000);
}).catch(() => {
  dialog.showErrorBox('AgentSwitcher', 'STARTUP_FAILED');
  app.exit(1);
});

app.on('second-instance', () => showPanel());
app.on('activate', () => showPanel());
app.on('window-all-closed', () => { /* Tray owns application lifetime. */ });
app.on('before-quit', (event) => {
  if (!exiting) { event.preventDefault(); void requestQuit(); }
});
