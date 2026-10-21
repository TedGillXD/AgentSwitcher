export const BUILT_IN_DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

/** The setting chooses the default; it does not restrict Codex to one model. */
export function availableDeepseekModels(defaultModel: string): string[] {
  return [...new Set([defaultModel, ...BUILT_IN_DEEPSEEK_MODELS])];
}
