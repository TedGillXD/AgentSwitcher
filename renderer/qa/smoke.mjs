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
let failSwitch = false;
let nextId = 1;
const profiles = [
  { id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'auto', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash', hasApiKey: true },
  { id: 'glm-personal', name: 'GLM · 个人', preset: 'glm', baseUrl: 'https://open.bigmodel.cn/api/v1', protocol: 'auto', modelIds: ['glm-5.3'], defaultModel: 'glm-5.3', hasApiKey: true },
  { id: 'kimi-personal', name: 'Kimi', preset: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', protocol: 'auto', modelIds: ['kimi-k3', 'kimi-k2.7-code'], defaultModel: 'kimi-k3', hasApiKey: true },
];
const keys = new Map(profiles.map((profile) => [profile.id, 'existing-mock-key']));
let state = {
  version: '0.2.1', platform: 'win32',
  settings: { language: 'zh-CN', codexHome: '', codexAppPath: '', deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-flash', launchAtLogin: false, hideOnBlur: false },
  profiles, activeProfile: 'chatgpt', hasApiKey: true, encryptionAvailable: true,
  codexInstalled: true, codexRunning: true, detectedAppPath: 'C:\\Apps\\Codex.exe',
  bridgeRunning: false, lastSwitchedAt: null, lastError: null,
};
const snapshot = () => structuredClone(state);
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
  await preview.getByRole('button', { name: '切换语言', exact: true }).click();
  await expect(preview.getByText('Browser preview', { exact: true })).toBeVisible();
  await noOverflow(preview); await emptyBrowserStorage(preview); await preview.close();

  await context.exposeBinding('__mockInvoke', async ({ page }, method, input) => {
    calls.push({ method, input: structuredClone(input) });
    if (method === 'getState') return snapshot();
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
    if (['closeSettings', 'hideWindow', 'quit', 'openConfigFolder'].includes(method)) return;
    throw new Error(`Unexpected method: ${method} from ${page.url()}`);
  });
  await context.addInitScript(() => {
    window.__stateListeners = []; window.__editListeners = [];
    const invoke = (method) => (input) => window.__mockInvoke(method, input);
    window.agentSwitcher = Object.fromEntries(['getState', 'saveSettings', 'saveProfile', 'deleteProfile', 'testConnection', 'switchProfile', 'restartCodex', 'chooseCodexApp', 'chooseCodexHome', 'openSettings', 'closeSettings', 'openConfigFolder', 'hideWindow', 'quit'].map((name) => [name, invoke(name)]));
    window.agentSwitcher.onStateChanged = (callback) => { window.__stateListeners.push(callback); return () => { window.__stateListeners = window.__stateListeners.filter((listener) => listener !== callback); }; };
    window.agentSwitcher.onEditProfile = (callback) => { window.__editListeners.push(callback); return () => { window.__editListeners = window.__editListeners.filter((listener) => listener !== callback); }; };
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
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ ok: true, browserErrors: errors, exercised: [...new Set(calls.map((call) => call.method))], profiles: state.profiles.length, screenshots: output }));
} finally { await browser.close(); }
