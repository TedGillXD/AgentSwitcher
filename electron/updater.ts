import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpdateState } from '../shared/types';
import { AppError } from './errors';

const repository = 'TedGillXD/AgentSwitcher';
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const repositoryUrl = `https://github.com/${repository}`;
const maxMetadataBytes = 2 * 1024 * 1024;
const maxChecksumBytes = 128 * 1024;
const maxInstallerBytes = 1536 * 1024 * 1024;
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

export interface VerifiedUpdate {
  version: string;
  filePath: string;
  sha256: string;
  assetName: string;
}

export interface AppUpdaterOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  packaged: boolean;
  cacheDirectory: string;
  fetch?: typeof fetch;
  onChange?: (state: UpdateState) => void;
  install: (update: VerifiedUpdate) => Promise<boolean>;
  /** Injectable budgets keep network timeout tests deterministic. */
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

interface Version { major: number; minor: number; patch: number; prerelease: string | null }
interface Asset { name: string; url: string; size: number; digest: string | null }
interface Candidate { version: string; asset: Asset; checksums: Asset }

function parseVersion(value: string, stableOnly = false): Version | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || stableOnly && (match[4] || match[5])) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (numbers.some(number => !Number.isSafeInteger(number))) return null;
  if (match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, prerelease: match[4] ?? null };
}

function newerVersion(latest: Version, current: Version): boolean {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (latest[key] !== current[key]) return latest[key] > current[key];
  }
  return latest.prerelease === null && current.prerelease !== null;
}

function fail(code: string): never { throw new AppError(code); }
function sanitized(error: unknown, fallback: string): string { return error instanceof AppError ? error.code : fallback; }
function assetUrl(version: string, name: string): string { return `${repositoryUrl}/releases/download/v${version}/${name}`; }

function readAsset(value: unknown, name: string, version: string, limit: number): Asset {
  if (!value || typeof value !== 'object') fail('UPDATE_ASSET_MISSING');
  const asset = value as Record<string, unknown>;
  if (asset.name !== name || asset.browser_download_url !== assetUrl(version, name) ||
      !Number.isSafeInteger(asset.size) || Number(asset.size) <= 0 || Number(asset.size) > limit ||
      asset.state !== undefined && asset.state !== 'uploaded') fail('UPDATE_INVALID_RELEASE');
  let digest: string | null = null;
  if (asset.digest !== undefined && asset.digest !== null) {
    if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) fail('UPDATE_INVALID_RELEASE');
    digest = asset.digest.slice(7).toLowerCase();
  }
  return { name, url: assetUrl(version, name), size: Number(asset.size), digest };
}

function throwHttp(response: Response, fallback: string): void {
  if (!response.ok) void response.body?.cancel().catch(() => undefined);
  if (response.status === 403 || response.status === 429) fail('UPDATE_RATE_LIMITED');
  if (!response.ok) fail(fallback);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function bytes(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body?.cancel().catch(() => undefined);
    fail('UPDATE_INVALID_RELEASE');
  }
  if (!response.body) fail('UPDATE_INVALID_RELEASE');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > limit) fail('UPDATE_INVALID_RELEASE');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function fileDigest(path: string, size: number): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== size) return null;
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class AppUpdater {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetcher: typeof fetch;
  private state: UpdateState;
  private candidate: Candidate | null = null;
  private downloaded: VerifiedUpdate | null = null;
  private operating = false;
  private downloadAbort: AbortController | null = null;

  constructor(private readonly options: AppUpdaterOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetcher = options.fetch ?? fetch;
    this.state = {
      status: 'idle', currentVersion: options.currentVersion, latestVersion: null, releaseUrl: null,
      releaseNotes: null, publishedAt: null, downloadedBytes: 0, totalBytes: 0, error: null,
      canInstall: options.packaged && this.supportedPlatform,
    };
  }

  private get supportedPlatform(): boolean {
    return ['darwin', 'win32'].includes(this.platform) && ['x64', 'arm64'].includes(this.arch);
  }
  get isInstalling(): boolean { return this.state.status === 'installing'; }
  getState(): UpdateState { return { ...this.state }; }

  /** Report a failed detached installer after startup without clobbering a live update. */
  recordInstallFailure(): UpdateState {
    if (this.operating || this.isInstalling) return this.getState();
    return this.changed({ status: 'error', error: 'UPDATE_INSTALL_FAILED' });
  }

  private changed(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch };
    try { this.options.onChange?.(this.getState()); } catch { /* UI observers cannot interrupt an update. */ }
    return this.getState();
  }

  private acquire(): void {
    if (this.operating || this.isInstalling) fail('UPDATE_IN_PROGRESS');
    this.operating = true;
  }

  async check(): Promise<UpdateState> {
    this.acquire();
    this.candidate = null;
    this.downloaded = null;
    this.changed({ status: 'checking', error: null, downloadedBytes: 0, totalBytes: 0,
      latestVersion: null, releaseUrl: null, releaseNotes: null, publishedAt: null });
    const signal = AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000);
    try {
      const current = parseVersion(this.options.currentVersion);
      if (!current) fail('UPDATE_INVALID_VERSION');
      const response = await abortable(this.fetcher(releaseApi, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AgentSwitcher/${this.options.currentVersion}` },
        redirect: 'error', signal,
      }), signal);
      throwHttp(response, 'UPDATE_CHECK_FAILED');
      const body: unknown = JSON.parse((await bytes(response, maxMetadataBytes, signal)).toString('utf8'));
      if (!body || typeof body !== 'object') fail('UPDATE_INVALID_RELEASE');
      const release = body as Record<string, unknown>;
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' ||
          !release.tag_name.startsWith('v')) fail('UPDATE_INVALID_RELEASE');
      const version = release.tag_name.slice(1);
      const parsed = parseVersion(version, true);
      const releaseUrl = `${repositoryUrl}/releases/tag/v${version}`;
      if (!parsed || release.html_url !== releaseUrl || typeof release.published_at !== 'string' ||
          !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets) ||
          release.body !== null && release.body !== undefined && typeof release.body !== 'string') fail('UPDATE_INVALID_RELEASE');
      const info = { latestVersion: version, releaseUrl, publishedAt: release.published_at,
        releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 20_000) : null };
      if (!newerVersion(parsed, current)) return this.changed({ ...info, status: 'up-to-date' });
      if (!this.supportedPlatform) return this.changed({ ...info, status: 'unsupported', error: 'UPDATE_UNSUPPORTED' });
      const name = `AgentSwitcher-${version}-${this.platform === 'darwin' ? 'mac' : 'win'}-${this.arch}.${this.platform === 'darwin' ? 'zip' : 'exe'}`;
      const assets = release.assets as Array<Record<string, unknown>>;
      const installers = assets.filter(asset => asset?.name === name);
      const checksums = assets.filter(asset => asset?.name === 'SHA256SUMS.txt');
      if (installers.length !== 1 || checksums.length !== 1) fail('UPDATE_ASSET_MISSING');
      this.candidate = {
        version, asset: readAsset(installers[0], name, version, maxInstallerBytes),
        checksums: readAsset(checksums[0], 'SHA256SUMS.txt', version, maxChecksumBytes),
      };
      return this.changed({ ...info, status: 'available', totalBytes: this.candidate.asset.size });
    } catch (error) {
      return this.changed({ status: 'error', error: signal.aborted ? 'UPDATE_TIMEOUT' : sanitized(error, 'UPDATE_CHECK_FAILED') });
    } finally { this.operating = false; }
  }

  /** Cancels only the active download; no installed application is touched. */
  cancelDownload(): void { this.downloadAbort?.abort(); }

  private async assetResponse(url: string, signal: AbortSignal): Promise<Response> {
    let next = url;
    for (let redirect = 0; redirect <= 4; redirect++) {
      const response = await abortable(this.fetcher(next, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': `AgentSwitcher/${this.options.currentVersion}` },
        redirect: 'manual', signal,
      }), signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) fail('UPDATE_DOWNLOAD_FAILED');
      const destination = new URL(location, next);
      if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash ||
          !(cdnHosts.has(destination.hostname) || destination.href === url)) fail('UPDATE_INVALID_RELEASE');
      next = destination.href;
    }
    return fail('UPDATE_DOWNLOAD_FAILED');
  }

  async download(): Promise<UpdateState> {
    this.acquire();
    const candidate = this.candidate;
    const controller = new AbortController();
    this.downloadAbort = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.downloadTimeoutMs ?? 10 * 60_000)]);
    let partial: string | null = null;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      if (!this.state.canInstall) fail('UPDATE_UNSUPPORTED');
      if (!candidate) fail('UPDATE_NOT_AVAILABLE');
      if (this.downloaded) return this.changed({ status: 'downloaded', error: null });
      this.changed({ status: 'downloading', error: null, downloadedBytes: 0, totalBytes: candidate.asset.size });
      const checksumResponse = await this.assetResponse(candidate.checksums.url, signal);
      throwHttp(checksumResponse, 'UPDATE_DOWNLOAD_FAILED');
      const checksumBody = await bytes(checksumResponse, maxChecksumBytes, signal);
      if (checksumBody.byteLength !== candidate.checksums.size || candidate.checksums.digest &&
          createHash('sha256').update(checksumBody).digest('hex') !== candidate.checksums.digest) fail('UPDATE_CHECKSUM_MISMATCH');
      const matching: string[] = [];
      for (const line of checksumBody.toString('utf8').split(/\r?\n/).filter(line => line.trim())) {
        const match = /^([a-f\d]{64})[ \t]+\*?([^\r\n]+)$/i.exec(line);
        if (!match) fail('UPDATE_INVALID_CHECKSUM');
        if (match[2] === candidate.asset.name) matching.push(match[1]!.toLowerCase());
      }
      if (matching.length !== 1) fail('UPDATE_INVALID_CHECKSUM');
      const expected = matching[0]!;
      if (candidate.asset.digest && candidate.asset.digest !== expected) fail('UPDATE_CHECKSUM_MISMATCH');
      await mkdir(this.options.cacheDirectory, { recursive: true, mode: 0o700 });
      const destination = join(this.options.cacheDirectory, candidate.asset.name);
      const cachedDigest = await fileDigest(destination, candidate.asset.size);
      signal.throwIfAborted();
      if (cachedDigest === expected) {
        this.downloaded = { version: candidate.version, filePath: destination, sha256: expected, assetName: candidate.asset.name };
        return this.changed({ status: 'downloaded', downloadedBytes: candidate.asset.size, error: null });
      }
      const response = await this.assetResponse(candidate.asset.url, signal);
      responseBody = response.body;
      throwHttp(response, 'UPDATE_DOWNLOAD_FAILED');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== candidate.asset.size)) fail('UPDATE_SIZE_MISMATCH');
      if (!response.body) fail('UPDATE_DOWNLOAD_FAILED');
      partial = join(this.options.cacheDirectory, `.${candidate.asset.name}.${randomUUID()}.partial`);
      const file = await open(partial, 'wx', 0o600);
      const reader = response.body.getReader();
      const digest = createHash('sha256');
      let size = 0;
      let previousPercent = -1;
      let finished = false;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) { finished = true; break; }
          size += chunk.value.byteLength;
          if (size > candidate.asset.size) fail('UPDATE_SIZE_MISMATCH');
          digest.update(chunk.value);
          await file.writeFile(chunk.value);
          this.state = { ...this.state, downloadedBytes: size };
          const percent = Math.floor(size / candidate.asset.size * 100);
          if (percent !== previousPercent) { this.changed({}); previousPercent = percent; }
        }
        if (size !== candidate.asset.size) fail('UPDATE_SIZE_MISMATCH');
        if (digest.digest('hex') !== expected) fail('UPDATE_CHECKSUM_MISMATCH');
        await file.sync();
      } finally {
        if (!finished) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        await file.close();
      }
      if (signal.aborted) throw signal.reason;
      // Rename atomically only after a complete, verified download. Replacing a
      // stale cache file never changes the installed application.
      await rename(partial, destination);
      partial = null;
      this.downloaded = { version: candidate.version, filePath: destination, sha256: expected, assetName: candidate.asset.name };
      return this.changed({ status: 'downloaded', downloadedBytes: candidate.asset.size, error: null });
    } catch (error) {
      if (responseBody && !responseBody.locked) void responseBody.cancel().catch(() => undefined);
      this.downloaded = null;
      const code = controller.signal.aborted ? 'UPDATE_CANCELLED' : signal.aborted ? 'UPDATE_TIMEOUT' : sanitized(error, 'UPDATE_DOWNLOAD_FAILED');
      return this.changed({ status: 'error', error: code, downloadedBytes: 0 });
    } finally {
      if (partial) await unlink(partial).catch(() => undefined);
      this.downloadAbort = null;
      this.operating = false;
    }
  }

  async install(): Promise<UpdateState> {
    this.acquire();
    let valid = false;
    try {
      if (!this.state.canInstall) fail('UPDATE_UNSUPPORTED');
      if (!this.downloaded || !this.candidate) fail('UPDATE_NOT_AVAILABLE');
      if (await fileDigest(this.downloaded.filePath, this.candidate.asset.size) !== this.downloaded.sha256) {
        this.downloaded = null;
        fail('UPDATE_CHECKSUM_MISMATCH');
      }
      valid = true;
      this.changed({ status: 'installing', error: null });
      const accepted = await this.options.install({ ...this.downloaded });
      return accepted ? this.getState() : this.changed({ status: 'downloaded', error: null });
    } catch (error) {
      if (!valid) this.downloaded = null;
      return this.changed({ status: valid ? 'downloaded' : 'error', error: sanitized(error, 'UPDATE_INSTALL_FAILED'),
        ...(!valid ? { downloadedBytes: 0 } : {}) });
    } finally { this.operating = false; }
  }
}
