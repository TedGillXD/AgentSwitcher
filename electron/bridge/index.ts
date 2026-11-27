import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { ApiProtocol } from '../../shared/types';
import { availableDeepseekModels } from '../../shared/models';
import { normalizeProviderBaseUrl } from '../../shared/provider-url';
import { fromChatResponse, streamChatResponse, toChatRequest, type ChatRequest } from './chat-completions';
import { BridgeRequestError as RequestError } from './errors';
import { listenOnLoopback } from './listen';
import { prepareRoutedInput, wrapRoutedJson, wrapRoutedStream } from './response-provenance';

interface BridgeListenerOptions {
  port?: number;
  token: string;
  model: string;
  /** Bounds a provider request, including its streaming response. */
  timeoutMs?: number;
  /** Text and image requests are bounded before parsing. Defaults to 64 MiB. */
  maxRequestBytes?: number;
}

export interface SingleBridgeOptions extends BridgeListenerOptions {
  apiKey: string;
  baseUrl: string;
  /** Auto falls back only when the Responses route is explicitly unsupported. */
  protocol?: ApiProtocol;
  /** Exact model allowlist. Omitted only for legacy DeepSeek configurations. */
  models?: string[];
  routes?: never;
  continuationKey?: never;
}

export interface BridgeModelRoute {
  slug: string;
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  protocol: ApiProtocol;
}

export type BridgeOptions = SingleBridgeOptions | (BridgeListenerOptions & {
  routes: readonly BridgeModelRoute[];
  /** Secret persisted across listener token rotations so same-route history can resume. */
  continuationKey?: string;
  apiKey?: never;
  baseUrl?: never;
  protocol?: never;
  models?: never;
});

interface Upstream {
  base: URL;
  apiKey: string;
  protocol?: ApiProtocol;
}

interface BoundModelRoute extends Upstream {
  upstreamModel: string;
  responseKey?: Buffer;
}

interface ModelRoutes {
  bySlug: ReadonlyMap<string, BoundModelRoute>;
  localModels: boolean;
  unsupportedModel: string;
}

function bindUpstream(baseUrl: string, apiKey: string, protocol?: ApiProtocol): Upstream {
  const base = new URL(normalizeProviderBaseUrl(baseUrl));
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n\x00]/.test(apiKey)) {
    throw new Error('The local proxy credentials or model are invalid.');
  }
  if (protocol !== undefined && !['responses', 'chat_completions', 'auto'].includes(protocol)) {
    throw new Error('The local proxy protocol or model list is invalid.');
  }
  return { base, apiKey, protocol };
}

function bindModelRoutes(options: BridgeOptions): ModelRoutes {
  const bySlug = new Map<string, BoundModelRoute>();
  if (options.routes !== undefined) {
    const continuationKey = options.continuationKey ?? options.token;
    if (!Array.isArray(options.routes) || options.baseUrl !== undefined || options.apiKey !== undefined ||
      options.protocol !== undefined || options.models !== undefined || typeof continuationKey !== 'string' || continuationKey.length < 16) {
      throw new Error('The local proxy model routes are invalid.');
    }
    for (const route of options.routes) {
      if (!route || typeof route.slug !== 'string' || !route.slug.trim() || bySlug.has(route.slug) ||
        typeof route.upstreamModel !== 'string' || !route.upstreamModel.trim() || route.protocol === undefined) {
        throw new Error('The local proxy model routes are invalid.');
      }
      const upstream = bindUpstream(route.baseUrl, route.apiKey, route.protocol);
      const responseKey = createHmac('sha256', continuationKey)
        .update(JSON.stringify([route.slug, upstream.base.href, upstream.apiKey, route.upstreamModel, upstream.protocol]))
        .digest();
      bySlug.set(route.slug, { ...upstream, upstreamModel: route.upstreamModel, responseKey });
    }
    if (!bySlug.has(options.model)) throw new Error('The local proxy default model is not routed.');
    return { bySlug, localModels: true, unsupportedModel: 'This model is not enabled for the combined API connection. Select a configured model in Codex.' };
  }

  const { model, models } = options;
  if (models !== undefined && (!Array.isArray(models) || !models.includes(model) ||
    models.some((slug) => typeof slug !== 'string' || !slug.trim()))) {
    throw new Error('The local proxy protocol or model list is invalid.');
  }
  const upstream = bindUpstream(options.baseUrl, options.apiKey, options.protocol);
  for (const slug of models ?? availableDeepseekModels(model)) bySlug.set(slug, { ...upstream, upstreamModel: slug });
  const unsupportedModel = models
    ? 'This model is not enabled for this API connection. Select a configured model in Codex.'
    : 'This model is not enabled for this DeepSeek connection. Select a listed DeepSeek model in Codex.';
  return { bySlug, localModels: false, unsupportedModel };
}

function json(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify({ error: { message, type: 'agent_switcher_proxy_error' } }));
}

function authenticated(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

async function requestBody(request: IncomingMessage, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new RequestError(413, 'The request exceeds the local proxy size limit.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Do not use a throwing for-await loop: it destroys the socket before a 413
  // response can reach the caller.
  let rejectBody: ((reason?: unknown) => void) | undefined;
  const abort = (): void => {
    chunks.length = 0;
    rejectBody?.(new RequestError(504, 'The local proxy request timed out or was cancelled.'));
    request.resume();
  };
  const raw = await new Promise<Buffer>((resolve, reject) => {
    rejectBody = reject;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    request.on('data', (chunk: Buffer) => {
      if (signal.aborted) return;
      bytes += chunk.byteLength;
      if (bytes > limit) {
        chunks.length = 0;
        reject(new RequestError(413, 'The request exceeds the local proxy size limit.'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('aborted', () => reject(new RequestError(400, 'The request was interrupted.')));
    request.once('error', () => reject(new RequestError(400, 'The request could not be read.')));
  }).finally(() => signal.removeEventListener('abort', abort));
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestError(400, 'A JSON request object is required.');
  }
}

/**
 * A credential-only loopback proxy. Native Responses payloads pass through;
 * OpenAI-compatible Chat Completions endpoints use a stateless tool adapter.
 * The API key never enters Codex config, the renderer, logs, or response errors.
 */
export class LocalBridge {
  private server: Server | undefined;
  private controllers = new Set<AbortController>();

  isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  async start(options: BridgeOptions): Promise<{ port: number }> {
    if (typeof options.token !== 'string' || options.token.length < 16 || typeof options.model !== 'string' || !options.model.trim()) {
      throw new Error('The local proxy credentials or model are invalid.');
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
      throw new Error('The local proxy port is invalid.');
    }
    // Validate and snapshot before replacing an existing listener.
    const routes = bindModelRoutes(options);
    const listener = { port: options.port, token: options.token, model: options.model, timeoutMs: options.timeoutMs, maxRequestBytes: options.maxRequestBytes };
    await this.stop();
    let port = 0;
    const server = createServer((request, response) => {
      void this.handle(request, response, listener, routes, port);
    });
    server.maxConnections = 32;
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    try {
      port = await listenOnLoopback(server, listener.port ?? 0);
    } catch {
      server.close();
      throw new Error('The local proxy port is unavailable.');
    }
    this.server = server;
    return { port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse, options: BridgeListenerOptions, routes: ModelRoutes, port: number): Promise<void> {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Browsers must not be able to consume a locally stored credential, even
      // if a web page somehow discovers the proxy's port and bearer token.
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}`) {
        json(response, 403, 'Only local Codex requests are permitted.');
        request.resume();
        return;
      }
      if (!authenticated(request.headers.authorization, options.token)) {
        json(response, 401, 'The local proxy token is missing or invalid.');
        request.resume();
        return;
      }
      const route = request.url;
      if (route === '/health' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end('{"ok":true}');
        return;
      }
      const responses = route === '/v1/responses' || route === '/responses';
      const models = route === '/v1/models' || route === '/models';
      if (!responses && !models) {
        json(response, 404, 'This provider route is not supported by the local proxy.');
        request.resume();
        return;
      }
      if ((responses && request.method !== 'POST') || (models && request.method !== 'GET')) {
        json(response, 405, 'This HTTP method is not permitted.');
        request.resume();
        return;
      }
      if (models && routes.localModels) {
        const data = [...routes.bySlug.keys()].map((id) => ({ id, object: 'model', created: 0, owned_by: 'agent-switcher' }));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(JSON.stringify({ object: 'list', data }));
        return;
      }
      if (this.controllers.size >= 8) {
        json(response, 429, 'The local proxy is busy. Try again shortly.');
        request.resume();
        return;
      }
      controller = new AbortController();
      this.controllers.add(controller);
      const abort = (): void => controller?.abort();
      request.once('aborted', abort);
      response.once('close', () => { if (!response.writableFinished) abort(); });
      timer = setTimeout(abort, options.timeoutMs ?? 300_000);
      timer.unref();
      let input: Record<string, unknown> | undefined;
      if (responses) {
        if ((request.headers['content-type'] ?? '').toLowerCase().split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) {
          throw new RequestError(415, 'An uncompressed application/json request is required.');
        }
        input = await requestBody(request, options.maxRequestBytes ?? 64 * 1024 * 1024, controller.signal);
      }
      const slug = input?.model === undefined && !routes.localModels ? options.model : input?.model;
      if (typeof slug !== 'string') throw new RequestError(400, routes.unsupportedModel);
      const provider = routes.bySlug.get(slug);
      if (!provider) throw new RequestError(400, routes.unsupportedModel);
      const { base, apiKey, protocol, upstreamModel, responseKey } = provider;
      const toChat = (payload: Record<string, unknown>): ChatRequest =>
        toChatRequest(responseKey ? prepareRoutedInput(payload) : payload, upstreamModel, slug);
      const signal = controller.signal;
      const send = async (route: string, payload: string | undefined): Promise<Response> => {
        const target = new URL(base);
        target.pathname = `${target.pathname.replace(/\/$/, '')}/${route}`;
        return fetch(target, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json, text/event-stream',
            ...(payload ? { 'Content-Type': 'application/json' } : {}),
          },
          body: payload,
          redirect: 'error',
          signal,
        });
      };
      let chat: ChatRequest | undefined;
      if (protocol === 'chat_completions' && input) chat = toChat(input);
      const payload = chat?.body ?? (input && { ...(responseKey ? prepareRoutedInput(input, responseKey) : input), model: upstreamModel });
      let upstream = await send(models ? 'models' : chat ? 'chat/completions' : 'responses', payload && JSON.stringify(payload));
      // A transport failure, authentication error, rate limit, or server error
      // may follow a charged inference. Never retry those against another API.
      if (protocol === 'auto' && [404, 405, 501].includes(upstream.status) && input) {
        await upstream.body?.cancel();
        chat = toChat(input);
        upstream = await send('chat/completions', JSON.stringify(chat.body));
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const message = upstream.status === 401 || upstream.status === 403
          ? 'The provider rejected the API key. Check the saved key and its permissions.'
          : upstream.status === 429
            ? 'The provider rate limit was reached. Try again later.'
            : `The provider returned HTTP ${upstream.status}.`;
        json(response, upstream.status, message);
        return;
      }
      if (!upstream.body) throw new RequestError(502, 'The provider returned an empty response.');
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!contentType.startsWith('application/json') && !contentType.startsWith('text/event-stream')) {
        await upstream.body.cancel();
        throw new RequestError(502, 'The provider returned an unsupported response format.');
      }
      if (chat) {
        if (chat.body.stream === true) {
          if (!contentType.startsWith('text/event-stream')) {
            await upstream.body.cancel();
            throw new RequestError(502, 'The provider did not return the requested Chat Completions stream.');
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          response.flushHeaders();
          await streamChatResponse(upstream.body, chat, response, signal);
        } else {
          if (!contentType.startsWith('application/json')) {
            await upstream.body.cancel();
            throw new RequestError(502, 'The provider did not return the requested Chat Completions JSON.');
          }
          let value: unknown;
          try { value = await upstream.json(); } catch (error) {
            if (signal.aborted) throw error;
            throw new RequestError(502, 'The provider returned invalid JSON.');
          }
          const converted = fromChatResponse(value, chat);
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          response.end(JSON.stringify(converted));
        }
        return;
      }
      if (responseKey && contentType.startsWith('application/json')) {
        const payload = await wrapRoutedJson(upstream.body, responseKey);
        response.writeHead(upstream.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(payload);
        return;
      }
      response.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders();
      const stream = responseKey
        ? Readable.from(wrapRoutedStream(upstream.body, responseKey))
        : Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>);
      await pipeline(stream, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else if (error instanceof RequestError) {
        json(response, error.status, error.message);
      } else if (controller?.signal.aborted) {
        json(response, 504, 'The provider request timed out or was cancelled.');
      } else {
        json(response, 502, 'The provider could not be reached. Check its URL and your network connection.');
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) this.controllers.delete(controller);
    }
  }
}
