import type { ApiProtocol, ProviderPreset } from './types';

export interface ProviderTemplate {
  preset: ProviderPreset;
  name: string;
  baseUrl: string;
  protocol: ApiProtocol;
  modelIds: string[];
  defaultModel: string;
}

/** User-editable starting points. Model discovery uses the actual entered URL and key. */
export const PROVIDER_PRESETS: ProviderTemplate[] = [
  { preset: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'auto', modelIds: ['deepseek-flash', 'deepseek-v4-pro'], defaultModel: 'deepseek-flash' },
  { preset: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/v1', protocol: 'auto', modelIds: ['glm-5.3', 'glm-5-turbo'], defaultModel: 'glm-5.3' },
  { preset: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', protocol: 'auto', modelIds: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'], defaultModel: 'kimi-k3' },
  { preset: 'custom', name: '', baseUrl: '', protocol: 'auto', modelIds: [], defaultModel: '' },
];
