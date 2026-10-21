import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalStore, defaultSettings, validateBaseUrl, validateProfile, validateSettings, profileApiKey,
  type SecretCodec, type SecretData,
} from '../electron/store';
import type { ApiProfileConfig, SaveProfileInput, SaveSettingsInput, Settings } from '../shared/types';

/** Test-only authenticated encryption; production uses Electron safeStorage. */
function aesCodec(key = randomBytes(32)): SecretCodec {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      if (value.length < 28) throw new Error('Invalid ciphertext');
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

const unavailableCodec: SecretCodec = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error('Keychain unavailable'); },
  decryptString: () => { throw new Error('Keychain unavailable'); },
};

let directory: string;
let storePath: string;
let settings: Settings;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-switcher-store-test-'));
  storePath = join(directory, 'settings.json');
  settings = { ...defaultSettings({}, directory), codexHome: join(directory, 'codex') };
});

afterEach(async () => {
  // Restrict recursive cleanup to the exact disposable directory we created.
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('agent-switcher-store-test-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await rm(target, { recursive: true, force: true });
});

describe('encrypted local settings persistence', () => {
  it.each([1, 2])('disables legacy focus hiding for a version-%s file without rewriting settings or encrypted keys', async (version) => {
    const codec = aesCodec();
    const legacySettings: Settings = { ...settings, language: 'en', launchAtLogin: true, hideOnBlur: true };
    const secrets: SecretData = version === 1 ? { apiKey: 'sk-legacy-hidden' } : { apiKeys: { glm: 'sk-glm-hidden' } };
    const encryptedSecrets = codec.encryptString(JSON.stringify(secrets)).toString('base64');
    const timestamp = '2026-10-21T10:00:00.000Z';
    const original = JSON.stringify({ version, settings: legacySettings, encryptedSecrets, lastSwitchedAt: timestamp,
      ...(version === 2 ? { profiles: [apiProfile()] } : {}),
    }, null, 2);
    await writeFile(storePath, original);
    const store = new LocalStore(storePath, codec, settings);
    await store.load();
    expect(store.settings).toEqual({ ...legacySettings, hideOnBlur: false });
    expect(store.getSecrets()).toEqual(secrets);
    expect(store.lastSwitchedAt).toBe(timestamp);
    expect(store.profiles).toEqual(version === 1 ? [{
      id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: legacySettings.deepseekBaseUrl,
      protocol: 'responses', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: legacySettings.deepseekModel,
    }] : [apiProfile()]);
    expect(await readFile(storePath, 'utf8')).toBe(original);
    expect(JSON.parse(await readFile(storePath, 'utf8')).encryptedSecrets).toBe(encryptedSecrets);
  });

  it('encrypts API keys, config snapshots and recovery journals on disk and round-trips them', async () => {
    const codec = aesCodec();
    const store = new LocalStore(storePath, codec, settings);
    const secrets: SecretData = {
      apiKey: 'sk-test-only-private-key-value',
      bridgeToken: 'private-local-bearer-token',
      bridgePort: 12345,
      snapshot: { home: settings.codexHome, values: { model: '"private-saved-model"' } },
      pending: { home: settings.codexHome, original: 'secret_setting = "private-original-config"\n', writtenHash: 'hash' },
    };
    const timestamp = '2026-10-21T10:00:00.000Z';
    await store.update(settings, secrets, timestamp);
    const raw = await readFile(storePath, 'utf8');
    for (const hidden of [secrets.apiKey, secrets.bridgeToken, 'private-saved-model', 'private-original-config']) {
      expect(raw).not.toContain(hidden);
    }
    const onDisk = JSON.parse(raw) as Record<string, unknown>;
    expect(onDisk.settings).toEqual(settings);
    expect(onDisk.encryptedSecrets).toEqual(expect.any(String));
    expect(onDisk).not.toHaveProperty('apiKey');
    expect(onDisk).not.toHaveProperty('snapshot');
    const restored = new LocalStore(storePath, codec, settings);
    await restored.load();
    expect(restored.getSecrets()).toEqual(secrets);
    expect(restored.lastSwitchedAt).toBe(timestamp);
    expect(restored.hasApiKey).toBe(true);
    expect(restored.encryptionAvailable).toBe(true);
  });

  it('keeps an existing key when saving settings with an empty or blank key field', async () => {
    const codec = aesCodec();
    const store = new LocalStore(storePath, codec, settings);
    await store.update(settings, { apiKey: 'sk-test-existing-key' });
    for (const apiKey of ['', '   ']) {
      const sanitized = validateSettings({ ...settings, language: 'en', apiKey });
      expect(sanitized).not.toHaveProperty('apiKey');
      await store.update(sanitized);
    }
    const restored = new LocalStore(storePath, codec, settings);
    await restored.load();
    expect(restored.getSecrets().apiKey).toBe('sk-test-existing-key');
    expect(restored.settings.language).toBe('en');
  });

  it('removes a key only through an explicit secrets update', async () => {
    const codec = aesCodec();
    const store = new LocalStore(storePath, codec, settings);
    await store.update(settings, { apiKey: 'sk-test-key-to-clear' });
    const secrets = store.getSecrets();
    delete secrets.apiKey;
    await store.update(settings, secrets);
    const restored = new LocalStore(storePath, codec, settings);
    await restored.load();
    expect(restored.hasApiKey).toBe(false);
    expect(restored.getSecrets()).toEqual({});
    expect(JSON.parse(await readFile(storePath, 'utf8'))).not.toHaveProperty('encryptedSecrets');
  });

  it('returns independent copies of settings and nested secrets', async () => {
    const store = new LocalStore(storePath, aesCodec(), settings);
    await store.update(settings, {
      apiKey: 'sk-test-key', snapshot: { home: settings.codexHome, values: { model: '"saved"' } },
    });
    const copiedSettings = store.settings;
    copiedSettings.language = 'en';
    const copiedSecrets = store.getSecrets();
    copiedSecrets.snapshot!.values.model = '"mutated"';
    delete copiedSecrets.apiKey;
    expect(store.settings.language).toBe('zh-CN');
    expect(store.getSecrets().snapshot?.values.model).toBe('"saved"');
    expect(store.hasApiKey).toBe(true);
  });

  it('preserves the encrypted blob when the system credential store is unavailable', async () => {
    const codec = aesCodec();
    const initial = new LocalStore(storePath, codec, settings);
    await initial.update(settings, { apiKey: 'sk-test-do-not-erase' });
    const before = await readFile(storePath, 'utf8');
    const locked = new LocalStore(storePath, unavailableCodec, settings);
    await locked.load();
    expect(locked.encryptionAvailable).toBe(false);
    expect(locked.settings).toEqual(settings);
    expect(() => locked.getSecrets()).toThrow('ENCRYPTION_UNAVAILABLE');
    await expect(locked.update({ ...settings, language: 'en' }, {})).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    expect(await readFile(storePath, 'utf8')).toBe(before);
    const unlocked = new LocalStore(storePath, codec, settings);
    await unlocked.load();
    expect(unlocked.getSecrets().apiKey).toBe('sk-test-do-not-erase');
  });

  it('does not replace a ciphertext that cannot be decrypted with the current key', async () => {
    const original = new LocalStore(storePath, aesCodec(), settings);
    await original.update(settings, { apiKey: 'sk-test-original-machine' });
    const before = await readFile(storePath, 'utf8');
    const otherMachine = new LocalStore(storePath, aesCodec(), settings);
    await otherMachine.load();
    expect(otherMachine.encryptionAvailable).toBe(false);
    await expect(otherMachine.update(settings, {})).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    expect(await readFile(storePath, 'utf8')).toBe(before);
  });

  it('allows settings without secrets when encryption is unavailable but refuses plaintext key storage', async () => {
    const store = new LocalStore(storePath, unavailableCodec, settings);
    await store.update(settings, {});
    const before = await readFile(storePath, 'utf8');
    await expect(store.update(settings, { apiKey: 'sk-test-never-plaintext' })).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    expect(await readFile(storePath, 'utf8')).toBe(before);
    expect(before).not.toContain('sk-test-never-plaintext');
  });

  it.each(['malformed JSON', 'unknown version', 'invalid settings'])(
    'rejects %s without overwriting the original file', async (kind) => {
    const raw = kind === 'malformed JSON' ? '{ "broken":' : kind === 'unknown version'
      ? JSON.stringify({ version: 99, settings })
      : JSON.stringify({ version: 1, settings: { language: 'unknown' } });
    await writeFile(storePath, raw, 'utf8');
    const store = new LocalStore(storePath, aesCodec(), settings);
    await expect(store.load()).rejects.toThrow('STORAGE_INVALID');
    expect(await readFile(storePath, 'utf8')).toBe(raw);
  });

  it('uses defaults for a missing file and leaves no temporary files after atomic saves', async () => {
    const store = new LocalStore(storePath, aesCodec(), settings);
    await store.load();
    expect(store.settings).toEqual(settings);
    expect(store.getSecrets()).toEqual({});
    await store.update(settings, { apiKey: 'sk-test-once' });
    await store.update({ ...settings, language: 'en' }, { apiKey: 'sk-test-twice' });
    expect(await readdir(directory)).toEqual(['settings.json']);
    expect(JSON.parse(await readFile(storePath, 'utf8')).settings.language).toBe('en');
  });
});

describe('settings validation boundaries', () => {
  it('keeps focus hiding disabled for defaults and incoming legacy settings', () => {
    expect(defaultSettings({}, directory).hideOnBlur).toBe(false);
    expect(validateSettings({ ...settings, hideOnBlur: true }).hideOnBlur).toBe(false);
  });

  it('normalizes HTTPS endpoints while retaining explicit API paths and ports', () => {
    expect(validateBaseUrl('https://API.DeepSeek.com/v1///')).toBe('https://api.deepseek.com/v1');
    expect(validateBaseUrl('https://deepseek.example:8443/v1')).toBe('https://deepseek.example:8443/v1');
  });

  it.each([
    'http://api.deepseek.com',
    'https://user:password@api.deepseek.com',
    'https://api.deepseek.com?key=secret',
    'https://api.deepseek.com/#secret',
    'file:///tmp/deepseek',
    'javascript:alert(1)',
    'not a URL',
  ])('rejects unsafe or malformed endpoint %s', (value) => {
    expect(() => validateBaseUrl(value)).toThrow('INVALID_SETTINGS');
  });

  it.each([
    { codexHome: 'relative/config' },
    { codexAppPath: 'relative/Codex.exe' },
    { codexHome: join(resolve('test'), 'line\nbreak') },
    { codexAppPath: join(resolve('test'), 'line\rbreak', 'Codex.exe') },
    { codexHome: join(resolve('test'), 'nul\x00path') },
    { deepseekModel: 'model"\nmodel_provider="attacker"' },
    { deepseekModel: 'model\x00name' },
    { apiKey: 'sk-test\r\nInjected: header' },
    { apiKey: 'a'.repeat(4097) },
    { language: 'fr' },
    { launchAtLogin: 'true' },
    { hideOnBlur: 1 },
    { clearApiKey: 'yes' },
  ])('rejects invalid settings without embedding input values in errors: %j', (patch) => {
    expect(() => validateSettings({ ...settings, ...patch } as SaveSettingsInput)).toThrow('INVALID_SETTINGS');
  });

  it('strips secret fields from the plain settings document', () => {
    const normalized = validateSettings({ ...settings, apiKey: 'sk-test-hidden', clearApiKey: false });
    expect(normalized).toEqual(settings);
    expect(normalized).not.toHaveProperty('apiKey');
    expect(normalized).not.toHaveProperty('clearApiKey');
  });
});

function apiProfile(id = 'glm'): ApiProfileConfig {
  return {
    id, name: id === 'glm' ? 'GLM work' : 'Kimi personal', preset: id === 'glm' ? 'glm' : 'kimi',
    baseUrl: `https://${id}.example/v1`, protocol: 'auto',
    modelIds: [`${id}-fixture`], defaultModel: `${id}-fixture`,
  };
}

describe('multiple API profile persistence and migration', () => {
  it('migrates legacy DeepSeek metadata in memory without rewriting credentials or the original file', async () => {
    const codec = aesCodec();
    const initial = new LocalStore(storePath, codec, settings);
    const secrets = { apiKey: 'sk-legacy-deepseek', bridgeToken: 'legacy-local-token', bridgePort: 12345 };
    await initial.update(settings, secrets);
    const legacy = JSON.parse(await readFile(storePath, 'utf8'));
    legacy.version = 1;
    delete legacy.profiles;
    await writeFile(storePath, JSON.stringify(legacy));
    const before = await readFile(storePath, 'utf8');
    const migrated = new LocalStore(storePath, codec, settings);
    await migrated.load();
    expect(migrated.profiles).toEqual([{
      id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: settings.deepseekBaseUrl,
      protocol: 'responses', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash',
    }]);
    expect(migrated.getSecrets()).toEqual(secrets);
    expect(profileApiKey(migrated.getSecrets(), 'deepseek')).toBe('sk-legacy-deepseek');
    expect(await readFile(storePath, 'utf8')).toBe(before);
    await migrated.update(settings);
    expect(JSON.parse(await readFile(storePath, 'utf8')).version).toBe(2);
    expect(migrated.getSecrets()).toEqual(secrets);
  });

  it('persists separate API keys only in the encrypted vault and exposes metadata copies', async () => {
    const codec = aesCodec();
    const store = new LocalStore(storePath, codec, settings);
    const profiles = [apiProfile(), apiProfile('kimi')];
    const secrets: SecretData = {
      apiKeys: { glm: 'sk-glm-private', kimi: 'sk-kimi-private' }, activeProfileId: 'glm',
    };
    await store.update(settings, secrets, null, profiles);
    const raw = await readFile(storePath, 'utf8');
    expect(raw).not.toContain('sk-glm-private');
    expect(raw).not.toContain('sk-kimi-private');
    expect(JSON.parse(raw).profiles).toEqual(profiles);
    const copy = store.profiles;
    copy[0]!.modelIds.push('injected');
    copy[0]!.name = 'changed';
    expect(store.profiles).toEqual(profiles);
    const restored = new LocalStore(storePath, codec, settings);
    await restored.load();
    expect(restored.profiles).toEqual(profiles);
    expect(profileApiKey(restored.getSecrets(), 'glm')).toBe('sk-glm-private');
    expect(profileApiKey(restored.getSecrets(), 'kimi')).toBe('sk-kimi-private');
    expect(profileApiKey(restored.getSecrets(), 'deepseek')).toBeUndefined();
  });

  it('retains scoped credentials and inactive profile metadata during ordinary settings saves', async () => {
    const store = new LocalStore(storePath, aesCodec(), settings);
    await store.update(settings, { apiKeys: { glm: 'sk-glm-private' } }, null, [apiProfile()]);
    await store.update({ ...settings, language: 'en' });
    expect(store.profiles).toEqual([apiProfile()]);
    expect(profileApiKey(store.getSecrets(), 'glm')).toBe('sk-glm-private');
  });

  it('does not treat inherited object properties or another provider key as a configured key', () => {
    expect(profileApiKey({ apiKeys: {}, apiKey: 'sk-legacy' }, 'constructor')).toBeUndefined();
    expect(profileApiKey({ apiKeys: { glm: 'sk-glm' }, apiKey: 'sk-legacy' }, 'kimi')).toBeUndefined();
    expect(profileApiKey({ apiKeys: { deepseek: 'sk-scoped' }, apiKey: 'sk-legacy' }, 'deepseek')).toBe('sk-scoped');
  });

  it('rejects duplicate profiles and invalid stored version-two metadata without rewriting files', async () => {
    const codec = aesCodec();
    const store = new LocalStore(storePath, codec, settings);
    await store.update(settings, {}, null, [apiProfile()]);
    const raw = await readFile(storePath, 'utf8');
    await expect(store.update(settings, {}, null, [apiProfile(), apiProfile()])).rejects.toThrow('INVALID_PROFILE');
    expect(await readFile(storePath, 'utf8')).toBe(raw);
    const corrupted = { ...JSON.parse(raw), profiles: [{ ...apiProfile(), defaultModel: 'not-in-list' }] };
    await writeFile(storePath, JSON.stringify(corrupted));
    await expect(new LocalStore(storePath, codec, settings).load()).rejects.toThrow('STORAGE_INVALID');
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual(corrupted);
  });

  it('preserves legacy encrypted data when migration runs while the keychain is locked', async () => {
    const initial = new LocalStore(storePath, aesCodec(), settings);
    await initial.update(settings, { apiKey: 'sk-keep-ciphertext' });
    const legacy = { ...JSON.parse(await readFile(storePath, 'utf8')), version: 1 };
    delete legacy.profiles;
    await writeFile(storePath, JSON.stringify(legacy));
    const before = await readFile(storePath, 'utf8');
    const locked = new LocalStore(storePath, unavailableCodec, settings);
    await locked.load();
    expect(locked.profiles[0]?.id).toBe('deepseek');
    await expect(locked.update(settings, {}, null, [apiProfile()])).rejects.toThrow('ENCRYPTION_UNAVAILABLE');
    expect(await readFile(storePath, 'utf8')).toBe(before);
  });
});

describe('API profile validation', () => {
  it('normalizes profile metadata and never persists credential fields in it', () => {
    const profile = validateProfile({ ...apiProfile(), name: '  GLM work  ', modelIds: ['glm-fixture', 'glm-fixture'], apiKey: 'sk-hidden' }, 'glm');
    expect(profile.name).toBe('GLM work');
    expect(profile.modelIds).toEqual(['glm-fixture']);
    expect(profile).not.toHaveProperty('apiKey');
  });

  it.each([
    ['chatgpt', {}], ['external', {}], ['../../escape', {}],
    ['glm', { name: '\nname' }], ['glm', { name: ' ' }], ['glm', { name: 'a'.repeat(81) }],
    ['glm', { protocol: 'anthropic' }], ['glm', { preset: 'unknown' }],
    ['glm', { modelIds: [] }], ['glm', { modelIds: ['model\nmalicious'] }],
    ['glm', { defaultModel: 'not-in-list' }], ['glm', { apiKey: 'key\r\nheader' }],
  ])('rejects invalid profile id=%s metadata=%j', (id, patch) => {
    expect(() => validateProfile({ ...apiProfile(), ...patch } as SaveProfileInput, id)).toThrow('INVALID_PROFILE');
  });
});
