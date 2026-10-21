import { describe, expect, it } from 'vitest';
import { modelCatalog, profileModelCatalog } from '../electron/catalog';

interface CatalogModel {
  slug: string;
  display_name: string;
  priority: number;
  visibility: string;
  supported_in_api: boolean;
  input_modalities: string[];
  supports_image_detail_original: boolean;
  context_window: number;
  max_context_window: number;
}

function catalog(defaultModel: string): CatalogModel[] {
  return (JSON.parse(modelCatalog(defaultModel)) as { models: CatalogModel[] }).models;
}

describe('DeepSeek model catalog', () => {
  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    'exposes Flash and Pro together when the configured default is %s', (defaultModel) => {
      const models = catalog(defaultModel);
      expect(models.map((model) => model.slug).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
      expect(models[0]).toMatchObject({ slug: defaultModel, priority: 1 });
      expect(models.every((model) => model.visibility === 'list' && model.supported_in_api)).toBe(true);
    },
  );

  it('keeps a custom default alongside both built-in models without duplicates', () => {
    const models = catalog('custom-deepseek-model');
    expect(models.map((model) => model.slug)).toEqual(['custom-deepseek-model', 'deepseek-flash', 'deepseek-v4-pro']);
    expect(new Set(models.map((model) => model.slug)).size).toBe(models.length);
    expect(models[0]).toMatchObject({ priority: 1, display_name: 'custom-deepseek-model' });
  });

  it('preserves separate image capabilities for Flash and Pro', () => {
    const models = catalog('deepseek-v4-pro');
    expect(models.find((model) => model.slug === 'deepseek-flash')).toMatchObject({
      display_name: 'DeepSeek-Flash', input_modalities: ['text', 'image'], supports_image_detail_original: true,
    });
    expect(models.find((model) => model.slug === 'deepseek-v4-pro')).toMatchObject({
      display_name: 'DeepSeek-V4-Pro', input_modalities: ['text'], supports_image_detail_original: false,
    });
  });

  it('preserves built-in context windows and uses the conservative custom-model fallback', () => {
    const models = catalog('custom-deepseek-model');
    const custom = models.find((model) => model.slug === 'custom-deepseek-model');
    const builtIns = models.filter((model) => model.slug !== 'custom-deepseek-model');
    expect(custom).toMatchObject({ context_window: 131072, max_context_window: 131072 });
    expect(builtIns).toHaveLength(2);
    expect(builtIns.every((model) => model.context_window === 1048576 && model.max_context_window === 1048576)).toBe(true);
  });
});

describe('generic API profile model catalog', () => {
  it('includes only the selected profile models with its default first', () => {
    const models = JSON.parse(profileModelCatalog({
      id: 'kimi', name: 'Kimi', preset: 'kimi', baseUrl: 'https://kimi.example/v1', protocol: 'chat_completions',
      modelIds: ['kimi-small', 'kimi-main', 'kimi-small'], defaultModel: 'kimi-main',
    })).models;
    expect(models.map((model: CatalogModel) => model.slug)).toEqual(['kimi-main', 'kimi-small']);
    expect(models[0]).toMatchObject({ priority: 1, context_window: 131072, input_modalities: ['text'], description: 'Kimi via AgentSwitcher' });
    expect(models.every((model: CatalogModel) => !model.slug.startsWith('deepseek'))).toBe(true);
    expect(models[0].default_reasoning_level).toBeNull();
    expect(models[0].supported_reasoning_levels).toEqual([]);
    expect(models[0].supports_reasoning_summaries).toBe(false);
  });

  it('does not transfer DeepSeek-specific capabilities solely because another provider reuses a model name', () => {
    const models = JSON.parse(profileModelCatalog({
      id: 'custom', name: 'Custom', preset: 'custom', baseUrl: 'https://custom.example/v1', protocol: 'auto',
      modelIds: ['deepseek-flash'], defaultModel: 'deepseek-flash',
    })).models;
    expect(models[0]).toMatchObject({ input_modalities: ['text'], supports_image_detail_original: false, context_window: 131072 });
  });
});
