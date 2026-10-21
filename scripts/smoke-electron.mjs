// Real Electron + preload + OS encryption, with isolated user-data/Codex folders.
// This test never switches profiles, stops Codex, or calls a paid provider API.
import { _electron as electron, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-switcher-electron-'));
const dataDirectory = join(directory, 'user-data');
const codexHome = join(directory, 'codex');
await mkdir(codexHome, { recursive: true });
await mkdir(dataDirectory, { recursive: true });
// Keep this IPC/encryption test independent of real desktop installations and
// slow Store discovery. Process control has its own disposable native fixture.
await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify({
  version: 1, lastSwitchedAt: null,
  settings: { language: 'zh-CN', codexHome,
    codexAppPath: join(directory, 'not-installed', process.platform === 'darwin' ? 'Codex.app' : 'Codex.exe'),
    deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-flash',
    launchAtLogin: false, hideOnBlur: true },
}));
await mkdir('test-results', { recursive: true });
const environment = { ...process.env, AGENT_SWITCHER_USER_DATA: dataDirectory, CODEX_HOME: codexHome };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
// A blocked native permission prompt must fail CI and leave useful logs.
// Only the Electron child created by this test can be terminated here.
const deadline = setTimeout(() => {
  console.error('Electron smoke exceeded its 3 minute deadline.');
  if (application?.process().exitCode === null) application.process().kill('SIGKILL');
}, 180000);
deadline.unref();
async function closeApplication() {
  if (!application) return;
  const closing = application;
  application = undefined;
  const timeout = setTimeout(() => {
    if (closing.process().exitCode === null) closing.process().kill('SIGKILL');
  }, 10000);
  timeout.unref();
  try { await closing.close(); } finally { clearTimeout(timeout); }
}
const executable = process.env.AGENT_SWITCHER_EXECUTABLE;
const stage = (name) => { if (process.env.CI) console.log(`Electron smoke: ${name}`); };
const launchOptions = {
  env: environment, timeout: 45000,
  ...(executable ? { executablePath: resolve(executable), args: [`--user-data-dir=${dataDirectory}`] } : { args: [resolve('out/main/index.js')] }),
};
try {
  stage('launch isolated application');
  application = await electron.launch(launchOptions);
  stage('attached to main process');
  // macOS canonicalizes /var to /private/var for packaged apps.
  const actualDataDirectory = await application.evaluate(({ app }) => app.getPath('userData'));
  expect(await realpath(actualDataDirectory)).toBe(await realpath(dataDirectory));
  const page = await application.firstWindow({ timeout: 45000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByText('CODEX 配置', { exact: true })).toBeVisible({ timeout: 45000 });
  stage('panel ready');
  const initial = await page.evaluate(() => window.agentSwitcher.getState());
  expect(initial.settings.codexHome).toBe(codexHome);
  expect(initial.settings.language).toBe('zh-CN');
  expect(initial.hasApiKey).toBe(false);
  expect(initial.encryptionAvailable).toBe(true);
  expect(initial.codexInstalled).toBe(false);
  expect(initial.settings.hideOnBlur).toBe(false);
  expect(await page.evaluate(() => typeof require)).toBe('undefined');
  expect(await page.evaluate(() => typeof process)).toBe('undefined');
  // Capture this isolated app's tray, then emit clicks without moving the real mouse.
  const displays = await application.evaluate(({ app, Tray, screen }) => {
    const getBounds = Tray.prototype.getBounds;
    Tray.prototype.getBounds = function () {
      globalThis.__smokeTray = this;
      return getBounds.call(this);
    };
    try { app.emit('second-instance'); } finally { Tray.prototype.getBounds = getBounds; }
    if (!globalThis.__smokeTray) throw new Error('Test tray was not captured');
    return screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea }));
  });
  await page.evaluate(() => window.agentSwitcher.hideWindow());
  for (const display of displays) {
    const probe = await application.evaluate(({ BrowserWindow, screen }, target) => {
      const panel = BrowserWindow.getAllWindows()[0];
      const area = target.workArea;
      const point = { x: area.x + area.width - 22, y: area.y + area.height - 20 };
      const icon = { x: point.x - 8, y: point.y - 8, width: 16, height: 16 };
      const cursor = screen.getCursorScreenPoint;
      screen.getCursorScreenPoint = () => point;
      const eventPoint = process.platform === 'darwin' ? { x: 8, y: 8 } : point;
      try {
        globalThis.__smokeTray.emit('click', {}, icon, eventPoint);
        const bounds = panel.getBounds();
        panel.emit('blur');
        const staysOpen = panel.isVisible();
        // A saved click point may belong to another screen after a DPI/layout change.
        const currentDisplay = screen.getAllDisplays().find(display => display.id === target.id);
        const anotherDisplay = screen.getAllDisplays().find(display => display.id !== target.id);
        const nearest = screen.getDisplayNearestPoint;
        if (anotherDisplay) screen.getDisplayNearestPoint = () => anotherDisplay;
        try { screen.emit('display-metrics-changed', {}, currentDisplay, ['scaleFactor']); }
        finally { screen.getDisplayNearestPoint = nearest; }
        const afterMetrics = panel.getBounds();
        globalThis.__smokeTray.emit('click', {}, icon, eventPoint);
        const togglesClosed = !panel.isVisible();
        globalThis.__smokeTray.emit('click', {}, icon, eventPoint);
        return { bounds, afterMetrics, staysOpen, togglesClosed };
      } finally { screen.getCursorScreenPoint = cursor; }
    }, display);
    const { bounds } = probe;
    expect(probe.staysOpen).toBe(true);
    expect(probe.togglesClosed).toBe(true);
    expect(probe.afterMetrics).toEqual(bounds);
    expect(bounds.x).toBeGreaterThanOrEqual(display.workArea.x);
    expect(bounds.y).toBeGreaterThanOrEqual(display.workArea.y);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(display.workArea.x + display.workArea.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(display.workArea.y + display.workArea.height);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(display.workArea.x + display.workArea.width - 60);
  }
  const fixtureKey = 'sk-local-smoke-fixture-no-api-requests';
  stage('verify OS encryption and configuration windows');
  const saved = await page.evaluate(async ({ settings, key }) => window.agentSwitcher.saveSettings({ ...settings, apiKey: key, language: 'en', hideOnBlur: false }), { settings: initial.settings, key: fixtureKey });
  expect(saved.hasApiKey).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const persisted = await readFile(join(dataDirectory, 'settings.json'), 'utf8');
  expect(persisted).not.toContain(fixtureKey);
  expect(JSON.parse(persisted).encryptedSecrets).toBeTruthy();
  expect(JSON.stringify(saved)).not.toContain(fixtureKey);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.evaluate(() => Promise.all([window.agentSwitcher.openSettings('deepseek'), window.agentSwitcher.openSettings('general')]));
  const manager = application.windows().find(candidate => candidate !== page) ?? await application.waitForEvent('window', { predicate: candidate => candidate !== page, timeout: 5000 });
  expect(manager).toBeTruthy();
  manager.on('pageerror', (error) => errors.push(error.message));
  await expect(manager.locator('#codex-home')).toHaveValue(codexHome);
  await page.evaluate(() => window.agentSwitcher.openSettings('deepseek'));
  await expect(manager.locator('#base-url')).toHaveValue('https://api.deepseek.com');
  expect(new URL(manager.url()).searchParams.get('window')).toBe('settings');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(target => !target.webContents.getURL().includes('window=settings')).isVisible())).toBe(true);
  expect(await manager.evaluate(() => typeof require)).toBe('undefined');
  expect(await manager.locator('#api-key').inputValue()).toBe('');
  const secondKey = 'sk-second-profile-smoke-fixture-no-api-requests';
  const withProfile = await manager.evaluate(async key => window.agentSwitcher.saveProfile({
    name: 'GLM smoke', preset: 'glm', baseUrl: 'https://provider.example/v1', apiKey: key,
    protocol: 'chat_completions', modelIds: ['glm-smoke-pro', 'glm-smoke-flash'], defaultModel: 'glm-smoke-pro',
  }), secondKey);
  const added = withProfile.profiles.find(profile => profile.name === 'GLM smoke');
  expect(added.hasApiKey).toBe(true);
  expect(JSON.stringify(withProfile)).not.toContain(secondKey);
  await expect(page.getByRole('heading', { name: 'GLM smoke', exact: true })).toBeVisible();
  await page.evaluate(id => window.agentSwitcher.openSettings(id), added.id);
  await expect(manager.locator('#base-url')).toHaveValue('https://provider.example/v1');
  expect(await manager.locator('#api-key').inputValue()).toBe('');
  await manager.locator('#profile-name').fill('Unsaved native window draft');
  await manager.getByRole('button', { name: 'Close settings', exact: true }).click();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(target => target.webContents.getURL().includes('window=settings')).isVisible())).toBe(false);
  await page.evaluate(() => window.agentSwitcher.openSettings());
  await expect(manager.locator('#profile-name')).toHaveValue('Unsaved native window draft');
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  await manager.locator('#profile-name').fill('GLM smoke');
  await manager.screenshot({ path: 'test-results/electron-manager.png' });
  const multiPersisted = await readFile(join(dataDirectory, 'settings.json'), 'utf8');
  expect(multiPersisted).not.toContain(secondKey);
  expect(multiPersisted).not.toContain(fixtureKey);
  expect(JSON.parse(multiPersisted).version).toBe(2);
  expect(await manager.evaluate(() => localStorage.length)).toBe(0);
  await page.screenshot({ path: 'test-results/electron-profiles.png' });
  await page.getByRole('button', { name: 'Hide to tray', exact: true }).click();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(target => !target.webContents.getURL().includes('window=settings')).isVisible())).toBe(false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(target => !target.webContents.getURL().includes('window=settings')).show());
  // Invalid IPC input is rejected by the main process, before any process/config mutation.
  const invalid = await page.evaluate(async () => {
    try { await window.agentSwitcher.switchProfile('invalid'); return ''; }
    catch (error) { return error.message; }
  });
  expect(invalid).toBe('INVALID_PROFILE');
  expect(errors).toEqual([]);
  await closeApplication();
  stage('verify encrypted persistence after reload');

  // An upgrade with the old preference enabled must also keep the panel open.
  const legacy = JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8'));
  legacy.settings.hideOnBlur = true;
  const legacyText = JSON.stringify(legacy);
  await writeFile(join(dataDirectory, 'settings.json'), legacyText);

  application = await electron.launch(launchOptions);
  const reopened = await application.firstWindow({ timeout: 45000 });
  await expect(reopened.locator('html')).toHaveAttribute('lang', 'en', { timeout: 45000 });
  const loaded = await reopened.evaluate(() => window.agentSwitcher.getState());
  expect(loaded.hasApiKey).toBe(true);
  expect(loaded.settings.codexHome).toBe(codexHome);
  expect(loaded.settings.hideOnBlur).toBe(false);
  expect(await readFile(join(dataDirectory, 'settings.json'), 'utf8')).toBe(legacyText);
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows()[0]; panel.emit('blur'); return panel.isVisible();
  })).toBe(true);
  const reloadedProfile = loaded.profiles.find(profile => profile.name === 'GLM smoke');
  expect(reloadedProfile.hasApiKey).toBe(true);
  expect(reloadedProfile.modelIds).toEqual(['glm-smoke-pro', 'glm-smoke-flash']);
  const renamed = await reopened.evaluate(id => window.agentSwitcher.saveProfile({
    id, name: 'GLM renamed', preset: 'glm', baseUrl: 'https://provider.example/v1',
    protocol: 'chat_completions', modelIds: ['glm-smoke-pro', 'glm-smoke-flash'], defaultModel: 'glm-smoke-pro',
  }), reloadedProfile.id);
  expect(renamed.profiles.find(profile => profile.id === reloadedProfile.id).hasApiKey).toBe(true);
  const deleted = await reopened.evaluate(id => window.agentSwitcher.deleteProfile(id), reloadedProfile.id);
  expect(deleted.profiles.some(profile => profile.id === reloadedProfile.id)).toBe(false);
  await reopened.evaluate((settings) => window.agentSwitcher.saveSettings({ ...settings, clearApiKey: true }), loaded.settings);
  expect((await reopened.evaluate(() => window.agentSwitcher.getState())).hasApiKey).toBe(false);

  stage('verify busy quit requests receive feedback');
  // Keep a configuration save pending without sending a network request. Only
  // this isolated main process receives the temporary fetch implementation.
  await application.evaluate(() => {
    globalThis.__smokeOriginalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(resolve => {
      globalThis.__smokeCompleteFetch = () => resolve(new Response(JSON.stringify({ data: [{ id: 'pending-smoke-model' }] }), {
        headers: { 'content-type': 'application/json' },
      }));
    });
  });
  await reopened.evaluate(() => {
    window.__smokePendingSave = window.agentSwitcher.saveProfile({
      name: 'Pending save smoke', preset: 'custom', baseUrl: 'https://provider.example/v1',
      protocol: 'responses', apiKey: 'sk-pending-smoke-fixture-no-api-requests',
    }).then(value => ({ value }), error => ({ error: error.message }));
  });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__smokeCompleteFetch)).toBe('function');
  expect(await reopened.evaluate(async () => {
    try { await window.agentSwitcher.quit(); return 'unexpected success'; }
    catch (error) { return error.message; }
  })).toBe('SWITCH_IN_PROGRESS');
  await application.evaluate(({ app, BrowserWindow, dialog, Tray }) => {
    globalThis.__smokeOriginalMessageBox = dialog.showMessageBox;
    globalThis.__smokeMessages = [];
    dialog.showMessageBox = async (...args) => {
      const owner = args[0] instanceof BrowserWindow ? args[0] : undefined;
      const options = owner ? args[1] : args[0];
      globalThis.__smokeMessages.push({ type: options.type, detail: options.detail, ownerVisible: owner?.isVisible() ?? false });
      return { response: 0, checkboxChecked: false };
    };
    // Capture a refreshed real tray menu so its availability and click callback
    // are tested while the service is busy, just as a menu-bar click would be.
    globalThis.__smokeOriginalSetContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.__smokeTrayMenu = menu;
      return globalThis.__smokeOriginalSetContextMenu.call(this, menu);
    };
    app.emit('second-instance');
  });
  await expect.poll(() => application.evaluate(() => Boolean(globalThis.__smokeTrayMenu))).toBe(true);
  expect(await application.evaluate(({ Tray }) => {
    Tray.prototype.setContextMenu = globalThis.__smokeOriginalSetContextMenu;
    const quit = globalThis.__smokeTrayMenu.items.find(item => item.label === 'Quit');
    if (!quit) throw new Error('Missing tray quit action');
    quit.click();
    return quit.enabled;
  })).toBe(true);
  await expect.poll(() => application.evaluate(() => globalThis.__smokeMessages)).toEqual([
    { type: 'info', detail: 'SWITCH_IN_PROGRESS', ownerVisible: true },
  ]);
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.__smokeOriginalMessageBox;
  });

  // An existing native picker takes priority even while the save is busy, so
  // another quit request can focus it instead of attempting a second modal.
  await application.evaluate(({ dialog }) => {
    globalThis.__smokeOriginalOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = () => new Promise(resolve => {
      globalThis.__smokeCompleteDialog = () => resolve({ canceled: true, filePaths: [] });
    });
  });
  await reopened.evaluate(() => {
    window.__smokePendingDialog = window.agentSwitcher.chooseCodexHome();
  });
  await expect.poll(() => application.evaluate(() => typeof globalThis.__smokeCompleteDialog)).toBe('function');
  expect(await reopened.evaluate(async () => {
    try { await window.agentSwitcher.quit(); return 'unexpected success'; }
    catch (error) { return error.message; }
  })).toBe('DIALOG_IN_PROGRESS');
  await application.evaluate(({ dialog }) => {
    globalThis.__smokeCompleteDialog();
    dialog.showOpenDialog = globalThis.__smokeOriginalOpenDialog;
  });
  expect(await reopened.evaluate(() => window.__smokePendingDialog)).toBeNull();
  await application.evaluate(() => {
    globalThis.__smokeCompleteFetch();
    globalThis.fetch = globalThis.__smokeOriginalFetch;
  });
  const completedSave = await reopened.evaluate(() => window.__smokePendingSave);
  expect(completedSave.error).toBeUndefined();

  // Prepare an active API fixture for startup. The bridge only listens on
  // loopback; no Codex process is launched and no upstream request is made.
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const bridgePort = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const bridgeToken = randomBytes(32).toString('hex');
  const encryptedSecrets = await application.evaluate(({ safeStorage }, secrets) => safeStorage.encryptString(JSON.stringify(secrets)).toString('base64'), {
    apiKey: fixtureKey, activeProfileId: 'deepseek', bridgePort, bridgeToken,
  });
  await closeApplication();
  const activeFixture = JSON.parse(await readFile(join(dataDirectory, 'settings.json'), 'utf8'));
  activeFixture.encryptedSecrets = encryptedSecrets;
  await writeFile(join(dataDirectory, 'settings.json'), JSON.stringify(activeFixture));
  await writeFile(join(codexHome, 'config.toml'), [
    'model = "deepseek-flash"', 'model_provider = "agent_switcher_deepseek"',
    '[model_providers.agent_switcher_deepseek]', `base_url = "http://127.0.0.1:${bridgePort}/v1"`,
    `experimental_bearer_token = "${bridgeToken}"`, '',
  ].join('\n'));

  stage('verify native quit confirmation ownership and recovery');
  application = await electron.launch(launchOptions);
  const activePage = await application.firstWindow({ timeout: 45000 });
  await expect(activePage.locator('html')).toHaveAttribute('lang', 'en', { timeout: 45000 });
  expect((await activePage.evaluate(() => window.agentSwitcher.getState())).bridgeRunning).toBe(true);
  await activePage.getByRole('button', { name: 'Hide to tray', exact: true }).click();
  await application.evaluate(({ app, BrowserWindow, dialog }) => {
    globalThis.__smokeOriginalMessageBox = dialog.showMessageBox;
    globalThis.__smokeMessages = [];
    globalThis.__smokeRejectQuestion = false;
    dialog.showMessageBox = async (...args) => {
      const owner = args[0] instanceof BrowserWindow ? args[0] : undefined;
      const options = owner ? args[1] : args[0];
      globalThis.__smokeMessages.push({ type: options.type, detail: options.detail, ownerVisible: owner?.isVisible() ?? false });
      if (options.type === 'question' && globalThis.__smokeRejectQuestion) {
        globalThis.__smokeRejectQuestion = false;
        throw new Error('OPERATION_FAILED');
      }
      return { response: 0, checkboxChecked: false };
    };
    app.emit('before-quit', { preventDefault() {} });
  });
  await expect.poll(() => application.evaluate(() => globalThis.__smokeMessages.length)).toBe(1);
  expect(await application.evaluate(() => globalThis.__smokeMessages[0])).toMatchObject({ type: 'question', ownerVisible: true });
  expect(application.process().exitCode).toBeNull();
  await application.evaluate(({ app }) => {
    globalThis.__smokeRejectQuestion = true;
    app.emit('before-quit', { preventDefault() {} });
  });
  await expect.poll(() => application.evaluate(() => globalThis.__smokeMessages.length)).toBe(3);
  expect(await application.evaluate(() => globalThis.__smokeMessages[2])).toMatchObject({ type: 'info', detail: 'OPERATION_FAILED', ownerVisible: true });
  await application.evaluate(({ app }) => app.emit('before-quit', { preventDefault() {} }));
  await expect.poll(() => application.evaluate(() => globalThis.__smokeMessages.length)).toBe(4);
  expect(await application.evaluate(() => globalThis.__smokeMessages[3])).toMatchObject({ type: 'question', ownerVisible: true });

  stage('verify actual quit button exits the isolated process');
  // Playwright disposes the application dispatcher on exit; retain the child
  // before clicking Quit so observing exitCode does not access a closed handle.
  const quittingProcess = application.process();
  await activePage.getByRole('button', { name: 'More actions', exact: true }).click();
  await activePage.getByRole('menuitem', { name: 'Quit Agent Switcher', exact: true }).click();
  await expect(activePage.getByRole('alertdialog')).toBeVisible();
  try {
    await activePage.getByRole('alertdialog').getByRole('button', { name: 'Quit Agent Switcher', exact: true }).click();
  } catch (error) {
    // Windows can terminate before Playwright acknowledges the click. A closed
    // target is expected only here; the child must still prove a clean exit.
    if (!error.message.includes('Target page, context or browser has been closed')) throw error;
  }
  await expect.poll(() => quittingProcess.exitCode, { timeout: 10000 }).toBe(0);
  application = undefined;
  console.log(`Electron smoke passed: tray positioning on ${displays.length} display(s), persistent panel on blur/upgrade, actual close buttons, two native windows, draft retention, profile CRUD, encryption, sandbox, busy quit feedback, owned native dialogs, retry after dialog failure and actual process exit. No Codex restart/API call.`);
} finally {
  clearTimeout(deadline);
  await closeApplication();
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('agent-switcher-electron-')) throw new Error('Unsafe smoke cleanup path');
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
