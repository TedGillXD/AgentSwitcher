import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiUsageSample } from '../shared/types';
import { LocalBridge, type BridgeModelRoute, type SingleBridgeOptions } from '../electron/bridge';
import { listenOnLoopback } from '../electron/bridge/listen';

const providerKey = 'sk-provider-secret-that-must-stay-in-main';
const proxyToken = 'only-a-local-random-bearer-token';
const bridges: LocalBridge[] = [];
const upstreams: Server[] = [];

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  upstreams.push(server);
  const port = await listenOnLoopback(server);
  return `http://127.0.0.1:${port}/provider/v1`;
}

async function proxy(baseUrl: string, overrides: Partial<SingleBridgeOptions> = {}, onUsage?: (sample: ApiUsageSample) => void): Promise<{ bridge: LocalBridge; url: string }> {
  const bridge = new LocalBridge(onUsage);
  bridges.push(bridge);
  const { port } = await bridge.start({ token: proxyToken, apiKey: providerKey, baseUrl, model: 'deepseek-flash', ...overrides });
  return { bridge, url: `http://127.0.0.1:${port}` };
}

function post(url: string, body: unknown = { input: 'hello', stream: false }, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(upstreams.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe('LocalBridge credential proxy', () => {
  it.each(['http', 'https'])('forwards to an explicitly configured %s gateway with a non-local hostname', async (protocol) => {
    const baseUrl = `${protocol}://api_gateway.internal.example:4000/v1`;
    const nativeFetch = globalThis.fetch;
    const upstreamFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"resp_gateway","output":[]}', {
      headers: { 'Content-Type': 'application/json' },
    }));
    const { url } = await proxy(baseUrl, { protocol: 'responses' });
    const payload = { model: 'deepseek-flash', input: 'hello', stream: false };
    const result = await nativeFetch(`${url}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: 'resp_gateway', output: [] });
    expect(upstreamFetch).toHaveBeenCalledExactlyOnceWith(new URL(`${baseUrl}/responses`), expect.objectContaining({
      method: 'POST', body: JSON.stringify(payload), redirect: 'error',
      headers: { Authorization: `Bearer ${providerKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }));
  });

  it('preserves the requested Responses model and substitutes only the upstream credential', async () => {
    const recordUsage = vi.fn(() => Promise.reject(new Error('usage store unavailable')));
    const upstreamJson = '{ "id":"resp_test","output":[],"usage":{"input_tokens":11,"output_tokens":5} }';
    let received: { url?: string; headers?: IncomingMessage['headers']; body?: unknown } = {};
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        received = { url: request.url, headers: request.headers, body };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(upstreamJson);
      });
    });
    const { url, bridge } = await proxy(baseUrl, { usageProfileId: 'deepseek' }, recordUsage);
    const payload = {
      model: 'deepseek-v4-pro',
      previous_response_id: 'resp_native_previous',
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }],
      tools: [{ type: 'custom', name: 'apply_patch' }],
      reasoning: { effort: 'max' },
      stream: false,
    };
    const result = await post(url, payload, { 'X-Codex-Account-ID': 'must-not-leave-the-computer' });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(upstreamJson);
    await expect.poll(() => recordUsage.mock.calls).toEqual([[{
      profileId: 'deepseek', model: 'deepseek-v4-pro', inputTokens: 11, outputTokens: 5, cachedInputTokens: null,
    }]]);
    expect(received.url).toBe('/provider/v1/responses');
    expect(received.body).toEqual(payload);
    expect(received.headers?.authorization).toBe(`Bearer ${providerKey}`);
    expect(received.headers?.['x-codex-account-id']).toBeUndefined();
    expect(received.headers?.authorization).not.toContain(proxyToken);
    expect(bridge.isRunning()).toBe(true);
  });

  it.each(['deepseek-flash', 'deepseek-v4-pro'])('keeps both Flash and Pro available when the configured default is %s', async (defaultModel) => {
    const received: unknown[] = [];
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        received.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    const { url, bridge } = await proxy(baseUrl, { model: defaultModel });
    for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
      const result = await post(url, { model, input: `Use ${model}`, stream: false });
      expect(result.status).toBe(200);
      await result.json();
    }
    expect(received).toEqual([
      { model: 'deepseek-flash', input: 'Use deepseek-flash', stream: false },
      { model: 'deepseek-v4-pro', input: 'Use deepseek-v4-pro', stream: false },
    ]);
    expect(bridge.isRunning()).toBe(true);
  });

  it('forwards simultaneous Flash and Pro requests independently through the same proxy', async () => {
    const requests: { response: ServerResponse; body: { model: string; input: string; stream: boolean } }[] = [];
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        requests.push({ response, body: body as typeof requests[number]['body'] });
        if (requests.length === 2) for (const entry of requests) {
          entry.response.writeHead(200, { 'Content-Type': 'application/json' });
          entry.response.end(JSON.stringify({ model: entry.body.model, input: entry.body.input }));
        }
      });
    });
    const { url } = await proxy(baseUrl);
    const models = ['deepseek-flash', 'deepseek-v4-pro'];
    const results = await Promise.all(models.map(async (model) => {
      const result = await post(url, { model, input: `Concurrent ${model}`, stream: false });
      expect(result.status).toBe(200);
      return result.json();
    }));
    expect(results).toEqual(models.map((model) => ({ model, input: `Concurrent ${model}` })));
    expect(requests.map(({ body }) => body.model).sort()).toEqual([...models].sort());
  });

  it('uses the configured default only when the request omits a model', async () => {
    let received: unknown;
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        received = body;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    const { url } = await proxy(baseUrl, { model: 'deepseek-v4-pro' });
    const payload = { input: 'Use the default', stream: false };
    const result = await post(url, payload);
    expect(result.status).toBe(200);
    await result.json();
    expect(received).toEqual({ ...payload, model: 'deepseek-v4-pro' });
  });

  it('also allows the configured custom model without losing either built-in model', async () => {
    const received: string[] = [];
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        received.push((body as { model: string }).model);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    const { url } = await proxy(baseUrl, { model: 'deepseek-custom-fixture' });
    for (const model of ['deepseek-custom-fixture', 'deepseek-flash', 'deepseek-v4-pro']) {
      const result = await post(url, { model, input: 'hello' });
      expect(result.status).toBe(200);
      await result.json();
    }
    expect(received).toEqual(['deepseek-custom-fixture', 'deepseek-flash', 'deepseek-v4-pro']);
  });

  it.each([
    { model: 'an-unexpected-model' }, { model: null }, { model: '' }, { model: 42 },
    { model: [] }, { model: {} }, { model: 'deepseek-flash ' }, { model: providerKey },
  ])('rejects an unsupported or invalid model without contacting the provider: $model', async ({ model }) => {
    let contacted = false;
    const baseUrl = await upstream(() => { contacted = true; });
    const { url } = await proxy(baseUrl);
    const result = await post(url, { model, input: 'hello' });
    expect(result.status).toBe(400);
    const error = await result.text();
    expect(error).toContain('Select a listed DeepSeek model in Codex');
    expect(error).not.toContain(providerKey);
    expect(contacted).toBe(false);
  });

  it('preserves provider SSE frames and UTF-8 text without protocol conversion', async () => {
    const recordUsage = vi.fn();
    const frames = [
      'event: response.created\r\ndata: {"type":"response.created","response":{"usage":{"input_tokens":2,"output_tokens":0}}}\r\n\r\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
      'event: response.completed\r\ndata: {"response":{"usage":{"input_tokens":30,\r\ndata: "output_tokens":12,"input_tokens_details":{"cached_tokens":0}}}}\r\n\r\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":12}}}\n\n',
    ].join('');
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from(frames);
      for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
      response.end();
    });
    const { url } = await proxy(baseUrl, { usageProfileId: 'deepseek' }, recordUsage);
    const result = await post(url, { input: 'hello', stream: true });
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
    expect(await result.text()).toBe(frames);
    await expect.poll(() => recordUsage.mock.calls).toEqual([[{
      profileId: 'deepseek', model: 'deepseek-flash', inputTokens: 30, outputTokens: 12, cachedInputTokens: 0,
    }]]);
  });

  it('supports authenticated model discovery with a GET request', async () => {
    let path: string | undefined;
    const baseUrl = await upstream((request, response) => {
      path = request.url;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"data":[{"id":"deepseek-flash"}]}');
    });
    const { url } = await proxy(baseUrl);
    const result = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${proxyToken}` } });
    expect(result.status).toBe(200);
    expect(path).toBe('/provider/v1/models');
    expect(await result.json()).toEqual({ data: [{ id: 'deepseek-flash' }] });
  });

  it('rejects missing or invalid local authentication without contacting the provider', async () => {
    let requests = 0;
    const baseUrl = await upstream(() => { requests += 1; });
    const { url } = await proxy(baseUrl);
    expect((await post(url, {}, { Authorization: `Bearer ${providerKey}` })).status).toBe(401);
    expect((await fetch(`${url}/health`)).status).toBe(401);
    expect(requests).toBe(0);
  });

  it('rejects browser origins and invalid Host headers to prevent browser access and DNS rebinding', async () => {
    let requests = 0;
    const baseUrl = await upstream(() => { requests += 1; });
    const { url } = await proxy(baseUrl);
    expect((await post(url, {}, { Origin: 'https://malicious.example' })).status).toBe(403);
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/models`, {
        headers: { Authorization: `Bearer ${proxyToken}`, Host: 'malicious.example' },
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    expect(hostStatus).toBe(403);
    expect(requests).toBe(0);
  });

  it('allows only known routes and their expected methods', async () => {
    const baseUrl = await upstream(() => { throw new Error('Must not be contacted'); });
    const { url } = await proxy(baseUrl);
    const headers = { Authorization: `Bearer ${proxyToken}` };
    expect((await fetch(`${url}/admin`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/v1/responses`, { headers })).status).toBe(405);
    expect((await fetch(`${url}/v1/responses?forward=/secrets`, { headers })).status).toBe(404);
    expect(await (await fetch(`${url}/health`, { headers })).json()).toEqual({ ok: true });
  });

  it('rejects malformed JSON and unsupported content types', async () => {
    const baseUrl = await upstream(() => { throw new Error('Must not be contacted'); });
    const { url } = await proxy(baseUrl);
    const malformed = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json' },
      body: '{broken',
    });
    expect(malformed.status).toBe(400);
    expect((await post(url, [], {})).status).toBe(400);
    expect((await post(url, {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
  });

  it('limits both declared and chunked request sizes before contacting the provider', async () => {
    let contacted = false;
    const baseUrl = await upstream(() => { contacted = true; });
    const { url } = await proxy(baseUrl, { maxRequestBytes: 32 });
    expect((await post(url, { input: 'a'.repeat(100) })).status).toBe(413);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/responses`, {
        method: 'POST', headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.write('{"input":"');
      request.end(`${'a'.repeat(100)}"}`);
    });
    expect(status).toBe(413);
    expect(contacted).toBe(false);
  });

  it('sanitizes upstream errors so an echoed API key cannot reach Codex or the renderer', async () => {
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json', 'X-Secret': providerKey });
      response.end(JSON.stringify({ error: `Invalid API key: ${providerKey}` }));
    });
    const { url } = await proxy(baseUrl);
    const result = await post(url);
    expect(result.status).toBe(401);
    expect(result.headers.get('x-secret')).toBeNull();
    const text = await result.text();
    expect(text).toContain('provider rejected');
    expect(text).not.toContain(providerKey);
    expect(text).not.toContain(proxyToken);
  });

  it('does not follow upstream redirects with stored credentials', async () => {
    let redirected = false;
    const baseUrl = await upstream((request, response) => {
      if (request.url?.includes('/leak')) redirected = true;
      response.writeHead(302, { Location: '/leak' });
      response.end();
    });
    const { url } = await proxy(baseUrl);
    expect((await post(url)).status).toBe(502);
    expect(redirected).toBe(false);
  });

  it('bounds upstream waiting time and returns a safe timeout', async () => {
    const baseUrl = await upstream(() => { /* Simulate a stalled provider. */ });
    const { url } = await proxy(baseUrl, { timeoutMs: 50 });
    const result = await post(url);
    expect(result.status).toBe(504);
    expect(await result.text()).toContain('timed out');
  });

  it('times out an incomplete local request body without contacting the provider', async () => {
    let contacted = false;
    const baseUrl = await upstream(() => { contacted = true; });
    const { url } = await proxy(baseUrl, { timeoutMs: 40 });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/v1/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
        request.end();
      });
      request.on('error', reject);
      request.write('{"input":"unfinished');
    });
    expect(status).toBe(504);
    expect(contacted).toBe(false);
  });

  it('aborts the upstream request when Codex disconnects during streaming', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: response.created\ndata: {}\n\n');
      response.once('close', disconnected);
    });
    const { url } = await proxy(baseUrl);
    const controller = new AbortController();
    const result = await fetch(`${url}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${proxyToken}`, 'Content-Type': 'application/json' },
      body: '{"input":"hello","stream":true}',
      signal: controller.signal,
    });
    expect(result.status).toBe(200);
    controller.abort();
    await expect(Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))])).resolves.toBe(true);
  });

  it('rejects unsupported protocols and embedded credentials, and can stop/rebind its original port', async () => {
    const bridge = new LocalBridge();
    bridges.push(bridge);
    const options = { token: proxyToken, apiKey: providerKey, model: 'deepseek-flash' };
    for (const baseUrl of ['ftp://provider.example', 'file:///tmp/provider', 'https://user:password@provider.example',
      'http://user:password@provider.example', 'http://provider.example?key=secret', 'http://provider.example#fragment']) {
      await expect(bridge.start({ ...options, baseUrl })).rejects.toThrow('HTTP or HTTPS without embedded credentials');
    }
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    const { port } = await bridge.start({ ...options, baseUrl });
    await bridge.stop();
    expect(bridge.isRunning()).toBe(false);
    expect((await bridge.start({ ...options, baseUrl, port })).port).toBe(port);
    expect(bridge.isRunning()).toBe(true);
  });
});

describe('combined API model routes', () => {
  it('advertises local aliases and keeps duplicate upstream IDs on their own credentials and protocols', async () => {
    const recordUsage = vi.fn();
    const calls: { provider: string; path: string | undefined; authorization: string | undefined; body: unknown }[] = [];
    const first = await upstream(async (request, response) => {
      calls.push({ provider: 'first', path: request.url, authorization: request.headers.authorization, body: await readBody(request) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"model":"shared","output":[],"usage":{"input_tokens":34,"output_tokens":4,"input_tokens_details":{"cached_tokens":8}}}');
    });
    const second = await upstream(async (request, response) => {
      calls.push({ provider: 'second', path: request.url, authorization: request.headers.authorization, body: await readBody(request) });
      if (request.url === '/provider/v1/responses') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end('{"usage":{"input_tokens":999,"output_tokens":999}}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"choices":[{"message":{"content":"via chat"},"finish_reason":"stop"}],"usage":{"prompt_tokens":62,"completion_tokens":5,"cached_tokens":27}}');
    });
    const routes: BridgeModelRoute[] = [
      { slug: 'first/shared', upstreamModel: 'shared', baseUrl: first, apiKey: 'first-fixture-key', protocol: 'responses', profileId: 'first' },
      { slug: 'second/shared', upstreamModel: 'shared', baseUrl: second, apiKey: 'second-fixture-key', protocol: 'auto', profileId: 'second' },
    ];
    const bridge = new LocalBridge(recordUsage);
    bridges.push(bridge);
    const { port } = await bridge.start({ token: proxyToken, model: 'first/shared', routes });
    const url = `http://127.0.0.1:${port}`;
    await expect(bridge.start({ token: proxyToken, model: 'first/shared', routes: [routes[0]!, routes[0]!] })).rejects.toThrow('model routes');
    routes[0]!.apiKey = 'mutated-after-listening';
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
    const list = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${proxyToken}` } });
    expect(await list.json()).toMatchObject({ object: 'list', data: [{ id: 'first/shared' }, { id: 'second/shared' }] });
    for (const body of [{ model: 'shared', input: 'No alias' }, { input: 'No model' }]) {
      expect((await post(url, body)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect(recordUsage).not.toHaveBeenCalled();

    const [responses, chat] = await Promise.all([
      post(url, { model: 'first/shared', input: 'Use first' }),
      post(url, { model: 'second/shared', input: 'Use second' }),
    ]);
    expect(responses.status).toBe(200);
    expect(await responses.json()).toMatchObject({ model: 'shared' });
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ model: 'second/shared' });
    await expect.poll(() => recordUsage.mock.calls).toHaveLength(2);
    expect(recordUsage).toHaveBeenCalledWith({ profileId: 'first', model: 'shared', inputTokens: 34, outputTokens: 4, cachedInputTokens: 8 });
    expect(recordUsage).toHaveBeenCalledWith({ profileId: 'second', model: 'shared', inputTokens: 62, outputTokens: 5, cachedInputTokens: 27 });
    expect(calls.filter(({ provider }) => provider === 'first')).toMatchObject([
      { path: '/provider/v1/responses', authorization: 'Bearer first-fixture-key', body: { model: 'shared', input: 'Use first' } },
    ]);
    expect(calls.filter(({ provider }) => provider === 'second')).toMatchObject([
      { path: '/provider/v1/responses', authorization: 'Bearer second-fixture-key', body: { model: 'shared', input: 'Use second' } },
      { path: '/provider/v1/chat/completions', authorization: 'Bearer second-fixture-key', body: { model: 'shared', messages: [{ role: 'user', content: 'Use second' }] } },
    ]);
  });

  it('restores opaque history only on the originating route, including after a listener token rotation', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_input', summary: [], encrypted_content: '加密推理' };
    const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible' }], encrypted_content: 'encrypted-message' };
    const call = { type: 'function_call', name: 'fixture_tool', call_id: 'test-call', arguments: '{}', encrypted_function_args: ['encrypted-argument'] };
    const compaction = { type: 'compaction', encrypted_content: 'encrypted-compaction' };
    const output = [reasoning, message, call, compaction];
    const firstHistory: unknown[] = [];
    const secondHistory: unknown[] = [];
    let fallback = false;
    const first = await upstream(async (request, response) => {
      const body = await readBody(request) as Record<string, unknown>;
      firstHistory.push(body);
      if (fallback && request.url === '/provider/v1/responses') { response.writeHead(404); response.end(); return; }
      if (request.url === '/provider/v1/chat/completions') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"choices":[{"message":{"content":"via chat"},"finish_reason":"stop"}]}');
        return;
      }
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const item = Buffer.from(`event: response.output_item.done\r\ndata: {"type":"response.output_item.done",\r\ndata: "item":${JSON.stringify(reasoning)}}\r\n\r\n`);
        const split = item.indexOf('加') + 1;
        response.write(item.subarray(0, split));
        response.end(Buffer.concat([item.subarray(split), Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\r\n\r\n`)]));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output }));
    });
    const second = await upstream(async (request, response) => {
      secondHistory.push((await readBody(request) as Record<string, unknown>).input);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    const routes: BridgeModelRoute[] = [
      { slug: 'first/model', upstreamModel: 'model', baseUrl: first, apiKey: 'first-fixture-key', protocol: 'auto' },
      { slug: 'second/model', upstreamModel: 'model', baseUrl: second, apiKey: 'second-fixture-key', protocol: 'responses' },
    ];
    const bridge = new LocalBridge();
    bridges.push(bridge);
    const options = { model: 'first/model', continuationKey: 'local-persisted-test-provenance-key', routes };
    const initial = await bridge.start({ ...options, token: proxyToken });
    const streamed = await post(`http://127.0.0.1:${initial.port}`, { model: 'first/model', input: 'Start', stream: true });
    const text = await streamed.text();
    expect(text).toContain('event: response.output_item.done\r\n');
    const frames = text.split('\r\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const wrapped = frames.at(-1).response.output;
    expect(wrapped[0].encrypted_content).not.toBe(reasoning.encrypted_content);
    expect(frames[0].item).toEqual(wrapped[0]);

    const token = 'different-listener-test-bearer-token';
    const rotated = await bridge.start({ ...options, token });
    const url = `http://127.0.0.1:${rotated.port}`;
    const headers = { Authorization: `Bearer ${token}` };
    const matching = await post(url, { model: 'first/model', input: wrapped }, headers);
    expect(await matching.json()).toMatchObject({ output: wrapped });
    expect(firstHistory.at(-1)).toMatchObject({ input: output });

    const other = await post(url, { model: 'second/model', input: wrapped }, headers);
    expect(other.status).toBe(200);
    const { encrypted_content: _messageCiphertext, ...portableMessage } = message;
    const { encrypted_function_args: _callCiphertext, ...portableCall } = call;
    expect(secondHistory).toEqual([[portableMessage, portableCall]]);

    fallback = true;
    const converted = await post(url, { model: 'first/model', input: wrapped }, headers);
    expect(converted.status).toBe(200);
    expect(firstHistory.at(-1)).toMatchObject({ messages: [{ role: 'assistant', tool_calls: [{ id: 'test-call' }] }] });
    for (const detached of [
      { previous_response_id: 'resp_other', input: 'Continue' },
      { conversation: 'conv_other', input: 'Continue' },
      { input: [{ type: 'item_reference', id: 'item_other' }] },
    ]) {
      expect((await post(url, { model: 'second/model', ...detached }, headers)).status).toBe(400);
    }
    expect(secondHistory).toHaveLength(1);
  });
});
