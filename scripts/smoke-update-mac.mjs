// End-to-end update of disposable app copies. Never installs into /Applications,
// touches the real user profile, or contacts a provider/GitHub release endpoint.
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') {
  console.log('macOS update smoke skipped on this platform.');
  process.exit(0);
}
const run = promisify(execFile);
// Use electron-builder's own archive dependency when preparing a future fixture.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
const sourceExecutable = process.env.AGENT_SWITCHER_EXECUTABLE;
if (!sourceExecutable) throw new Error('Set AGENT_SWITCHER_EXECUTABLE to the packaged macOS app executable.');
const sourceApp = dirname(dirname(dirname(resolve(sourceExecutable))));
if (!sourceApp.endsWith('.app')) throw new Error('Expected an app bundle executable.');
const sourceVersion = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(sourceApp, 'Contents/Info.plist')])).stdout.trim();
const futureVersion = sourceVersion.replace(/\d+$/, patch => String(Number(patch) + 1));
const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-switcher-update-smoke-')));
const installedApp = join(directory, 'Installed Folder With Spaces', 'AgentSwitcher.app');
const installedExecutable = join(installedApp, 'Contents/MacOS/AgentSwitcher');
const futureApp = join(directory, 'future', 'AgentSwitcher.app');
const userData = join(directory, 'User Profile With Spaces');
const codexHome = join(directory, 'codex');
let application;
let child;
let server;
let oldExited = false;
let stage = 'prepare disposable bundles';
let appOutput = '';
function advance(value) { stage = value; console.log(`Update smoke: ${stage}`); }
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function fixtureProcesses() {
  const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'pid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && match[2] === installedExecutable ? [Number(match[1])] : [];
  });
}
try {
  await mkdir(dirname(installedApp), { recursive: true });
  await mkdir(dirname(futureApp), { recursive: true });
  await mkdir(userData); await mkdir(codexHome);
  await run('/usr/bin/ditto', [sourceApp, installedApp]);
  await run('/usr/bin/ditto', [sourceApp, futureApp]);
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    await run('/usr/bin/plutil', ['-replace', key, '-string', futureVersion, join(futureApp, 'Contents/Info.plist')]);
  }
  // Electron reads the runtime version from package.json before Info.plist.
  const futureArchive = join(futureApp, 'Contents/Resources/app.asar');
  const unpacked = join(directory, 'fixture-source');
  asar.extractAll(futureArchive, unpacked);
  const metadata = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
  metadata.version = futureVersion;
  await writeFile(join(unpacked, 'package.json'), JSON.stringify(metadata));
  await rm(futureArchive);
  asar.uncacheAll();
  await asar.createPackage(unpacked, futureArchive);
  const integrity = createHash('sha256').update(asar.getRawHeader(futureArchive).headerString).digest('hex');
  await run('/usr/bin/plutil', ['-replace', 'ElectronAsarIntegrity.Resources/app\\.asar.hash', '-string', integrity, join(futureApp, 'Contents/Info.plist')]);
  await rm(unpacked, { recursive: true });
  const sourceEntitlements = (await run('/usr/bin/codesign', ['--display', '--entitlements', '-', sourceApp])).stdout;
  await run('/usr/bin/codesign', ['--force', '--deep', '--preserve-metadata=entitlements,flags', '--sign', '-', futureApp]);
  expect((await run('/usr/bin/codesign', ['--display', '--entitlements', '-', futureApp])).stdout).toBe(sourceEntitlements);
  const rendererBundle = 'Contents/Frameworks/AgentSwitcher Helper (Renderer).app';
  expect((await run('/usr/bin/codesign', ['--display', '--entitlements', '-', join(futureApp, rendererBundle)])).stdout)
    .toBe((await run('/usr/bin/codesign', ['--display', '--entitlements', '-', join(sourceApp, rendererBundle)])).stdout);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', futureApp]);
  const asset = `AgentSwitcher-${futureVersion}-mac-${process.arch}.zip`;
  const archive = join(directory, asset);
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', futureApp, archive]);
  const hash = await digest(archive);
  const size = (await stat(archive)).size;
  if (process.env.AGENT_SWITCHER_KEEP_UPDATE_FIXTURE) {
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/update-fixture-debug.json', JSON.stringify({ directory, installedExecutable, userData, archive, hash, asset, sourceVersion, futureVersion }));
  }
  const checksums = `${hash}  ${asset}\n`;
  const base = `https://github.com/TedGillXD/AgentSwitcher/releases/download/v${futureVersion}/`;
  const release = {
    tag_name: `v${futureVersion}`, draft: false, prerelease: false,
    html_url: `https://github.com/TedGillXD/AgentSwitcher/releases/tag/v${futureVersion}`,
    published_at: new Date().toISOString(), body: 'Disposable end-to-end update fixture.',
    assets: [
      { name: asset, size, browser_download_url: base + asset, digest: `sha256:${hash}` },
      { name: 'SHA256SUMS.txt', size: Buffer.byteLength(checksums), browser_download_url: base + 'SHA256SUMS.txt' },
    ],
  };
  server = createServer((request, response) => {
    if (request.url === '/latest') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(release)); }
    else if (request.url === '/checksums') response.end(checksums);
    else if (request.url === '/installer') { response.setHeader('Content-Length', size); createReadStream(archive).pipe(response); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const local = `http://127.0.0.1:${server.address().port}`;
  const settings = JSON.stringify({ version: 1, lastSwitchedAt: null, settings: {
    language: 'en', codexHome, codexAppPath: join(directory, 'not-installed/Codex.app'),
    deepseekBaseUrl: 'https://api.deepseek.com', deepseekModel: 'deepseek-flash', launchAtLogin: false, hideOnBlur: false,
  } });
  await writeFile(join(userData, 'settings.json'), settings);
  await writeFile(join(codexHome, 'config.toml'), '# Disposable update fixture\n');
  const before = await digest(join(codexHome, 'config.toml'));
  const environment = { ...process.env, CODEX_HOME: codexHome };
  delete environment.ELECTRON_RUN_AS_NODE;
  advance('launch isolated installed copy');
  application = await electron.launch({ executablePath: installedExecutable, args: [`--user-data-dir=${userData}`], env: environment, timeout: 45000 });
  child = application.process();
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { appOutput = (appOutput + chunk.toString()).slice(-16000); });
  const page = await application.firstWindow({ timeout: 45000 });
  await expect(page.locator('.profile-card')).not.toHaveCount(0, { timeout: 45000 });
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
  expect((await page.evaluate(() => window.agentSwitcher.getState())).version).toBe(sourceVersion);
  await application.evaluate(({ dialog }, fixture) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = url === 'https://api.github.com/repos/TedGillXD/AgentSwitcher/releases/latest' ? '/latest'
        : url === fixture.base + 'SHA256SUMS.txt' ? '/checksums' : url === fixture.base + fixture.asset ? '/installer' : null;
      if (!path) throw new Error('Unexpected update smoke request');
      return originalFetch(fixture.local + path, init);
    };
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, { base, asset, local });
  advance('check and download verified update');
  expect((await page.evaluate(() => window.agentSwitcher.checkForUpdates())).status).toBe('available');
  expect((await page.evaluate(() => window.agentSwitcher.downloadUpdate())).status).toBe('downloaded');
  advance('prepare installation and exit old process');
  try {
    const installing = await page.evaluate(() => window.agentSwitcher.installUpdate());
    expect(installing.status, `Install preparation returned ${installing.error ?? installing.status}`).toBe('installing');
  }
  catch (error) { if (!error.message.includes('Target page, context or browser has been closed')) throw error; }
  await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
  oldExited = true;
  const receipt = join(userData, 'updates/installer/pending-install.json');
  advance('wait for replacement, relaunch and healthy startup cleanup');
  await expect.poll(async () => {
    try {
      const version = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(installedApp, 'Contents/Info.plist')])).stdout.trim();
      const pending = await stat(receipt).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
      const pids = await fixtureProcesses();
      return version === futureVersion && !pending && pids.length === 1;
    } catch { return false; }
  }, { timeout: 60000, intervals: [500, 1000] }).toBe(true);
  expect(await readFile(join(userData, 'settings.json'), 'utf8')).toBe(settings);
  expect(await digest(join(codexHome, 'config.toml'))).toBe(before);
  expect((await readdir(dirname(installedApp))).filter(name => name.startsWith('.AgentSwitcher-'))).toEqual([]);
  console.log(`macOS update smoke passed: verified ${sourceVersion} → fixture ${futureVersion}, streamed SHA-256 download, parent exit, app replacement, relaunch with the same isolated profile, healthy-start backup cleanup, unchanged settings/Codex config. Only temporary copies were updated.`);
} catch (error) {
  console.error(`Update smoke failed during: ${stage}`, error);
  console.error('Original application output:', appOutput);
  const installer = join(userData, 'updates/installer');
  for (const name of await readdir(installer).catch(() => [])) {
    if (name.endsWith('.result')) console.error('Installer helper result:', await readFile(join(installer, name), 'utf8'));
    if (name === 'pending-install.json') console.error('Pending installer receipt:', await readFile(join(installer, name), 'utf8'));
  }
  console.error('Installed bundle version:', (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(installedApp, 'Contents/Info.plist')]).catch(() => ({ stdout: 'unavailable' }))).stdout.trim());
  const remaining = await fixtureProcesses();
  console.error('Remaining disposable process IDs:', remaining);
  if (remaining.length) console.error('Disposable application arguments:', (await run('/bin/ps', ['-ww', '-p', remaining.join(','), '-o', 'pid=,ppid=,args='])).stdout);
  try {
    asar.uncacheAll();
    console.error('Installed runtime package version:', JSON.parse(asar.extractFile(join(installedApp, 'Contents/Resources/app.asar'), 'package.json').toString()).version);
  } catch { console.error('Installed runtime package version unavailable'); }
  if (process.env.CI) for (const pid of remaining) {
    // Only sample the exact disposable executable, never other desktop apps.
    const sample = join(directory, `process-${pid}.sample`);
    await run('/usr/bin/sample', [String(pid), '1', '1', '-file', sample]).catch(() => undefined);
    console.error('Disposable application stack:', (await readFile(sample, 'utf8').catch(() => 'Sample unavailable')).slice(0, 18000));
  }
  throw error;
} finally {
  if (!oldExited && child?.exitCode === null) {
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10000);
    try { await application.close(); } catch {} finally { clearTimeout(timeout); }
  }
  // Stop only the newly relaunched disposable executable, verified by exact path.
  for (const pid of await fixtureProcesses()) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  // A native system dialog can prevent graceful termination on CI. Force only
  // this exact disposable executable so cleanup cannot hide the original error.
  await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  for (const pid of await fixtureProcesses()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  await expect.poll(async () => (await fixtureProcesses()).length, { timeout: 10000 }).toBe(0);
  if (server) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
  if (process.env.AGENT_SWITCHER_KEEP_UPDATE_FIXTURE) console.log(`Retained disposable update fixture: ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
