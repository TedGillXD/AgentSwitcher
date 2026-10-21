import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completePendingUpdate, prepareUpdateInstall, type InstallerDependencies, type PrepareUpdateInstallOptions } from '../electron/update-installer';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function bundle(path: string, version: string, identifier = 'dev.agentswitcher.desktop'): Promise<void> {
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(join(path, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: identifier, CFBundleShortVersionString: version }));
  await writeFile(join(path, 'Contents', 'MacOS', 'AgentSwitcher'), version, { mode: 0o755 });
}

async function version(path: string): Promise<string> { return JSON.parse(await readFile(join(path, 'Contents', 'Info.plist'), 'utf8')).CFBundleShortVersionString; }

async function fixture(platform: 'darwin' | 'win32' = 'darwin') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-switcher-installer-')));
  directories.push(root);
  const userData = join(root, 'user data');
  const target = join(root, "Agent Switcher '$(touch unexpected)'.app");
  const source = join(root, 'release', 'AgentSwitcher.app');
  const executable = platform === 'darwin' ? join(target, 'Contents', 'MacOS', 'AgentSwitcher') : join(root, 'Program Files', 'AgentSwitcher', 'AgentSwitcher.exe');
  await mkdir(userData);
  await bundle(target, '0.2.3');
  await bundle(source, '0.2.4');
  if (platform === 'win32') { await mkdir(dirname(executable), { recursive: true }); await writeFile(executable, 'old exe'); }
  const name = `AgentSwitcher-0.2.4-${platform === 'darwin' ? 'mac-arm64.zip' : 'win-x64.exe'}`;
  const file = join(root, name);
  await writeFile(file, 'verified synthetic download');
  const run = vi.fn<NonNullable<InstallerDependencies['run']>>(async (command, args) => {
    if (command === '/usr/bin/plutil') {
      const info = JSON.parse(await readFile(args.at(-1)!, 'utf8'));
      return { stdout: String(info[args[1]!]) };
    }
    if (command === '/usr/bin/ditto') {
      if (args[0] === '-xk') await cp(source, join(args[2]!, 'AgentSwitcher.app'), { recursive: true });
      else await cp(args[0]!, args[1]!, { recursive: true });
      return { stdout: '' };
    }
    if (command === '/usr/bin/codesign') return { stdout: '' };
    throw new Error('Unexpected test command');
  });
  const start = vi.fn<NonNullable<InstallerDependencies['spawnDetached']>>().mockResolvedValue(undefined);
  const open = join(root, 'mock open.mjs');
  await writeFile(open, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./opened.jsonl', import.meta.url), JSON.stringify(process.argv.slice(2))+'\\n');
`, { mode: 0o700 });
  const options: PrepareUpdateInstallOptions = {
    update: { version: '0.2.4', filePath: file, sha256: 'a'.repeat(64), assetName: name },
    platform, executablePath: executable, userDataDirectory: userData, currentVersion: '0.2.3', parentPid: 2147483647,
    dependencies: { run, spawnDetached: start, helperCommands: { open } },
  };
  const receiptFile = join(userData, 'updates', 'installer', 'pending-install.json');
  const receipt = async () => JSON.parse(await readFile(receiptFile, 'utf8')) as { id: string; targetApp: string; stagedApp: string; backupApp: string; fromVersion: string; toVersion: string };
  return { root, target, source, executable, userData, file, run, start, options, receiptFile, receipt, open };
}

describe('prepared update installation', () => {
  it('stages a verified macOS bundle without replacing the running application', async () => {
    const f = await fixture();
    const plan = await prepareUpdateInstall(f.options);
    expect(await version(f.target)).toBe('0.2.3');
    expect(await version((await f.receipt()).stagedApp)).toBe('0.2.4');
    expect(f.run.mock.calls.filter(([command]) => command === '/usr/bin/codesign')).toEqual([
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', expect.stringContaining('extract-')]],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', (await f.receipt()).stagedApp]],
    ]);
    expect(f.start).not.toHaveBeenCalled();
    await Promise.all([plan.launch(), plan.launch()]);
    expect(f.start).toHaveBeenCalledTimes(1);
    const [shell, args] = f.start.mock.calls[0]!;
    expect(shell).toBe('/bin/sh');
    expect(args).toContain(f.target);
    if (process.platform !== 'win32') expect((await lstat(args[0]!)).mode & 0o777).toBe(0o700);
  });

  it('rejects the wrong bundle identity or version before creating an install plan', async () => {
    const f = await fixture();
    await bundle(f.source, '0.2.4', 'another.application');
    await expect(prepareUpdateInstall(f.options)).rejects.toThrow('UPDATE_INSTALL_FAILED');
    expect(await version(f.target)).toBe('0.2.3');
    await expect(lstat(f.receiptFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.start).not.toHaveBeenCalled();
    await bundle(f.source, '0.2.5');
    await expect(prepareUpdateInstall(f.options)).rejects.toThrow('UPDATE_INSTALL_FAILED');
  });

  it('keeps the old application when signature verification fails', async () => {
    const f = await fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args) => {
      if (command === '/usr/bin/codesign') throw new Error('private OS message');
      return original(command, args);
    });
    await expect(prepareUpdateInstall(f.options)).rejects.toThrow('UPDATE_INSTALL_FAILED');
    expect(await version(f.target)).toBe('0.2.3');
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(['0.2.3', '0.2.2', '0.2.4-beta.1', '99999999999999999999.0.0'])('rejects non-upgrade version %s', async candidate => {
    const f = await fixture();
    await expect(prepareUpdateInstall({ ...f.options, update: { ...f.options.update, version: candidate } })).rejects.toThrow('UPDATE_INSTALL_FAILED');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('rejects disk images, translocated apps, symlink bundles and unsupported platforms', async () => {
    const f = await fixture();
    await expect(prepareUpdateInstall({ ...f.options, executablePath: '/Volumes/AgentSwitcher/AgentSwitcher.app/Contents/MacOS/AgentSwitcher' })).rejects.toThrow();
    await expect(prepareUpdateInstall({ ...f.options, executablePath: '/private/var/AppTranslocation/id/d/AgentSwitcher.app/Contents/MacOS/AgentSwitcher' })).rejects.toThrow();
    const alias = join(f.root, 'Alias.app');
    await symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareUpdateInstall({ ...f.options, executablePath: join(alias, 'Contents/MacOS/AgentSwitcher') })).rejects.toThrow('UPDATE_INSTALL_FAILED');
    await expect(prepareUpdateInstall({ ...f.options, platform: 'linux' })).rejects.toThrow('UPDATE_UNSUPPORTED');
  });

  it('launches the Windows NSIS installer with an unquoted final original-directory argument', async () => {
    const f = await fixture('win32');
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.file, ['--updated', '--force-run', `/D=${dirname(f.executable)}`], {
      windowsVerbatimArguments: true, argv0: `"${f.file}"`,
    });
    expect(await readFile(f.executable, 'utf8')).toBe('old exe');
    expect(f.run).not.toHaveBeenCalled();
  });

  it('reports installer startup failure without replacing the application, and permits retry', async () => {
    const f = await fixture('win32');
    f.start.mockRejectedValueOnce(Object.assign(new Error('secret path must not escape'), { code: 'EACCES' }));
    const plan = await prepareUpdateInstall(f.options);
    await expect(plan.launch()).rejects.toThrow('UPDATE_PERMISSION_DENIED');
    await expect(plan.launch()).resolves.toBeUndefined();
    expect(await readFile(f.executable, 'utf8')).toBe('old exe');
  });

  it.skipIf(process.platform === 'win32')('refuses Windows argument quoting before launching an installer', async () => {
    const f = await fixture('win32');
    const unsafe = join(f.root, 'unsafe"setup.exe');
    await writeFile(unsafe, 'fixture');
    await expect(prepareUpdateInstall({ ...f.options, update: { ...f.options.update, filePath: unsafe } })).rejects.toThrow('UPDATE_INSTALL_LOCATION_INVALID');
  });
});

describe.skipIf(process.platform !== 'darwin')('macOS helper with disposable application fixtures', () => {
  it('performs atomic replacement, preserves a backup, and cleans only after healthy startup', async () => {
    const f = await fixture();
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    const [shell, args] = f.start.mock.calls[0]!;
    await execute(shell, args);
    const receipt = await f.receipt();
    expect(await version(f.target)).toBe('0.2.4');
    expect(await version(receipt.backupApp)).toBe('0.2.3');
    const opened = (await readFile(join(f.root, 'opened.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(opened).toEqual([['-n', f.target, '--args', `--user-data-dir=${f.userData}`]]);
    expect(await lstat(join(f.root, 'unexpected')).catch(() => null)).toBeNull();
    await completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.4', dependencies: { run: f.run } });
    expect(await version(f.target)).toBe('0.2.4');
    await expect(lstat(receipt.backupApp)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(f.receiptFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(args[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the old application if the second rename fails, and can prepare a retry', async () => {
    const f = await fixture();
    const move = join(f.root, 'failing move');
    await writeFile(move, '#!/bin/sh\ncase "$1" in *"/.AgentSwitcher-update-"*) exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o700 });
    f.options.dependencies!.helperCommands!.move = move;
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    const [shell, args] = f.start.mock.calls[0]!;
    await expect(execute(shell, args)).rejects.toMatchObject({ code: 1 });
    const previous = await f.receipt();
    expect(await version(f.target)).toBe('0.2.3');
    expect(await lstat(previous.backupApp).catch(() => null)).toBeNull();
    await prepareUpdateInstall(f.options);
    expect((await f.receipt()).id).not.toBe(previous.id);
    expect(await lstat(previous.stagedApp).catch(() => null)).toBeNull();
    expect(await version(f.target)).toBe('0.2.3');
  });

  it('reopens the unchanged old application when the first rename fails', async () => {
    const f = await fixture();
    const move = join(f.root, 'denied move');
    await writeFile(move, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    f.options.dependencies!.helperCommands!.move = move;
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    const [shell, args] = f.start.mock.calls[0]!;
    await expect(execute(shell, args)).rejects.toMatchObject({ code: 1 });
    expect(await version(f.target)).toBe('0.2.3');
    expect(await lstat((await f.receipt()).backupApp).catch(() => null)).toBeNull();
    expect(JSON.parse((await readFile(join(f.root, 'opened.jsonl'), 'utf8')).trim())).toEqual(['-n', f.target, '--args', `--user-data-dir=${f.userData}`]);
    await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.3', dependencies: { run: f.run } })).resolves.toBe('UPDATE_INSTALL_FAILED');
  });

  it('restores the old application if the new application cannot launch', async () => {
    const f = await fixture();
    await writeFile(f.open, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const info=JSON.parse(readFileSync(join(process.argv[3],'Contents','Info.plist'),'utf8'));
process.exit(info.CFBundleShortVersionString==='0.2.4'?1:0);
`, { mode: 0o700 });
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    const [shell, args] = f.start.mock.calls[0]!;
    await expect(execute(shell, args)).rejects.toMatchObject({ code: 1 });
    expect(await version(f.target)).toBe('0.2.3');
    expect(await version((await f.receipt()).stagedApp)).toBe('0.2.4');
  });

  it('bounds waiting for a live parent without stopping it or changing the application', async () => {
    const f = await fixture();
    const sleep = join(f.root, 'fast sleep');
    await writeFile(sleep, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    f.options.parentPid = process.pid;
    f.options.dependencies!.helperCommands!.sleep = sleep;
    const plan = await prepareUpdateInstall(f.options);
    await plan.launch();
    const [shell, args] = f.start.mock.calls[0]!;
    await expect(execute(shell, args)).rejects.toMatchObject({ code: 1 });
    expect(await version(f.target)).toBe('0.2.3');
    expect(await readFile(args[7]!, 'utf8')).toBe('UPDATE_PARENT_TIMEOUT\n');
    expect(await lstat((await f.receipt()).backupApp).catch(() => null)).toBeNull();
  });
});

describe('update receipt cleanup boundaries', () => {
  it('reports a failed update after rollback without throwing or deleting its recovery data', async () => {
    const f = await fixture();
    await prepareUpdateInstall(f.options);
    const receipt = await f.receipt();
    const result = join(dirname(f.receiptFile), `install-${receipt.id}.result`);
    for (const status of ['UPDATE_INSTALL_FAILED', 'UPDATE_PARENT_TIMEOUT']) {
      await writeFile(result, status + '\n');
      await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.3', dependencies: { run: f.run } })).resolves.toBe('UPDATE_INSTALL_FAILED');
      expect(await f.receipt()).toEqual(receipt);
      expect(await version(receipt.stagedApp)).toBe('0.2.4');
    }
  });

  it('does not report a failed update when a prepared plan has no result', async () => {
    const f = await fixture();
    await prepareUpdateInstall(f.options);
    await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.3', dependencies: { run: f.run } })).resolves.toBeNull();
    const receipt = await f.receipt();
    await writeFile(join(dirname(f.receiptFile), `install-${receipt.id}.result`), 'INSTALLED\n');
    await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.3', dependencies: { run: f.run } })).resolves.toBeNull();
  });

  it('does not remove a backup before the expected new version has loaded', async () => {
    const f = await fixture();
    await prepareUpdateInstall(f.options);
    const receipt = await f.receipt();
    await cp(f.target, receipt.backupApp, { recursive: true });
    await completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.3', dependencies: { run: f.run } });
    expect(await version(receipt.backupApp)).toBe('0.2.3');
  });

  it('rejects receipts pointing at unrelated folders or with non-UUID names', async () => {
    const f = await fixture();
    await prepareUpdateInstall(f.options);
    const original = await f.receipt();
    const unrelated = join(f.root, 'unrelated.app');
    await bundle(unrelated, '0.2.3');
    await writeFile(f.receiptFile, JSON.stringify({ ...original, backupApp: unrelated }));
    await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.4', dependencies: { run: f.run } })).rejects.toThrow('UPDATE_INSTALL_FAILED');
    expect(await version(unrelated)).toBe('0.2.3');
    await writeFile(f.receiptFile, JSON.stringify({ ...original, id: 'not-a-uuid' }));
    await expect(completePendingUpdate({ platform: 'darwin', executablePath: f.executable, userDataDirectory: f.userData, version: '0.2.4', dependencies: { run: f.run } })).rejects.toThrow('UPDATE_INSTALL_FAILED');
    expect(basename(original.backupApp)).toContain('.AgentSwitcher-backup-');
  });
});
