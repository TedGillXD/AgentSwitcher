import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { availableDeepseekModels } from '../../shared/models';
import { fromChatResponse, streamChatResponse, toChatRequest, type ChatRequest } from './chat-completions';
import { BridgeRequestError as RequestError } from './errors';
import { listenOnLoopback } from './listen';

export interface BridgeOptions {
  port?: number;
  token: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Auto falls back only when the Responses route is explicitly unsupported. */
  protocol?: 'responses' | 'chat_completions' | 'auto';
  /** Exact model allowlist. Omitted only for legacy DeepSeek configurations. */
  models?: string[];
  /** Bounds a provider request, including its streaming response. */
  timeoutMs?: number;
  /** Text and image requests are bounded before parsing. Defaults to 64 MiB. */
  maxRequestBytes?: number;
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
    const base = new URL(options.baseUrl);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password || base.search || base.hash) {
      throw new Error('The provider URL must use HTTPS, or HTTP on localhost, without embedded credentials.');
    }
    if (!options.apiKey || options.apiKey.includes('\r') || options.apiKey.includes('\n') || options.token.length < 16 || !options.model) {
      throw new Error('The local proxy credentials or model are invalid.');
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
      throw new Error('The local proxy port is invalid.');
    }
    if ((options.protocol !== undefined && !['responses', 'chat_completions', 'auto'].includes(options.protocol)) ||
        (options.models !== undefined && (!Array.isArray(options.models) || !options.models.length ||
          options.models.some((model) => typeof model !== 'string' || !model.trim()) || !options.models.includes(options.model)))) {
      throw new Error('The local proxy protocol or model list is invalid.');
    }
    // Snapshot configuration so a caller cannot change credentials or the
    // allowlist of a running listener by mutating its original options object.
    options = { ...options, ...(options.models ? { models: [...options.models] } : {}) };
    await this.stop();
    let port = 0;
    const server = createServer((request, response) => {
      void this.handle(request, response, options, base, port);
    });
    server.maxConnections = 32;
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    try {
      port = await listenOnLoopback(server, options.port ?? 0);
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

  private async handle(request: IncomingMessage, response: ServerResponse, options: BridgeOptions, base: URL, port: number): Promise<void> {
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
      let body: string | undefined;
      let input: Record<string, unknown> | undefined;
      if (responses) {
        if ((request.headers['content-type'] ?? '').toLowerCase().split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) {
          throw new RequestError(415, 'An uncompressed application/json request is required.');
        }
        input = await requestBody(request, options.maxRequestBytes ?? 64 * 1024 * 1024, controller.signal);
        const model = input.model === undefined ? options.model : input.model;
        if (typeof model !== 'string' || !(options.models ?? availableDeepseekModels(options.model)).includes(model)) {
          throw new RequestError(400, options.models
            ? 'This model is not enabled for this API connection. Select a configured model in Codex.'
            : 'This model is not enabled for this DeepSeek connection. Select a listed DeepSeek model in Codex.');
        }
        input = { ...input, model };
        body = JSON.stringify({ ...input, model });
      }
      const signal = controller.signal;
      const send = async (route: string, payload: string | undefined): Promise<Response> => {
        const target = new URL(base);
        target.pathname = `${target.pathname.replace(/\/$/, '')}/${route}`;
        return fetch(target, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: 'application/json, text/event-stream',
            ...(payload ? { 'Content-Type': 'application/json' } : {}),
          },
          body: payload,
          redirect: 'error',
          signal,
        });
      };
      let chat: ChatRequest | undefined;
      if (responses && options.protocol === 'chat_completions' && input) chat = toChatRequest(input, String(input.model));
      let upstream = await send(models ? 'models' : chat ? 'chat/completions' : 'responses', chat ? JSON.stringify(chat.body) : body);
      // A transport failure, authentication error, rate limit, or server error
      // may follow a charged inference. Never retry those against another API.
      if (responses && options.protocol === 'auto' && [404, 405, 501].includes(upstream.status) && input) {
        await upstream.body?.cancel();
        chat = toChatRequest(input, String(input.model));
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
      response.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>), response);
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
