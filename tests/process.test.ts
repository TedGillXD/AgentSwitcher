import { describe, expect, it, vi } from 'vitest'
import { CodexProcess, type CodexInstallation, type CommandRunner } from '../electron/platform/codex-process'

const desktop: CodexInstallation = {
  path: 'C:\\Users\\test\\AppData\\Local\\Programs\\Codex\\Codex.exe',
  kind: 'executable',
  label: 'Codex',
}
const macDesktop: CodexInstallation = {
  path: '/Applications/Codex.app',
  kind: 'app',
  label: 'Codex',
  executablePath: '/Applications/Codex.app/Contents/MacOS/Codex',
}
const result = (stdout = '') => ({ stdout, stderr: '' })

describe('Codex desktop process adapter', () => {
  it('detects an ordinary Windows desktop installation without Store discovery', async () => {
    const run = vi.fn<CommandRunner>()
    const adapter = new CodexProcess({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      exists: async (candidate) => candidate === desktop.path,
      run,
    })
    expect(await adapter.detect()).toEqual(desktop)
    expect(run).not.toHaveBeenCalled()
  })

  it('uses Store manifest discovery rather than a hard-coded AUMID', async () => {
    const storePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\Codex.exe'
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([{
      path: storePath, aumid: 'OpenAI.Codex_abc123!App', label: 'Codex',
    }])))
    const adapter = new CodexProcess({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\not-installed' },
      exists: async (candidate) => candidate === storePath,
      run,
    })
    expect(await adapter.detect()).toEqual({
      path: storePath, kind: 'store', aumid: 'OpenAI.Codex_abc123!App', label: 'Codex',
    })
    expect(run.mock.calls[0]![1].at(-1)).toContain('Get-AppxPackageManifest')
    expect(run.mock.calls[0]![1].at(-1)).toContain('Get-StartApps')
  })

  it('detects the unified OpenAI.Codex Store package whose main executable is ChatGPT.exe', async () => {
    const storePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([{
      path: storePath, packageName: 'OpenAI.Codex', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', label: 'Codex',
    }])))
    const adapter = new CodexProcess({
      platform: 'win32', run, exists: async (candidate) => candidate === storePath,
    })
    expect(await adapter.detect()).toEqual({
      path: storePath, kind: 'store', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', label: 'Codex',
    })
    const script = run.mock.calls[0]![1].at(-1)!
    expect(script).toContain("@('*Codex*', '*ChatGPT*')")
    expect(script).toContain('^(Codex|ChatGPT)\\.exe$')
  })

  it('preserves the exact preferred ChatGPT.exe path and AUMID from the Codex Store package', async () => {
    const storePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
    const otherPath = 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_1.0_x64__example\\app\\ChatGPT.exe'
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([
      { path: otherPath, packageName: 'OpenAI.ChatGPT', aumid: 'OpenAI.ChatGPT_example!Other', label: 'Other installation' },
      { path: storePath, packageName: 'OpenAI.Codex', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', label: 'Codex' },
    ])))
    const adapter = new CodexProcess({ platform: 'win32', run, exists: async () => true })
    expect(await adapter.detect(storePath)).toEqual({
      path: storePath, kind: 'store', aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', label: 'Codex',
    })
    expect(run.mock.calls[0]![1].at(-1)).toContain("@('*Codex*', '*ChatGPT*')")
  })

  it('prefers the Codex package identity even when ChatGPT is its executable name', async () => {
    const codexPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_version\\app\\ChatGPT.exe'
    const otherPath = 'C:\\Program Files\\WindowsApps\\OpenAI.ChatGPT_version\\app\\ChatGPT.exe'
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([
      { path: otherPath, packageName: 'OpenAI.ChatGPT', aumid: 'OpenAI.ChatGPT_example!App', label: 'ChatGPT' },
      { path: codexPath, packageName: 'OpenAI.Codex', aumid: 'OpenAI.Codex_example!App', label: 'Codex' },
    ])))
    const adapter = new CodexProcess({
      platform: 'win32', run, exists: async (candidate) => candidate === codexPath || candidate === otherPath,
    })
    expect((await adapter.detect())?.path).toBe(codexPath)
  })

  it('does not select bundled CLI executables returned by Store discovery', async () => {
    const cliPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_version\\app\\resources\\codex.exe'
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([{
      path: cliPath, packageName: 'OpenAI.Codex', aumid: 'OpenAI.Codex_example!Cli', label: 'Codex',
    }])))
    const adapter = new CodexProcess({
      platform: 'win32', run, exists: async (candidate) => candidate === cliPath,
    })
    expect(await adapter.detect()).toBeNull()
    expect(await adapter.detect(cliPath)).toBeNull()
  })

  it('rejects CLI binaries and relative paths even if they exist', async () => {
    const adapter = new CodexProcess({ platform: 'win32', exists: async () => true })
    expect(await adapter.detect('C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.exe')).toBeNull()
    expect(await adapter.detect('..\\Codex.exe')).toBeNull()
    expect(await adapter.detect('C:\\tools\\other.exe')).toBeNull()
  })

  it('matches exact Windows executable paths and excludes renderer and CLI processes', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([
      { pid: 100, path: desktop.path, commandLine: 'Codex.exe' },
      { pid: 101, path: desktop.path, commandLine: 'Codex.exe --type=renderer' },
      { pid: 103, path: desktop.path, commandLine: 'Codex.exe "--type=utility"' },
      { pid: 102, path: 'C:\\cli\\codex.exe', commandLine: 'codex exec task' },
    ])))
    const adapter = new CodexProcess({ platform: 'win32', run, sleep: async () => {} })
    expect(await adapter.isRunning(desktop)).toBe(true)
    expect(run.mock.calls[0]![2]?.env?.AGENT_SWITCHER_DESKTOP_PATH).toBe(desktop.path)
    expect(run.mock.calls[0]![1].at(-1)).not.toContain(desktop.path)
    expect(run.mock.calls[0]![1].at(-1)).toContain(`-Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'"`)
    expect(run.mock.calls[0]![2]?.timeout).toBe(30_000)
  })

  it('uses a separately configurable, bounded Windows query timeout for both discovery and process checks', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result('[]'))
    const adapter = new CodexProcess({
      platform: 'win32', run, exists: async () => false,
      powershellTimeoutMs: 45_000, stopTimeoutMs: 5_000,
    })
    expect(await adapter.detect()).toBeNull()
    expect(await adapter.isRunning(desktop)).toBe(false)
    expect(run.mock.calls).toHaveLength(2)
    expect(run.mock.calls.every(([, , options]) => options?.timeout === 45_000)).toBe(true)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120_001, 1000.5])(
    'rejects an unbounded or invalid PowerShell timeout %s', (powershellTimeoutMs) => {
      expect(() => new CodexProcess({ powershellTimeoutMs })).toThrow('PowerShell query timeout')
    },
  )

  it('gracefully closes only matched main PIDs and waits for exit', async () => {
    let checks = 0
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => {
      if (file === 'taskkill.exe') return result()
      checks++
      return result(JSON.stringify(checks <= 2 ? [
        { pid: 100, path: desktop.path },
        { pid: 101, path: desktop.path, commandLine: 'Codex.exe --type=gpu-process' },
        { pid: 102, path: 'C:\\cli\\codex.exe' },
      ] : []))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 100, pollMs: 10,
    })
    await adapter.stop(desktop)
    const kills = run.mock.calls.filter(([file]) => file === 'taskkill.exe')
    expect(kills).toHaveLength(1)
    expect(kills[0]![1]).toEqual(['/PID', '100', '/T'])
    expect(checks).toBe(3)
  })

  it('refuses to force a desktop application that did not close', async () => {
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => file === 'taskkill.exe'
      ? result() : result(JSON.stringify([{ pid: 100, path: desktop.path }])))
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 10, pollMs: 5,
    })
    await expect(adapter.stop(desktop)).rejects.toThrow('did not close gracefully')
    expect(run.mock.calls.flatMap(([, args]) => args)).not.toContain('/F')
    expect(run.mock.calls.flatMap(([, args]) => args)).not.toContain('/IM')
  })

  it('handles a process that already exited before taskkill ran', async () => {
    let checks = 0
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => {
      if (file === 'taskkill.exe') throw new Error('Process not found')
      return result(JSON.stringify(checks++ === 0 ? [{ pid: 100, path: desktop.path }] : []))
    })
    const adapter = new CodexProcess({ platform: 'win32', run, sleep: async () => {} })
    await expect(adapter.stop(desktop)).resolves.toBeUndefined()
  })

  it('does not force a desktop that closes normally even when force was allowed', async () => {
    let running = true
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => {
      if (file === 'taskkill.exe') { running = false; return result() }
      return result(JSON.stringify(running ? [{ pid: 100, path: desktop.path }] : []))
    })
    const adapter = new CodexProcess({ platform: 'win32', run, sleep: async () => {} })
    await adapter.stop(desktop, { force: true })
    expect(run.mock.calls.filter(([file]) => file === 'taskkill.exe').map(([, args]) => args))
      .toEqual([['/PID', '100', '/T']])
  })

  it('forces only freshly verified main desktop PIDs after graceful shutdown times out', async () => {
    let forced = false
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === 'taskkill.exe') {
        if (args.includes('/F')) forced = true
        return result()
      }
      return result(JSON.stringify(forced ? [] : [
        { pid: 100, path: desktop.path },
        { pid: 101, path: desktop.path, commandLine: 'Codex.exe --type=renderer' },
        { pid: 102, path: 'C:\\other\\Codex.exe' },
        { pid: 103, path: 'C:\\cli\\codex.exe' },
      ]))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await adapter.stop(desktop, { force: true })
    const kills = run.mock.calls.filter(([file]) => file === 'taskkill.exe')
    expect(kills.map(([, args]) => args)).toEqual([
      ['/PID', '100', '/T'], ['/PID', '100', '/T', '/F'],
    ])
    expect(run.mock.calls.filter(([file]) => file === 'powershell.exe')).toHaveLength(5)
    expect(run.mock.calls.flatMap(([, args]) => args)).not.toContain('/IM')
  })

  it('refreshes a replaced desktop PID before forcing and never forces the stale original PID', async () => {
    let graceAttempted = false
    let forced = false
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === 'taskkill.exe') {
        if (args.includes('/F')) forced = true
        else graceAttempted = true
        return result()
      }
      const pid = graceAttempted ? 200 : 100
      return result(JSON.stringify(forced ? [] : [{ pid, path: desktop.path }]))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await adapter.stop(desktop, { force: true })
    expect(run.mock.calls.filter(([file]) => file === 'taskkill.exe').map(([, args]) => args))
      .toEqual([['/PID', '100', '/T'], ['/PID', '200', '/T', '/F']])
  })

  it('skips force candidates whose PID no longer belongs to the desktop at final verification', async () => {
    let checks = 0
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => {
      if (file === 'taskkill.exe') return result()
      checks++
      return result(JSON.stringify([{ pid: 100, path: checks <= 3 ? desktop.path : 'C:\\other\\Codex.exe' }]))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await adapter.stop(desktop, { force: true })
    expect(run.mock.calls.filter(([file]) => file === 'taskkill.exe').map(([, args]) => args))
      .toEqual([['/PID', '100', '/T']])
  })

  it('accepts a force command error when the verified desktop has already exited', async () => {
    let running = true
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === 'taskkill.exe') {
        if (args.includes('/F')) { running = false; throw new Error('Process already exited') }
        return result()
      }
      return result(JSON.stringify(running ? [{ pid: 100, path: desktop.path }] : []))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await expect(adapter.stop(desktop, { force: true })).resolves.toBeUndefined()
    expect(run.mock.calls.some(([file, args]) => file === 'taskkill.exe' && args.includes('/F'))).toBe(true)
  })

  it('reports failure when the desktop remains alive after force termination', async () => {
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === 'taskkill.exe') {
        if (args.includes('/F')) throw new Error('Access denied')
        return result()
      }
      return result(JSON.stringify([{ pid: 100, path: desktop.path }]))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await expect(adapter.stop(desktop, { force: true })).rejects.toThrow('did not stop after force termination')
  })

  it('uses the separately bounded force wait before reporting a desktop that remains alive', async () => {
    let checksAfterForce = 0
    let forced = false
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === 'taskkill.exe') {
        if (args.includes('/F')) forced = true
        return result()
      }
      if (forced) checksAfterForce++
      return result(JSON.stringify([{ pid: 100, path: desktop.path }]))
    })
    const adapter = new CodexProcess({
      platform: 'win32', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 300, pollMs: 100,
    })
    await expect(adapter.stop(desktop, { force: true })).rejects.toThrow('did not stop after force termination')
    expect(checksAfterForce).toBe(3)
  })

  it('launches the selected Windows executable without shell interpolation', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined)
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([{ pid: 100, path: desktop.path }])))
    const adapter = new CodexProcess({
      platform: 'win32', run, spawn, env: { ELECTRON_RUN_AS_NODE: '1' },
    })
    await adapter.launch(desktop, { CODEX_HOME: 'C:\\Custom Codex' })
    expect(spawn).toHaveBeenCalledWith(desktop.path, [], expect.objectContaining({ CODEX_HOME: 'C:\\Custom Codex' }))
    expect(spawn.mock.calls[0]![2]).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('activates Store applications with the discovered AUMID', async () => {
    const spawn = vi.fn().mockResolvedValue(undefined)
    const installation: CodexInstallation = { ...desktop, kind: 'store', aumid: 'OpenAI.Codex_123!App' }
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(JSON.stringify([{ pid: 100, path: desktop.path }])))
    const adapter = new CodexProcess({ platform: 'win32', run, spawn })
    await adapter.launch(installation)
    expect(spawn).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_123!App'], expect.any(Object))
  })

  it('reports launch failure when a spawned process never becomes a desktop application', async () => {
    const adapter = new CodexProcess({
      platform: 'win32', spawn: async () => {}, run: async () => result('[]'),
      sleep: async () => {}, launchTimeoutMs: 10, pollMs: 5,
    })
    await expect(adapter.launch(desktop)).rejects.toThrow('did not start')
  })

  it('looks up the actual executable in a macOS app bundle', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result('Codex\n'))
    const adapter = new CodexProcess({
      platform: 'darwin', run, exists: async (candidate) =>
        candidate === macDesktop.path || candidate === macDesktop.executablePath,
    })
    expect(await adapter.detect()).toEqual(macDesktop)
    expect(run).toHaveBeenCalledWith('/usr/bin/plutil', [
      '-extract', 'CFBundleExecutable', 'raw', '-o', '-', '/Applications/Codex.app/Contents/Info.plist',
    ], expect.any(Object))
  })

  it.each(['/Applications/ChatGPT.app', '/Users/test/Applications/ChatGPT.app'])(
    'falls back to the unified macOS desktop bundle %s after Codex locations', async (bundle) => {
    const executablePath = `${bundle}/Contents/MacOS/ChatGPT`
    const run = vi.fn<CommandRunner>().mockResolvedValue(result('ChatGPT\n'))
    const checkedPaths: string[] = []
    const adapter = new CodexProcess({
      platform: 'darwin', home: '/Users/test', run,
      exists: async (candidate) => {
        checkedPaths.push(candidate)
        return candidate === bundle || candidate === executablePath
      },
    })
    expect(await adapter.detect()).toEqual({ path: bundle, kind: 'app', label: 'ChatGPT', executablePath })
    expect(checkedPaths.slice(0, 2)).toEqual(['/Applications/Codex.app', '/Users/test/Applications/Codex.app'])
  })

  it('matches the macOS bundle main executable exactly, including spaces', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result([
      '100 /Applications/Codex.app/Contents/MacOS/Codex',
      '101 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper',
      '102 /usr/local/bin/codex',
      '103 /Applications/Other Codex.app/Contents/MacOS/Codex',
    ].join('\n')))
    const adapter = new CodexProcess({ platform: 'darwin', run })
    expect(await adapter.isRunning(macDesktop)).toBe(true)
    run.mockResolvedValueOnce(result('102 /usr/local/bin/codex'))
    expect(await adapter.isRunning(macDesktop)).toBe(false)
  })

  it('uses graceful SIGTERM for macOS and opens the app bundle', async () => {
    let running = true
    const run = vi.fn<CommandRunner>().mockImplementation(async (file) => {
      if (file === '/bin/kill') running = false
      if (file === '/usr/bin/open') running = true
      return result(file === '/bin/ps' && running ? '100 /Applications/Codex.app/Contents/MacOS/Codex' : '')
    })
    const adapter = new CodexProcess({
      platform: 'darwin', run, sleep: async () => {}, env: { CODEX_HOME: '' },
    })
    await adapter.stop(macDesktop)
    await adapter.launch(macDesktop)
    expect(run).toHaveBeenCalledWith('/bin/kill', ['-TERM', '100'], expect.any(Object))
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', '/Applications/Codex.app'], expect.any(Object))
  })

  it('falls back to SIGKILL on macOS only after an opted-in graceful timeout', async () => {
    let forced = false
    const run = vi.fn<CommandRunner>().mockImplementation(async (file, args) => {
      if (file === '/bin/kill' && args[0] === '-KILL') forced = true
      return result(file === '/bin/ps' && !forced ? [
        '100 /Applications/Codex.app/Contents/MacOS/Codex',
        '101 /Applications/Other Codex.app/Contents/MacOS/Codex',
        '102 /usr/local/bin/codex',
      ].join('\n') : '')
    })
    const adapter = new CodexProcess({
      platform: 'darwin', run, sleep: async () => {}, stopTimeoutMs: 1, forceTimeoutMs: 1, pollMs: 1,
    })
    await adapter.stop(macDesktop, { force: true })
    expect(run.mock.calls.filter(([file]) => file === '/bin/kill').map(([, args]) => args))
      .toEqual([['-TERM', '100'], ['-KILL', '100']])
  })

  it('explicitly passes the configured Codex home through macOS LaunchServices', async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue(result('100 /Applications/Codex.app/Contents/MacOS/Codex'))
    const adapter = new CodexProcess({ platform: 'darwin', run, env: { CODEX_HOME: '' } })
    await adapter.launch(macDesktop, { CODEX_HOME: '/Users/test/Custom Codex' })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', [
      '-a', '/Applications/Codex.app', '--env', 'CODEX_HOME=/Users/test/Custom Codex',
    ], expect.any(Object))
  })

  it.each(['Codex', 'ChatGPT'])('opens a fresh chat in the selected macOS %s bundle after a provider change', async (name) => {
    const installation = {
      ...macDesktop, path: `/Applications/${name}.app`,
      executablePath: `/Applications/${name}.app/Contents/MacOS/${name}`,
    }
    const run = vi.fn<CommandRunner>().mockResolvedValue(result(`100 ${installation.executablePath}`))
    const adapter = new CodexProcess({ platform: 'darwin', run, env: { CODEX_HOME: '' } })
    await adapter.launch(installation, { CODEX_HOME: '/Users/test/Custom Codex' }, { newThread: true })
    // Inspect only the command arguments: assertion failures must not dump the host environment.
    expect(run.mock.calls.find(([file]) => file === '/usr/bin/open')?.[1]).toEqual([
      '-a', installation.path, '--env', 'CODEX_HOME=/Users/test/Custom Codex', 'codex://threads/new?mode=codex',
    ])
  })

  it('returns null on unsupported platforms and never executes a command', async () => {
    const run = vi.fn<CommandRunner>()
    const adapter = new CodexProcess({ platform: 'linux', run })
    expect(await adapter.detect()).toBeNull()
    await expect(adapter.launch(desktop)).rejects.toThrow('Unsupported')
    expect(run).not.toHaveBeenCalled()
  })
})
