import { availableDeepseekModels } from '../shared/models';
import type { ApiProfileConfig } from '../shared/types';

/** Metadata based on DeepSeek's published Codex integration (2026-10-21). */
export function modelCatalog(selectedModel: string): string {
  return profileModelCatalog({
    id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com',
    protocol: 'responses', modelIds: availableDeepseekModels(selectedModel), defaultModel: selectedModel,
  });
}

/** Only expose models belonging to the selected connection; never mix provider accounts. */
export function profileModelCatalog(profile: ApiProfileConfig): string {
  const models = [...new Set([profile.defaultModel, ...profile.modelIds])];
  return JSON.stringify({ models: models.map((slug, index) => ({
    slug,
    display_name: slug === 'deepseek-flash' ? 'DeepSeek-Flash' : slug === 'deepseek-v4-pro' ? 'DeepSeek-V4-Pro' : slug,
    description: `${profile.name} via AgentSwitcher`,
    prefer_websockets: false, support_verbosity: true, default_verbosity: 'low',
    apply_patch_tool_type: 'freeform', web_search_tool_type: 'text',
    input_modalities: profile.preset === 'deepseek' && slug === 'deepseek-flash' ? ['text', 'image'] : ['text'],
    supports_image_detail_original: profile.preset === 'deepseek' && slug === 'deepseek-flash',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true, tool_mode: null, multi_agent_version: 'v2',
    use_responses_lite: false, include_skills_usage_instructions: false,
    auto_review_model_override: null,
    context_window: profile.preset === 'deepseek' && (slug === 'deepseek-flash' || slug === 'deepseek-v4-pro') ? 1048576 : 131072,
    max_context_window: profile.preset === 'deepseek' && (slug === 'deepseek-flash' || slug === 'deepseek-v4-pro') ? 1048576 : 131072,
    effective_context_window_percent: 95, auto_compact_token_limit: null,
    comp_hash: '3000', reasoning_summary_format: 'experimental', default_reasoning_summary: 'none',
    default_reasoning_level: profile.preset === 'deepseek' ? 'high' : null, supported_reasoning_levels: profile.preset === 'deepseek' ? [
      { effort: 'low', description: 'Fast responses' },
      { effort: 'high', description: 'Deeper reasoning' },
      { effort: 'max', description: 'Maximum reasoning depth' },
    ] : [],
    shell_type: 'shell_command', visibility: 'list', minimal_client_version: '0.144.0',
    supported_in_api: true, availability_nux: null, upgrade: null, priority: index + 1,
    experimental_supported_tools: [], supports_search_tool: false,
    default_service_tier: null, supports_reasoning_summaries: profile.preset === 'deepseek',
    base_instructions: 'You are a coding assistant working with the user in a shared workspace. Inspect relevant code, make the requested changes carefully, preserve unrelated work, and validate your results. Communicate clearly and concisely. Follow the user instructions and repository guidance.',
  })) }, null, 2) + '\n';
}
