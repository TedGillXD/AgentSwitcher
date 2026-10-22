import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { parseTOML, type AST } from 'toml-eslint-parser';
import type { ApiProfileConfig, ProfileId } from '../shared/types';
import { availableDeepseekModels } from '../shared/models';
import { AppError } from './errors';
import type { ConfigSnapshot, ModelSelection } from './store';

export const PROVIDER = 'agent_switcher_deepseek';
const PROVIDER_PREFIX = 'agent_switcher_';

function profileIdValid(id: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(id) && !['chatgpt', 'external'].includes(id);
}

export function catalogFile(home: string, id = 'deepseek'): string {
  if (!profileIdValid(id)) throw new AppError('INVALID_PROFILE');
  return join(home, id === 'deepseek' ? 'agent-switcher-models.json' : `agent-switcher-models-${id}.json`);
}
const DESKTOP_EFFORTS = 'desktop.enabled-reasoning-efforts';
export const MANAGED_KEYS = [
  'model', 'model_provider', 'profile', 'preferred_auth_method', 'forced_login_method',
  'model_catalog_json', 'model_reasoning_effort', 'model_reasoning_summary',
  'model_context_window', 'model_auto_compact_token_limit', 'web_search', 'service_tier',
  DESKTOP_EFFORTS,
];

function document(text: string): { ast: AST.TOMLProgram; data: Record<string, unknown> } {
  const source = text.replace(/^\uFEFF/, '');
  try { return { ast: parseTOML(source), data: parse(source) as Record<string, unknown> }; }
  catch { throw new AppError('CONFIG_INVALID'); }
}

function keyPath(key: AST.TOMLKey): string[] {
  return key.keys.map((item) => item.type === 'TOMLBare' ? item.name : item.value);
}

// A quoted key containing a dot is one literal key, not a dotted TOML path.
function keyId(parts: readonly string[]): string { return JSON.stringify(parts); }

function entries(ast: AST.TOMLProgram): Map<string, AST.TOMLKeyValue> {
  const found = new Map<string, AST.TOMLKeyValue>();
  const add = (node: AST.TOMLKeyValue, path: string[]) => {
    const full = [...path, ...keyPath(node.key)];
    found.set(keyId(full), node);
    if (node.value.type === 'TOMLInlineTable') for (const child of node.value.body) add(child, full);
  };
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') add(node, []);
    else if (node.resolvedKey.every((key) => typeof key === 'string')) {
      for (const child of node.body) add(child, node.resolvedKey as string[]);
    }
  }
  return found;
}

/** CST edits preserve comments, whitespace, multiline values, and unrelated tables. */
export function patchValues(text: string, changes: Record<string, string | null>): string {
  // Windows tools commonly produce a UTF-8 BOM. Preserve it at byte zero while
  // keeping every CST offset relative to the source passed to the parser.
  if (text.startsWith('\uFEFF')) return '\uFEFF' + patchValues(text.slice(1), changes);
  const { ast } = document(text);
  const found = entries(ast);
  const edits: { start: number; end: number; text: string }[] = [];
  const insertions = new Map<number, string[]>();
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const insert = (position: number, value: string) => insertions.set(position, [...(insertions.get(position) ?? []), value]);
  for (const [path, raw] of Object.entries(changes)) {
    const parts = path.split('.');
    const node = found.get(keyId(parts));
    if (node) {
      if (raw !== null) edits.push({ start: node.value.range[0], end: node.value.range[1], text: raw });
      else {
        // Removing an inline member also needs comma handling; reject instead of risking a config.
        if (node.parent.type === 'TOMLInlineTable') throw new AppError('CONFIG_UNSUPPORTED_FORMAT');
        edits.push({ start: node.range[0], end: node.range[1], text: '' });
      }
    } else if (raw !== null) {
      if (parts.length === 1) insert(0, `${path} = ${raw}${newline}`);
      else {
        // Defining a.b.c at the document root would implicitly define a and a.b.
        // If [a] already exists later, TOML treats that as a table redefinition.
        // Insert relative to the deepest explicit ancestor instead.
        const parent = ast.body[0].body
          .filter((item): item is AST.TOMLTable =>
            item.type === 'TOMLTable' && item.kind === 'standard' &&
            item.resolvedKey.length < parts.length &&
            item.resolvedKey.every((key, index) => key === parts[index]))
          .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
        const inlineParent = parts.slice(0, -1).some((_, i) => found.get(keyId(parts.slice(0, i + 1)))?.value.type === 'TOMLInlineTable');
        if (inlineParent) throw new AppError('CONFIG_UNSUPPORTED_FORMAT');
        if (parent) {
          // Insert just after the header line, outside a possible trailing comment.
          const endOfHeader = text.indexOf('\n', parent.key.range[1]);
          const position = endOfHeader < 0 ? text.length : endOfHeader + 1;
          const relativePath = parts.slice(parent.resolvedKey.length).join('.');
          insert(position, `${endOfHeader < 0 ? newline : ''}${relativePath} = ${raw}${newline}`);
        } else insert(0, `${path} = ${raw}${newline}`);
      }
    }
  }
  for (const [position, values] of insertions) edits.push({ start: position, end: position, text: values.join('') });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  document(result);
  return result;
}

export function activeProfile(text: string | null): ProfileId | 'external' {
  const { data } = document(text ?? '');
  if (typeof data.model_provider === 'string' && data.model_provider.startsWith(PROVIDER_PREFIX) && !data.profile) {
    const id = data.model_provider.slice(PROVIDER_PREFIX.length);
    if (profileIdValid(id)) return id;
  }
  if ((!data.model_provider || data.model_provider === 'openai') && !data.profile && data.forced_login_method !== 'api') return 'chatgpt';
  return 'external';
}

export function snapshotConfig(text: string, home: string): ConfigSnapshot {
  const source = text.replace(/^\uFEFF/, '');
  const { ast } = document(source);
  const found = entries(ast);
  const values: Record<string, string | null> = {};
  for (const key of MANAGED_KEYS) {
    const node = found.get(keyId(key.split('.')));
    values[key] = node ? source.slice(...node.value.range) : null;
  }
  return { home: resolve(home), values };
}

export function snapshotModelSelection(text: string, home: string): ModelSelection {
  const { data } = document(text);
  return {
    home: resolve(home),
    model: typeof data.model === 'string' ? data.model : null,
    reasoningEffort: typeof data.model_reasoning_effort === 'string' ? data.model_reasoning_effort : null,
  };
}

export function chatgptConfig(text: string, snapshot?: ConfigSnapshot): string {
  const changes = snapshot ? { ...snapshot.values } : Object.fromEntries(MANAGED_KEYS.map((key) => [key, null]));
  // A pre-existing third-party provider/profile is preserved in the encrypted snapshot,
  // but this button always selects the built-in ChatGPT provider.
  const previousProvider = snapshot?.values.model_provider;
  const previousProviderValue = previousProvider ? document(`model_provider = ${previousProvider}\n`).data.model_provider : undefined;
  if (previousProviderValue !== undefined && previousProviderValue !== 'openai') {
    for (const key of MANAGED_KEYS) if (key !== DESKTOP_EFFORTS) changes[key] = null;
  }
  changes.model_provider = '"openai"';
  changes.profile = null;
  changes.preferred_auth_method = '"chatgpt"';
  // An API-key-only credential cache must not silently retain API billing when
  // the user selects ChatGPT. Codex handles the native ChatGPT sign-in flow.
  changes.forced_login_method = '"chatgpt"';
  return patchValues(text, changes);
}

export function deepseekConfig(text: string, home: string, port: number, token: string, model: string): string {
  return apiConfig(text, home, port, token, {
    id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com',
    protocol: 'responses', modelIds: availableDeepseekModels(model), defaultModel: model,
  });
}

export function apiConfig(text: string, home: string, port: number, token: string, profile: ApiProfileConfig, selection?: ModelSelection): string {
  if (!profileIdValid(profile.id)) throw new AppError('INVALID_PROFILE');
  const providerId = `${PROVIDER_PREFIX}${profile.id}`;
  const provider = `model_providers.${providerId}`;
  // A removed model (or a different Codex home) must not revive stale choices.
  const saved = selection?.home === resolve(home) &&
    (selection.model === null || profile.modelIds.includes(selection.model)) ? selection : undefined;
  return patchValues(text, {
    model: JSON.stringify(saved?.model ?? profile.defaultModel), model_provider: JSON.stringify(providerId), profile: null,
    preferred_auth_method: '"apikey"',
    // Custom provider auth is supplied by the local proxy. Do not force an API login,
    // which could log out the user's existing ChatGPT credential cache.
    forced_login_method: null,
    model_catalog_json: JSON.stringify(catalogFile(home, profile.id)),
    model_reasoning_effort: saved ? (saved.reasoningEffort === null ? null : JSON.stringify(saved.reasoningEffort)) :
      profile.preset === 'deepseek' ? '"high"' : null,
    model_reasoning_summary: '"none"',
    model_context_window: null, model_auto_compact_token_limit: null,
    web_search: '"disabled"', service_tier: null,
    [DESKTOP_EFFORTS]: '["low", "medium", "high", "xhigh", "ultra", "max"]',
    [`${provider}.name`]: JSON.stringify(`${profile.name} · AgentSwitcher`),
    [`${provider}.base_url`]: JSON.stringify(`http://127.0.0.1:${port}/v1`),
    [`${provider}.wire_api`]: '"responses"',
    [`${provider}.requires_openai_auth`]: 'false',
    [`${provider}.supports_websockets`]: 'false',
    [`${provider}.experimental_bearer_token`]: JSON.stringify(token),
  });
}

export function configHash(text: string | null): string {
  return createHash('sha256').update(text === null ? '\0missing' : text).digest('hex');
}

export function managedEndpoint(text: string): { port: number; token: string; model: string } | null {
  const { data } = document(text);
  const providers = data.model_providers as Record<string, Record<string, unknown>> | undefined;
  if (typeof data.model_provider !== 'string' || !data.model_provider.startsWith(PROVIDER_PREFIX)) return null;
  const selected = data.model_provider;
  const provider = providers?.[selected];
  if (!provider || typeof provider.base_url !== 'string' || typeof provider.experimental_bearer_token !== 'string') return null;
  try {
    const url = new URL(provider.base_url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || !url.port || Number(url.port) === 0 || url.username || url.password || url.search || url.hash) return null;
    return { port: Number(url.port), token: provider.experimental_bearer_token, model: String(data.model ?? '') };
  } catch { return null; }
}

/** Only maintain our own catalog; an explicitly selected external catalog is user-owned. */
export function usesManagedCatalog(text: string, home: string): boolean {
  const { data } = document(text);
  if (typeof data.model_catalog_json !== 'string') return false;
  const actual = resolve(data.model_catalog_json);
  const id = activeProfile(text);
  if (!profileIdValid(id)) return false;
  const expected = resolve(catalogFile(home, id));
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}
