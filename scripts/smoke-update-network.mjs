// Chromium transport through a disposable HTTP proxy; no external requests or app installs.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directory = await mkdtemp(join(tmpdir(), 'agent-switcher-network-'));
const requests = [];
let streamClosed = false;
let application;
const proxy = createServer((request, response) => {
  const url = new URL(request.url);
  requests.push(url.pathname);
  if (url.hostname !== 'update-fixture.invalid') { response.writeHead(502); response.end(); return; }
  if (url.pathname === '/metadata') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ from: 'disposable-proxy' }));
  } else if (url.pathname === '/redirect') {
    response.writeHead(302, { Location: 'http://update-fixture.invalid/target' }); response.end();
  } else if (url.pathname === '/target') response.end('manual redirect destination');
  else if (url.pathname === '/stream') {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.flushHeaders();
    const timer = setInterval(() => response.write(Buffer.alloc(8192, 65)), 10);
    response.once('close', () => { streamClosed = true; clearInterval(timer); });
  } else { response.writeHead(404); response.end(); }
});
proxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const deadline = setTimeout(() => {
  console.error('Update transport smoke exceeded its one minute deadline.');
  if (application?.process().exitCode === null) application.process().kill('SIGKILL');
}, 60000);
deadline.unref();
try {
  const userData = join(directory, 'isolated-user-data');
  await mkdir(userData);
  const source = await readFile(resolve('electron/update-network.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modulePath = join(directory, 'update-network.mjs');
  await writeFile(modulePath, compiled);
  const helper = join(directory, 'network-helper.cjs');
  await writeFile(helper, `const {app,net}=require('electron');
app.setName('AgentSwitcher Network Test');
app.setPath('userData', ${JSON.stringify(userData)});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const {createUpdateFetch}=await import(${JSON.stringify(pathToFileURL(modulePath).href)});
 globalThis.__updateTransport=createUpdateFetch(options=>net.request(options));
 globalThis.__updateTransportReady=true;
});\n`);
  await new Promise((resolveListen, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolveListen); });
  const proxyAddress = `127.0.0.1:${proxy.address().port}`;
  application = await electron.launch({ args: [helper], env: environment, timeout: 30000 });
  await expect.poll(() => application.evaluate(() => Boolean(globalThis.__updateTransportReady))).toBe(true);
  const resolved = await application.evaluate(async ({ session }, address) => {
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http://${address}` });
    return session.defaultSession.resolveProxy('http://update-fixture.invalid/metadata');
  }, proxyAddress);
  expect(resolved).toBe(`PROXY ${proxyAddress}`);
  const metadata = await application.evaluate(async () => {
    const response = await globalThis.__updateTransport('http://update-fixture.invalid/metadata', { redirect: 'error' });
    return { status: response.status, data: await response.json() };
  });
  expect(metadata).toEqual({ status: 200, data: { from: 'disposable-proxy' } });
  const redirect = await application.evaluate(async () => {
    const response = await globalThis.__updateTransport('http://update-fixture.invalid/redirect', { redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location'), body: await response.text() };
  });
  expect(redirect).toEqual({ status: 302, location: 'http://update-fixture.invalid/target', body: '' });
  expect(requests).not.toContain('/target');
  const redirectRejected = await application.evaluate(async () => {
    try { await globalThis.__updateTransport('http://update-fixture.invalid/redirect', { redirect: 'error' }); return false; }
    catch { return true; }
  });
  expect(redirectRejected).toBe(true);
  expect(requests).not.toContain('/target');
  const received = requests.length;
  const preAbort = await application.evaluate(async () => {
    const controller = new AbortController(); controller.abort();
    try { await globalThis.__updateTransport('http://update-fixture.invalid/pre-abort', { signal: controller.signal, redirect: 'manual' }); return false; }
    catch (error) { return error.name === 'AbortError'; }
  });
  expect(preAbort).toBe(true);
  expect(requests).toHaveLength(received);
  const abortedStream = await application.evaluate(async () => {
    const controller = new AbortController();
    const response = await globalThis.__updateTransport('http://update-fixture.invalid/stream', { redirect: 'manual', signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    controller.abort();
    const result = await Promise.race([
      (async () => { try { while (!(await reader.read()).done) {} return false; } catch { return true; } })(),
      new Promise(resolveTimeout => setTimeout(() => resolveTimeout(false), 5000)),
    ]);
    return !first.done && first.value.length > 0 && result;
  });
  expect(abortedStream).toBe(true);
  await expect.poll(() => streamClosed).toBe(true);
  console.log('Update transport smoke passed: session proxy, streamed response, visible manual redirects, rejected redirects, pre-abort and stream cancellation.');
} finally {
  clearTimeout(deadline);
  if (application) {
    const closing = application;
    const timeout = setTimeout(() => { if (closing.process().exitCode === null) closing.process().kill('SIGKILL'); }, 5000);
    try { await closing.close(); } finally { clearTimeout(timeout); }
  }
  await new Promise(resolveClose => { proxy.close(resolveClose); proxy.closeAllConnections(); });
  const absolute = resolve(directory);
  if (!absolute.startsWith(`${resolve(tmpdir())}${sep}`) || !basename(absolute).startsWith('agent-switcher-network-')) throw new Error('Unsafe fixture cleanup path');
  await rm(absolute, { recursive: true, force: true });
}
