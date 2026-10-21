export type Language = 'zh-CN' | 'en';
export type ProfileId = string;
export type View = 'profiles' | 'settings';
export type ApiProtocol = 'auto' | 'responses' | 'chat_completions';
export type ProviderPreset = 'deepseek' | 'glm' | 'kimi' | 'custom';

export interface ApiProfileConfig {
  id: string;
  name: string;
  preset: ProviderPreset;
  baseUrl: string;
  protocol: ApiProtocol;
  modelIds: string[];
  defaultModel: string;
}

export interface ApiProfile extends ApiProfileConfig { hasApiKey: boolean }

export interface SaveProfileInput {
  id?: string;
  name: string;
  preset: ProviderPreset;
  baseUrl: string;
  protocol: ApiProtocol;
  /** Omit to discover models using the API URL and key. */
  modelIds?: string[];
  defaultModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ConnectionInput {
  profileId?: string;
  apiKey?: string;
  baseUrl?: string;
  protocol?: ApiProtocol;
  model?: string;
}

export interface Settings {
  language: Language;
  codexHome: string;
  codexAppPath: string;
  deepseekBaseUrl: string;
  /** Initial/default model; Codex can choose any model in the generated catalog. */
  deepseekModel: string;
  launchAtLogin: boolean;
  /** Legacy storage field. Panels now stay open on blur; always false. */
  hideOnBlur: boolean;
}

export interface AppState {
  version: string;
  platform: string;
  settings: Settings;
  profiles: ApiProfile[];
  activeProfile: ProfileId | 'external';
  hasApiKey: boolean;
  encryptionAvailable: boolean;
  codexInstalled: boolean;
  codexRunning: boolean;
  detectedAppPath: string | null;
  bridgeRunning: boolean;
  lastSwitchedAt: string | null;
  lastError: string | null;
}

export interface SaveSettingsInput extends Settings {
  /** Undefined/empty keeps the stored key. Use clearApiKey to delete it. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface SwitchResult {
  state: AppState;
  restarted: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models?: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AgentSwitcherApi {
  getState(): Promise<AppState>;
  saveSettings(input: SaveSettingsInput): Promise<AppState>;
  saveProfile(input: SaveProfileInput): Promise<AppState>;
  deleteProfile(id: string): Promise<AppState>;
  openSettings(profileId?: string): Promise<void>;
  closeSettings(): Promise<void>;
  switchProfile(profile: ProfileId): Promise<SwitchResult>;
  restartCodex(): Promise<AppState>;
  testConnection(input?: ConnectionInput): Promise<ConnectionResult>;
  chooseCodexApp(): Promise<string | null>;
  chooseCodexHome(): Promise<string | null>;
  openConfigFolder(): Promise<void>;
  hideWindow(): Promise<void>;
  quit(confirmed?: boolean): Promise<void>;
  onStateChanged(callback: (state: AppState) => void): () => void;
  onNavigate(callback: (view: View) => void): () => void;
  onEditProfile(callback: (id: string | null) => void): () => void;
}

declare global {
  interface Window { agentSwitcher?: AgentSwitcherApi }
}
