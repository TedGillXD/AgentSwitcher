import { Readable } from 'node:stream';
import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron';

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/** Chromium networking honors the OS proxy. Redirects remain visible to the updater. */
export function createUpdateFetch(makeRequest: (options: ClientRequestConstructorOptions) => ClientRequest): typeof fetch {
  return async (input, init) => {
    const source = typeof input === 'string' || input instanceof URL ? undefined : input;
    const url = source ? source.url : String(input);
    const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) throw new TypeError('Update requests must use GET or HEAD');
    const signal = init?.signal ?? source?.signal;
    signal?.throwIfAborted();
    const redirectMode = init?.redirect ?? source?.redirect ?? 'error';
    if (redirectMode === 'follow') throw new TypeError('Update redirects must be checked explicitly');
    const headers = Object.fromEntries(new Headers(init?.headers ?? source?.headers));
    return new Promise<Response>((resolve, reject) => {
      const request = makeRequest({ url, method, headers, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      let settled = false;
      let body: Readable | undefined;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const fail = (error: unknown) => {
        if (!settled) { settled = true; reject(error); }
        body?.destroy(error instanceof Error ? error : new Error('Update request cancelled'));
        request.abort();
        cleanup();
      };
      const abort = () => fail(signal?.reason ?? new DOMException('Update request cancelled', 'AbortError'));
      // ClientRequest is a Writable: its close can precede the network response.
      // Keep handling network errors until the response body ends or is cancelled.
      request.on('error', fail);
      request.on('abort', () => {
        if (!settled) fail(new DOMException('Update request cancelled', 'AbortError'));
      });
      request.once('redirect', (status, _method, destination, values) => {
        if (redirectMode === 'error') { fail(new TypeError('Unexpected update redirect')); return; }
        try {
          const headers = responseHeaders(values);
          headers.set('location', destination);
          settled = true;
          resolve(new Response(null, { status, headers }));
        } catch (error) { settled = true; reject(error); }
        // Electron cancels manual redirects with an error unless aborted in this event.
        // The updater validates Location before making a fresh request to the CDN.
        cleanup();
        request.abort();
      });
      request.once('response', (message: IncomingMessage) => {
        try {
          // Electron's IncomingMessage extends Readable; its declarations omit those methods.
          body = message as unknown as Readable;
          // HEAD/empty responses have no Web reader to handle stream errors.
          body.on('error', cleanup);
          const noBody = method === 'HEAD' || [204, 205, 304].includes(message.statusCode);
          const stream = noBody ? null : Readable.toWeb(body, {
            strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
          }) as ReadableStream<Uint8Array>;
          const response = new Response(stream, { status: message.statusCode, headers: responseHeaders(message.headers) });
          body.once('end', cleanup);
          body.once('close', () => { cleanup(); if (!body?.readableEnded) request.abort(); });
          if (noBody) body.resume();
          settled = true;
          resolve(response);
        } catch (error) { fail(error instanceof Error ? error : new TypeError('Invalid update response')); }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else request.end();
    });
  };
}
