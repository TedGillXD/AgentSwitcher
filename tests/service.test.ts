import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { ProfileService } from '../electron/service';
import { LocalStore, defaultSettings, type SecretCodec, type SecretData } from '../electron/store';
import { atomicWrite, readOptional } from '../electron/files';
import { apiConfig, catalogFile, chatgptConfig, configHash, deepseekConfig, managedEndpoint, patchValues, PROVIDER, snapshotConfig } from '../electron/config';
import { PROVIDER_PRESETS } from '../shared/provider-presets';
import type { ApiProfile, SaveProfileInput } from '../shared/types';
import { AppError } from '../electron/errors';
import type { CodexInstallation, LaunchOptions, StopOptions } from '../electron/platform/codex-process';
import type { BridgeOptions } from '../electron/bridge';

const API_KEY = 'sk-service-fixture-secret';
const LOCAL_TOKEN = 'a-local-service-token-at-least-sixteen-characters';
const directories: string[] = [];
const ORIGINAL = `# Keep this comment and the user's formatting.
model = "gpt-fixture"
model_provider = "openai"
model_reasoning_effort = "medium"
web_search = "cached"
approval_policy = "on-request"

[desktop]
enabled-reasoning-efforts = ["low", "medium", "high"]
theme = "dark"

[mcp_servers.fixture]
command = "fixture-server"
args = ["--safe"]

[projects."D:/fixture/project"]
trust_level = "trusted"
`;

// The injected codec is intentionally a deterministic test double, never an OS
// keychain implementation. Production encryption is outside this service test.
const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)),
  decryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xa5)).toString('utf8'),
};

async function fixture(original: string | null = ORIGINAL, secrets: SecretData = { apiKey: API_KEY }, platform = 'win32') {
  const directory = await mkdtemp(join(tmpdir(), 'agent-switcher-service-'));
  directories.push(directory);
  const codexHome = join(directory, 'codex');
  const configPath = join(codexHome, 'config.toml');
  if (original !== null) await atomicWrite(configPath, original);
  const settings = { ...defaultSettings({}, directory), codexHome, codexAppPath: join(directory, 'Codex.exe') };
  const storePath = join(directory, 'settings.json');
  const store = new LocalStore(storePath, codec, settings);
  await store.load();
  await store.update(settings, secrets);
  const installation: CodexInstallation = { kind: 'executable', path: settings.codexAppPath, label: 'Codex fixture' };
  let running = true;
  const processes = {
    detect: vi.fn(async (_preferred?: string) => installation as CodexInstallation | null),
    isRunning: vi.fn(async (_installation: CodexInstallation) => running),
    stop: vi.fn(async (_installation: CodexInstallation, _options?: StopOptions) => { running = false; }),
    launch: vi.fn(async (_installation: CodexInstallation, _environment?: NodeJS.ProcessEnv, _options?: LaunchOptions) => { running = true; }),
  };
  let bridgeRunning = false;
  const bridge = {
    isRunning: vi.fn(() => bridgeRunning),
    start: vi.fn(async (_options: BridgeOptions) => { bridgeRunning = true; return { port: 41987 }; }),
    stop: vi.fn(async () => { bridgeRunning = false; }),
  };
  const onChange = vi.fn();
  const onLoginPreference = vi.fn();
  const service = new ProfileService({ store, processes, bridge, version: 'test', platform, onChange, onLoginPreference });
  return { directory, configPath, storePath, store, settings, installation, processes, bridge, service, onChange, onLoginPreference };
}

function readConfig(path: string): Promise<string> { return readFile(path, 'utf8'); }

async function selectModel(f: Awaited<ReturnType<typeof fixture>>, model: string, effort: string | null): Promise<void> {
  await writeFile(f.configPath, patchValues(await readConfig(f.configPath), {
    model: JSON.stringify(model), model_reasoning_effort: effort === null ? null : JSON.stringify(effort),
  }));
}

async function createProfile(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<SaveProfileInput> = {}): Promise<ApiProfile> {
  const previousIds = new Set(f.store.profiles.map((profile) => profile.id));
  const state = await f.service.saveProfile({
    name: 'Example API', preset: 'custom', baseUrl: 'https://provider.example/v1', protocol: 'auto',
    modelIds: ['example-fast', 'example-pro'], defaultModel: 'example-pro', apiKey: 'sk-example-profile',
    ...overrides,
  });
  const profile = state.profiles.find((profile) => !previousIds.has(profile.id));
  if (!profile) throw new Error('Expected saveProfile to create one new API profile.');
  return profile;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('agent-switcher-service-')) {
      throw new Error('Refusing to remove a directory outside this test fixture.');
    }
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('ProfileService transactions', () => {
  it('opens a fresh macOS chat on provider changes in both directions', async () => {
    const f = await fixture(ORIGINAL, { apiKey: API_KEY }, 'darwin');
    const other = await createProfile(f);
    await f.service.switchProfile('deepseek');
    await f.service.switchProfile(other.id);
    await f.service.switchProfile('chatgpt');
    expect(f.processes.launch.mock.calls.map((call) => call[2])).toEqual([
      { newThread: true }, { newThread: true }, { newThread: true },
    ]);
    expect(parse(await readConfig(f.configPath)).model_provider).toBe('openai');
  });

  it('preserves the current macOS chat on an ordinary restart or reapplying the same profile', async () => {
    const f = await fixture(ORIGINAL, { apiKey: API_KEY }, 'darwin');
    await f.service.switchProfile('deepseek');
    f.processes.launch.mockClear();
    await f.service.restartCodex();
    await f.service.switchProfile('deepseek');
    expect(f.processes.launch).toHaveBeenCalledTimes(2);
    expect(f.processes.launch.mock.calls.every((call) => call.length === 2)).toBe(true);
  });

  it('reopens the previous macOS chat when a provider switch is rolled back', async () => {
    const f = await fixture(ORIGINAL, { apiKey: API_KEY }, 'darwin');
    f.processes.launch.mockRejectedValueOnce(new Error('Launch failed'));
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('APP_START_FAILED');
    expect(f.processes.launch.mock.calls.map((call) => call[2])).toEqual([{ newThread: true }, undefined]);
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
  });

  it('switches ChatGPT → DeepSeek → ChatGPT and preserves unrelated configuration and auth files', async () => {
    const f = await fixture();
    const authPath = join(f.settings.codexHome, 'auth.json');
    const auth = '{"tokens":{"access_token":"existing-chatgpt-fixture"}}\n';
    await writeFile(authPath, auth);
    const launchConfigs: string[] = [];
    f.processes.launch.mockImplementation(async () => { launchConfigs.push(await readConfig(f.configPath)); });

    const switched = await f.service.switchProfile('deepseek');
    expect(switched.restarted).toBe(true);
    expect(switched.state.activeProfile).toBe('deepseek');
    expect(switched.state.bridgeRunning).toBe(true);
    const deepseek = parse(await readConfig(f.configPath));
    expect(deepseek.model).toBe('deepseek-flash');
    expect(deepseek.model_provider).toBe(PROVIDER);
    expect(deepseek.mcp_servers).toEqual(parse(ORIGINAL).mcp_servers);
    expect(deepseek.projects).toEqual(parse(ORIGINAL).projects);
    expect(deepseek.approval_policy).toBe('on-request');
    expect(await readConfig(f.configPath)).toContain('# Keep this comment');
    expect(await readConfig(f.configPath)).not.toContain(API_KEY);
    expect(await readConfig(f.storePath)).not.toContain(API_KEY);
    const installedCatalog = JSON.parse(await readConfig(join(f.settings.codexHome, 'agent-switcher-models.json'))) as { models: { slug: string }[] };
    expect(installedCatalog.models.map((model) => model.slug)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(f.store.getSecrets().snapshot?.values.model).toBe('"gpt-fixture"');
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect(f.store.lastSwitchedAt).not.toBeNull();

    // User changes while DeepSeek is active must survive restoring the managed fields.
    await writeFile(f.configPath, (await readConfig(f.configPath)).replace('theme = "dark"', 'theme = "light"'));
    const restored = await f.service.switchProfile('chatgpt');
    const chatgpt = parse(await readConfig(f.configPath));
    expect(restored.state.activeProfile).toBe('chatgpt');
    expect(restored.state.bridgeRunning).toBe(false);
    expect(chatgpt.model).toBe('gpt-fixture');
    expect(chatgpt.model_reasoning_effort).toBe('medium');
    expect(chatgpt.web_search).toBe('cached');
    expect(chatgpt.model_provider).toBe('openai');
    expect(chatgpt.preferred_auth_method).toBe('chatgpt');
    expect(chatgpt.desktop).toEqual({ 'enabled-reasoning-efforts': ['low', 'medium', 'high'], theme: 'light' });
    expect(chatgpt.mcp_servers).toEqual(parse(ORIGINAL).mcp_servers);
    expect(await readConfig(authPath)).toBe(auth);
    expect(f.store.getSecrets().snapshot).toBeUndefined();
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect(launchConfigs).toHaveLength(2);
    expect(parse(launchConfigs[0]!).model_provider).toBe(PROVIDER);
    expect(parse(launchConfigs[1]!).model_provider).toBe('openai');
    expect(f.processes.stop).toHaveBeenCalledTimes(2);
    expect(f.processes.stop.mock.calls).toEqual([
      [f.installation, { force: true }], [f.installation, { force: true }],
    ]);
    expect(f.bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('does not stop Codex or write config when the key is missing or the installation cannot be found', async () => {
    const f = await fixture(ORIGINAL, {});
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('API_KEY_REQUIRED');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
    f.processes.detect.mockResolvedValueOnce(null);
    await expect(f.service.switchProfile('chatgpt')).rejects.toThrow('CODEX_NOT_FOUND');
    expect(f.service.isBusy).toBe(false);
  });

  it('reports unavailable encryption without attempting a rollback before any mutation', async () => {
    const f = await fixture();
    vi.spyOn(codec, 'isEncryptionAvailable').mockReturnValue(false);
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
  });

  it('cleans up a newly started bridge if the transaction journal cannot be saved', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'update').mockRejectedValue(new AppError('STORAGE_WRITE_FAILED'));
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('STORAGE_WRITE_FAILED');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.bridge.isRunning()).toBe(false);
    expect(f.bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failure before the config write and stops only its newly started bridge', async () => {
    const f = await fixture();
    f.processes.stop.mockRejectedValueOnce(new AppError('STOP_FAILED'));
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('APP_STOP_FAILED');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
    expect(f.bridge.isRunning()).toBe(false);
    expect(f.bridge.stop).toHaveBeenCalledTimes(1);
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: true });
    expect((await f.service.getState()).lastError).toBe('APP_STOP_FAILED');
  });

  it('restores the previous file and relaunches its prior configuration when launching the new profile fails', async () => {
    const f = await fixture();
    const launchConfigs: string[] = [];
    const events: string[] = [];
    f.processes.stop.mockImplementation(async () => { events.push(`stop:${parse(await readConfig(f.configPath)).model_provider}`); });
    f.processes.launch.mockImplementation(async () => {
      launchConfigs.push(await readConfig(f.configPath));
      events.push(`launch:${parse(await readConfig(f.configPath)).model_provider}`);
      if (launchConfigs.length === 1) throw new AppError('LAUNCH_FAILED');
    });
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('APP_START_FAILED');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(launchConfigs).toHaveLength(2);
    expect(parse(launchConfigs[0]!).model_provider).toBe(PROVIDER);
    expect(launchConfigs[1]).toBe(ORIGINAL);
    // A failed launch can still leave a partially started process. It must be
    // stopped while its config is intact, before restoring the old config.
    expect(events).toEqual(['stop:openai', `launch:${PROVIDER}`, `stop:${PROVIDER}`, 'launch:openai']);
    expect(f.processes.stop.mock.calls).toEqual([
      [f.installation, { force: true }], [f.installation, { force: true }],
    ]);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
    expect(f.store.lastSwitchedAt).toBeNull();
    expect(f.bridge.isRunning()).toBe(false);
  });

  it('keeps the recovery journal and new config if a partially launched process cannot be stopped', async () => {
    const f = await fixture();
    f.processes.stop.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Cannot close the partially launched application'));
    f.processes.launch.mockRejectedValueOnce(new Error('Partial launch failed readiness check'));
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('ROLLBACK_FAILED');
    expect(parse(await readConfig(f.configPath)).model_provider).toBe(PROVIDER);
    expect(f.store.getSecrets().pending?.original).toBe(ORIGINAL);
    expect(f.processes.stop).toHaveBeenCalledTimes(2);
    expect(f.processes.launch).toHaveBeenCalledTimes(1);
    expect(f.bridge.isRunning()).toBe(true);
  });

  it('stops an already launched new profile before rolling back a failed final storage commit', async () => {
    const f = await fixture();
    const update = f.store.update.bind(f.store);
    let writes = 0;
    vi.spyOn(f.store, 'update').mockImplementation(async (settings, secrets, switchedAt) => {
      writes += 1;
      if (writes === 2) throw new AppError('STORAGE_WRITE_FAILED');
      await update(settings, secrets, switchedAt);
    });
    const events: string[] = [];
    f.processes.stop.mockImplementation(async () => { events.push('stop'); });
    f.processes.launch.mockImplementation(async () => { events.push(`launch:${parse(await readConfig(f.configPath)).model_provider}`); });
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('STORAGE_WRITE_FAILED');
    expect(events).toEqual(['stop', `launch:${PROVIDER}`, 'stop', 'launch:openai']);
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
    expect(f.bridge.isRunning()).toBe(false);
  });

  it('detects an external edit made during shutdown and never overwrites it', async () => {
    const f = await fixture();
    const edited = `${ORIGINAL}\n# changed by another editor during shutdown\n`;
    f.processes.stop.mockImplementation(async () => { await writeFile(f.configPath, edited); });
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('CONFIG_CONFLICT');
    expect(await readConfig(f.configPath)).toBe(edited);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
    expect(f.bridge.isRunning()).toBe(false);
    expect(f.processes.launch).toHaveBeenCalledTimes(1);
  });

  it('preserves a post-write external edit and its recovery journal if rollback cannot safely restore it', async () => {
    const f = await fixture();
    const edited = `${ORIGINAL}\n# external edit after new config was written\n`;
    f.processes.launch.mockImplementation(async () => {
      await writeFile(f.configPath, edited);
      throw new AppError('LAUNCH_FAILED');
    });
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('ROLLBACK_FAILED');
    expect(await readConfig(f.configPath)).toBe(edited);
    expect(f.store.getSecrets().pending?.original).toBe(ORIGINAL);
    expect((await f.service.getState()).lastError).toBe('ROLLBACK_FAILED');
    expect(f.service.isBusy).toBe(false);
  });

  it('serializes mutating commands while a switch is in progress', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const stopped = new Promise<void>((resolve) => { entered = resolve; });
    f.processes.stop.mockImplementation(async () => { entered(); await paused; });
    const switching = f.service.switchProfile('deepseek');
    await stopped;
    expect(f.service.isBusy).toBe(true);
    await expect(f.service.saveSettings(f.settings)).rejects.toThrow('SWITCH_IN_PROGRESS');
    await expect(f.service.restartCodex()).rejects.toThrow('SWITCH_IN_PROGRESS');
    await expect(f.service.switchProfile('chatgpt')).rejects.toThrow('SWITCH_IN_PROGRESS');
    release();
    await switching;
    expect(f.service.isBusy).toBe(false);
    expect(f.processes.stop).toHaveBeenCalledTimes(1);
  });

  it('removes a newly created config on rollback when there was originally no config file', async () => {
    const f = await fixture(null);
    f.processes.launch.mockRejectedValueOnce(new AppError('LAUNCH_FAILED'));
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('APP_START_FAILED');
    expect(await readOptional(f.configPath)).toBeNull();
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
  });

  it('passes a non-secret Codex home and removes inherited API credentials from launch environment', async () => {
    const f = await fixture();
    vi.stubEnv('OPENAI_API_KEY', 'inherited-openai-key');
    vi.stubEnv('CODEX_API_KEY', 'inherited-codex-key');
    await f.service.restartCodex();
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: true });
    const env = f.processes.launch.mock.calls[0]?.[1];
    expect(env?.CODEX_HOME).toBe(f.settings.codexHome);
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
  });

  it('keeps the original config and does not launch when an explicit forced restart cannot stop the desktop', async () => {
    const f = await fixture();
    f.processes.stop.mockRejectedValueOnce(new Error('Desktop still running after force attempt'));
    await expect(f.service.restartCodex()).rejects.toThrow('APP_STOP_FAILED');
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: true });
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
  });
});

describe('ProfileService recovery and settings', () => {
  it('stops a live desktop before restoring a pending config and relaunches before clearing the journal', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, {
      apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987,
      pending: {
        home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash(written),
        previousSecrets: { apiKey: API_KEY },
      },
    });
    const events: string[] = [];
    f.processes.stop.mockImplementation(async () => {
      expect(await readConfig(f.configPath)).toBe(written);
      expect(f.store.getSecrets().pending).toBeDefined();
      events.push('stop');
    });
    f.processes.launch.mockImplementation(async () => {
      expect(await readConfig(f.configPath)).toBe(ORIGINAL);
      expect(f.store.getSecrets().pending).toBeDefined();
      events.push('launch');
    });
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation(async (...args) => {
      events.push('commit');
      return update(...args);
    });
    await f.service.initialize();
    expect(events).toEqual(['stop', 'launch', 'commit']);
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: false });
    expect(f.store.getSecrets()).toEqual({ apiKey: API_KEY });
    expect((await f.service.getState()).activeProfile).toBe('chatgpt');
    expect(f.bridge.start).not.toHaveBeenCalled();
  });

  it('does not automatically launch an already closed desktop while recovering pending config', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, {
      apiKey: API_KEY,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash(written) },
    });
    f.processes.isRunning.mockResolvedValue(false);
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(f.store.getSecrets().pending).toBeUndefined();
  });

  it('leaves the abandoned config and recovery journal intact if live Codex cannot stop during recovery', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    await writeFile(f.configPath, written);
    const secrets: SecretData = {
      apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash(written) },
    };
    await f.store.update(f.settings, secrets);
    f.processes.stop.mockRejectedValueOnce(new Error('User has an open modal dialog'));
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(written);
    expect(f.store.getSecrets()).toEqual(secrets);
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: false });
    expect((await f.service.getState()).lastError).toBe('APP_STOP_FAILED');
  });

  it('recovers a pending on-disk switch on startup using its original content', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, {
      apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash(written) },
    });
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect((await f.service.getState()).lastError).toBeNull();
    const reloaded = new LocalStore(f.storePath, codec, f.settings);
    await reloaded.load();
    expect(reloaded.getSecrets().pending).toBeUndefined();
  });

  it('clears a pending journal when the config still matches the original pre-write state', async () => {
    const f = await fixture();
    await f.store.update(f.settings, {
      apiKey: API_KEY,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash('a not-yet-written config') },
    });
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect((await f.service.getState()).lastError).toBeNull();
  });

  it('restores the previous encrypted snapshot when a pending switch to ChatGPT is recovered', async () => {
    const f = await fixture();
    const snapshot = snapshotConfig(ORIGINAL, f.settings.codexHome);
    const original = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    const written = chatgptConfig(original, snapshot);
    const previousSecrets: SecretData = { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987, snapshot };
    const pending = { home: f.settings.codexHome, original, writtenHash: configHash(written), previousSecrets };
    await writeFile(f.configPath, written);
    // A staged ChatGPT transaction has deleted snapshot from its current secrets;
    // recovery must restore the snapshot saved with the previous committed state.
    await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987, pending });
    f.processes.launch.mockImplementationOnce(async () => {
      expect(await readConfig(f.configPath)).toBe(original);
      expect(f.bridge.isRunning()).toBe(true);
      expect(f.store.getSecrets().pending).toBeDefined();
    });
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(original);
    expect(f.store.getSecrets().snapshot).toEqual(snapshot);
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect((await f.service.getState()).bridgeRunning).toBe(true);
    await f.service.switchProfile('chatgpt');
    const restored = parse(await readConfig(f.configPath));
    expect(restored.model).toBe('gpt-fixture');
    expect(restored.web_search).toBe('cached');
  });

  it('does not overwrite an external edit while recovering an interrupted transaction', async () => {
    const edited = `${ORIGINAL}\n# preserve this newer edit\n`;
    const f = await fixture(edited);
    await f.store.update(f.settings, {
      apiKey: API_KEY,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash('interrupted config') },
    });
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(edited);
    expect(f.store.getSecrets().pending).toBeDefined();
    expect((await f.service.getState()).lastError).toBe('CONFIG_CONFLICT');
  });

  it('blocks settings, switching, and restarting while an unresolved recovery journal remains', async () => {
    const edited = `${ORIGINAL}\n# newer edit blocks automatic recovery\n`;
    const f = await fixture(edited);
    const secrets: SecretData = {
      apiKey: API_KEY,
      pending: {
        home: f.settings.codexHome, original: ORIGINAL,
        writtenHash: configHash('an abandoned transaction config'),
        previousSecrets: { apiKey: API_KEY, snapshot: snapshotConfig(ORIGINAL, f.settings.codexHome) },
      },
    };
    await f.store.update(f.settings, secrets);
    await f.service.initialize();
    expect((await f.service.getState()).lastError).toBe('CONFIG_CONFLICT');
    const stored = await readConfig(f.storePath);
    await expect(f.service.saveSettings({ ...f.settings, language: 'en', clearApiKey: true })).rejects.toThrow('RECOVERY_REQUIRED');
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('RECOVERY_REQUIRED');
    await expect(f.service.switchProfile('chatgpt')).rejects.toThrow('RECOVERY_REQUIRED');
    await expect(f.service.restartCodex()).rejects.toThrow('RECOVERY_REQUIRED');
    expect(await readConfig(f.storePath)).toBe(stored);
    expect(f.store.getSecrets()).toEqual(secrets);
    expect(await readConfig(f.configPath)).toBe(edited);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.service.isBusy).toBe(false);
  });

  it('resumes the exact owned DeepSeek proxy endpoint after an ordinary restart', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987 });
    await f.service.initialize();
    expect(f.bridge.start).toHaveBeenCalledWith({
      port: 41987, token: LOCAL_TOKEN, apiKey: API_KEY,
      baseUrl: f.settings.deepseekBaseUrl, model: 'deepseek-flash',
      models: ['deepseek-flash', 'deepseek-v4-pro'], protocol: 'responses',
    });
    expect((await f.service.getState()).bridgeRunning).toBe(true);
  });

  it('preserves edits made while the desktop is closing during startup recovery', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    const edited = `${written}\n# external edit while closing\n`;
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, {
      apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987,
      pending: { home: f.settings.codexHome, original: ORIGINAL, writtenHash: configHash(written) },
    });
    f.processes.stop.mockImplementation(async () => { await writeFile(f.configPath, edited); });
    await f.service.initialize();
    expect(await readConfig(f.configPath)).toBe(edited);
    expect(f.store.getSecrets().pending).toBeDefined();
    expect((await f.service.getState()).lastError).toBe('CONFIG_CONFLICT');
    expect(f.processes.launch).not.toHaveBeenCalled();
  });

  it('refuses to start a proxy for a config endpoint it does not own', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    const catalogPath = join(f.settings.codexHome, 'agent-switcher-models.json');
    const oldCatalog = '{"models":[{"slug":"deepseek-flash"}]}\n';
    await writeFile(f.configPath, written);
    await writeFile(catalogPath, oldCatalog);
    await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: 'different-owner-token', bridgePort: 41987 });
    await f.service.initialize();
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect((await f.service.getState()).lastError).toBe('CONFIG_CONFLICT');
    await expect(f.service.restartCodex()).rejects.toThrow('CONFIG_CONFLICT');
    expect(await readConfig(catalogPath)).toBe(oldCatalog);
    expect(await readConfig(f.configPath)).toBe(written);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
  });

  it('protects active API credentials, model, endpoint, and config home while allowing language preferences', async () => {
    const f = await fixture();
    await f.service.switchProfile('deepseek');
    await expect(f.service.saveSettings({ ...f.settings, clearApiKey: true })).rejects.toThrow('API_KEY_IN_USE');
    await expect(f.service.saveSettings({ ...f.settings, apiKey: 'sk-another-key' })).rejects.toThrow('RESTART_REQUIRED');
    await expect(f.service.saveSettings({ ...f.settings, deepseekModel: 'deepseek-v4-pro' })).rejects.toThrow('RESTART_REQUIRED');
    await expect(f.service.saveSettings({ ...f.settings, deepseekBaseUrl: 'https://another-provider.example' })).rejects.toThrow('RESTART_REQUIRED');
    await expect(f.service.saveSettings({ ...f.settings, codexHome: join(f.directory, 'another-home') })).rejects.toThrow('CONFIG_HOME_ACTIVE');
    const state = await f.service.saveSettings({ ...f.settings, language: 'en', hideOnBlur: false });
    expect(state.settings.language).toBe('en');
    expect(state.settings.hideOnBlur).toBe(false);
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
  });

  it('keeps an existing key for an empty password field, and deletes it only when explicitly requested', async () => {
    const f = await fixture();
    await f.service.saveSettings({ ...f.settings, apiKey: '' });
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
    await f.service.saveSettings({ ...f.settings, apiKey: '  sk-replaced  ' });
    expect(f.store.getSecrets().apiKey).toBe('sk-replaced');
    await f.service.saveSettings({ ...f.settings, clearApiKey: true });
    expect(f.store.hasApiKey).toBe(false);
  });

  it('compensates an OS login preference change if saving settings fails', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'update').mockRejectedValueOnce(new AppError('STORAGE_WRITE_FAILED'));
    await expect(f.service.saveSettings({ ...f.settings, launchAtLogin: true })).rejects.toThrow('STORAGE_WRITE_FAILED');
    expect(f.onLoginPreference.mock.calls).toEqual([[true], [false]]);
    expect(f.store.settings.launchAtLogin).toBe(false);
  });

  it('does not permit switching a Store app against a custom Codex home that activation cannot carry', async () => {
    const f = await fixture();
    f.processes.detect.mockResolvedValue({ ...f.installation, kind: 'store', aumid: 'Fixture!App' });
    await expect(f.service.switchProfile('deepseek')).rejects.toThrow('CUSTOM_HOME_STORE_UNSUPPORTED');
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
  });

  it('rejects malformed settings and insecure credential endpoints before persistence', async () => {
    const f = await fixture();
    for (const deepseekBaseUrl of ['http://provider.example', 'https://key:secret@provider.example', 'https://provider.example?token=secret', 'https://provider.example#fragment']) {
      await expect(f.service.saveSettings({ ...f.settings, deepseekBaseUrl })).rejects.toThrow('INVALID_SETTINGS');
    }
    await expect(f.service.saveSettings({ ...f.settings, apiKey: 'key\r\ninjected-header:secret' })).rejects.toThrow('INVALID_SETTINGS');
    expect(f.store.settings).toEqual(f.settings);
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
  });
});

describe('ProfileService managed model catalog upgrades', () => {
  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    'upgrades an old single-model catalog on ordinary startup while keeping %s as default', async (defaultModel) => {
      const f = await fixture();
      const settings = { ...f.settings, deepseekModel: defaultModel };
      const written = deepseekConfig(ORIGINAL, settings.codexHome, 41987, LOCAL_TOKEN, defaultModel);
      const catalogPath = join(settings.codexHome, 'agent-switcher-models.json');
      const authPath = join(settings.codexHome, 'auth.json');
      const auth = '{"tokens":{"access_token":"existing-chatgpt-fixture"}}\n';
      await writeFile(f.configPath, written);
      await writeFile(catalogPath, JSON.stringify({ models: [{ slug: defaultModel }] }));
      await writeFile(authPath, auth);
      await f.store.update(settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987 }, null,
        f.store.profiles.map((profile) => ({ ...profile, defaultModel })));
      const stored = await readConfig(f.storePath);

      await f.service.initialize();

      const catalog = JSON.parse(await readConfig(catalogPath)) as { models: { slug: string }[] };
      expect(catalog.models).toHaveLength(2);
      expect(catalog.models[0]?.slug).toBe(defaultModel);
      expect(catalog.models.map((model) => model.slug).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
      expect(await readConfig(f.configPath)).toBe(written);
      expect(await readConfig(authPath)).toBe(auth);
      expect(await readConfig(f.storePath)).toBe(stored);
      expect(f.processes.stop).not.toHaveBeenCalled();
      expect(f.processes.launch).not.toHaveBeenCalled();
      expect(f.bridge.start).toHaveBeenCalledWith({
        port: 41987, token: LOCAL_TOKEN, apiKey: API_KEY,
        baseUrl: settings.deepseekBaseUrl, model: defaultModel,
        models: ['deepseek-flash', 'deepseek-v4-pro'], protocol: 'responses',
      });
      expect((await f.service.getState()).lastError).toBeNull();
    },
  );

  it('refreshes both models and restores an offline proxy before a user-confirmed desktop restart', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    const catalogPath = join(f.settings.codexHome, 'agent-switcher-models.json');
    await writeFile(f.configPath, written);
    await writeFile(catalogPath, '{"models":[{"slug":"deepseek-flash"}]}');
    await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987 });
    const stored = await readConfig(f.storePath);
    const events: string[] = [];
    const checkReady = async () => {
      const catalog = JSON.parse(await readConfig(catalogPath)) as { models: { slug: string }[] };
      expect(catalog.models.map((model) => model.slug)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
      expect(f.bridge.isRunning()).toBe(true);
      expect(await readConfig(f.configPath)).toBe(written);
    };
    f.processes.stop.mockImplementationOnce(async () => { await checkReady(); events.push('stop'); });
    f.processes.launch.mockImplementationOnce(async () => { await checkReady(); events.push('launch'); });

    const state = await f.service.restartCodex();

    expect(events).toEqual(['stop', 'launch']);
    expect(f.processes.stop).toHaveBeenCalledWith(f.installation, { force: true });
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    expect(state.activeProfile).toBe('deepseek');
    expect(state.settings.deepseekModel).toBe('deepseek-flash');
    expect(state.bridgeRunning).toBe(true);
    expect(await readConfig(f.storePath)).toBe(stored);
  });

  it('refreshes the model list without restarting a proxy that is already serving requests', async () => {
    const f = await fixture();
    const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash');
    const catalogPath = join(f.settings.codexHome, 'agent-switcher-models.json');
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987 });
    await f.service.initialize();
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    await writeFile(catalogPath, '{"models":[{"slug":"deepseek-flash"}]}');

    await f.service.restartCodex();

    const catalog = JSON.parse(await readConfig(catalogPath)) as { models: { slug: string }[] };
    expect(catalog.models.map((model) => model.slug)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    expect(f.bridge.stop).not.toHaveBeenCalled();
  });

  it.each(['initialize', 'restart'] as const)(
    'preserves explicitly selected external catalogs during %s', async (operation) => {
      const f = await fixture();
      const catalogPath = join(f.settings.codexHome, 'agent-switcher-models.json');
      const customPath = join(f.directory, 'user-owned-models.json');
      const written = deepseekConfig(ORIGINAL, f.settings.codexHome, 41987, LOCAL_TOKEN, 'deepseek-flash')
        .replace(JSON.stringify(catalogPath), JSON.stringify(customPath));
      const customCatalog = '{"models":[{"slug":"user-owned-model","custom":true}]}\n';
      const managedCatalog = '{"models":[{"slug":"deepseek-flash"}]}\n';
      await writeFile(f.configPath, written);
      await writeFile(customPath, customCatalog);
      await writeFile(catalogPath, managedCatalog);
      await f.store.update(f.settings, { apiKey: API_KEY, bridgeToken: LOCAL_TOKEN, bridgePort: 41987 });

      if (operation === 'initialize') await f.service.initialize();
      else await f.service.restartCodex();

      expect(await readConfig(customPath)).toBe(customCatalog);
      expect(await readConfig(catalogPath)).toBe(managedCatalog);
      expect(await readConfig(f.configPath)).toBe(written);
      expect(f.bridge.start).toHaveBeenCalledTimes(1);
      if (operation === 'initialize') {
        expect(f.processes.stop).not.toHaveBeenCalled();
        expect(f.processes.launch).not.toHaveBeenCalled();
      }
    },
  );

  it('does not create or activate a DeepSeek catalog when starting with ChatGPT', async () => {
    const f = await fixture();
    await f.service.initialize();
    expect(await readOptional(join(f.settings.codexHome, 'agent-switcher-models.json'))).toBeNull();
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
  });
});

describe('ProfileService connection checks', () => {
  it('uses the stored key when the renderer explicitly supplies an undefined optional apiKey', async () => {
    const f = await fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"deepseek-flash"}]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await f.service.testConnection({
      apiKey: undefined, baseUrl: f.settings.deepseekBaseUrl, model: f.settings.deepseekModel,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.objectContaining({
      headers: { Authorization: `Bearer ${API_KEY}` },
    }));
  });

  it('checks a model catalog without issuing a paid inference request or persisting a draft key', async () => {
    const f = await fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await f.service.testConnection({ apiKey: 'sk-draft', baseUrl: 'https://provider.example/v1/', model: 'deepseek-v4-pro' });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-draft' }, redirect: 'error',
    }));
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
  });

  it('returns symbolic key, model, network, and validation errors without leaking provider messages', async () => {
    const f = await fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(`Rejected ${API_KEY}`, { status: 401 }));
    expect((await f.service.testConnection()).error).toBe('API_KEY_REJECTED');
    fetchMock.mockResolvedValueOnce(new Response('{"data":[{"id":"other-model"}]}', { status: 200 }));
    expect((await f.service.testConnection({ model: f.settings.deepseekModel })).error).toBe('MODEL_NOT_FOUND');
    fetchMock.mockRejectedValueOnce(new Error(`Socket error containing ${API_KEY}`));
    const error = await f.service.testConnection();
    expect(error.error).toBe('CONNECTION_FAILED');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect((await f.service.testConnection({ baseUrl: 'http://provider.example' })).error).toBe('INVALID_SETTINGS');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('ProfileService API profile management', () => {
  it('creates and edits independent API configurations, retaining a blank key and deleting only the requested key', async () => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'First API', apiKey: 'sk-first-profile' });
    const second = await createProfile(f, { name: 'Second API', apiKey: 'sk-second-profile', protocol: 'chat_completions' });
    expect(first.id).not.toBe(second.id);
    expect(first.hasApiKey).toBe(true);
    expect(second.hasApiKey).toBe(true);
    expect(f.store.getSecrets().apiKeys).toEqual({ [first.id]: 'sk-first-profile', [second.id]: 'sk-second-profile' });
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);

    const edited = await f.service.saveProfile({ ...first, name: 'Renamed API', apiKey: '', defaultModel: 'example-fast' });
    expect(edited.profiles.find((profile) => profile.id === first.id)).toMatchObject({ name: 'Renamed API', defaultModel: 'example-fast', hasApiKey: true });
    expect(f.store.getSecrets().apiKeys?.[first.id]).toBe('sk-first-profile');
    await f.service.saveProfile({ ...second, clearApiKey: true });
    expect((await f.service.getState()).profiles.find((profile) => profile.id === second.id)?.hasApiKey).toBe(false);
    expect(f.store.getSecrets().apiKeys?.[second.id]).toBeUndefined();
    expect(f.store.getSecrets().apiKeys?.[first.id]).toBe('sk-first-profile');

    const deleted = await f.service.deleteProfile(first.id);
    expect(deleted.profiles.map((profile) => profile.id)).toEqual(['deepseek', second.id]);
    expect(f.store.getSecrets().apiKeys?.[first.id]).toBeUndefined();
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
    const publicState = JSON.stringify(deleted);
    const stored = await readConfig(f.storePath);
    for (const key of [API_KEY, 'sk-first-profile', 'sk-second-profile']) {
      expect(publicState).not.toContain(key);
      expect(stored).not.toContain(key);
    }
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
  });

  it('persists several configurations and their encrypted keys across a store reload', async () => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'GLM fixture', preset: 'glm', apiKey: 'sk-glm-fixture' });
    const second = await createProfile(f, { name: 'Kimi fixture', preset: 'kimi', apiKey: 'sk-kimi-fixture' });
    const reloaded = new LocalStore(f.storePath, codec, f.settings);
    await reloaded.load();
    expect(reloaded.profiles.map((profile) => profile.id)).toEqual(['deepseek', first.id, second.id]);
    expect(reloaded.profiles.find((profile) => profile.id === second.id)).toMatchObject({ name: 'Kimi fixture', preset: 'kimi' });
    expect(reloaded.getSecrets().apiKeys).toEqual({ [first.id]: 'sk-glm-fixture', [second.id]: 'sk-kimi-fixture' });
  });

  it('rejects edits and deletion of an active configuration while allowing another configuration to change', async () => {
    const f = await fixture();
    const first = await createProfile(f);
    const second = await createProfile(f, { name: 'Inactive API' });
    await f.service.switchProfile(first.id);
    const stored = await readConfig(f.storePath);
    const written = await readConfig(f.configPath);
    await expect(f.service.saveProfile({ ...first, apiKey: 'sk-replacement' })).rejects.toThrow('PROFILE_IN_USE');
    await expect(f.service.deleteProfile(first.id)).rejects.toThrow('PROFILE_IN_USE');
    expect(await readConfig(f.storePath)).toBe(stored);
    expect(await readConfig(f.configPath)).toBe(written);
    expect(f.store.getSecrets().apiKeys?.[first.id]).toBe('sk-example-profile');
    await f.service.saveProfile({ ...second, name: 'Changed while another API is active' });
    expect(f.store.profiles.find((profile) => profile.id === second.id)?.name).toBe('Changed while another API is active');
    await f.service.switchProfile('chatgpt');
    await f.service.deleteProfile(first.id);
    expect(f.store.profiles.some((profile) => profile.id === first.id)).toBe(false);
  });

  it('allows a profile without a key to be saved but blocks activating it before stopping the desktop', async () => {
    const f = await fixture();
    const profile = await createProfile(f, { apiKey: '' });
    expect(profile.hasApiKey).toBe(false);
    await expect(f.service.switchProfile(profile.id)).rejects.toThrow('API_KEY_REQUIRED');
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
  });

  it('rejects unknown profile identifiers and malformed metadata without persisting changes', async () => {
    const f = await fixture();
    const stored = await readConfig(f.storePath);
    await expect(f.service.deleteProfile('unknown')).rejects.toThrow('PROFILE_NOT_FOUND');
    await expect(f.service.switchProfile('unknown')).rejects.toThrow('INVALID_PROFILE');
    await expect(f.service.saveProfile({ id: 'unknown', name: 'Unknown', preset: 'custom', baseUrl: 'https://provider.example', protocol: 'auto', modelIds: ['one'] })).rejects.toThrow('PROFILE_NOT_FOUND');
    await expect(createProfile(f, { modelIds: ['bad model'] })).rejects.toThrow('INVALID_PROFILE');
    await expect(createProfile(f, { apiKey: 'sk-test\r\nInjected: yes' })).rejects.toThrow('INVALID_PROFILE');
    expect(await readConfig(f.storePath)).toBe(stored);
    expect(await readConfig(f.configPath)).toBe(ORIGINAL);
  });

  it('keeps migrated DeepSeek settings and the legacy key synchronized when editing its configuration', async () => {
    const f = await fixture();
    const deepseek = (await f.service.getState()).profiles.find((profile) => profile.id === 'deepseek')!;
    await f.service.saveProfile({ ...deepseek, modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-v4-pro', apiKey: 'sk-deepseek-updated', protocol: 'auto' });
    expect(f.store.settings.deepseekModel).toBe('deepseek-v4-pro');
    expect(f.store.getSecrets().apiKey).toBe('sk-deepseek-updated');
    await f.service.switchProfile('deepseek');
    expect(parse(await readConfig(f.configPath)).model).toBe('deepseek-v4-pro');
    expect(f.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-deepseek-updated', model: 'deepseek-v4-pro', protocol: 'auto' }));
  });
});

describe('ProfileService API model discovery', () => {
  it('discovers, deduplicates, and validates models from the entered API URL and key without an inference call', async () => {
    const f = await fixture();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'discovered-fast' }, { id: 'discovered-pro' }, { id: 'discovered-fast' }, { id: 'bad model' }, { id: 42 },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const profile = await createProfile(f, { baseUrl: ' https://discovery.example/v1/chat/completions/ ', modelIds: undefined, defaultModel: undefined, apiKey: '  sk-discovery  ' });
    expect(profile.baseUrl).toBe('https://discovery.example/v1');
    expect(profile.modelIds).toEqual(['discovered-fast', 'discovered-pro']);
    expect(profile.defaultModel).toBe('discovered-fast');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://discovery.example/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-discovery' }, redirect: 'error',
    }));
    expect(f.store.getSecrets().apiKeys?.[profile.id]).toBe('sk-discovery');
    expect(f.processes.stop).not.toHaveBeenCalled();
  });

  it.each(['deepseek', 'glm', 'kimi'] as const)('uses the %s preset models when its official endpoint does not offer model discovery', async (presetId) => {
    const f = await fixture();
    const preset = PROVIDER_PRESETS.find((preset) => preset.preset === presetId)!;
    const fetchMock = vi.fn().mockResolvedValue(new Response('Models endpoint not supported', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const profile = await createProfile(f, { ...preset, modelIds: undefined, defaultModel: undefined, apiKey: 'sk-official-preset' });
    expect(profile.modelIds).toEqual(preset.modelIds);
    expect(profile.defaultModel).toBe(preset.defaultModel);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(preset.baseUrl + '/models', expect.objectContaining({ headers: { Authorization: 'Bearer sk-official-preset' } }));
  });

  it('prefers discovered models over a preset and selects a model actually offered by that endpoint', async () => {
    const f = await fixture();
    const preset = PROVIDER_PRESETS.find((preset) => preset.preset === 'glm')!;
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"glm-private-fast"},{"id":"glm-private-pro"}]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const profile = await createProfile(f, { ...preset, modelIds: undefined, defaultModel: undefined });
    expect(profile.modelIds).toEqual(['glm-private-fast', 'glm-private-pro']);
    expect(profile.defaultModel).toBe('glm-private-fast');
  });

  it('rejects an explicitly selected default model absent from the profile model list', async () => {
    const f = await fixture();
    await expect(createProfile(f, { modelIds: ['example-fast'], defaultModel: 'example-pro' })).rejects.toThrow('INVALID_PROFILE');
    expect(f.store.profiles).toHaveLength(1);
  });

  it.each([
    { status: 401, preset: 'glm' as const, baseUrl: 'https://open.bigmodel.cn/api/v1', error: 'API_KEY_REJECTED' },
    { status: 503, preset: 'glm' as const, baseUrl: 'https://open.bigmodel.cn/api/v1', error: 'CONNECTION_FAILED' },
    { status: 404, preset: 'custom' as const, baseUrl: 'https://custom.example/v1', error: 'MODEL_DISCOVERY_UNAVAILABLE' },
    { status: 404, preset: 'glm' as const, baseUrl: 'https://another.example/v1', error: 'MODEL_DISCOVERY_UNAVAILABLE' },
  ])('does not hide $error with preset defaults for $baseUrl', async ({ status, preset, baseUrl, error }) => {
    const f = await fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream error containing sk-draft-private', { status })));
    const stored = await readConfig(f.storePath);
    await expect(createProfile(f, { preset, baseUrl, modelIds: undefined, apiKey: 'sk-draft-private' })).rejects.toThrow(error);
    expect(await readConfig(f.storePath)).toBe(stored);
    expect(JSON.stringify(await f.service.getState())).not.toContain('sk-draft-private');
  });

  it('uses a saved profile key only for an explicitly selected profile and never borrows the legacy key for a new URL', async () => {
    const f = await fixture();
    const profile = await createProfile(f, { apiKey: 'sk-scoped-profile' });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"example-pro"}]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await f.service.testConnection({ baseUrl: profile.baseUrl })).error).toBe('API_KEY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await f.service.testConnection({ profileId: profile.id, baseUrl: profile.baseUrl, model: 'example-pro', apiKey: '' });
    expect(result).toMatchObject({ ok: true, models: ['example-pro'] });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(profile.baseUrl + '/models', expect.objectContaining({ headers: { Authorization: 'Bearer sk-scoped-profile' } }));
    expect(f.store.getSecrets().apiKey).toBe(API_KEY);
  });
});

describe('ProfileService switching between API configurations', () => {
  it('switches API A → API B → ChatGPT with isolated catalogs, rotated local tokens, and the original ChatGPT snapshot', async () => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'First API', baseUrl: 'https://first.example/v1', apiKey: 'sk-first-only' });
    const second = await createProfile(f, { name: 'Second API', baseUrl: 'https://second.example/v1', apiKey: 'sk-second-only', protocol: 'chat_completions', modelIds: ['second-model'], defaultModel: 'second-model' });
    const authPath = join(f.settings.codexHome, 'auth.json');
    const auth = '{"tokens":{"access_token":"fixture-chatgpt-token"}}\n';
    await writeFile(authPath, auth);
    await f.service.switchProfile(first.id);
    const firstConfig = await readConfig(f.configPath);
    const originalSnapshot = f.store.getSecrets().snapshot;
    const firstEndpoint = managedEndpoint(firstConfig)!;
    expect(originalSnapshot?.values.model).toBe('"gpt-fixture"');
    expect(firstEndpoint.token).toBe(f.store.getSecrets().bridgeToken);
    expect(parse(firstConfig).model_catalog_json).toBe(catalogFile(f.settings.codexHome, first.id));
    const firstCatalog = await readConfig(catalogFile(f.settings.codexHome, first.id));

    const switched = await f.service.switchProfile(second.id);
    const secondConfig = await readConfig(f.configPath);
    const secondEndpoint = managedEndpoint(secondConfig)!;
    expect(switched.state.activeProfile).toBe(second.id);
    expect(f.store.getSecrets().activeProfileId).toBe(second.id);
    expect(secondEndpoint.port).toBe(firstEndpoint.port);
    expect(secondEndpoint.token).not.toBe(firstEndpoint.token);
    expect(secondEndpoint.token).toBe(f.store.getSecrets().bridgeToken);
    expect(f.store.getSecrets().snapshot).toEqual(originalSnapshot);
    expect(parse(secondConfig).model_provider).toBe('agent_switcher_' + second.id);
    expect(parse(secondConfig).model).toBe('second-model');
    expect(parse(secondConfig).model_catalog_json).toBe(catalogFile(f.settings.codexHome, second.id));
    expect(await readConfig(catalogFile(f.settings.codexHome, first.id))).toBe(firstCatalog);
    expect(JSON.parse(await readConfig(catalogFile(f.settings.codexHome, second.id))).models.map((model: { slug: string }) => model.slug)).toEqual(['second-model']);
    expect(f.bridge.start).toHaveBeenLastCalledWith({ port: firstEndpoint.port, token: secondEndpoint.token, apiKey: 'sk-second-only', baseUrl: second.baseUrl, model: 'second-model', models: ['second-model'], protocol: 'chat_completions' });
    expect(secondConfig).not.toContain('sk-first-only');
    expect(secondConfig).not.toContain('sk-second-only');

    await writeFile(f.configPath, secondConfig.replace('theme = "dark"', 'theme = "light"'));
    const restored = await f.service.switchProfile('chatgpt');
    const chatgpt = parse(await readConfig(f.configPath));
    expect(restored.state.activeProfile).toBe('chatgpt');
    expect(restored.state.bridgeRunning).toBe(false);
    expect(chatgpt.model).toBe('gpt-fixture');
    expect(chatgpt.model_provider).toBe('openai');
    expect(chatgpt.model_reasoning_effort).toBe('medium');
    expect(chatgpt.desktop).toEqual({ 'enabled-reasoning-efforts': ['low', 'medium', 'high'], theme: 'light' });
    expect(chatgpt.mcp_servers).toEqual(parse(ORIGINAL).mcp_servers);
    expect(await readConfig(authPath)).toBe(auth);
    expect(f.store.getSecrets().snapshot).toBeUndefined();
    expect(f.store.getSecrets().activeProfileId).toBeUndefined();
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect(f.store.getSecrets().apiKeys).toEqual({ [first.id]: 'sk-first-only', [second.id]: 'sk-second-only' });
  });

  it.each(['launch', 'bridge'] as const)('restores API A, its key, and its token before relaunching when API B fails during %s', async (failure) => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'First API', baseUrl: 'https://first.example/v1', apiKey: 'sk-first-rollback' });
    const second = await createProfile(f, { name: 'Second API', baseUrl: 'https://second.example/v1', apiKey: 'sk-second-rollback' });
    await f.service.switchProfile(first.id);
    const firstConfig = await readConfig(f.configPath);
    const previousSecrets = f.store.getSecrets();
    const previousTimestamp = f.store.lastSwitchedAt;
    const previousBridge = f.bridge.start.mock.calls[0]![0];
    if (failure === 'launch') f.processes.launch.mockRejectedValueOnce(new Error('B cannot start'));
    else f.bridge.start.mockRejectedValueOnce(new AppError('BRIDGE_START_FAILED'));
    f.processes.launch.mockImplementationOnce(async () => {
      expect(await readConfig(f.configPath)).toBe(firstConfig);
      expect(f.bridge.isRunning()).toBe(true);
      expect(f.bridge.start).toHaveBeenLastCalledWith(previousBridge);
      expect(f.store.getSecrets()).toEqual(previousSecrets);
    });
    await expect(f.service.switchProfile(second.id)).rejects.toThrow(failure === 'launch' ? 'APP_START_FAILED' : 'BRIDGE_START_FAILED');
    expect(await readConfig(f.configPath)).toBe(firstConfig);
    expect(f.store.getSecrets()).toEqual(previousSecrets);
    expect(f.store.lastSwitchedAt).toBe(previousTimestamp);
    expect(f.store.getSecrets().pending).toBeUndefined();
    expect(f.bridge.start).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-first-rollback', token: previousSecrets.bridgeToken, baseUrl: first.baseUrl }));
    expect((await f.service.getState()).activeProfile).toBe(first.id);
    expect(f.bridge.isRunning()).toBe(true);
  });

  it('resumes the saved active API profile with its own key and catalog after an ordinary app startup', async () => {
    const f = await fixture();
    const profile = await createProfile(f, { apiKey: 'sk-custom-resume', protocol: 'chat_completions' });
    await f.service.switchProfile(profile.id);
    const written = await readConfig(f.configPath);
    const endpoint = managedEndpoint(written)!;
    const staleCatalog = '{"models":[{"slug":"stale-model"}]}';
    await writeFile(catalogFile(f.settings.codexHome, profile.id), staleCatalog);
    await f.bridge.stop();
    f.bridge.start.mockClear();
    f.processes.stop.mockClear();
    f.processes.launch.mockClear();
    await f.service.initialize();
    expect(f.bridge.start).toHaveBeenCalledExactlyOnceWith({
      port: endpoint.port, token: endpoint.token, apiKey: 'sk-custom-resume', baseUrl: profile.baseUrl,
      model: profile.defaultModel, models: profile.modelIds, protocol: profile.protocol,
    });
    expect(JSON.parse(await readConfig(catalogFile(f.settings.codexHome, profile.id))).models[0].slug).toBe(profile.defaultModel);
    expect(await readConfig(f.configPath)).toBe(written);
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
  });

  it.each(['initialize', 'restart'] as const)('refuses a dormant profile manually selected with another profile’s live bridge credentials during %s', async (operation) => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'First API', apiKey: 'sk-first-manual' });
    const second = await createProfile(f, { name: 'Second API', apiKey: 'sk-second-manual' });
    await f.service.switchProfile(first.id);
    const endpoint = managedEndpoint(await readConfig(f.configPath))!;
    const manual = apiConfig(await readConfig(f.configPath), f.settings.codexHome, endpoint.port, endpoint.token, second);
    await writeFile(f.configPath, manual);
    await f.bridge.stop();
    f.bridge.start.mockClear();
    f.processes.stop.mockClear();
    f.processes.launch.mockClear();
    if (operation === 'initialize') {
      await f.service.initialize();
      expect((await f.service.getState()).lastError).toBe('CONFIG_CONFLICT');
    } else await expect(f.service.restartCodex()).rejects.toThrow('CONFIG_CONFLICT');
    expect(f.bridge.start).not.toHaveBeenCalled();
    expect(f.processes.stop).not.toHaveBeenCalled();
    expect(f.processes.launch).not.toHaveBeenCalled();
    expect(await readConfig(f.configPath)).toBe(manual);
    expect(f.store.getSecrets().activeProfileId).toBe(first.id);
  });

  it('recovers an interrupted A → B switch using A’s journaled credentials before reopening the desktop', async () => {
    const f = await fixture();
    const first = await createProfile(f, { name: 'First API', apiKey: 'sk-first-recovery' });
    const second = await createProfile(f, { name: 'Second API', apiKey: 'sk-second-recovery' });
    await f.service.switchProfile(first.id);
    const original = await readConfig(f.configPath);
    const previousSecrets = f.store.getSecrets();
    const endpoint = managedEndpoint(original)!;
    const secondToken = 'different-local-token-for-second-profile';
    const written = apiConfig(original, f.settings.codexHome, endpoint.port, secondToken, second);
    await writeFile(f.configPath, written);
    await f.store.update(f.settings, {
      ...previousSecrets, activeProfileId: second.id, bridgeToken: secondToken,
      pending: { home: f.settings.codexHome, original, writtenHash: configHash(written), previousSecrets },
    });
    await f.bridge.stop();
    f.bridge.start.mockClear();
    f.processes.stop.mockClear();
    f.processes.launch.mockClear();
    f.processes.launch.mockImplementationOnce(async () => {
      expect(await readConfig(f.configPath)).toBe(original);
      expect(f.bridge.start).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-first-recovery', token: endpoint.token, models: first.modelIds }));
    });
    await f.service.initialize();
    expect(f.store.getSecrets()).toEqual(previousSecrets);
    expect((await f.service.getState()).activeProfile).toBe(first.id);
    expect((await f.service.getState()).lastError).toBeNull();
    expect(f.processes.stop).toHaveBeenCalledExactlyOnceWith(f.installation, { force: false });
    expect(f.processes.launch).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileService remembers each API model selection', () => {
  it('restores the last DeepSeek model and effort after a ChatGPT round trip and app restart', async () => {
    const f = await fixture();
    await f.service.switchProfile('deepseek');
    await selectModel(f, 'deepseek-v4-pro', 'max');
    await f.service.switchProfile('chatgpt');
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'gpt-fixture', model_reasoning_effort: 'medium' });
    await selectModel(f, 'gpt-other-fixture', 'high');

    const reloadedStore = new LocalStore(f.storePath, codec, f.settings);
    await reloadedStore.load();
    const reloadedService = new ProfileService({ store: reloadedStore, processes: f.processes, bridge: f.bridge, version: 'test' });
    await reloadedService.initialize();
    await reloadedService.switchProfile('deepseek');
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'deepseek-v4-pro', model_reasoning_effort: 'max' });
    await reloadedService.switchProfile('chatgpt');
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'gpt-other-fixture', model_reasoning_effort: 'high' });
    expect(reloadedStore.getSecrets().pending).toBeUndefined();
  });

  it('isolates multiple API selections and preserves a selection when switching to the same profile', async () => {
    const f = await fixture();
    const first = await createProfile(f);
    const second = await createProfile(f, { name: 'Second API', modelIds: ['second-fast', 'second-pro'], defaultModel: 'second-fast' });
    await f.service.switchProfile(first.id);
    await selectModel(f, 'example-fast', 'low');
    await f.service.switchProfile(second.id);
    await selectModel(f, 'second-pro', 'high');
    await f.service.switchProfile(first.id);
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'example-fast', model_reasoning_effort: 'low' });
    await selectModel(f, 'example-pro', 'medium');
    await f.service.switchProfile(first.id);
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'example-pro', model_reasoning_effort: 'medium' });
    await f.service.switchProfile('chatgpt');
    await f.service.switchProfile(second.id);
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'second-pro', model_reasoning_effort: 'high' });
  });

  it('keeps an explicitly absent reasoning effort instead of restoring the DeepSeek default', async () => {
    const f = await fixture();
    await f.service.switchProfile('deepseek');
    await selectModel(f, 'deepseek-v4-pro', null);
    await f.service.switchProfile('chatgpt');
    await f.service.switchProfile('deepseek');
    const config = parse(await readConfig(f.configPath));
    expect(config.model).toBe('deepseek-v4-pro');
    expect(config.model_reasoning_effort).toBeUndefined();
  });

  it('retains a remembered selection when only the profile name and key are edited', async () => {
    const f = await fixture();
    const profile = await createProfile(f);
    await f.service.switchProfile(profile.id);
    await selectModel(f, 'example-fast', 'high');
    await f.service.switchProfile('chatgpt');
    await f.service.saveProfile({ ...profile, name: 'Renamed API', apiKey: 'sk-fixture-replacement' });
    await f.service.switchProfile(profile.id);
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'example-fast', model_reasoning_effort: 'high' });
    expect(f.bridge.start).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'sk-fixture-replacement' }));
  });

  it('honors an explicitly changed default model instead of an older desktop selection', async () => {
    const f = await fixture();
    const profile = await createProfile(f);
    await f.service.switchProfile(profile.id);
    await selectModel(f, 'example-pro', 'high');
    await f.service.switchProfile('chatgpt');
    await f.service.saveProfile({ ...profile, defaultModel: 'example-fast' });
    await f.service.switchProfile(profile.id);
    const config = parse(await readConfig(f.configPath));
    expect(config.model).toBe('example-fast');
    expect(config.model_reasoning_effort).toBeUndefined();
  });

  it('falls back to the configured default after a remembered model is removed', async () => {
    const f = await fixture();
    const profile = await createProfile(f);
    await f.service.switchProfile(profile.id);
    await selectModel(f, 'example-fast', 'high');
    await f.service.switchProfile('chatgpt');
    await f.service.saveProfile({ ...profile, modelIds: ['example-pro'] });
    await f.service.switchProfile(profile.id);
    const config = parse(await readConfig(f.configPath));
    expect(config.model).toBe('example-pro');
    expect(config.model_reasoning_effort).toBeUndefined();
  });

  it('rolls back selection changes on a failed switch and saves the latest choice on retry', async () => {
    const f = await fixture();
    await f.service.switchProfile('deepseek');
    await selectModel(f, 'deepseek-v4-pro', 'low');
    await f.service.switchProfile('chatgpt');
    await f.service.switchProfile('deepseek');
    await selectModel(f, 'deepseek-flash', 'max');
    const original = await readConfig(f.configPath);
    const previousSecrets = f.store.getSecrets();
    f.processes.launch.mockRejectedValueOnce(new Error('fixture launch failed'));
    await expect(f.service.switchProfile('chatgpt')).rejects.toThrow('APP_START_FAILED');
    expect(await readConfig(f.configPath)).toBe(original);
    expect(f.store.getSecrets()).toEqual(previousSecrets);
    expect(f.store.getSecrets().pending).toBeUndefined();
    await f.service.switchProfile('chatgpt');
    await f.service.switchProfile('deepseek');
    expect(parse(await readConfig(f.configPath))).toMatchObject({ model: 'deepseek-flash', model_reasoning_effort: 'max' });
  });

  it('removes remembered choices when deleting the corresponding profile', async () => {
    const f = await fixture();
    const profile = await createProfile(f);
    await f.service.switchProfile(profile.id);
    await selectModel(f, 'example-fast', 'low');
    await f.service.switchProfile('chatgpt');
    expect(f.store.getSecrets().profileSelections?.[profile.id]).toBeDefined();
    await f.service.deleteProfile(profile.id);
    expect(f.store.getSecrets().profileSelections?.[profile.id]).toBeUndefined();
  });
});
