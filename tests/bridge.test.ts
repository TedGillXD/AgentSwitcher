import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBridge, type BridgeOptions } from '../electron/bridge';
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

async function proxy(baseUrl: string, overrides: Partial<BridgeOptions> = {}): Promise<{ bridge: LocalBridge; url: string }> {
  const bridge = new LocalBridge();
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
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(upstreams.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe('LocalBridge credential proxy', () => {
  it('preserves the requested Responses model and substitutes only the upstream credential', async () => {
    let received: { url?: string; headers?: IncomingMessage['headers']; body?: unknown } = {};
    const baseUrl = await upstream((request, response) => {
      void readBody(request).then((body) => {
        received = { url: request.url, headers: request.headers, body };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"id":"resp_test","output":[]}');
      });
    });
    const { url, bridge } = await proxy(baseUrl);
    const payload = {
      model: 'deepseek-v4-pro',
      input: [{ type: 'function_call_output', call_id: 'call_1', output: '42' }],
      tools: [{ type: 'custom', name: 'apply_patch' }],
      stream: false,
    };
    const result = await post(url, payload, { 'X-Codex-Account-ID': 'must-not-leave-the-computer' });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: 'resp_test', output: [] });
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
    const frames = 'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from(frames);
      response.write(bytes.subarray(0, bytes.length - 35));
      response.end(bytes.subarray(bytes.length - 35));
    });
    const { url } = await proxy(baseUrl);
    const result = await post(url, { input: 'hello', stream: true });
    expect(result.headers.get('content-type')).toBe('text/event-stream');
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
    expect(await result.text()).toBe(frames);
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

  it('rejects insecure remote URLs and embedded credentials, and can stop/rebind its original port', async () => {
    const bridge = new LocalBridge();
    bridges.push(bridge);
    const options = { token: proxyToken, apiKey: providerKey, model: 'deepseek-flash' };
    await expect(bridge.start({ ...options, baseUrl: 'http://provider.example' })).rejects.toThrow('HTTPS');
    await expect(bridge.start({ ...options, baseUrl: 'https://user:password@provider.example' })).rejects.toThrow('credentials');
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
