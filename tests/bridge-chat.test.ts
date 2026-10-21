import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBridge, type BridgeOptions } from '../electron/bridge';
import { listenOnLoopback } from '../electron/bridge/listen';

const apiKey = 'sk-provider-credential-not-for-codex';
const token = 'local-proxy-credential-only';
const servers: Server[] = [];
const bridges: LocalBridge[] = [];

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  const port = await listenOnLoopback(server);
  return `http://127.0.0.1:${port}/provider/v1`;
}

async function proxy(baseUrl: string, overrides: Partial<BridgeOptions> = {}): Promise<string> {
  const bridge = new LocalBridge();
  bridges.push(bridge);
  const { port } = await bridge.start({ apiKey, token, baseUrl, model: 'custom-code', models: ['custom-code', 'custom-fast'], protocol: 'chat_completions', ...overrides });
  return `http://127.0.0.1:${port}`;
}

async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function reply(response: ServerResponse, message: Record<string, unknown> = { content: 'Hello' }, finish = 'stop'): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'chatcmpl-upstream', choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } } }));
}

function sse(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
}

function events(text: string): Record<string, unknown>[] {
  return text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});

describe('generic provider Chat Completions bridge', () => {
  it('rebinds an auto-assigned Fetch-blocked port before returning a usable listener', async () => {
    const server = createServer((_request, response) => response.end('ready'));
    servers.push(server);
    const address = vi.spyOn(server, 'address').mockReturnValueOnce({ address: '127.0.0.1', family: 'IPv4', port: 6000 });
    const port = await listenOnLoopback(server);
    expect(address.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(port).not.toBe(6000);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ready');
    address.mockRestore();
  });

  it('converts instructions, full history, images, controls and response usage without forwarding local credentials', async () => {
    let received: Record<string, unknown> = {};
    const baseUrl = await upstream(async (request, response) => {
      expect(request.url).toBe('/provider/v1/chat/completions');
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
      expect(request.headers['x-codex-account-id']).toBeUndefined();
      received = await read(request);
      reply(response, { content: '你好' });
    });
    const url = await proxy(baseUrl);
    const response = await post(url, {
      model: 'custom-fast', instructions: 'Be helpful', stream: false, max_output_tokens: 123, temperature: 0.5,
      input: [{ role: 'developer', content: [{ type: 'input_text', text: 'Project rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Explain' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' }] }],
    });
    expect(response.status).toBe(200);
    expect(received).toMatchObject({ model: 'custom-fast', stream: false, max_tokens: 123, temperature: 0.5, messages: [
      { role: 'system', content: 'Be helpful' }, { role: 'system', content: [{ type: 'text', text: 'Project rules' }] },
      { role: 'user', content: [{ type: 'text', text: 'Explain' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] },
    ] });
    const result = await response.json();
    expect(result).toMatchObject({ object: 'response', status: 'completed', model: 'custom-fast', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(received)).not.toContain(token);
  });

  it('performs function and custom apply_patch tool round trips with namespaced tools and reasoning', async () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch';
    const tools = [{ type: 'namespace', name: 'functions', description: 'Project tools', tools: [
      { type: 'function', name: 'shell_command', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
    ] }];
    let round = 0;
    const baseUrl = await upstream(async (request, response) => {
      const input = await read(request);
      const supplied = input.tools as { function: { name: string; parameters: unknown } }[];
      expect(supplied.map((tool) => tool.function.name)).toEqual(['functions__shell_command', 'functions__apply_patch']);
      expect(supplied[1]?.function.parameters).toMatchObject({ required: ['input'], properties: { input: { type: 'string', description: expect.stringContaining('start: /.+/') } } });
      if (round++ === 0) reply(response, { content: null, reasoning_content: 'Need to inspect and patch', tool_calls: [
        { id: 'call-shell', type: 'function', function: { name: 'functions__shell_command', arguments: '{"command":"pwd"}' } },
        { id: 'call-patch', type: 'function', function: { name: 'functions__apply_patch', arguments: JSON.stringify({ input: patch }) } },
      ] }, 'tool_calls');
      else {
        expect(input.messages).toEqual([
          { role: 'user', content: 'Edit the project' },
          { role: 'assistant', content: null, reasoning_content: 'Need to inspect and patch', tool_calls: [
            { id: 'call-shell', type: 'function', function: { name: 'functions__shell_command', arguments: '{"command":"pwd"}' } },
            { id: 'call-patch', type: 'function', function: { name: 'functions__apply_patch', arguments: JSON.stringify({ input: patch }) } },
          ] },
          { role: 'tool', tool_call_id: 'call-shell', content: 'D:/project' },
          { role: 'tool', tool_call_id: 'call-patch', content: 'Applied successfully' },
        ]);
        reply(response, { content: 'Edited' });
      }
    });
    const url = await proxy(baseUrl);
    const first = await (await post(url, { input: 'Edit the project', tools, stream: false })).json();
    expect(first.output).toMatchObject([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need to inspect and patch' }] },
      { type: 'function_call', call_id: 'call-shell', namespace: 'functions', name: 'shell_command', arguments: '{"command":"pwd"}' },
      { type: 'custom_tool_call', call_id: 'call-patch', namespace: 'functions', name: 'apply_patch', input: patch },
    ]);
    const second = await post(url, { input: [
      { role: 'user', content: 'Edit the project' }, ...first.output,
      { type: 'function_call_output', call_id: 'call-shell', output: 'D:/project' },
      { type: 'custom_tool_call_output', call_id: 'call-patch', output: [{ type: 'input_text', text: 'Applied successfully' }] },
    ], tools, stream: false });
    expect(second.status).toBe(200);
    expect((await second.json()).output[0].content[0].text).toBe('Edited');
    expect(round).toBe(2);
  });

  it('converts split UTF-8 SSE into sequential Responses text and reasoning events', async () => {
    const baseUrl = await upstream(async (request, response) => {
      expect(await read(request)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const raw = Buffer.from(sse({ reasoning_content: '思考' }) + sse({ content: '你' }) + sse({ content: '好' }, 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\r\n\r\ndata: [DONE]\r\n\r\n`);
      for (let offset = 0; offset < raw.length; offset += 7) response.write(raw.subarray(offset, offset + 7));
      response.end();
    });
    const response = await post(await proxy(baseUrl), { input: 'hello', stream: true });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const result = events(await response.text());
    expect(result.map((event) => event.sequence_number)).toEqual(result.map((_, index) => index));
    expect(result.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['你', '好']);
    expect(result.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'reasoning', summary: [{ text: '思考' }] }, { type: 'message', content: [{ text: '你好' }] },
    ], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } });
    expect(result.some((event) => event.type === 'response.content_part.done')).toBe(true);
    expect(result.some((event) => event.type === 'response.reasoning_summary_text.done')).toBe(true);
  });

  it('streams parallel function arguments and restores custom tool input without JSON wrapper', async () => {
    const patch = '*** Begin Patch\n*** End Patch';
    const encoded = JSON.stringify({ input: patch });
    const baseUrl = await upstream(async (request, response) => {
      await read(request);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse({ tool_calls: [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'shell', arguments: '{"cmd":' } },
        { index: 1, id: 'call-b', type: 'function', function: { name: 'apply_patch', arguments: encoded.slice(0, 10) } },
      ] }));
      response.write(sse({ tool_calls: [{ index: 1, function: { arguments: encoded.slice(10) } }, { index: 0, function: { arguments: '"pwd"}' } }] }));
      response.end(sse({}, 'tool_calls') + 'data: [DONE]\n\n');
    });
    const response = await post(await proxy(baseUrl), { input: 'edit', stream: true, tools: [{ type: 'function', name: 'shell', parameters: {} }, { type: 'custom', name: 'apply_patch' }] });
    const result = events(await response.text());
    expect(result.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => event.delta).join('')).toBe('{"cmd":"pwd"}');
    expect(result.find((event) => event.type === 'response.custom_tool_call_input.done')).toMatchObject({ input: patch, output_index: 1 });
    expect(result.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [
      { type: 'function_call', call_id: 'call-a', name: 'shell', arguments: '{"cmd":"pwd"}' },
      { type: 'custom_tool_call', call_id: 'call-b', name: 'apply_patch', input: patch },
    ] } });
    const added = result.filter((event) => event.type === 'response.output_item.added');
    const done = result.filter((event) => event.type === 'response.output_item.done');
    expect(added.map((event) => (event.item as { id: string }).id)).toEqual(done.map((event) => (event.item as { id: string }).id));
  });

  it.each(['length', 'content_filter'])('reports %s as incomplete, not a successful generation', async (finish) => {
    const baseUrl = await upstream((_request, response) => reply(response, { content: 'partial' }, finish));
    const result = await (await post(await proxy(baseUrl), { input: 'hello' })).json();
    expect(result.status).toBe('incomplete');
    expect(result.incomplete_details.reason).toBe(finish === 'length' ? 'max_output_tokens' : 'content_filter');
  });

  it.each([
    { previous_response_id: 'resp-stored', input: 'continue' },
    { input: 'search', tools: [{ type: 'web_search' }] },
    { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }] },
    { input: [{ type: 'item_reference', id: 'item-1' }] },
    { input: 'hello', conversation: 'conv-1' },
    { input: 'hello', background: true },
  ])('rejects unsupported context explicitly before any provider request: %j', async (body) => {
    let calls = 0;
    const baseUrl = await upstream((_request, response) => { calls++; reply(response); });
    const response = await post(await proxy(baseUrl), body);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('native Responses');
    expect(calls).toBe(0);
  });

  it('rejects provider tool calls that were not declared and never exposes a provider error body', async () => {
    const baseUrl = await upstream((_request, response) => reply(response, { content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: apiKey, arguments: '{}' } }] }, 'tool_calls'));
    const response = await post(await proxy(baseUrl), { input: 'hello' });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(apiKey);
  });

  it('rejects invalid JSON custom-tool wrappers rather than executing corrupted freeform input', async () => {
    const baseUrl = await upstream((_request, response) => reply(response, { content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'apply_patch', arguments: 'raw patch without JSON wrapper' } }] }, 'tool_calls'));
    const response = await post(await proxy(baseUrl), { input: 'edit', tools: [{ type: 'custom', name: 'apply_patch' }] });
    expect(response.status).toBe(502);
  });

  it('never emits completed after a truncated Chat stream', async () => {
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse({ content: 'unfinished' }));
    });
    const response = await post(await proxy(baseUrl), { input: 'hello', stream: true });
    const result = events(await response.text());
    expect(result.at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_chat_response' } } });
    expect(result.some((event) => event.type === 'response.completed')).toBe(false);
  });

  it('converts a provider SSE error into a sanitized Responses failure', async () => {
    const baseUrl = await upstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ error: { message: apiKey } })}\n\n`);
    });
    const response = await post(await proxy(baseUrl), { input: 'hello', stream: true });
    const text = await response.text();
    expect(text).not.toContain(apiKey);
    expect(events(text).at(-1)).toMatchObject({ type: 'response.failed', response: { status: 'failed' } });
  });

  it('aborts the provider stream when its local client disconnects', async () => {
    let providerClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { providerClosed = resolve; });
    const baseUrl = await upstream(async (request, response) => {
      await read(request);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse({ content: 'working' }));
      response.once('close', () => providerClosed?.());
    });
    const controller = new AbortController();
    const url = await proxy(baseUrl);
    const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'hello', stream: true }), signal: controller.signal });
    await response.body?.getReader().read();
    controller.abort();
    await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Provider stream was not cancelled')), 1500))]);
  });

  it('uses an exact per-profile allowlist and independent upstream credentials', async () => {
    const received: string[] = [];
    const baseUrl = await upstream(async (request, response) => {
      received.push(`${request.headers.authorization}:${(await read(request)).model}`);
      reply(response);
    });
    const a = await proxy(baseUrl, { apiKey: 'key-one', model: 'model-a', models: ['model-a'] });
    const b = await proxy(baseUrl, { apiKey: 'key-two', model: 'model-b', models: ['model-b'] });
    expect((await post(a, { input: 'hello', model: 'deepseek-flash' })).status).toBe(400);
    expect((await post(a, { input: 'hello', model: 'model-b' })).status).toBe(400);
    expect((await post(a, { input: 'hello' })).status).toBe(200);
    expect((await post(b, { input: 'hello' })).status).toBe(200);
    expect(received).toEqual(['Bearer key-one:model-a', 'Bearer key-two:model-b']);
  });

  it('keeps /models transparent for Chat Completions connections', async () => {
    const baseUrl = await upstream((request, response) => {
      expect(request.url).toBe('/provider/v1/models');
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"data":[{"id":"discovered-model"}]}');
    });
    const response = await fetch(`${await proxy(baseUrl)}/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toEqual({ data: [{ id: 'discovered-model' }] });
  });

  it.each([404, 405, 501])('auto falls back only after an explicitly unsupported Responses route (%i)', async (status) => {
    const routes: string[] = [];
    const baseUrl = await upstream(async (request, response) => {
      routes.push(request.url ?? '');
      const body = await read(request);
      expect(body.model).toBe('custom-fast');
      if (request.url?.endsWith('/responses')) { expect(body.input).toBe('hello'); response.writeHead(status); response.end('unsupported'); }
      else { expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]); reply(response); }
    });
    const response = await post(await proxy(baseUrl, { protocol: 'auto' }), { input: 'hello', model: 'custom-fast' });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('completed');
    expect(routes).toEqual(['/provider/v1/responses', '/provider/v1/chat/completions']);
  });

  it.each([400, 401, 403, 429, 500, 502, 503])('auto never retries ambiguous, authentication or rate-limit failures (%i)', async (status) => {
    let calls = 0;
    const baseUrl = await upstream(async (request, response) => { await read(request); calls++; response.writeHead(status); response.end(apiKey); });
    const response = await post(await proxy(baseUrl, { protocol: 'auto' }), { input: 'hello' });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(apiKey);
    expect(calls).toBe(1);
  });

  it('auto never retries an ambiguous disconnected request', async () => {
    let calls = 0;
    const baseUrl = await upstream(async (request) => { await read(request); calls++; request.socket.destroy(); });
    const response = await post(await proxy(baseUrl, { protocol: 'auto' }), { input: 'hello' });
    expect(response.status).toBe(502);
    expect(calls).toBe(1);
  });

  it('auto retains native Responses bodies and event bytes when supported', async () => {
    const native = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"native-id","status":"completed"}}\n\n';
    const baseUrl = await upstream(async (request, response) => {
      expect(request.url).toBe('/provider/v1/responses');
      expect(await read(request)).toMatchObject({ input: 'hello', tools: [{ type: 'web_search' }] });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(native);
    });
    const response = await post(await proxy(baseUrl, { protocol: 'auto' }), { input: 'hello', tools: [{ type: 'web_search' }], stream: true });
    expect(await response.text()).toBe(native);
  });
});
