import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater, type AppUpdaterOptions, type VerifiedUpdate } from '../electron/updater';
import { AppError } from '../electron/errors';
import type { UpdateState } from '../shared/types';

const directories: string[] = [];
const api = 'https://api.github.com/repos/TedGillXD/AgentSwitcher/releases/latest';
const repo = 'https://github.com/TedGillXD/AgentSwitcher';
const payload = Buffer.from('verified release installer fixture');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const downloadUrl = (version: string, name: string) => `${repo}/releases/download/v${version}/${name}`;
const checksumText = (name: string, digest = sha(payload)) => `${digest}  ${name}\n`;

function release(version = '0.2.4', platform = 'mac', arch = 'arm64') {
  const name = `AgentSwitcher-${version}-${platform}-${arch}.${platform === 'mac' ? 'zip' : 'exe'}`;
  const sums = checksumText(name);
  return {
    tag_name: `v${version}`, html_url: `${repo}/releases/tag/v${version}`, draft: false, prerelease: false,
    published_at: '2026-10-22T00:00:00Z', body: 'A verified update.',
    assets: [
      { name, size: payload.length, browser_download_url: downloadUrl(version, name), digest: `sha256:${sha(payload)}`, state: 'uploaded' },
      { name: 'SHA256SUMS.txt', size: Buffer.byteLength(sums), browser_download_url: downloadUrl(version, 'SHA256SUMS.txt'), digest: `sha256:${sha(sums)}`, state: 'uploaded' },
    ],
  };
}

async function fixture(overrides: Partial<AppUpdaterOptions> = {}, metadata = release()) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-switcher-update-'));
  directories.push(directory);
  const states: UpdateState[] = [];
  const installer = vi.fn<(update: VerifiedUpdate) => Promise<boolean>>().mockResolvedValue(false);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input);
    if (url === api) return Response.json(metadata);
    if (url.endsWith('/SHA256SUMS.txt')) return new Response(checksumText(metadata.assets[0]!.name));
    if (url === metadata.assets[0]!.browser_download_url) return new Response(payload);
    throw new Error(`Unexpected URL: ${url}`);
  });
  const updater = new AppUpdater({ currentVersion: '0.2.3', platform: 'darwin', arch: 'arm64', packaged: true,
    cacheDirectory: directory, fetch: fetcher, install: installer, onChange: state => states.push(state), ...overrides });
  return { updater, directory, states, installer, fetcher, metadata };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('GitHub release updates', () => {
  it('reports a failed detached installer at startup and permits a fresh check and retry', async () => {
    const { updater, states, installer } = await fixture();
    expect(updater.getState().status).toBe('idle');
    expect(updater.recordInstallFailure()).toMatchObject({ status: 'error', error: 'UPDATE_INSTALL_FAILED', currentVersion: '0.2.3' });
    expect(states.at(-1)?.error).toBe('UPDATE_INSTALL_FAILED');
    expect(await updater.check()).toMatchObject({ status: 'available', error: null });
    expect((await updater.download()).status).toBe('downloaded');
    expect((await updater.install()).status).toBe('downloaded');
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed startup failure reporting overwrite a running release check', async () => {
    const { updater, fetcher, metadata, states } = await fixture();
    let complete!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const checking = updater.check();
    const before = updater.getState();
    const count = states.length;
    expect(before.status).toBe('checking');
    expect(updater.recordInstallFailure()).toEqual(before);
    expect(states).toHaveLength(count);
    complete(Response.json(metadata));
    expect(await checking).toMatchObject({ status: 'available', error: null });
  });

  it('keeps an accepted installation active when a stale startup failure arrives', async () => {
    const { updater, installer, states } = await fixture();
    await updater.check(); await updater.download();
    installer.mockResolvedValueOnce(true);
    await updater.install();
    const before = updater.getState();
    const count = states.length;
    expect(before.status).toBe('installing');
    expect(updater.recordInstallFailure()).toEqual(before);
    expect(states).toHaveLength(count);
    expect(updater.isInstalling).toBe(true);
  });

  it.each([
    ['0.2.3', '0.2.3', 'up-to-date'], ['0.2.3', '0.2.2', 'up-to-date'],
    ['0.2.9', '0.2.10', 'available'], ['0.9.9', '1.0.0', 'available'],
    ['0.3.0', '0.2.99', 'up-to-date'], ['0.2.4-beta.2', '0.2.4', 'available'],
    ['0.2.4+local', '0.2.4', 'up-to-date'],
  ])('compares %s with %s without a downgrade', async (currentVersion, version, status) => {
    const { updater } = await fixture({ currentVersion }, release(version));
    expect(await updater.check()).toMatchObject({ status, latestVersion: version, error: null });
  });

  it.each([
    ['darwin', 'x64', 'mac'], ['darwin', 'arm64', 'mac'], ['win32', 'x64', 'win'], ['win32', 'arm64', 'win'],
  ] as const)('selects the %s %s artifact and validates its checksum before installation', async (platform, arch, artifact) => {
    const { updater, metadata, installer, directory } = await fixture({ platform, arch }, release('0.2.4', artifact, arch));
    expect((await updater.check()).status).toBe('available');
    const downloaded = await updater.download();
    expect(downloaded).toMatchObject({ status: 'downloaded', downloadedBytes: payload.length, totalBytes: payload.length, error: null });
    expect(await readFile(join(directory, metadata.assets[0]!.name))).toEqual(payload);
    expect((await updater.install()).status).toBe('downloaded');
    expect(installer).toHaveBeenCalledWith({ version: '0.2.4', filePath: join(directory, metadata.assets[0]!.name),
      assetName: metadata.assets[0]!.name, sha256: sha(payload) });
  });

  it('uses only the official public API and supplies no provider credentials', async () => {
    const { updater, fetcher } = await fixture();
    await updater.check();
    expect(fetcher).toHaveBeenCalledWith(api, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AgentSwitcher/0.2.3' } }));
  });

  it.each(['v0.2.4-beta.1', 'v00.2.4', 'v0.2.4/../../malicious', 'v9007199254740992.0.0', 'v0.2.4+build'])('rejects invalid stable release tag %s', async tag => {
    const metadata = release(); metadata.tag_name = tag;
    const { updater } = await fixture({}, metadata);
    expect(await updater.check()).toMatchObject({ status: 'error', error: 'UPDATE_INVALID_RELEASE' });
  });

  it.each(['draft', 'prerelease'] as const)('refuses %s releases', async property => {
    const metadata = release(); metadata[property] = true;
    const { updater } = await fixture({}, metadata);
    expect((await updater.check()).error).toBe('UPDATE_INVALID_RELEASE');
  });

  it.each([
    'http://github.com/TedGillXD/AgentSwitcher/releases/download/v0.2.4/AgentSwitcher-0.2.4-mac-arm64.zip',
    'https://github.com/attacker/AgentSwitcher/releases/download/v0.2.4/AgentSwitcher-0.2.4-mac-arm64.zip',
    'https://github.com.evil.example/AgentSwitcher.zip', 'file:///tmp/installer.zip',
    'https://github.com/TedGillXD/AgentSwitcher/releases/download/v0.2.4/../../installer.zip',
  ])('rejects an untrusted download location %s', async url => {
    const metadata = release(); metadata.assets[0]!.browser_download_url = url;
    const { updater, fetcher } = await fixture({}, metadata);
    expect((await updater.check()).error).toBe('UPDATE_INVALID_RELEASE');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects release pages outside the repository and missing/duplicate artifacts', async () => {
    const offsite = release(); offsite.html_url = 'https://evil.example/update';
    const missing = release(); missing.assets = missing.assets.slice(1);
    const duplicate = release(); duplicate.assets.push(duplicate.assets[0]!);
    for (const [metadata, error] of [[offsite, 'UPDATE_INVALID_RELEASE'], [missing, 'UPDATE_ASSET_MISSING'], [duplicate, 'UPDATE_ASSET_MISSING']] as const) {
      const { updater } = await fixture({}, metadata);
      expect((await updater.check()).error).toBe(error);
    }
  });

  it('supports checking in development but never downloads or installs there', async () => {
    const { updater, installer, fetcher } = await fixture({ packaged: false });
    expect(await updater.check()).toMatchObject({ status: 'available', canInstall: false });
    expect((await updater.download()).error).toBe('UPDATE_UNSUPPORTED');
    expect((await updater.install()).error).toBe('UPDATE_UNSUPPORTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(installer).not.toHaveBeenCalled();
  });

  it('reports unsupported platform/architecture without guessing an installer', async () => {
    const { updater } = await fixture({ platform: 'linux', arch: 'arm' });
    expect(await updater.check()).toMatchObject({ status: 'unsupported', latestVersion: '0.2.4', canInstall: false, error: 'UPDATE_UNSUPPORTED' });
  });

  it('sanitizes network failures and GitHub rate limits', async () => {
    const { updater, fetcher } = await fixture();
    fetcher.mockRejectedValueOnce(new Error('Network error echoing private-token-do-not-display'));
    expect(await updater.check()).toMatchObject({ status: 'error', error: 'UPDATE_CHECK_FAILED' });
    expect(JSON.stringify(updater.getState())).not.toContain('private-token');
    fetcher.mockResolvedValueOnce(new Response('private server details', { status: 403 }));
    expect((await updater.check()).error).toBe('UPDATE_RATE_LIMITED');
  });

  it('bounds a metadata request even if a transport does not honor AbortSignal', async () => {
    const { updater } = await fixture({ requestTimeoutMs: 10, fetch: () => new Promise(() => {}) });
    expect((await updater.check()).error).toBe('UPDATE_TIMEOUT');
  });

  it('rejects an oversized metadata response before buffering it', async () => {
    const { updater, fetcher } = await fixture();
    fetcher.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }));
    expect((await updater.check()).error).toBe('UPDATE_INVALID_RELEASE');
  });

  it('does not let UI observers corrupt a valid update', async () => {
    const { updater } = await fixture({ onChange: () => { throw new Error('Observer failed'); } });
    expect((await updater.check()).status).toBe('available');
    expect((await updater.download()).status).toBe('downloaded');
  });

  it('reuses a cache file only after hashing it against fresh official checksums', async () => {
    const { updater, fetcher, directory, metadata } = await fixture();
    await updater.check();
    await writeFile(join(directory, metadata.assets[0]!.name), payload);
    expect((await updater.download()).status).toBe('downloaded');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // Creating file symlinks on Windows may require an elevated host permission.
  it.skipIf(process.platform === 'win32')('does not mistake a symbolic-link cache entry for an already verified installer', async () => {
    const { updater, directory, metadata } = await fixture();
    const elsewhere = join(directory, 'untouched');
    await writeFile(elsewhere, payload);
    await symlink(elsewhere, join(directory, metadata.assets[0]!.name));
    await updater.check();
    expect((await updater.download()).status).toBe('downloaded');
    expect(await readFile(elsewhere)).toEqual(payload);
  });

  it('streams progress and cleans corrupt partial files before allowing a retry', async () => {
    const { updater, fetcher, metadata, states, directory } = await fixture();
    await updater.check();
    fetcher.mockImplementationOnce(async () => new Response(checksumText(metadata.assets[0]!.name)));
    fetcher.mockImplementationOnce(async () => new Response(Buffer.alloc(payload.length, 0)));
    expect((await updater.download()).error).toBe('UPDATE_CHECKSUM_MISMATCH');
    expect(await readdir(directory)).toEqual([]);
    expect((await updater.download()).status).toBe('downloaded');
    expect(states.some(state => state.status === 'downloading' && state.downloadedBytes > 0)).toBe(true);
  });

  it.each(['short', 'long', 'length-header'] as const)('rejects %s downloads', async mode => {
    const { updater, fetcher, metadata, directory } = await fixture();
    await updater.check();
    fetcher.mockImplementationOnce(async () => new Response(checksumText(metadata.assets[0]!.name)));
    fetcher.mockImplementationOnce(async () => mode === 'short' ? new Response(payload.subarray(1))
      : mode === 'long' ? new Response(Buffer.concat([payload, Buffer.from('x')]))
        : new Response(payload, { headers: { 'content-length': String(payload.length + 1) } }));
    expect((await updater.download()).error).toBe('UPDATE_SIZE_MISMATCH');
    expect(await readdir(directory)).toEqual([]);
  });

  it('requires exactly one checksum for the selected artifact', async () => {
    const metadata = release();
    const duplicate = checksumText(metadata.assets[0]!.name).repeat(2);
    metadata.assets[1]!.size = Buffer.byteLength(duplicate);
    metadata.assets[1]!.digest = `sha256:${sha(duplicate)}`;
    const { updater, fetcher } = await fixture({}, metadata);
    await updater.check();
    fetcher.mockImplementationOnce(async () => new Response(duplicate));
    expect((await updater.download()).error).toBe('UPDATE_INVALID_CHECKSUM');
  });

  it('follows only the official GitHub asset CDN redirects', async () => {
    const { updater, fetcher, metadata } = await fixture();
    await updater.check();
    const trusted = 'https://release-assets.githubusercontent.com/fixture?signature=opaque';
    fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: trusted } }));
    fetcher.mockImplementationOnce(async () => new Response(checksumText(metadata.assets[0]!.name)));
    expect((await updater.download()).status).toBe('downloaded');
    expect(fetcher.mock.calls[2]?.[0]).toBe(trusted);
    expect(fetcher.mock.calls[2]?.[1]?.redirect).toBe('manual');
  });

  it('refuses redirects to another host before requesting it', async () => {
    const { updater, fetcher } = await fixture();
    await updater.check();
    fetcher.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/installer' } }));
    expect((await updater.download()).error).toBe('UPDATE_INVALID_RELEASE');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cancels a hanging body, rejects concurrent operations, and removes its partial file', async () => {
    const { updater, fetcher, metadata, directory } = await fixture();
    await updater.check();
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    fetcher.mockImplementationOnce(async () => new Response(checksumText(metadata.assets[0]!.name)));
    fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); started(); },
    })));
    const download = updater.download();
    await start;
    const beforeFailureReport = updater.getState();
    expect(updater.recordInstallFailure()).toEqual(beforeFailureReport);
    await expect(updater.check()).rejects.toThrow('UPDATE_IN_PROGRESS');
    await expect(updater.download()).rejects.toThrow('UPDATE_IN_PROGRESS');
    await expect(updater.install()).rejects.toThrow('UPDATE_IN_PROGRESS');
    updater.cancelDownload();
    expect((await download).error).toBe('UPDATE_CANCELLED');
    expect(await readdir(directory)).toEqual([]);
  });

  it('times out and removes an unfinished installer', async () => {
    const { updater, fetcher, metadata, directory } = await fixture({ downloadTimeoutMs: 20 });
    await updater.check();
    fetcher.mockImplementationOnce(async () => new Response(checksumText(metadata.assets[0]!.name)));
    fetcher.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })));
    expect((await updater.download()).error).toBe('UPDATE_TIMEOUT');
    expect(await readdir(directory)).toEqual([]);
  });

  it('checks the downloaded bytes again at installation time and never invokes a tampered installer', async () => {
    const { updater, installer, directory, metadata } = await fixture();
    await updater.check(); await updater.download();
    await writeFile(join(directory, metadata.assets[0]!.name), Buffer.alloc(payload.length, 0));
    expect(await updater.install()).toMatchObject({ status: 'error', error: 'UPDATE_CHECKSUM_MISMATCH', downloadedBytes: 0 });
    expect(installer).not.toHaveBeenCalled();
    expect((await updater.download()).status).toBe('downloaded');
  });

  it('retains the verified download when confirmation is cancelled or installation fails', async () => {
    const { updater, installer } = await fixture();
    await updater.check(); await updater.download();
    expect(await updater.install()).toMatchObject({ status: 'downloaded', error: null });
    installer.mockRejectedValueOnce(new AppError('UPDATE_INSTALL_PERMISSION'));
    expect(await updater.install()).toMatchObject({ status: 'downloaded', error: 'UPDATE_INSTALL_PERMISSION' });
    installer.mockResolvedValueOnce(true);
    expect(await updater.install()).toMatchObject({ status: 'installing', error: null });
    expect(updater.isInstalling).toBe(true);
    await expect(updater.check()).rejects.toThrow('UPDATE_IN_PROGRESS');
  });

  it('returns snapshots that cannot change the updater state or verified installer path', async () => {
    const { updater, installer } = await fixture();
    const checked = await updater.check(); checked.latestVersion = '999.0.0';
    const downloaded = await updater.download(); downloaded.status = 'idle';
    installer.mockImplementationOnce(async update => { update.filePath = '/untrusted'; return false; });
    await updater.install(); await updater.install();
    expect(updater.getState().latestVersion).toBe('0.2.4');
    expect(basename(installer.mock.calls[1]![0].filePath)).toBe('AgentSwitcher-0.2.4-mac-arm64.zip');
  });
});
