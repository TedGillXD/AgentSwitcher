import { availableDeepseekModels, profileModelReasoning, type ReasoningEffort } from '../shared/models';
import type { ApiProfileConfig } from '../shared/types';

const REASONING_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: 'Fast responses',
  medium: 'Moderate reasoning',
  high: 'Deeper reasoning',
  xhigh: 'Extra high reasoning depth',
  ultra: 'Ultra reasoning depth',
  max: 'Maximum reasoning depth',
};

export interface CatalogModelSource {
  slug: string;
  upstreamId: string;
  profile: ApiProfileConfig;
}

export interface CodexApiProfile {
  id: string;
  name: string;
  models: readonly CatalogModelSource[];
}

export function codexApiProfile(profile: ApiProfileConfig): CodexApiProfile {
  return {
    id: profile.id, name: profile.name,
    models: [...new Set([profile.defaultModel, ...profile.modelIds])].map((slug) => ({ slug, upstreamId: slug, profile })),
  };
}

/** Metadata based on DeepSeek's published Codex integration (2026-10-21). */
export function modelCatalog(selectedModel: string): string {
  return profileModelCatalog({
    id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com',
    protocol: 'responses', modelIds: availableDeepseekModels(selectedModel), defaultModel: selectedModel,
  });
}

export function profileModelCatalog(profile: ApiProfileConfig): string {
  return codexModelCatalog(codexApiProfile(profile));
}

export function codexModelCatalog(config: CodexApiProfile): string {
  const profileNames = new Map(config.models.map(({ profile }) => [profile.id, profile.name]));
  const idsByName = new Map<string, string[]>();
  for (const [id, name] of profileNames) {
    const ids = idsByName.get(name) ?? [];
    ids.push(id);
    idsByName.set(name, ids);
  }
  const models = config.models.map(({ slug, upstreamId, profile }, index) => {
    const { efforts, defaultEffort } = profileModelReasoning(profile, upstreamId);
    const modelName = upstreamId === 'deepseek-flash' ? 'DeepSeek-Flash' : upstreamId === 'deepseek-v4-pro' ? 'DeepSeek-V4-Pro' : upstreamId;
    const deepseek = profile.preset === 'deepseek';
    const image = deepseek && upstreamId === 'deepseek-flash';
    const contextWindow = deepseek && (image || upstreamId === 'deepseek-v4-pro') ? 1048576 : 131072;
    const sameNameIds = idsByName.get(profile.name)!;
    const configurationName = sameNameIds.length > 1 ? `${profile.name} (${sameNameIds.indexOf(profile.id) + 1})` : profile.name;
    return {
      slug,
      display_name: slug === upstreamId ? modelName : `${modelName} · ${configurationName}`,
      description: `${profile.name} via AgentSwitcher`,
      prefer_websockets: false, support_verbosity: true, default_verbosity: 'low',
      apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
      input_modalities: image ? ['text', 'image'] : ['text'],
      supports_image_detail_original: image,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      supports_parallel_tool_calls: true, tool_mode: null, multi_agent_version: 'v2',
      use_responses_lite: false, include_skills_usage_instructions: false,
      auto_review_model_override: null,
      context_window: contextWindow, max_context_window: contextWindow,
      effective_context_window_percent: 95, auto_compact_token_limit: null,
      comp_hash: '3000', reasoning_summary_format: 'experimental', default_reasoning_summary: 'none',
      default_reasoning_level: defaultEffort,
      supported_reasoning_levels: efforts.map((effort) => ({ effort, description: REASONING_DESCRIPTIONS[effort] })),
      shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.144.0',
      supported_in_api: true, availability_nux: null, upgrade: null, priority: index + 1,
      experimental_supported_tools: [], supports_search_tool: false,
      default_service_tier: null, supports_reasoning_summaries: deepseek,
      base_instructions: 'You are a coding assistant working with the user in a shared workspace. Inspect relevant code, make the requested changes carefully, preserve unrelated work, and validate your results. Communicate clearly and concisely. Follow the user instructions and repository guidance.',
    };
  });
  return JSON.stringify({ models }, null, 2) + '\n';
}
