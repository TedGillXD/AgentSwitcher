// Run with a preview server listening: node renderer/qa/smoke.mjs
// Two isolated renderers share a mock desktop API. No Codex or provider is contacted.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) });
const context = await browser.newContext({ viewport: { width: 460, height: 740 }, deviceScaleFactor: 1 });
const errors = [];
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
const url = process.env.AGENT_SWITCHER_PREVIEW_URL || 'http://127.0.0.1:5173';
const panel = await context.newPage();
let manager;
const calls = [];
const requestOverrides = new Map();
let failSwitch = false;
let nextId = 1;
const profiles = [
  { id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'auto', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash', hasApiKey: true },
  { id: 'glm-personal', name: 'GLM · 个人', preset: 'glm', baseUrl: 'https://open.bigmodel.cn/api/v1', protocol: 'auto', modelIds: ['glm-5.3'], defaultModel: 'glm-5.3', hasApiKey: true },
  { id: 'kimi-personal', name: 'Kimi', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', protocol: 'auto', modelIds: ['kimi-k3', 'kimi-k2.7-code'], defaultModel: 'kimi-k3', hasApiKey: true },
];
const keys = new Map(profiles.map((profile) => [profile.id, 'existing-mock-key']));
let state = {
  version: '0.2.4', platform: 'win32',
  settings: { language: 'zh-CN', codexHome: '', codexAppPath: '', deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-flash', launchAtLogin: false, hideOnBlur: false },
  profiles, activeProfile: 'chatgpt', hasApiKey: true, encryptionAvailable: true,
  codexInstalled: true, codexRunning: true, detectedAppPath: 'C:\\Apps\\Codex.exe',
  bridgeRunning: false, lastSwitchedAt: null, lastError: null,
};
const snapshot = () => structuredClone(state);
let updateState = {
  status: 'idle', currentVersion: state.version, latestVersion: null, releaseUrl: null, releaseNotes: null, publishedAt: null,
  downloadedBytes: 0, totalBytes: 0, error: null, canInstall: true,
};
const updateSnapshot = () => structuredClone(updateState);
const broadcastUpdate = async (patch) => {
  updateState = { ...updateState, ...patch };
  const next = updateSnapshot();
  await Promise.all(context.pages().map((page) => page.evaluate((value) => window.__updateListeners?.forEach((listener) => listener(value)), next)));
  return next;
};
const broadcast = async () => {
  const value = snapshot();
  await Promise.all(context.pages().map((page) => page.evaluate((next) => window.__stateListeners?.forEach((listener) => listener(next)), value)));
};
const discovered = (endpoint) => endpoint.includes('unsupported') ? [] : endpoint.includes('bigmodel') ? ['glm-5.3', 'glm-5.2'] : endpoint.includes('moonshot') ? ['kimi-k3', 'kimi-k2.7-code'] : ['model-flash', 'model-pro'];

async function noOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || [...document.querySelectorAll('.content, .profile-card, .settings-section, .editor-scroll, .editor-save-bar, .manager-sidebar')].some((element) => element.scrollWidth > element.clientWidth + 1));
  expect(overflow).toBe(false);
}
async function emptyBrowserStorage(page) { expect(await page.evaluate(() => localStorage.length)).toBe(0); }
async function selectSidebar(name) { await manager.locator('.profile-navigation').getByRole('button', { name }).click(); }
const callCount = (method) => calls.filter((call) => call.method === method).length;
async function clickWindowAction(page, buttonName, method) {
  const before = callCount(method);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await expect.poll(() => callCount(method)).toBe(before + 1);
}
async function openQuitMenu(page) {
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出 Agent Switcher', exact: true }).click();
}

try {
  // Browser mode is labeled and cannot perform desktop mutations.
  await panel.goto(url);
  await expect(panel.getByText('浏览器预览', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '管理配置', exact: true })).toBeDisabled();
  const preview = await context.newPage();
  await preview.setViewportSize({ width: 960, height: 760 });
  await preview.goto(`${url}/?window=settings`);
  await preview.getByLabel('API 地址', { exact: true }).fill('https://preview.example/v1');
  await preview.getByLabel('API Key', { exact: true }).fill('preview-never-saved');
  await expect(preview.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '测试并发现模型', exact: true })).toBeDisabled();
  await preview.goto(`${url}/?window=settings&profile=general`);
  await expect(preview.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled();
  await expect(preview.getByText('请在已安装的桌面应用中检查和安装更新。', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '切换语言', exact: true }).click();
  await expect(preview.getByText('Browser preview', { exact: true })).toBeVisible();
  await noOverflow(preview); await emptyBrowserStorage(preview); await preview.close();

  await context.exposeBinding('__mockInvoke', async ({ page }, method, input) => {
    calls.push({ method, input: structuredClone(input) });
    const override = requestOverrides.get(page)?.[method];
    if (override) return override(input);
    if (method === 'getState') return snapshot();
    if (method === 'getUpdateState') return updateSnapshot();
    if (method === 'checkForUpdates') return broadcastUpdate({ status: 'up-to-date', latestVersion: state.version, error: null });
    if (method === 'downloadUpdate') return broadcastUpdate({ status: 'downloaded', error: null });
    if (method === 'installUpdate') return broadcastUpdate({ status: 'downloaded', error: null });
    if (method === 'openSettings') {
      if (!manager || manager.isClosed()) {
        manager = await context.newPage();
        await manager.setViewportSize({ width: 960, height: 760 });
        await manager.goto(`${url}/?window=settings${input ? `&profile=${encodeURIComponent(input)}` : ''}`);
        await expect(manager.locator('.editor-column')).toBeVisible();
      } else if (input !== undefined) await manager.evaluate((id) => window.__editListeners?.forEach((listener) => listener(id)), input);
      return;
    }
    if (method === 'saveSettings') { state.settings = input; await broadcast(); return snapshot(); }
    if (method === 'saveProfile') {
      if (input.id === state.activeProfile) throw new Error('PROFILE_IN_USE');
      const ids = input.modelIds?.length ? input.modelIds : discovered(input.baseUrl);
      if (!ids.length) throw new Error('MODELS_REQUIRED');
      const id = input.id || `new-${nextId++}`;
      const previous = state.profiles.find((profile) => profile.id === id);
      if (input.apiKey) keys.set(id, input.apiKey); else if (input.clearApiKey) keys.delete(id);
      const value = { ...previous, id, name: input.name, preset: input.preset, baseUrl: input.baseUrl.replace(/\/+$/, ''), protocol: input.protocol, modelIds: ids, defaultModel: input.defaultModel || ids[0], hasApiKey: keys.has(id) };
      state.profiles = previous ? state.profiles.map((profile) => profile.id === id ? value : profile) : [...state.profiles, value];
      await broadcast(); return snapshot();
    }
    if (method === 'deleteProfile') {
      if (input === state.activeProfile) throw new Error('PROFILE_IN_USE');
      state.profiles = state.profiles.filter((profile) => profile.id !== input); keys.delete(input);
      await broadcast(); return snapshot();
    }
    if (method === 'testConnection') {
      const models = discovered(input.baseUrl);
      return models.length ? { ok: true, latencyMs: 42, models } : { ok: false, latencyMs: 18, error: 'MODEL_DISCOVERY_UNAVAILABLE' };
    }
    if (method === 'switchProfile') {
      if (failSwitch) { failSwitch = false; throw new Error('APP_STOP_FAILED'); }
      state = { ...state, activeProfile: input, bridgeRunning: input !== 'chatgpt', lastSwitchedAt: new Date().toISOString() };
      await broadcast(); return { state: snapshot(), restarted: true };
    }
    if (method === 'restartCodex') return snapshot();
    if (method === 'chooseCodexApp') return 'C:\\Apps\\Codex.exe';
    if (method === 'chooseCodexHome') return 'C:\\Isolated\\.codex';
    if (['closeSettings', 'hideWindow', 'quit', 'openConfigFolder', 'openUpdateRelease'].includes(method)) return;
    throw new Error(`Unexpected method: ${method} from ${page.url()}`);
  });
  await context.addInitScript(() => {
    window.__stateListeners = []; window.__editListeners = []; window.__updateListeners = [];
    const invoke = (method) => (input) => window.__mockInvoke(method, input);
    window.agentSwitcher = Object.fromEntries(['getState', 'saveSettings', 'saveProfile', 'deleteProfile', 'testConnection', 'switchProfile', 'restartCodex', 'chooseCodexApp', 'chooseCodexHome', 'openSettings', 'closeSettings', 'openConfigFolder', 'hideWindow', 'quit', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'openUpdateRelease'].map((name) => [name, invoke(name)]));
    window.agentSwitcher.onStateChanged = (callback) => { window.__stateListeners.push(callback); return () => { window.__stateListeners = window.__stateListeners.filter((listener) => listener !== callback); }; };
    window.agentSwitcher.onEditProfile = (callback) => { window.__editListeners.push(callback); return () => { window.__editListeners = window.__editListeners.filter((listener) => listener !== callback); }; };
    window.agentSwitcher.onUpdateStateChanged = (callback) => { window.__updateListeners.push(callback); return () => { window.__updateListeners = window.__updateListeners.filter((listener) => listener !== callback); }; };
    window.agentSwitcher.onNavigate = () => () => {};
  });
  await panel.reload();
  await expect(panel.getByText('浏览器预览', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.profile-card')).toHaveCount(4);
  await panel.screenshot({ path: path.join(output, 'profiles-zh.png') });
  await panel.getByRole('button', { name: '管理配置', exact: true }).click();
  await expect.poll(() => Boolean(manager)).toBe(true);
  await expect(manager.getByRole('heading', { name: '新建 API 配置', exact: true })).toBeVisible();
  await manager.locator('.provider-templates').getByRole('button', { name: 'GLM', exact: true }).click();
  await expect(manager.getByLabel('API 地址', { exact: true })).toHaveValue('https://open.bigmodel.cn/api/v1');
  await manager.getByLabel('配置名称', { exact: false }).fill('GLM · 工作');
  await manager.getByLabel('API Key', { exact: true }).fill('mock-secret-never-persisted');
  await manager.getByRole('button', { name: '显示密钥', exact: true }).click();
  await expect(manager.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'text');
  await manager.getByRole('button', { name: '隐藏密钥', exact: true }).click();
  await manager.getByRole('button', { name: '测试并发现模型', exact: true }).click();
  await expect(manager.getByText(/连接成功/)).toBeVisible();
  await manager.getByRole('button', { name: '高级选项', exact: true }).click();
  await manager.getByLabel('默认模型', { exact: true }).selectOption('glm-5.2');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByText('配置已保存。', { exact: true })).toBeVisible();
  await expect(manager.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(panel.locator('.profile-card')).toHaveCount(5);
  expect(state.profiles.at(-1).modelIds).toEqual(['glm-5.3', 'glm-5.2']);
  expect(state.profiles.at(-1).defaultModel).toBe('glm-5.2');
  await manager.getByLabel('配置名称', { exact: false }).fill('GLM Team');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'GLM Team', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === 'saveProfile').at(-1).input.apiKey).toBeUndefined();
  expect(keys.get(state.profiles.at(-1).id)).toBe('mock-secret-never-persisted');
  await manager.screenshot({ path: path.join(output, 'manager-profile-zh.png') });

  // URL + key is enough for a custom endpoint with model discovery.
  await manager.getByRole('button', { name: '添加配置', exact: true }).click();
  await manager.getByLabel('API 地址', { exact: true }).fill('https://custom.example/v1');
  await manager.getByLabel('API Key', { exact: true }).fill('custom-test-key');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'custom.example', exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === 'saveProfile').at(-1).input.modelIds).toBeUndefined();
  expect(state.profiles.at(-1).modelIds).toEqual(['model-flash', 'model-pro']);
  await manager.getByRole('button', { name: '移除已保存的密钥', exact: true }).click();
  await expect(manager.locator('.key-removal')).toContainText('保存后将移除此密钥。');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByText('配置已保存。', { exact: true })).toBeVisible();
  expect(state.profiles.at(-1).hasApiKey).toBe(false);
  expect(calls.filter((call) => call.method === 'saveProfile').at(-1).input.clearApiKey).toBe(true);
  await manager.getByLabel('API Key', { exact: true }).fill('replacement-test-key');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(state.profiles.at(-1).hasApiKey).toBe(true);

  // Unsupported discovery has an actionable manual fallback.
  await manager.getByRole('button', { name: '添加配置', exact: true }).click();
  await manager.getByLabel('API 地址', { exact: true }).fill('https://unsupported.example/v1');
  await manager.getByLabel('API Key', { exact: true }).fill('manual-test-key');
  await manager.getByRole('button', { name: '测试并发现模型', exact: true }).click();
  await expect(manager.getByRole('alert')).toContainText('手动填写模型 ID');
  await manager.getByLabel('可用模型', { exact: true }).fill('provider-pro\nprovider-flash');
  await manager.getByLabel('默认模型', { exact: true }).selectOption('provider-flash');
  await manager.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'unsupported.example', exact: true })).toBeVisible();

  // Cross-window state broadcasts preserve unsaved drafts.
  await manager.getByLabel('配置名称', { exact: false }).fill('Unsaved draft');
  await panel.getByRole('button', { name: '切换语言', exact: true }).click();
  await expect(manager.locator('html')).toHaveAttribute('lang', 'en');
  await expect(manager.getByLabel('Configuration name', { exact: false })).toHaveValue('Unsaved draft');
  await manager.getByRole('button', { name: 'General settings', exact: true }).click();
  await expect(manager.getByRole('alertdialog')).toBeVisible();
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(manager.getByLabel('Configuration name', { exact: false })).toHaveValue('Unsaved draft');
  await manager.getByRole('button', { name: 'General settings', exact: true }).click();
  await manager.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(manager.getByRole('switch', { name: 'Hide panel when focus is lost', exact: true })).toHaveCount(0);
  await manager.getByLabel('Application path', { exact: true }).fill('C:\\Apps\\Codex.exe');
  await manager.getByRole('switch', { name: 'Launch at login', exact: true }).click();
  await manager.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(manager.getByText('Settings saved.', { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.method === 'saveSettings').at(-1).input.hideOnBlur).toBe(false);
  await manager.screenshot({ path: path.join(output, 'manager-general-en.png') });
  await selectSidebar('GLM Team');
  await manager.getByRole('button', { name: 'Delete configuration', exact: true }).click();
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click();
  await manager.getByRole('button', { name: 'Delete configuration', exact: true }).click();
  await manager.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(manager.getByText('Configuration deleted.', { exact: true })).toBeVisible();
  expect(state.profiles.some((profile) => profile.name === 'GLM Team')).toBe(false);

  // Switch confirmations, localized failures, and active-profile edit locks.
  const deepseekCard = panel.locator('.profile-card').filter({ has: panel.getByRole('heading', { name: 'DeepSeek', exact: true }) });
  failSwitch = true;
  await deepseekCard.getByRole('button', { name: 'Switch', exact: true }).click();
  await panel.getByRole('button', { name: 'Switch & restart', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Codex could not exit');
  await deepseekCard.getByRole('button', { name: 'Switch', exact: true }).click();
  await panel.getByRole('button', { name: 'Switch & restart', exact: true }).click();
  await expect(panel.getByText('Local connection active', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit DeepSeek', exact: true }).click();
  await expect(manager.getByText(/This configuration is in use/)).toBeVisible();
  await expect(manager.getByLabel('API base URL', { exact: true })).toBeDisabled();
  await expect(manager.getByRole('button', { name: 'Delete configuration', exact: true })).toBeDisabled();
  await manager.getByRole('button', { name: 'Switch to ChatGPT', exact: true }).click();
  await manager.getByRole('button', { name: 'Switch & restart', exact: true }).click();
  await expect(manager.getByLabel('API base URL', { exact: true })).toBeEnabled();
  await manager.getByLabel('Configuration name', { exact: false }).fill('Retained draft');
  await manager.getByRole('button', { name: 'Close settings', exact: true }).click();
  await panel.getByRole('button', { name: 'Manage configurations', exact: true }).click();
  await expect(manager.getByLabel('Configuration name', { exact: false })).toHaveValue('Retained draft');
  await manager.screenshot({ path: path.join(output, 'manager-profile-en.png') });
  await manager.setViewportSize({ width: 800, height: 620 });
  await noOverflow(manager);
  await manager.screenshot({ path: path.join(output, 'manager-compact-en.png') });
  await manager.setViewportSize({ width: 960, height: 760 });
  await manager.getByRole('button', { name: 'Change language', exact: true }).click();
  await expect(panel.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await noOverflow(manager); await noOverflow(panel);
  await emptyBrowserStorage(manager); await emptyBrowserStorage(panel);

  // Window controls remain available when the first state request fails or hangs.
  for (const loadMode of ['reject', 'pending']) {
    for (const settingsWindow of [false, true]) {
      const probe = await context.newPage();
      let releaseLoad;
      const pendingLoad = new Promise((resolve) => { releaseLoad = resolve; });
      requestOverrides.set(probe, { getState: () => {
        if (loadMode === 'reject') throw new Error('CONNECTION_FAILED');
        return pendingLoad;
      } });
      try {
        await probe.goto(`${url}/${settingsWindow ? '?window=settings' : ''}`);
        if (loadMode === 'reject') await expect(probe.getByRole('alert')).toContainText('连接失败');
        else await expect(probe.getByText('正在准备…', { exact: true })).toBeVisible();
        await clickWindowAction(probe, settingsWindow ? '关闭设置' : '收起到托盘', settingsWindow ? 'closeSettings' : 'hideWindow');
        if (!settingsWindow) {
          const quits = callCount('quit');
          await openQuitMenu(probe);
          await expect.poll(() => callCount('quit')).toBe(quits + 1);
        }
      } finally {
        releaseLoad(snapshot());
        requestOverrides.delete(probe);
        await probe.close();
      }
    }
  }

  // Hiding and a rejected quit must not release a business operation's busy lock.
  const busyPanel = await context.newPage();
  let releaseFolder;
  const pendingFolder = new Promise((resolve) => { releaseFolder = resolve; });
  requestOverrides.set(busyPanel, {
    openConfigFolder: () => pendingFolder,
    quit: () => { throw new Error('SWITCH_IN_PROGRESS'); },
  });
  try {
    await busyPanel.goto(url);
    await busyPanel.getByRole('button', { name: '打开配置目录', exact: true }).click();
    await expect(busyPanel.getByRole('button', { name: '管理配置', exact: true })).toBeDisabled();
    await clickWindowAction(busyPanel, '收起到托盘', 'hideWindow');
    await expect(busyPanel.getByRole('button', { name: '管理配置', exact: true })).toBeDisabled();
    await openQuitMenu(busyPanel);
    await expect(busyPanel.getByRole('alert')).toContainText('当前操作尚未完成');
    await expect(busyPanel.getByRole('button', { name: '管理配置', exact: true })).toBeDisabled();
    releaseFolder();
    await expect(busyPanel.getByRole('button', { name: '管理配置', exact: true })).toBeEnabled();
  } finally {
    releaseFolder(); requestOverrides.delete(busyPanel); await busyPanel.close();
  }
  const busyManager = await context.newPage();
  let releaseDiscovery;
  const pendingDiscovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  requestOverrides.set(busyManager, { testConnection: () => pendingDiscovery });
  try {
    await busyManager.goto(`${url}/?window=settings`);
    await busyManager.getByLabel('API 地址', { exact: true }).fill('https://provider.example/v1');
    await busyManager.getByLabel('API Key', { exact: true }).fill('pending-discovery-fixture');
    await busyManager.getByRole('button', { name: '测试并发现模型', exact: true }).click();
    await expect(busyManager.getByRole('button', { name: '正在发现…', exact: true })).toBeDisabled();
    await clickWindowAction(busyManager, '关闭设置', 'closeSettings');
    await expect(busyManager.getByRole('button', { name: '正在发现…', exact: true })).toBeDisabled();
    releaseDiscovery({ ok: true, latencyMs: 0, models: ['fixture-model'] });
    await expect(busyManager.getByRole('button', { name: '测试并发现模型', exact: true })).toBeEnabled();
  } finally {
    releaseDiscovery({ ok: true, latencyMs: 0, models: ['fixture-model'] });
    requestOverrides.delete(busyManager); await busyManager.close();
  }

  // An active bridge still asks for confirmation before the quit IPC is sent.
  const connectedPanel = await context.newPage();
  requestOverrides.set(connectedPanel, { getState: () => ({ ...snapshot(), bridgeRunning: true }) });
  try {
    await connectedPanel.goto(url);
    await expect(connectedPanel.locator('.profile-card')).not.toHaveCount(0);
    const quits = callCount('quit');
    await openQuitMenu(connectedPanel);
    await expect(connectedPanel.getByRole('alertdialog')).toBeVisible();
    expect(callCount('quit')).toBe(quits);
    await connectedPanel.getByRole('button', { name: '取消', exact: true }).click();
    expect(callCount('quit')).toBe(quits);
    await openQuitMenu(connectedPanel);
    await clickWindowAction(connectedPanel, '退出 Agent Switcher', 'quit');
    expect(calls.filter((call) => call.method === 'quit').at(-1).input).toBe(true);
  } finally { requestOverrides.delete(connectedPanel); await connectedPanel.close(); }

  // A valid pushed state recovers a failed load and reports only changed errors.
  const stateEventsPanel = await context.newPage();
  requestOverrides.set(stateEventsPanel, { getState: () => { throw new Error('CONNECTION_FAILED'); } });
  const pushState = (next) => stateEventsPanel.evaluate((value) => window.__stateListeners.forEach((listener) => listener(value)), next);
  try {
    await stateEventsPanel.goto(url);
    await expect(stateEventsPanel.getByRole('alert')).toContainText('连接失败');
    await pushState(snapshot());
    await expect(stateEventsPanel.locator('.profile-card')).not.toHaveCount(0);
    await expect(stateEventsPanel.getByRole('alert')).toHaveCount(0);
    await pushState({ ...snapshot(), lastError: 'BRIDGE_START_FAILED' });
    await expect(stateEventsPanel.getByRole('alert')).toContainText('本地连接未能启动');
    await stateEventsPanel.getByRole('button', { name: '关闭提示', exact: true }).click();
    await pushState({ ...snapshot(), lastError: 'BRIDGE_START_FAILED' });
    await expect(stateEventsPanel.getByRole('alert')).toHaveCount(0);
    await pushState(snapshot());
    await stateEventsPanel.getByRole('button', { name: '重启 Codex', exact: true }).click();
    await stateEventsPanel.getByRole('button', { name: '重启', exact: true }).click();
    await expect(stateEventsPanel.getByRole('status')).toContainText('Codex 桌面应用已重启');
    await pushState(snapshot());
    await expect(stateEventsPanel.getByRole('status')).toContainText('Codex 桌面应用已重启');
    await pushState({ ...snapshot(), lastError: 'BRIDGE_START_FAILED' });
    await expect(stateEventsPanel.getByRole('alert')).toContainText('本地连接未能启动');
  } finally { requestOverrides.delete(stateEventsPanel); await stateEventsPanel.close(); }

  // Updating is an explicit settings action. Downloading never locks window
  // controls, and a saved update survives leaving and reopening General settings.
  const updater = await context.newPage();
  await updater.setViewportSize({ width: 960, height: 760 });
  let checkAttempts = 0;
  let downloadAttempts = 0;
  let installAttempts = 0;
  let releaseDownload;
  const pendingDownload = new Promise((resolve) => { releaseDownload = resolve; });
  const availableUpdate = { status: 'available', latestVersion: '0.3.0', releaseUrl: 'https://github.com/TedGillXD/AgentSwitcher/releases/tag/v0.3.0', releaseNotes: 'New settings and app update support.\n更新说明仅作为文本显示。', publishedAt: '2026-10-22T00:00:00Z', error: null };
  requestOverrides.set(updater, {
    checkForUpdates: async () => {
      checkAttempts++;
      await broadcastUpdate({ status: 'checking', error: null });
      if (checkAttempts === 1) {
        await broadcastUpdate({ status: 'error', error: 'UPDATE_CHECK_FAILED' });
        throw new Error('UPDATE_CHECK_FAILED');
      }
      return broadcastUpdate(availableUpdate);
    },
    downloadUpdate: async () => {
      downloadAttempts++;
      if (downloadAttempts === 1) {
        await broadcastUpdate({ status: 'error', error: 'UPDATE_CHECKSUM_MISMATCH' });
        throw new Error('UPDATE_CHECKSUM_MISMATCH');
      }
      await broadcastUpdate({ status: 'downloading', error: null, downloadedBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 });
      await pendingDownload;
      return broadcastUpdate({ status: 'downloaded', downloadedBytes: 100 * 1024 * 1024 });
    },
    installUpdate: async () => {
      installAttempts++;
      await broadcastUpdate({ status: 'installing', error: null });
      if (installAttempts === 2) {
        await broadcastUpdate({ status: 'downloaded', error: 'UPDATE_INSTALL_FAILED' });
        throw new Error('UPDATE_INSTALL_FAILED');
      }
      // The first installation request is cancelled in the native confirmation.
      return broadcastUpdate({ status: installAttempts === 1 ? 'downloaded' : 'installing', error: null });
    },
  });
  try {
    const checksBeforeMount = callCount('checkForUpdates');
    await updater.goto(`${url}/?window=settings&profile=general`);
    await expect(updater.getByRole('heading', { name: '应用更新', exact: true })).toBeVisible();
    expect(callCount('checkForUpdates')).toBe(checksBeforeMount);
    await updater.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(updater.getByRole('alert')).toContainText('检查更新失败');
    await updater.getByRole('button', { name: '重试', exact: true }).click();
    await expect(updater.getByText('发现新版本 0.3.0。', { exact: true })).toBeVisible();
    await clickWindowAction(updater, '查看发布页', 'openUpdateRelease');
    await updater.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(updater.getByRole('alert')).toContainText('更新文件校验失败');
    await updater.getByRole('button', { name: '重新下载', exact: true }).click();
    await expect(updater.getByRole('progressbar', { name: '更新下载进度', exact: true })).toHaveAttribute('value', '25');
    await expect(updater.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    await expect(updater.getByRole('button', { name: '浏览', exact: true }).first()).toBeEnabled();
    await clickWindowAction(updater, '关闭设置', 'closeSettings');
    await updater.locator('.profile-navigation').getByRole('button', { name: 'DeepSeek', exact: false }).click();
    await updater.getByRole('button', { name: '通用设置', exact: true }).click();
    await expect(updater.getByRole('progressbar', { name: '更新下载进度', exact: true })).toHaveAttribute('value', '25');
    releaseDownload();
    await expect(updater.getByText('更新已就绪，可以安装。', { exact: true })).toBeVisible();
    const originalHome = await updater.locator('#codex-home').inputValue();
    await updater.locator('#codex-home').fill(`${originalHome}-unsaved`);
    await expect(updater.getByRole('button', { name: '安装并重启', exact: true })).toBeDisabled();
    await expect(updater.getByText('安装更新前，请先保存设置。', { exact: true })).toBeVisible();
    await updater.locator('#codex-home').fill(originalHome);
    await updater.getByRole('button', { name: '安装并重启', exact: true }).click();
    await expect.poll(() => installAttempts).toBe(1);
    await expect(updater.getByRole('button', { name: '安装并重启', exact: true })).toBeEnabled();
    await updater.getByRole('button', { name: '安装并重启', exact: true }).click();
    await expect(updater.getByRole('alert')).toContainText('安装更新未完成');
    await expect(updater.getByRole('button', { name: '安装并重启', exact: true })).toBeEnabled();
    await updater.locator('.update-section').screenshot({ path: path.join(output, 'app-update-ready-zh.png') });
    await updater.setViewportSize({ width: 800, height: 620 });
    await noOverflow(updater);
    await updater.getByRole('button', { name: '安装并重启', exact: true }).click();
    await expect(updater.getByRole('button', { name: '正在准备重启…', exact: true })).toBeDisabled();
    await expect(updater.getByRole('button', { name: '关闭设置', exact: true })).toBeEnabled();
  } finally { releaseDownload(); requestOverrides.delete(updater); await updater.close(); }

  // Already-current and development builds get clear outcomes. Development can
  // check releases but cannot download or install over the running application.
  const currentUpdater = await context.newPage();
  await currentUpdater.setViewportSize({ width: 960, height: 760 });
  await broadcastUpdate({ status: 'idle', latestVersion: null, error: null, canInstall: true });
  try {
    await currentUpdater.goto(`${url}/?window=settings&profile=general`);
    await currentUpdater.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(currentUpdater.getByText('你正在使用最新版本。', { exact: true })).toBeVisible();
    await broadcastUpdate({ ...availableUpdate, canInstall: false });
    await expect(currentUpdater.getByRole('button', { name: '下载更新', exact: true })).toBeDisabled();
    await expect(currentUpdater.getByText('请使用已安装的桌面版本进行应用内更新，也可从发布页手动安装。', { exact: true })).toBeVisible();
    await currentUpdater.getByRole('button', { name: '切换语言', exact: true }).click();
    await expect(currentUpdater.getByRole('heading', { name: 'App updates', exact: true })).toBeVisible();
    await expect(currentUpdater.getByRole('button', { name: 'Download update', exact: true })).toBeDisabled();
    await noOverflow(currentUpdater);
    await emptyBrowserStorage(currentUpdater);
    await currentUpdater.locator('.update-section').screenshot({ path: path.join(output, 'app-update-available-en.png') });
  } finally { await currentUpdater.close(); }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ ok: true, browserErrors: errors, exercised: [...new Set(calls.map((call) => call.method))], profiles: state.profiles.length, screenshots: output }));
} finally { await browser.close(); }
