import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { AppError } from './errors';
import { atomicWrite } from './files';
import type { VerifiedUpdate } from './updater';

const bundleId = 'dev.agentswitcher.desktop';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Electron treats .asar files as virtual directories. Recursive removal of a
// complete application must operate on the physical archives instead.
const removeTree: typeof rm = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises.rm
  : rm;

export interface InstallerDependencies {
  run?: (file: string, args: string[]) => Promise<{ stdout: string }>;
  spawnDetached?: (file: string, args: string[], options?: { windowsVerbatimArguments: boolean; argv0: string }) => Promise<void>;
  /** Test adapters run the same helper against disposable bundles. */
  helperCommands?: Partial<{ open: string; move: string; sleep: string }>;
}

export interface PrepareUpdateInstallOptions {
  update: VerifiedUpdate;
  platform: NodeJS.Platform;
  executablePath: string;
  userDataDirectory: string;
  currentVersion: string;
  parentPid: number;
  dependencies?: InstallerDependencies;
}

interface Receipt {
  format: 1;
  id: string;
  bundleId: string;
  targetApp: string;
  stagedApp: string;
  backupApp: string;
  fromVersion: string;
  toVersion: string;
}

const runCommand: NonNullable<InstallerDependencies['run']> = (file, args) => new Promise((resolveResult, reject) => {
  execFile(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolveResult({ stdout }));
});

const spawnDetached: NonNullable<InstallerDependencies['spawnDetached']> = (file, args, options) => new Promise((resolveResult, reject) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false, ...options });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolveResult(); });
});

function fail(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new AppError(code === 'EACCES' || code === 'EPERM' ? 'UPDATE_PERMISSION_DENIED' : 'UPDATE_INSTALL_FAILED');
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function regular(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new AppError('UPDATE_INSTALL_FAILED');
}

function appFromExecutable(executablePath: string): string {
  if (!isAbsolute(executablePath) || basename(executablePath) !== 'AgentSwitcher' ||
      basename(dirname(executablePath)) !== 'MacOS' || basename(dirname(dirname(executablePath))) !== 'Contents') {
    throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
  }
  const appPath = dirname(dirname(dirname(resolve(executablePath))));
  if (!appPath.endsWith('.app') || appPath.startsWith(`${sep}Volumes${sep}`) || appPath.split(sep).includes('AppTranslocation')) {
    throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
  }
  return appPath;
}

function cachePaths(userDataDirectory: string) {
  if (!isAbsolute(userDataDirectory)) throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
  const directory = join(resolve(userDataDirectory), 'updates', 'installer');
  return { directory, receipt: join(directory, 'pending-install.json') };
}

async function canonicalCache(userDataDirectory: string, create: boolean) {
  const paths = cachePaths(userDataDirectory);
  if (create) await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await regular(paths.directory, true);
  const directory = await realpath(paths.directory);
  if (directory !== join(await realpath(resolve(userDataDirectory)), 'updates', 'installer')) throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
  return { directory, receipt: join(directory, 'pending-install.json') };
}

function helperPath(directory: string, id: string): string { return join(directory, `install-${id}.sh`); }
function resultPath(directory: string, id: string): string { return join(directory, `install-${id}.result`); }

function validateReceipt(value: unknown, targetApp: string): Receipt {
  if (!value || typeof value !== 'object') throw new AppError('UPDATE_INSTALL_FAILED');
  const receipt = value as Receipt;
  const parent = dirname(targetApp);
  if (receipt.format !== 1 || typeof receipt.id !== 'string' || !uuidPattern.test(receipt.id) ||
      receipt.bundleId !== bundleId || receipt.targetApp !== targetApp ||
      receipt.stagedApp !== join(parent, `.AgentSwitcher-update-${receipt.id}.app`) ||
      receipt.backupApp !== join(parent, `.AgentSwitcher-backup-${receipt.id}.app`) ||
      !versionPattern.test(receipt.fromVersion) || !versionPattern.test(receipt.toVersion) || receipt.fromVersion === receipt.toVersion) {
    throw new AppError('UPDATE_INSTALL_FAILED');
  }
  return receipt;
}

async function readReceipt(path: string, target: string): Promise<Receipt | null> {
  if (!await exists(path)) return null;
  await regular(path, false);
  return validateReceipt(JSON.parse(await readFile(path, 'utf8')), target);
}

async function verifyBundle(path: string, version: string, run: NonNullable<InstallerDependencies['run']>): Promise<void> {
  await regular(path, true);
  const plist = join(path, 'Contents', 'Info.plist');
  const identifier = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])).stdout.trim();
  const actualVersion = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).stdout.trim();
  if (identifier !== bundleId || actualVersion !== version) throw new AppError('UPDATE_INSTALL_FAILED');
}

// Paths are arguments, never shell source. This script is also exercised by
// fixture tests; the production command paths are fixed by the main process.
const macHelper = `#!/bin/sh
set -eu
umask 077
parent="$1"; target="$2"; staged="$3"; backup="$4"; receipt="$5"; id="$6"; result="$7"
open_command="$8"; move_command="$9"; shift 9; sleep_command="$1"; profile="$2"
reopen() { "$open_command" -n "$target" --args "--user-data-dir=$profile"; }
report() { printf '%s\\n' "$1" > "$result"; }
attempt=0
while /bin/kill -0 "$parent" 2>/dev/null; do
  if [ "$attempt" -ge 30 ]; then report UPDATE_PARENT_TIMEOUT; exit 1; fi
  "$sleep_command" 1
  attempt=$((attempt + 1))
done
current_id=$(/usr/bin/plutil -extract id raw -o - "$receipt" 2>/dev/null) || exit 1
[ "$current_id" = "$id" ] || exit 1
[ -d "$target" ] && [ ! -L "$target" ] && [ -d "$staged" ] && [ ! -L "$staged" ] || { report UPDATE_INSTALL_FAILED; exit 1; }
[ ! -e "$backup" ] && [ ! -L "$backup" ] || { report UPDATE_INSTALL_FAILED; exit 1; }
if ! "$move_command" "$target" "$backup"; then
  report UPDATE_INSTALL_FAILED
  reopen || true
  exit 1
fi
if ! "$move_command" "$staged" "$target"; then
  "$move_command" "$backup" "$target" || true
  report UPDATE_INSTALL_FAILED
  reopen || true
  exit 1
fi
report INSTALLED
if ! reopen; then
  if "$move_command" "$target" "$staged"; then "$move_command" "$backup" "$target" || true; fi
  report UPDATE_INSTALL_FAILED
  reopen || true
  exit 1
fi
`;

async function removePlanFiles(receipt: Receipt, directory: string): Promise<void> {
  for (const path of [helperPath(directory, receipt.id), resultPath(directory, receipt.id)]) {
    if (await exists(path)) { await regular(path, false); await unlink(path); }
  }
}

export async function prepareUpdateInstall(options: PrepareUpdateInstallOptions): Promise<{ launch(): Promise<void> }> {
  const { update, platform, executablePath, userDataDirectory, currentVersion, parentPid } = options;
  const run = options.dependencies?.run ?? runCommand;
  const start = options.dependencies?.spawnDetached ?? spawnDetached;
  let stagedApp: string | undefined;
  let createdReceipt: Receipt | undefined;
  let installerDirectory: string | undefined;
  try {
    if (!['darwin', 'win32'].includes(platform)) throw new AppError('UPDATE_UNSUPPORTED');
    if (!versionPattern.test(update.version) || !versionPattern.test(currentVersion) ||
        !update.version.split('.').map(Number).every(Number.isSafeInteger) ||
        !currentVersion.split('.').map(Number).every(Number.isSafeInteger)) throw new AppError('UPDATE_INSTALL_FAILED');
    const newer = update.version.split('.').map(Number);
    const current = currentVersion.split('.').map(Number);
    const firstDifference = newer.findIndex((component, index) => component !== current[index]);
    if (firstDifference < 0 || newer[firstDifference]! <= current[firstDifference]!) throw new AppError('UPDATE_INSTALL_FAILED');
    if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw new AppError('UPDATE_INSTALL_FAILED');
    await regular(update.filePath, false);
    await regular(executablePath, false);
    if (platform === 'win32') {
      if (!/^AgentSwitcher-[0-9]+\.[0-9]+\.[0-9]+-win-(x64|arm64)\.exe$/.test(update.assetName) ||
          !update.assetName.startsWith(`AgentSwitcher-${update.version}-`) || !update.filePath.toLowerCase().endsWith('.exe') ||
          !isAbsolute(executablePath) || basename(executablePath).toLowerCase() !== 'agentswitcher.exe' ||
          /[\u0000-\u001F"]/.test(update.filePath + executablePath)) throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
      let pending: Promise<void> | null = null;
      return { launch() {
        // NSIS requires /D to be the final, unquoted parameter, including spaces.
        // Quote argv0 separately while CreateProcess receives the actual file.
        pending ??= start(update.filePath, ['--updated', '--force-run', `/D=${dirname(executablePath)}`], {
          windowsVerbatimArguments: true, argv0: `"${update.filePath}"`,
        }).catch((error) => { pending = null; throw fail(error); });
        return pending;
      } };
    }
    if (!/^AgentSwitcher-[0-9]+\.[0-9]+\.[0-9]+-mac-(x64|arm64)\.zip$/.test(update.assetName) ||
        !update.assetName.startsWith(`AgentSwitcher-${update.version}-`)) throw new AppError('UPDATE_INSTALL_FAILED');
    const originalAppPath = appFromExecutable(executablePath);
    await regular(originalAppPath, true);
    const targetApp = appFromExecutable(await realpath(executablePath));
    if (await realpath(originalAppPath) !== targetApp) throw new AppError('UPDATE_INSTALL_LOCATION_INVALID');
    await access(dirname(targetApp), constants.W_OK);
    await verifyBundle(targetApp, currentVersion, run);
    const cache = await canonicalCache(userDataDirectory, true);
    installerDirectory = cache.directory;
    const previous = await readReceipt(cache.receipt, targetApp);
    if (previous) {
      if (previous.fromVersion !== currentVersion || await exists(previous.backupApp)) throw new AppError('UPDATE_INSTALL_FAILED');
      // Invalidating the old receipt first prevents an older waiting helper from
      // applying an abandoned plan after this process eventually exits.
      await unlink(cache.receipt);
      if (await exists(previous.stagedApp)) { await verifyBundle(previous.stagedApp, previous.toVersion, run); await removeTree(previous.stagedApp, { recursive: true }); }
      await removePlanFiles(previous, cache.directory);
    }
    const id = randomUUID();
    stagedApp = join(dirname(targetApp), `.AgentSwitcher-update-${id}.app`);
    const receipt: Receipt = { format: 1, id, bundleId, targetApp, stagedApp,
      backupApp: join(dirname(targetApp), `.AgentSwitcher-backup-${id}.app`), fromVersion: currentVersion, toVersion: update.version };
    const extracted = await mkdtemp(join(cache.directory, 'extract-'));
    try {
      await run('/usr/bin/ditto', ['-xk', update.filePath, extracted]);
      const source = join(extracted, 'AgentSwitcher.app');
      await verifyBundle(source, update.version, run);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
      await run('/usr/bin/ditto', [source, stagedApp]);
      await verifyBundle(stagedApp, update.version, run);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    } finally { await removeTree(extracted, { recursive: true, force: true }); }
    createdReceipt = receipt;
    await writeFile(helperPath(cache.directory, id), macHelper, { mode: 0o700, flag: 'wx' });
    await atomicWrite(cache.receipt, JSON.stringify(receipt) + '\n');
    const commands = options.dependencies?.helperCommands;
    const args = [helperPath(cache.directory, id), String(parentPid), targetApp, stagedApp, receipt.backupApp, cache.receipt, id,
      resultPath(cache.directory, id), commands?.open ?? '/usr/bin/open', commands?.move ?? '/bin/mv', commands?.sleep ?? '/bin/sleep', await realpath(userDataDirectory)];
    let pending: Promise<void> | null = null;
    return { launch() {
      pending ??= start('/bin/sh', args).catch((error) => { pending = null; throw fail(error); });
      return pending;
    } };
  } catch (error) {
    if (stagedApp) await removeTree(stagedApp, { recursive: true, force: true }).catch(() => undefined);
    if (createdReceipt && installerDirectory) {
      await removePlanFiles(createdReceipt, installerDirectory).catch(() => undefined);
      await unlink(join(installerDirectory, 'pending-install.json')).catch(() => undefined);
    }
    throw fail(error);
  }
}

export async function completePendingUpdate(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  userDataDirectory: string;
  version: string;
  dependencies?: InstallerDependencies;
}): Promise<string | null> {
  if (options.platform !== 'darwin') return null;
  try {
    if (!await exists(cachePaths(options.userDataDirectory).receipt)) return null;
    const cache = await canonicalCache(options.userDataDirectory, false);
    const originalAppPath = appFromExecutable(options.executablePath);
    await regular(originalAppPath, true);
    const targetApp = appFromExecutable(await realpath(options.executablePath));
    const receipt = await readReceipt(cache.receipt, targetApp);
    if (!receipt) return null;
    const run = options.dependencies?.run ?? runCommand;
    if (options.version !== receipt.toVersion) {
      const result = resultPath(cache.directory, receipt.id);
      if (options.version === receipt.fromVersion && await exists(result)) {
        await regular(result, false);
        if ((await lstat(result)).size > 128) throw new AppError('UPDATE_INSTALL_FAILED');
        const status = (await readFile(result, 'utf8')).trim();
        if (status === 'UPDATE_INSTALL_FAILED' || status === 'UPDATE_PARENT_TIMEOUT') return 'UPDATE_INSTALL_FAILED';
      }
      return null;
    }
    await verifyBundle(targetApp, receipt.toVersion, run);
    if (await exists(receipt.backupApp)) {
      await verifyBundle(receipt.backupApp, receipt.fromVersion, run);
      await removeTree(receipt.backupApp, { recursive: true });
    }
    if (await exists(receipt.stagedApp)) {
      await verifyBundle(receipt.stagedApp, receipt.toVersion, run);
      await removeTree(receipt.stagedApp, { recursive: true });
    }
    await removePlanFiles(receipt, cache.directory);
    await unlink(cache.receipt);
    return null;
  } catch (error) { throw fail(error); }
}
