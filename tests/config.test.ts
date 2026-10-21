import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { resolve } from 'node:path';
import {
  PROVIDER, activeProfile, apiConfig, catalogFile, chatgptConfig, configHash, deepseekConfig,
  managedEndpoint, patchValues, snapshotConfig, usesManagedCatalog,
} from '../electron/config';
import type { ApiProfileConfig } from '../shared/types';

const home = resolve('test-codex-home');
const token = 'local-bridge-token-that-is-not-an-api-key';
const switchToDeepSeek = (text: string) => deepseekConfig(text, home, 12345, token, 'deepseek-flash');

describe('Codex config CST patching', () => {
  it('preserves comments, unrelated MCP settings and multiline text while replacing only managed values', () => {
    const source = [
      '# My personal preferences',
      'model = "old-codex" # keep this comment',
      'approval_policy = "on-request"',
      'instructions = """',
      'A line that resembles model = "leave this alone"',
      'and [model_providers] is still string content.',
      '"""',
      '',
      '[mcp_servers.local_tools] # keep the server',
      'command = "node"',
      'args = ["tool.js", "--verbose"]',
      'env = { PORT = "1234" }',
      '',
    ].join('\n');
    const written = switchToDeepSeek(source);
    const parsed = parse(written);
    expect(parsed.model).toBe('deepseek-flash');
    expect(parsed.approval_policy).toBe('on-request');
    expect(parsed.instructions).toBe(parse(source).instructions);
    expect(written).toContain('model = "deepseek-flash" # keep this comment');
    expect(written).toContain('# My personal preferences');
    expect(written).toContain(source.slice(source.indexOf('[mcp_servers.local_tools]')));
    expect(activeProfile(written)).toBe('deepseek');
  });

  it('retains CRLF newlines and inline comments when inserting missing fields', () => {
    const source = '# Windows config\r\nmodel = "old" # note\r\n[desktop] # local UI\r\nfoo = true\r\n';
    const written = switchToDeepSeek(source);
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(written).toContain('model = "deepseek-flash" # note\r\n');
    expect(written).toContain('[desktop] # local UI\r\nenabled-reasoning-efforts = ');
    expect((parse(written).desktop as Record<string, unknown>).foo).toBe(true);
  });

  it('preserves a Windows UTF-8 BOM and keeps snapshot offsets correct', () => {
    const source = '\uFEFF# Generated on Windows\r\nmodel = "my-codex"\r\n';
    const snapshot = snapshotConfig(source, home);
    const written = switchToDeepSeek(source);
    expect(written[0]).toBe('\uFEFF');
    expect(written.slice(1)).not.toContain('\uFEFF');
    expect(activeProfile(written)).toBe('deepseek');
    expect(snapshot.values.model).toBe('"my-codex"');
    const restored = chatgptConfig(written, snapshot);
    expect(restored[0]).toBe('\uFEFF');
    expect(parse(restored).model).toBe('my-codex');
  });

  it('inserts a missing provider relative to an explicit root ancestor table', () => {
    const source = '# Providers\n[model_providers] # keep header\nother = { name = "Other" }\n';
    const written = switchToDeepSeek(source);
    const providers = parse(written).model_providers as Record<string, Record<string, unknown>>;
    expect(providers[PROVIDER]?.base_url).toBe('http://127.0.0.1:12345/v1');
    expect(providers.other?.name).toBe('Other');
    expect(written).toContain(`[model_providers] # keep header\n${PROVIDER}.name = `);
  });

  it('inserts into the deepest ancestor while leaving sibling provider definitions unchanged', () => {
    const source = [
      '[model_providers]',
      'other.name = "Other"',
      `[model_providers.${PROVIDER}] # owned provider`,
      'name = "Old" # retained',
      '[mcp_servers.server]',
      'command = "tool"',
      '',
    ].join('\n');
    const written = switchToDeepSeek(source);
    expect(parse(written).model_provider).toBe(PROVIDER);
    expect(written).toContain(`name = "DeepSeek · AgentSwitcher" # retained`);
    expect(written).toContain('other.name = "Other"');
    expect(written).toContain('[mcp_servers.server]\ncommand = "tool"');
    expect(written).toContain(`[model_providers.${PROVIDER}] # owned provider\nbase_url = `);
  });

  it('supports existing dotted keys at the root and nested desktop tables', () => {
    const source = [
      'desktop.enabled-reasoning-efforts = ["low"] # custom efforts',
      `model_providers.${PROVIDER}.name = "Old"`,
      `model_providers.${PROVIDER}.base_url = "http://127.0.0.1:9999/v1"`,
      '[desktop.appearance]',
      'theme = "dark"',
      '',
    ].join('\n');
    const written = switchToDeepSeek(source);
    expect(written).toContain('# custom efforts');
    expect((parse(written).desktop as Record<string, unknown>).appearance).toEqual({ theme: 'dark' });
    expect(managedEndpoint(written)).toEqual({ port: 12345, token, model: 'deepseek-flash' });
  });

  it('does not confuse a quoted literal dot key with a nested table path', () => {
    const source = '"desktop.enabled-reasoning-efforts" = "literal and unrelated"\n[desktop]\nfoo = true\n';
    const written = switchToDeepSeek(source);
    const data = parse(written);
    expect(data['desktop.enabled-reasoning-efforts']).toBe('literal and unrelated');
    expect((data.desktop as Record<string, unknown>)['enabled-reasoning-efforts']).toEqual([
      'low', 'medium', 'high', 'xhigh', 'ultra', 'max',
    ]);
  });

  it('handles a table header with a trailing comment and no final newline', () => {
    const written = patchValues('[desktop] # final comment', { 'desktop.foo': 'true', 'desktop.bar': '42' });
    expect(parse(written).desktop).toEqual({ foo: true, bar: 42 });
    expect(written).toContain('[desktop] # final comment\n');
  });

  it('updates existing inline table values but rejects unsupported inline insertions/removals safely', () => {
    const source = 'desktop = { foo = true, enabled-reasoning-efforts = ["low"] } # keep\n';
    const updated = patchValues(source, { 'desktop.enabled-reasoning-efforts': '["high"]' });
    expect(updated).toBe('desktop = { foo = true, enabled-reasoning-efforts = ["high"] } # keep\n');
    expect(() => patchValues(source, { 'desktop.missing': 'true' })).toThrow('CONFIG_UNSUPPORTED_FORMAT');
    expect(() => patchValues(source, { 'desktop.enabled-reasoning-efforts': null })).toThrow('CONFIG_UNSUPPORTED_FORMAT');
    expect(source).toContain('enabled-reasoning-efforts = ["low"]');
  });

  it('rejects malformed input before generating a replacement config', () => {
    expect(() => switchToDeepSeek('model = "unterminated')).toThrow('CONFIG_INVALID');
    expect(() => patchValues('model = "old"\n', { model: 'invalid @@@' })).toThrow('CONFIG_INVALID');
  });
});

const glm: ApiProfileConfig = {
  id: 'glm-work', name: 'GLM work', preset: 'glm', baseUrl: 'https://glm.example/v1',
  protocol: 'auto', modelIds: ['glm-fixture'], defaultModel: 'glm-fixture',
};

describe('generic API profile configuration', () => {
  it('uses a distinct provider and catalog for each API profile while retaining unrelated settings', () => {
    const source = '# keep\napproval_policy = "on-request"\n[mcp_servers.fixture]\ncommand = "fixture"\n';
    const written = apiConfig(source, home, 23456, token, glm);
    const data = parse(written);
    expect(data.model).toBe('glm-fixture');
    expect(data.model_provider).toBe('agent_switcher_glm-work');
    expect(data.model_catalog_json).toBe(catalogFile(home, 'glm-work'));
    expect(data.model_reasoning_effort).toBeUndefined();
    expect(data.approval_policy).toBe('on-request');
    expect(data.mcp_servers).toEqual({ fixture: { command: 'fixture' } });
    expect(written).toContain('# keep');
    expect(written).not.toContain(glm.baseUrl);
    const provider = (data.model_providers as Record<string, unknown>)['agent_switcher_glm-work'];
    expect(provider).toMatchObject({ name: 'GLM work · AgentSwitcher', base_url: 'http://127.0.0.1:23456/v1', experimental_bearer_token: token });
    expect(activeProfile(written)).toBe('glm-work');
    expect(managedEndpoint(written)).toEqual({ port: 23456, token, model: 'glm-fixture' });
    expect(usesManagedCatalog(written, home)).toBe(true);
  });

  it('switches API providers without treating an inactive provider table as the active endpoint', () => {
    const deepseek = switchToDeepSeek('');
    const written = apiConfig(deepseek, home, 23456, 'other-local-token', glm);
    expect(activeProfile(written)).toBe('glm-work');
    expect(managedEndpoint(written)).toEqual({ port: 23456, token: 'other-local-token', model: 'glm-fixture' });
    expect(parse(written).model_providers).toHaveProperty(PROVIDER);
    const unrelated = written.replace('model_provider = "agent_switcher_glm-work"', 'model_provider = "unrelated"');
    expect(activeProfile(unrelated)).toBe('external');
    expect(managedEndpoint(unrelated)).toBeNull();
  });

  it('restores the original ChatGPT snapshot after multiple API profiles', () => {
    const original = 'model = "saved-chatgpt"\nmodel_provider = "openai"\nweb_search = "cached"\n';
    const snapshot = snapshotConfig(original, home);
    const deepseek = switchToDeepSeek(original);
    const generic = apiConfig(deepseek, home, 23456, token, glm);
    const restored = parse(chatgptConfig(generic, snapshot));
    expect(restored.model).toBe('saved-chatgpt');
    expect(restored.model_provider).toBe('openai');
    expect(restored.web_search).toBe('cached');
    expect(restored.model_catalog_json).toBeUndefined();
  });

  it('preserves explicitly selected external catalogs and rejects unsafe provider identifiers', () => {
    const written = apiConfig('', home, 23456, token, glm);
    expect(usesManagedCatalog(written.replace(JSON.stringify(catalogFile(home, glm.id)), JSON.stringify(resolve(home, 'custom.json'))), home)).toBe(false);
    expect(usesManagedCatalog('model_provider = "openai"\nmodel_catalog_json = "custom.json"\n', home)).toBe(false);
    for (const id of ['../../outside', 'chatgpt', 'external', 'bad.id']) {
      expect(() => catalogFile(home, id)).toThrow('INVALID_PROFILE');
      expect(() => apiConfig('', home, 23456, token, { ...glm, id })).toThrow('INVALID_PROFILE');
    }
    expect(catalogFile(home, 'deepseek')).toBe(resolve(home, 'agent-switcher-models.json'));
    expect(catalogFile(home, 'glm-work')).toBe(resolve(home, 'agent-switcher-models-glm-work.json'));
  });
});

describe('profile selection and restoration', () => {
  it('restores original managed values without overwriting newer unrelated settings', () => {
    const original = [
      'model = "my-codex" # chosen model',
      'model_provider = "openai"',
      'model_reasoning_effort = "low"',
      'web_search = "live"',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      '[desktop]',
      'enabled-reasoning-efforts = ["low", "high"]',
      'theme = "dark"',
      '',
    ].join('\n');
    const snapshot = snapshotConfig(original, home);
    const switched = switchToDeepSeek(original).replace('approval_policy = "on-request"', 'approval_policy = "never"');
    const restored = chatgptConfig(switched, snapshot);
    const data = parse(restored);
    expect(data.model).toBe('my-codex');
    expect(data.model_reasoning_effort).toBe('low');
    expect(data.web_search).toBe('live');
    expect(data.service_tier).toBe('fast');
    expect(data.approval_policy).toBe('never');
    expect(data.preferred_auth_method).toBe('chatgpt');
    expect(data.forced_login_method).toBe('chatgpt');
    expect(data.model_catalog_json).toBeUndefined();
    expect(data.desktop).toEqual({ 'enabled-reasoning-efforts': ['low', 'high'], theme: 'dark' });
    expect(restored).toContain('model = "my-codex" # chosen model');
    expect(activeProfile(restored)).toBe('chatgpt');
  });

  it('compares an original multiline openai provider string semantically', () => {
    const original = 'model = "my-codex"\nmodel_provider = """\nopenai"""\n';
    expect(parse(original).model_provider).toBe('openai');
    const restored = chatgptConfig(switchToDeepSeek(original), snapshotConfig(original, home));
    expect(parse(restored).model).toBe('my-codex');
    expect(parse(restored).model_provider).toBe('openai');
    expect(parse(restored).forced_login_method).toBe('chatgpt');
  });

  it('selects built-in ChatGPT defaults when the snapshot was a custom third-party provider', () => {
    const original = 'model = "other-model"\nmodel_provider = "other"\nmodel_reasoning_effort = "high"\n';
    const restored = chatgptConfig(switchToDeepSeek(original), snapshotConfig(original, home));
    expect(parse(restored).model).toBeUndefined();
    expect(parse(restored).model_provider).toBe('openai');
    expect(parse(restored).forced_login_method).toBe('chatgpt');
    expect(parse(restored).model_reasoning_effort).toBeUndefined();
  });

  it('clears a selected named profile so it cannot override the selected provider', () => {
    const original = 'profile = "work"\n[profiles.work]\nmodel_provider = "other"\n';
    const switched = switchToDeepSeek(original);
    expect(parse(switched).profile).toBeUndefined();
    expect(parse(switched).profiles).toEqual({ work: { model_provider: 'other' } });
    expect(parse(chatgptConfig(switched)).forced_login_method).toBe('chatgpt');
    expect(activeProfile(original)).toBe('external');
  });

  it('uses only the local bearer token in a generated DeepSeek config', () => {
    const written = switchToDeepSeek('');
    const data = parse(written);
    const providers = data.model_providers as Record<string, Record<string, unknown>>;
    expect(providers[PROVIDER]).toMatchObject({
      base_url: 'http://127.0.0.1:12345/v1', wire_api: 'responses',
      requires_openai_auth: false, supports_websockets: false, experimental_bearer_token: token,
    });
    expect(data.forced_login_method).toBeUndefined();
    expect(data.web_search).toBe('disabled');
    expect(written).not.toContain('api.deepseek.com');
    expect(snapshotConfig('', home).home).toBe(home);
  });

  it('rejects remote or unrelated endpoint definitions when restoring a local bridge', () => {
    const written = switchToDeepSeek('');
    expect(managedEndpoint(written.replace('127.0.0.1', 'example.com'))).toBeNull();
    expect(managedEndpoint(written.replace('http://', 'https://'))).toBeNull();
    expect(managedEndpoint('')).toBeNull();
  });

  it('distinguishes an absent config from an empty config in transaction hashes', () => {
    expect(configHash(null)).not.toBe(configHash(''));
    expect(configHash('model = "x"')).toBe(configHash('model = "x"'));
    expect(configHash('model = "x"')).not.toBe(configHash('model = "y"'));
  });
});
