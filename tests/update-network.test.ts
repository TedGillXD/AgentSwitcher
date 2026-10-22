import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateFetch } from '../electron/update-network';

function requestFixture() {
  const events = new EventEmitter();
  const abort = vi.fn(() => { events.emit('abort'); events.emit('close'); });
  const end = vi.fn();
  const request = Object.assign(events, { abort, end }) as unknown as ClientRequest;
  const makeRequest = vi.fn((_options: ClientRequestConstructorOptions) => request);
  return { events, request, makeRequest, abort, end, fetcher: createUpdateFetch(makeRequest) };
}

describe('Chromium update transport', () => {
  it('keeps receiving headers and supports stream cancellation after Electron closes its writable request', async () => {
    const f = requestFixture();
    const body = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/octet-stream' } });
    f.end.mockImplementation(() => {
      // Electron's Writable finishes its upload and closes before the response.
      f.events.emit('close');
      queueMicrotask(() => { f.events.emit('response', body); body.write(Buffer.from('first response chunk')); });
    });
    const controller = new AbortController();
    const response = await f.fetcher('https://github.com/fixture', { redirect: 'manual', signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.abort).toHaveBeenCalled();
    expect(f.makeRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/fixture', redirect: 'manual', credentials: 'omit', cache: 'no-store',
    }));
  });

  it('returns a redirect for updater validation and cancels the original transaction synchronously', async () => {
    const f = requestFixture();
    let abortedInRedirect = false;
    f.end.mockImplementation(() => {
      f.events.emit('close');
      queueMicrotask(() => {
        f.events.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/fixture', {});
        abortedInRedirect = f.abort.mock.calls.length > 0;
      });
    });
    const response = await f.fetcher('https://github.com/fixture', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://release-assets.githubusercontent.com/fixture');
    expect(abortedInRedirect).toBe(true);
  });

  it('rejects automatic redirects before issuing any request', async () => {
    const f = requestFixture();
    await expect(f.fetcher('https://github.com/fixture', { redirect: 'follow' })).rejects.toThrow('checked explicitly');
    expect(f.makeRequest).not.toHaveBeenCalled();
  });
});
