import type { ApiProfileConfig } from './types';

export const ALL_API_PROFILE_ID = 'all-api';
export const BUILT_IN_DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const DEEPSEEK_REASONING_EFFORTS = ['low', 'high', 'max'] as const;

/** The setting chooses the default; it does not restrict Codex to one model. */
export function availableDeepseekModels(defaultModel: string): string[] {
  return [...new Set([defaultModel, ...BUILT_IN_DEEPSEEK_MODELS])];
}

export function profileModelReasoning(profile: ApiProfileConfig, model: string): {
  efforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
} {
  if (profile.preset === 'deepseek') return { efforts: DEEPSEEK_REASONING_EFFORTS, defaultEffort: 'high' };

  const configuredEfforts = profile.reasoningEfforts;
  const efforts = configuredEfforts && Object.hasOwn(configuredEfforts, model) ? configuredEfforts[model] ?? [] : [];
  return { efforts, defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? null };
}
