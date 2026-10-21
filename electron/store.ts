import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ApiProfileConfig, Settings, SaveProfileInput, SaveSettingsInput } from '../shared/types';
import { availableDeepseekModels } from '../shared/models';
import { AppError } from './errors';
import { atomicWrite, readOptional } from './files';

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ConfigSnapshot {
  home: string;
  /** Raw TOML values; only the fields we override, never a stale whole-file restore. */
  values: Record<string, string | null>;
}

export interface SecretData {
  apiKey?: string;
  apiKeys?: Record<string, string>;
  activeProfileId?: string;
  snapshot?: ConfigSnapshot;
  bridgeToken?: string;
  bridgePort?: number;
  pending?: { home: string; original: string | null; writtenHash: string; previousSecrets?: SecretData };
}

interface StoredState {
  version: 2;
  settings: Settings;
  profiles: ApiProfileConfig[];
  encryptedSecrets?: string;
  lastSwitchedAt: string | null;
}

export function profileApiKey(secrets: SecretData, id: string): string | undefined {
  const scoped = secrets.apiKeys && Object.hasOwn(secrets.apiKeys, id) ? secrets.apiKeys[id] : undefined;
  return (typeof scoped === 'string' && scoped ? scoped : undefined) || (id === 'deepseek' ? secrets.apiKey : undefined);
}

export function legacyDeepseekProfile(settings: Settings): ApiProfileConfig {
  return {
    id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: settings.deepseekBaseUrl,
    protocol: 'responses', modelIds: availableDeepseekModels(settings.deepseekModel), defaultModel: settings.deepseekModel,
  };
}

export function validateProfile(input: SaveProfileInput, id: string): ApiProfileConfig {
  const validId = /^[a-z][a-z0-9_-]{0,63}$/;
  const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  if (!input || typeof id !== 'string' || !validId.test(id) || ['chatgpt', 'external'].includes(id) ||
    typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1F]/.test(input.name) ||
    !['deepseek', 'glm', 'kimi', 'custom'].includes(input.preset) ||
    !['auto', 'responses', 'chat_completions'].includes(input.protocol) || typeof input.baseUrl !== 'string' ||
    (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00]/.test(input.apiKey))) ||
    (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')) throw new AppError('INVALID_PROFILE');
  const supplied = input.modelIds ?? (input.defaultModel ? [input.defaultModel] : []);
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > 1000 ||
    supplied.some((model) => typeof model !== 'string' || !modelId.test(model))) throw new AppError('INVALID_PROFILE');
  const modelIds = [...new Set(supplied)];
  const defaultModel = input.defaultModel ?? modelIds[0]!;
  if (typeof defaultModel !== 'string' || !modelId.test(defaultModel) || !modelIds.includes(defaultModel)) throw new AppError('INVALID_PROFILE');
  return { id, name: input.name.trim(), preset: input.preset, baseUrl: validateBaseUrl(input.baseUrl), protocol: input.protocol, modelIds, defaultModel };
}

function validateProfiles(profiles: ApiProfileConfig[]): ApiProfileConfig[] {
  if (!Array.isArray(profiles) || profiles.length > 100) throw new AppError('INVALID_PROFILE');
  const normalized = profiles.map((profile) => validateProfile(profile, profile?.id));
  if (new Set(normalized.map((profile) => profile.id)).size !== normalized.length) throw new AppError('INVALID_PROFILE');
  return normalized;
}

export function defaultSettings(env = process.env, home = homedir()): Settings {
  return {
    language: 'zh-CN', codexHome: env.CODEX_HOME || join(home, '.codex'),
    codexAppPath: '', deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-flash', launchAtLogin: false, hideOnBlur: false,
  };
}

export function validateBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError('INVALID_SETTINGS'); }
  // A custom endpoint is allowed, but secrets must never travel over plaintext HTTP.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new AppError('INVALID_SETTINGS');
  }
  return url.href.replace(/\/+$/, '');
}

export function validateSettings(input: SaveSettingsInput): Settings {
  if (!input || !['zh-CN', 'en'].includes(input.language) ||
      typeof input.codexHome !== 'string' || !isAbsolute(input.codexHome) || /[\x00-\x1F]/.test(input.codexHome) ||
      typeof input.codexAppPath !== 'string' || /[\x00-\x1F]/.test(input.codexAppPath) || (input.codexAppPath !== '' && !isAbsolute(input.codexAppPath)) ||
      typeof input.deepseekBaseUrl !== 'string' ||
      typeof input.deepseekModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.deepseekModel) ||
      typeof input.launchAtLogin !== 'boolean' || typeof input.hideOnBlur !== 'boolean' ||
      (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00]/.test(input.apiKey))) ||
      (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean')) {
    throw new AppError('INVALID_SETTINGS');
  }
  return {
    language: input.language, codexHome: input.codexHome.trim(), codexAppPath: input.codexAppPath.trim(),
    deepseekBaseUrl: validateBaseUrl(input.deepseekBaseUrl), deepseekModel: input.deepseekModel,
    // Kept for compatibility with existing files; panels now stay open until explicitly hidden.
    launchAtLogin: input.launchAtLogin, hideOnBlur: false,
  };
}

export class LocalStore {
  private state: StoredState;
  private secrets: SecretData = {};
  private lockedSecrets = false;

  constructor(private readonly path: string, private readonly codec: SecretCodec, defaults = defaultSettings()) {
    this.state = { version: 2, settings: defaults, profiles: [legacyDeepseekProfile(defaults)], lastSwitchedAt: null };
  }

  async load(): Promise<void> {
    const text = await readOptional(this.path);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Omit<StoredState, 'version'> & { version: number };
      if (![1, 2].includes(parsed.version) ||
        (parsed.lastSwitchedAt !== null && (typeof parsed.lastSwitchedAt !== 'string' || !Number.isFinite(Date.parse(parsed.lastSwitchedAt)))) ||
        (parsed.encryptedSecrets !== undefined && (typeof parsed.encryptedSecrets !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.encryptedSecrets)))) throw new Error('version');
      const settings = validateSettings(parsed.settings);
      const profiles = parsed.version === 1 ? [legacyDeepseekProfile(settings)] : validateProfiles(parsed.profiles);
      this.state = { version: 2, settings, profiles, encryptedSecrets: parsed.encryptedSecrets, lastSwitchedAt: parsed.lastSwitchedAt };
    } catch { throw new AppError('STORAGE_INVALID'); }
    if (this.state.encryptedSecrets) {
      try {
        if (!this.codec.isEncryptionAvailable()) throw new Error('unavailable');
        this.secrets = JSON.parse(this.codec.decryptString(Buffer.from(this.state.encryptedSecrets, 'base64'))) as SecretData;
      } catch {
        // Keep the encrypted blob intact; settings must not erase an inaccessible keychain.
        this.lockedSecrets = true;
      }
    }
  }

  get settings(): Settings { return { ...this.state.settings }; }
  get profiles(): ApiProfileConfig[] { return structuredClone(this.state.profiles); }
  get lastSwitchedAt(): string | null { return this.state.lastSwitchedAt; }
  get encryptionAvailable(): boolean { return !this.lockedSecrets && this.codec.isEncryptionAvailable(); }
  get hasApiKey(): boolean { return Boolean(profileApiKey(this.secrets, 'deepseek')) || this.lockedSecrets; }

  getSecrets(): SecretData {
    if (this.lockedSecrets) throw new AppError('ENCRYPTION_UNAVAILABLE');
    return structuredClone(this.secrets);
  }

  async update(settings: Settings, secrets = this.getSecrets(), lastSwitchedAt = this.state.lastSwitchedAt, profiles = this.state.profiles): Promise<void> {
    if (this.lockedSecrets) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const safeSettings = validateSettings(settings);
    const safeProfiles = validateProfiles(profiles);
    const safeSecrets = structuredClone(secrets);
    let encryptedSecrets: string | undefined;
    if (Object.keys(safeSecrets).length) {
      if (!this.codec.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
      encryptedSecrets = this.codec.encryptString(JSON.stringify(safeSecrets)).toString('base64');
    }
    const next: StoredState = { version: 2, settings: safeSettings, profiles: safeProfiles, encryptedSecrets, lastSwitchedAt };
    await atomicWrite(this.path, JSON.stringify(next, null, 2) + '\n');
    this.state = next;
    this.secrets = safeSecrets;
  }
}
