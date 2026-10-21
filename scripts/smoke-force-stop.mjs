// Windows-only integration test. The ONLY process this script permits taskkill
// to target is its own disposable Node helper, copied to a temp ChatGPT.exe.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { CodexProcess } from '../electron/platform/codex-process.ts';

if (process.platform !== 'win32') {
  console.log('Force-stop OS smoke skipped: Windows fixture test. macOS signals are covered by mock tests.');
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'agent-switcher-force-'));
const fixtureExecutable = join(directory, 'ChatGPT.exe');
const execute = promisify(execFile);
const commands = [];
let helper;
try {
  await copyFile(process.execPath, fixtureExecutable);
  helper = spawn(fixtureExecutable, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true, shell: false,
  });
  await once(helper, 'spawn');
  const fixturePid = helper.pid;
  assert(Number.isSafeInteger(fixturePid));
  const adapter = new CodexProcess({
    stopTimeoutMs: 1200, forceTimeoutMs: 5000, pollMs: 100,
    run: async (file, args, options = {}) => {
      if (file === 'taskkill.exe') {
        assert.equal(args[0], '/PID');
        assert.equal(args[1], String(fixturePid), 'Refusing to kill any process other than the fixture');
        assert(!args.includes('/IM'));
        commands.push([...args]);
      } else {
        assert.equal(file, 'powershell.exe');
        assert.equal(options.env?.AGENT_SWITCHER_DESKTOP_PATH, fixtureExecutable);
      }
      const result = await execute(file, args, {
        env: options.env, timeout: options.timeout ?? 10000,
        encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    },
  });
  const installation = { path: fixtureExecutable, kind: 'executable', label: 'Disposable test fixture' };
  assert.equal(await adapter.isRunning(installation), true);
  await adapter.stop(installation, { force: true });
  assert.equal(await adapter.isRunning(installation), false);
  assert(commands.some((args) => args.includes('/F')), 'The headless fixture must exercise force fallback');
  console.log('Windows force-stop smoke passed: graceful timeout → refreshed exact-path PID → taskkill /T /F → verified exit. Only the disposable helper was stopped.');
} finally {
  if (helper && helper.exitCode === null && helper.signalCode === null) {
    const exited = once(helper, 'exit').catch(() => undefined);
    helper.kill();
    await exited;
  }
  const absolute = resolve(directory);
  assert(absolute.startsWith(`${resolve(tmpdir())}${sep}`) && basename(absolute).startsWith('agent-switcher-force-'));
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
