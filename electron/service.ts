import { randomBytes, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ApiProfileConfig, AppState, ConnectionInput, ConnectionResult, ProfileId, SaveProfileInput, SaveSettingsInput, SwitchResult } from '../shared/types';
import { PROVIDER_PRESETS } from '../shared/provider-presets';
import { availableDeepseekModels } from '../shared/models';
import { activeProfile, apiConfig, catalogFile, chatgptConfig, configHash, managedEndpoint, snapshotConfig, snapshotModelSelection, usesManagedCatalog } from './config';
import { profileModelCatalog } from './catalog';
import { AppError, errorCode } from './errors';
import { atomicWrite, readOptional } from './files';
import { LocalStore, profileApiKey, validateBaseUrl, validateProfile, validateSettings, type SecretData } from './store';
import type { CodexInstallation, CodexProcess } from './platform/codex-process';
import type { BridgeOptions, LocalBridge } from './bridge';

export interface ServiceOptions {
  store: LocalStore;
  processes: Pick<CodexProcess, 'detect' | 'isRunning' | 'stop' | 'launch'>;
  bridge: Pick<LocalBridge, 'start' | 'stop' | 'isRunning'>;
  version: string;
  platform?: string;
  onChange?: (state: AppState) => void;
  onLoginPreference?: (enabled: boolean) => void;
}

export class ProfileService {
  private busy = false;
  private lastError: string | null = null;
  private readonly platform: string;
  constructor(private readonly options: ServiceOptions) { this.platform = options.platform ?? process.platform; }
  get isBusy(): boolean { return this.busy; }
  get configPath(): string { return join(this.options.store.settings.codexHome, 'config.toml'); }
  private selected(text: string | null): string {
    const id = activeProfile(text);
    return id === 'chatgpt' || id === 'external' || this.options.store.profiles.some((p) => p.id === id) ? id : 'external';
  }
  private profile(id: string): ApiProfileConfig {
    const profile = this.options.store.profiles.find((p) => p.id === id);
    if (!profile) throw new AppError('PROFILE_NOT_FOUND');
    return profile;
  }
  private ownedEndpoint(text: string, secrets: SecretData): { port: number; token: string; model: string } {
    const endpoint = managedEndpoint(text);
    if (!endpoint || endpoint.token !== secrets.bridgeToken || endpoint.port !== secrets.bridgePort) throw new AppError('CONFIG_CONFLICT');
    return endpoint;
  }
  private bridgeOptions(profile: ApiProfileConfig, secrets: SecretData, port?: number, token = secrets.bridgeToken): BridgeOptions {
    const apiKey = profileApiKey(secrets, profile.id);
    if (!apiKey) throw new AppError('API_KEY_REQUIRED');
    if (!token) throw new AppError('CONFIG_CONFLICT');
    return { port, token, apiKey, baseUrl: profile.baseUrl, model: profile.defaultModel, models: profile.modelIds, protocol: profile.protocol };
  }
  private async writeCatalog(profile: ApiProfileConfig): Promise<void> {
    await atomicWrite(catalogFile(this.options.store.settings.codexHome, profile.id), profileModelCatalog(profile));
  }
  async initialize(): Promise<void> {
    try {
      const { store, bridge } = this.options;
      let secrets = store.getSecrets();
      let recovering = false;
      let recoveryInstallation: CodexInstallation | null = null;
      let recoveryWasRunning = false;
      if (secrets.pending) {
        const pendingPath = join(secrets.pending.home, 'config.toml');
        const current = await readOptional(pendingPath);
        const matchesWritten = configHash(current) === secrets.pending.writtenHash;
        if (!matchesWritten && configHash(current) !== configHash(secrets.pending.original)) throw new AppError('CONFIG_CONFLICT');
        recoveryInstallation = await this.options.processes.detect(store.settings.codexAppPath || undefined);
        if (recoveryInstallation) {
          recoveryWasRunning = await this.options.processes.isRunning(recoveryInstallation);
          if (recoveryWasRunning) await this.stopApp(recoveryInstallation);
        }
        if (configHash(await readOptional(pendingPath)) !== configHash(current)) throw new AppError('CONFIG_CONFLICT');
        if (matchesWritten) await this.restoreFile(pendingPath, secrets.pending.original);
        secrets = structuredClone(secrets.pending.previousSecrets ?? secrets);
        delete secrets.pending;
        recovering = true;
      }
      const text = await readOptional(this.configPath);
      const selected = this.selected(text);
      if (text && selected !== 'chatgpt' && selected !== 'external') {
        const profile = this.profile(selected);
        const endpoint = this.ownedEndpoint(text, secrets);
        if (secrets.activeProfileId && secrets.activeProfileId !== selected) throw new AppError('CONFIG_CONFLICT');
        const options = this.bridgeOptions(profile, secrets, endpoint.port, endpoint.token);
        if (usesManagedCatalog(text, store.settings.codexHome)) await this.writeCatalog(profile);
        await bridge.start(options);
      }
      if (recovering) {
        if (recoveryWasRunning && recoveryInstallation) await this.launchApp(recoveryInstallation);
        await store.update(store.settings, secrets);
      }
    } catch (error) { this.lastError = errorCode(error); }
  }
  async getState(): Promise<AppState> {
    const { store, processes, bridge } = this.options;
    let selected = 'external';
    try { selected = this.selected(await readOptional(this.configPath)); }
    catch (error) { this.lastError = errorCode(error); }
    let installation: CodexInstallation | null = null;
    let running = false;
    try {
      installation = await processes.detect(store.settings.codexAppPath || undefined);
      if (installation) running = await processes.isRunning(installation);
    } catch (error) { this.lastError = errorCode(error); }
    let secrets: SecretData = {};
    try { secrets = store.getSecrets(); } catch { /* Keep inaccessible secrets untouched. */ }
    const profiles = store.profiles.map((profile) => ({ ...profile, hasApiKey: Boolean(profileApiKey(secrets, profile.id)) }));
    return {
      version: this.options.version, platform: this.platform, settings: store.settings, profiles,
      activeProfile: selected, hasApiKey: store.hasApiKey, encryptionAvailable: store.encryptionAvailable,
      codexInstalled: Boolean(installation), codexRunning: running, detectedAppPath: installation?.path ?? null,
      bridgeRunning: bridge.isRunning(), lastSwitchedAt: store.lastSwitchedAt, lastError: this.lastError,
    };
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new AppError('SWITCH_IN_PROGRESS');
    this.busy = true;
    try {
      if (this.options.store.getSecrets().pending) throw new AppError('RECOVERY_REQUIRED');
      const result = await action(); this.lastError = null; return result;
    } catch (error) { this.lastError = errorCode(error); throw new AppError(this.lastError); }
    finally {
      this.busy = false;
      void this.getState().then((state) => this.options.onChange?.(state)).catch(() => undefined);
    }
  }
  async saveSettings(input: SaveSettingsInput): Promise<AppState> {
    return this.locked(async () => {
      const { store } = this.options;
      const settings = validateSettings(input);
      const previous = store.settings;
      const secrets = store.getSecrets();
      const selected = this.selected(await readOptional(this.configPath));
      const apiActive = selected !== 'chatgpt' && selected !== 'external';
      if (apiActive && resolve(settings.codexHome) !== resolve(previous.codexHome)) throw new AppError('CONFIG_HOME_ACTIVE');
      const legacyChange = Boolean(input.apiKey?.trim() || input.clearApiKey) ||
        settings.deepseekBaseUrl !== previous.deepseekBaseUrl || settings.deepseekModel !== previous.deepseekModel;
      if (selected === 'deepseek' && legacyChange) {
        if (input.clearApiKey) throw new AppError('API_KEY_IN_USE');
        throw new AppError('RESTART_REQUIRED');
      }
      let profiles = store.profiles;
      if (legacyChange) {
        if (settings.deepseekModel !== previous.deepseekModel && secrets.profileSelections) delete secrets.profileSelections.deepseek;
        if (input.clearApiKey) {
          delete secrets.apiKey;
          if (secrets.apiKeys) delete secrets.apiKeys.deepseek;
        } else if (input.apiKey?.trim()) {
          secrets.apiKey = input.apiKey.trim();
          if (secrets.apiKeys?.deepseek) secrets.apiKeys.deepseek = input.apiKey.trim();
        }
        profiles = profiles.map((profile) => profile.id === 'deepseek' ? {
          ...profile, baseUrl: settings.deepseekBaseUrl, defaultModel: settings.deepseekModel,
          modelIds: availableDeepseekModels(settings.deepseekModel),
        } : profile);
      }
      if (settings.launchAtLogin !== previous.launchAtLogin) this.options.onLoginPreference?.(settings.launchAtLogin);
      try { await store.update(settings, secrets, store.lastSwitchedAt, profiles); }
      catch (error) {
        if (settings.launchAtLogin !== previous.launchAtLogin) this.options.onLoginPreference?.(previous.launchAtLogin);
        throw error;
      }
      return this.getState();
    });
  }
  async saveProfile(input: SaveProfileInput): Promise<AppState> {
    return this.locked(async () => {
      const { store } = this.options;
      if (!input || typeof input !== 'object' || typeof input.baseUrl !== 'string' || typeof input.name !== 'string' ||
          input.id !== undefined && typeof input.id !== 'string' ||
          input.modelIds !== undefined && (!Array.isArray(input.modelIds) || input.modelIds.some((id) => typeof id !== 'string')) ||
          (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00]/.test(input.apiKey)))) throw new AppError('INVALID_PROFILE');
      const id = input.id ?? 'api-' + randomUUID();
      const existing = input.id ? this.profile(input.id) : undefined;
      if (this.selected(await readOptional(this.configPath)) === id) throw new AppError('PROFILE_IN_USE');
      const secrets = store.getSecrets();
      const apiKey = input.clearApiKey ? undefined : input.apiKey?.trim() || profileApiKey(secrets, id);
      const baseUrl = this.normalizeBase(input.baseUrl);
      let modelIds = input.modelIds;
      if (!modelIds?.length) {
        if (!apiKey) throw new AppError('API_KEY_REQUIRED');
        const result = await this.queryModels(baseUrl, apiKey);
        if (!result.ok) {
          const preset = PROVIDER_PRESETS.find((preset) => preset.preset === input.preset && preset.baseUrl === baseUrl);
          if (result.error === 'MODEL_DISCOVERY_UNAVAILABLE' && preset?.modelIds.length) modelIds = [...preset.modelIds];
          else throw new AppError(result.error ?? 'MODEL_DISCOVERY_FAILED');
        } else modelIds = result.models;
      }
      const preferred = input.defaultModel || existing?.defaultModel || PROVIDER_PRESETS.find((p) => p.preset === input.preset)?.defaultModel;
      const defaultModel = input.defaultModel || (preferred && modelIds?.includes(preferred) ? preferred : modelIds?.[0]);
      const name = input.name?.trim() || PROVIDER_PRESETS.find((p) => p.preset === input.preset)?.name || new URL(baseUrl).hostname;
      const profile = validateProfile({ ...input, name, baseUrl, modelIds, defaultModel }, id);
      if (existing && profile.defaultModel !== existing.defaultModel && secrets.profileSelections) delete secrets.profileSelections[id];
      if (apiKey) {
        if (id === 'deepseek') { secrets.apiKey = apiKey; if (secrets.apiKeys?.deepseek) secrets.apiKeys.deepseek = apiKey; }
        else secrets.apiKeys = { ...secrets.apiKeys, [id]: apiKey };
      } else {
        if (id === 'deepseek') delete secrets.apiKey;
        if (secrets.apiKeys) delete secrets.apiKeys[id];
      }
      const profiles = existing ? store.profiles.map((p) => p.id === id ? profile : p) : [...store.profiles, profile];
      const settings = id === 'deepseek' ? { ...store.settings, deepseekBaseUrl: profile.baseUrl, deepseekModel: profile.defaultModel } : store.settings;
      await store.update(settings, secrets, store.lastSwitchedAt, profiles);
      return this.getState();
    });
  }
  async deleteProfile(id: string): Promise<AppState> {
    return this.locked(async () => {
      const { store } = this.options;
      this.profile(id);
      if (this.selected(await readOptional(this.configPath)) === id) throw new AppError('PROFILE_IN_USE');
      const secrets = store.getSecrets();
      if (secrets.apiKeys) delete secrets.apiKeys[id];
      if (id === 'deepseek') delete secrets.apiKey;
      if (secrets.profileSelections) delete secrets.profileSelections[id];
      await store.update(store.settings, secrets, store.lastSwitchedAt, store.profiles.filter((p) => p.id !== id));
      return this.getState();
    });
  }
  async switchProfile(id: ProfileId): Promise<SwitchResult> {
    if (id !== 'chatgpt' && !this.options.store.profiles.some((p) => p.id === id)) throw new AppError('INVALID_PROFILE');
    return this.locked(async () => {
      const { store, processes, bridge } = this.options;
      const settings = store.settings;
      const target = id === 'chatgpt' ? undefined : this.profile(id);
      const installation = await this.installation();
      const path = this.configPath;
      const original = await readOptional(path);
      const previousId = this.selected(original);
      const previousProfile = store.profiles.find((p) => p.id === previousId);
      const previousSecrets = store.getSecrets();
      if (previousProfile && previousSecrets.activeProfileId && previousSecrets.activeProfileId !== previousId) throw new AppError('CONFIG_CONFLICT');
      const previousSwitchedAt = store.lastSwitchedAt;
      const nextSecrets = structuredClone(previousSecrets);
      if (previousProfile && original) {
        nextSecrets.profileSelections = {
          ...nextSecrets.profileSelections,
          [previousId]: snapshotModelSelection(original, settings.codexHome),
        };
      }
      const wasRunning = await processes.isRunning(installation);
      const bridgeWasRunning = bridge.isRunning();
      const previousEndpoint = previousProfile && original ? this.ownedEndpoint(original, previousSecrets) : null;
      const previousBridge = bridgeWasRunning && previousProfile && previousEndpoint
        ? this.bridgeOptions(previousProfile, previousSecrets, previousEndpoint.port, previousEndpoint.token) : null;
      let bridgeChanged = false;
      let written: string | null = null;
      let stopped = false;
      let launchAttempted = false;
      let journalWritten = false;
      try {
        let next: string;
        let targetBridge: BridgeOptions | undefined;
        if (target) {
          if (!store.encryptionAvailable) throw new AppError('ENCRYPTION_UNAVAILABLE');
          if (!profileApiKey(nextSecrets, id)) throw new AppError('API_KEY_REQUIRED');
          if (!previousProfile) nextSecrets.snapshot = snapshotConfig(original ?? '', settings.codexHome);
          const token = previousId === id && nextSecrets.bridgeToken ? nextSecrets.bridgeToken : randomBytes(32).toString('hex');
          let port = nextSecrets.bridgePort;
          targetBridge = this.bridgeOptions(target, nextSecrets, port, token);
          if (!bridgeWasRunning && !previousProfile) {
            const started = await bridge.start(targetBridge);
            bridgeChanged = true;
            port = started.port;
            targetBridge.port = port;
          }
          if (!port) throw new AppError('BRIDGE_START_FAILED');
          nextSecrets.bridgeToken = token;
          nextSecrets.bridgePort = port;
          nextSecrets.activeProfileId = id;
          next = apiConfig(original ?? '', settings.codexHome, port, token, target, nextSecrets.profileSelections?.[id]);
        } else {
          const snapshot = nextSecrets.snapshot?.home === resolve(settings.codexHome) ? nextSecrets.snapshot : undefined;
          next = chatgptConfig(original ?? '', snapshot);
          delete nextSecrets.snapshot;
          delete nextSecrets.activeProfileId;
        }
        nextSecrets.pending = { home: settings.codexHome, original, writtenHash: configHash(next), previousSecrets };
        await store.update(settings, nextSecrets);
        journalWritten = true;
        await this.stopApp(installation, true);
        stopped = true;
        if (configHash(await readOptional(path)) !== configHash(original)) throw new AppError('CONFIG_CONFLICT');
        if (target && targetBridge) {
          if (!bridgeChanged) {
            bridgeChanged = true;
            await bridge.stop();
            await bridge.start(targetBridge);
          }
          await this.writeCatalog(target);
        }
        await atomicWrite(path, next);
        written = next;
        launchAttempted = true;
        await this.launchApp(installation, this.platform === 'darwin' && previousId !== id);
        delete nextSecrets.pending;
        await store.update(settings, nextSecrets, new Date().toISOString());
        if (!target && bridge.isRunning()) await bridge.stop();
        this.lastError = null;
        return { state: await this.getState(), restarted: true };
      } catch (error) {
        let rollbackFailed = false;
        let safeToRestore = true;
        let restored = written === null;
        let bridgeRestored = true;
        if (launchAttempted) {
          try { await this.stopApp(installation, true); }
          catch { rollbackFailed = true; safeToRestore = false; }
        }
        if (written !== null && safeToRestore) {
          try {
            if (configHash(await readOptional(path)) !== configHash(written)) throw new AppError('CONFIG_CONFLICT');
            await this.restoreFile(path, original);
            restored = true;
          } catch { rollbackFailed = true; }
        }
        if (bridgeChanged && restored) {
          try { await bridge.stop(); if (previousBridge) await bridge.start(previousBridge); }
          catch { rollbackFailed = true; bridgeRestored = false; }
        }
        if (journalWritten && restored && bridgeRestored) {
          try { await store.update(settings, previousSecrets, previousSwitchedAt); }
          catch { rollbackFailed = true; }
        }
        if (stopped && wasRunning && restored && safeToRestore && bridgeRestored) {
          try { await this.launchApp(installation); } catch { rollbackFailed = true; }
        }
        if (rollbackFailed) throw new AppError('ROLLBACK_FAILED');
        throw error;
      }
    });
  }
  async restartCodex(): Promise<AppState> {
    return this.locked(async () => {
      const installation = await this.installation();
      const { store, bridge } = this.options;
      const text = await readOptional(this.configPath);
      const profile = store.profiles.find((p) => p.id === this.selected(text));
      if (profile && text) {
        const secrets = store.getSecrets();
        if (secrets.activeProfileId && secrets.activeProfileId !== profile.id) throw new AppError('CONFIG_CONFLICT');
        const endpoint = this.ownedEndpoint(text, secrets);
        const options = this.bridgeOptions(profile, secrets, endpoint.port, endpoint.token);
        if (usesManagedCatalog(text, store.settings.codexHome)) await this.writeCatalog(profile);
        if (!bridge.isRunning()) await bridge.start(options);
      }
      await this.stopApp(installation, true);
      await this.launchApp(installation);
      return this.getState();
    });
  }
  async testConnection(input?: ConnectionInput): Promise<ConnectionResult> {
    const start = performance.now();
    try {
      if (input && (typeof input !== 'object' || Object.values(input).some((value) => value !== undefined && typeof value !== 'string'))) throw new AppError('INVALID_SETTINGS');
      const profile = input?.profileId ? this.profile(input.profileId) : this.options.store.profiles.find((p) => p.id === 'deepseek');
      if (!input?.profileId && !input?.apiKey?.trim() && input?.baseUrl &&
          this.normalizeBase(input.baseUrl) !== profile?.baseUrl) throw new AppError('API_KEY_REQUIRED');
      const key = input?.apiKey?.trim() || (profile ? profileApiKey(this.options.store.getSecrets(), profile.id) : undefined);
      if (!key) throw new AppError('API_KEY_REQUIRED');
      const base = this.normalizeBase(input?.baseUrl ?? profile?.baseUrl ?? '');
      const result = await this.queryModels(base, key);
      if (result.ok && input?.model && !result.models?.includes(input.model)) throw new AppError('MODEL_NOT_FOUND');
      return { ...result, latencyMs: Math.round(performance.now() - start) };
    } catch (error) { return { ok: false, latencyMs: Math.round(performance.now() - start), error: errorCode(error) }; }
  }
  private normalizeBase(input: string): string {
    return validateBaseUrl(input.trim().replace(/\/(?:chat\/completions|responses|models)\/?$/, ''));
  }
  private async queryModels(base: string, key: string): Promise<ConnectionResult> {
    const start = performance.now();
    if (key.length > 4096 || /[\r\n\x00]/.test(key)) throw new AppError('INVALID_SETTINGS');
    try {
      const response = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(response.status === 401 || response.status === 403 ? 'API_KEY_REJECTED' : [404, 405, 501].includes(response.status) ? 'MODEL_DISCOVERY_UNAVAILABLE' : 'CONNECTION_FAILED');
      }
      const data = await response.json() as { data?: { id?: unknown }[] };
      const models = [...new Set((data.data ?? []).map((item) => item.id).filter((id): id is string =>
        typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)))].slice(0, 1000);
      if (!models.length) throw new AppError('MODEL_DISCOVERY_UNAVAILABLE');
      return { ok: true, latencyMs: Math.round(performance.now() - start), models };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - start), error: errorCode(error) === 'OPERATION_FAILED' ? 'CONNECTION_FAILED' : errorCode(error) };
    }
  }
  private async installation(): Promise<CodexInstallation> {
    const settings = this.options.store.settings;
    const installation = await this.options.processes.detect(settings.codexAppPath || undefined);
    if (!installation) throw new AppError('CODEX_NOT_FOUND');
    if (installation.kind === 'store' && resolve(settings.codexHome) !== resolve(homedir(), '.codex')) throw new AppError('CUSTOM_HOME_STORE_UNSUPPORTED');
    return installation;
  }
  private launchEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.options.store.settings.codexHome };
    delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
    return env;
  }
  private async stopApp(installation: CodexInstallation, force = false): Promise<void> {
    try { await this.options.processes.stop(installation, { force }); } catch { throw new AppError('APP_STOP_FAILED'); }
  }
  private async launchApp(installation: CodexInstallation, newThread = false): Promise<void> {
    try {
      const env = this.launchEnvironment();
      if (newThread) await this.options.processes.launch(installation, env, { newThread: true });
      else await this.options.processes.launch(installation, env);
    } catch { throw new AppError('APP_START_FAILED'); }
  }
  private async restoreFile(path: string, original: string | null): Promise<void> {
    if (original !== null) await atomicWrite(path, original);
    else await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
