import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export interface CodexInstallation {
  /** Absolute desktop executable or macOS .app bundle path. */
  path: string
  kind: 'executable' | 'app' | 'store'
  label: string
  /** Store activation ID; never used as executable command text. */
  aumid?: string
  /** Exact main executable inside a macOS bundle. */
  executablePath?: string
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv
  timeout?: number
}

export interface StopOptions {
  /** Explicitly allow force termination after the normal close timeout. */
  force?: boolean
}

export interface LaunchOptions {
  /** Open a fresh chat on macOS so a restored thread cannot override the new provider. */
  newThread?: boolean
}

export type CommandRunner = (
  file: string,
  args: string[],
  options?: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>

export type AppSpawner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<void>

export interface CodexProcessOptions {
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
  run?: CommandRunner
  spawn?: AppSpawner
  exists?: (filePath: string, kind: 'file' | 'directory') => Promise<boolean>
  sleep?: (milliseconds: number) => Promise<void>
  stopTimeoutMs?: number
  forceTimeoutMs?: number
  launchTimeoutMs?: number
  /** Bounds each Windows system query, including a cold PowerShell/WMI startup. */
  powershellTimeoutMs?: number
  pollMs?: number
}

const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeout ?? 10_000,
        maxBuffer: 2 * 1024 * 1024,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      },
    )
  })

const spawnApp: AppSpawner = (file, args, env) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(file, args, {
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

const fileExists = async (filePath: string, kind: 'file' | 'directory'): Promise<boolean> => {
  try {
    const info = await stat(filePath)
    return kind === 'directory' ? info.isDirectory() : info.isFile()
  } catch {
    return false
  }
}

// Paths and IDs travel through environment variables, never interpolated into
// PowerShell code. Enumerating exact executable paths avoids killing Codex CLI.
const WINDOWS_PROCESS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$target = $env:AGENT_SWITCHER_DESKTOP_PATH
$targetName = [System.IO.Path]::GetFileName($target)
# Filter in CIM before materializing records; only these desktop image names
# are supported, so no user-controlled text enters a WQL expression.
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object {
  $_.Name -ieq $targetName -and $_.ExecutablePath -ieq $target -and
  $_.CommandLine -notmatch '(?:^|[\\s\x22])--type(?:=|[\\s\x22])'
} | ForEach-Object {
  [PSCustomObject]@{ pid = [int]$_.ProcessId; path = $_.ExecutablePath; commandLine = $_.CommandLine }
})
ConvertTo-Json -InputObject $matches -Compress
`

const WINDOWS_STORE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$startApps = @(Get-StartApps -ErrorAction SilentlyContinue)
$packages = @(foreach ($pattern in @('*Codex*', '*ChatGPT*')) {
  Get-AppxPackage -Name $pattern -ErrorAction SilentlyContinue
}) | Sort-Object -Property PackageFullName -Unique
$matches = @(foreach ($package in $packages) {
  try {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
    foreach ($entry in $manifest.Package.Applications.Application) {
      # The OpenAI.Codex package currently launches app\\ChatGPT.exe. The
      # executable basename and the package identity are independent.
      $executableName = [System.IO.Path]::GetFileName($entry.Executable)
      if ($executableName -inotmatch '^(Codex|ChatGPT)\\.exe$') { continue }
      $aumid = $package.PackageFamilyName + '!' + $entry.Id
      $startEntry = $startApps | Where-Object { $_.AppID -eq $aumid } | Select-Object -First 1
      [PSCustomObject]@{
        path = Join-Path $package.InstallLocation $entry.Executable
        packageName = $package.Name
        aumid = $aumid
        label = $(if ($startEntry) { $startEntry.Name } else { [System.IO.Path]::GetFileNameWithoutExtension($executableName) })
      }
    }
  } catch { }
})
ConvertTo-Json -InputObject $matches -Compress
`

interface WindowsProcessRecord {
  pid: number
  path: string
  commandLine?: string
}

interface StoreRecord {
  path: string
  aumid: string
  label: string
  packageName?: string
}

function jsonArray<T>(input: string): T[] {
  const clean = input.trim().replace(/^\uFEFF/, '')
  if (!clean) return []
  const parsed: unknown = JSON.parse(clean)
  if (parsed === null) return []
  return (Array.isArray(parsed) ? parsed : [parsed]) as T[]
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function safePath(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001F]/.test(value)
}

function isBundledCliPath(value: string): boolean {
  return /[\\/](?:resources|node_modules|vendor|bin)[\\/]/i.test(value)
}

export class CodexProcess {
  private readonly platform: NodeJS.Platform
  private readonly home: string
  private readonly env: NodeJS.ProcessEnv
  private readonly run: CommandRunner
  private readonly spawn: AppSpawner
  private readonly exists: NonNullable<CodexProcessOptions['exists']>
  private readonly sleep: NonNullable<CodexProcessOptions['sleep']>
  private readonly stopTimeoutMs: number
  private readonly forceTimeoutMs: number
  private readonly launchTimeoutMs: number
  private readonly powershellTimeoutMs: number
  private readonly pollMs: number

  constructor(options: CodexProcessOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? homedir()
    this.env = { ...process.env, ...options.env }
    this.run = options.run ?? runCommand
    this.spawn = options.spawn ?? spawnApp
    this.exists = options.exists ?? fileExists
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000
    this.forceTimeoutMs = options.forceTimeoutMs ?? 5_000
    this.launchTimeoutMs = options.launchTimeoutMs ?? 12_000
    // First use of Windows PowerShell and CIM can exceed ten seconds on an
    // ARM64 machine. This query budget is separate from the shutdown grace wait.
    this.powershellTimeoutMs = options.powershellTimeoutMs ?? 30_000
    if (!Number.isInteger(this.powershellTimeoutMs) || this.powershellTimeoutMs < 1 || this.powershellTimeoutMs > 120_000) {
      throw new Error('PowerShell query timeout must be an integer between 1 and 120000 milliseconds')
    }
    this.pollMs = options.pollMs ?? 300
  }

  async detect(preferredPath?: string): Promise<CodexInstallation | null> {
    if (this.platform !== 'win32' && this.platform !== 'darwin') return null
    if (preferredPath?.trim()) return this.detectPreferred(preferredPath.trim())

    if (this.platform === 'darwin') {
      for (const candidate of [
        '/Applications/Codex.app', path.posix.join(this.home, 'Applications/Codex.app'),
        '/Applications/ChatGPT.app', path.posix.join(this.home, 'Applications/ChatGPT.app'),
      ]) {
        const result = await this.macInstallation(candidate)
        if (result) return result
      }
      return null
    }

    const candidates = [
      this.env.LOCALAPPDATA && path.win32.join(this.env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe'),
      this.env.LOCALAPPDATA && path.win32.join(this.env.LOCALAPPDATA, 'Codex', 'Codex.exe'),
      this.env.LOCALAPPDATA && path.win32.join(this.env.LOCALAPPDATA, 'Programs', 'OpenAI Codex', 'Codex.exe'),
      this.env.ProgramFiles && path.win32.join(this.env.ProgramFiles, 'Codex', 'Codex.exe'),
      this.env['ProgramFiles(x86)'] && path.win32.join(this.env['ProgramFiles(x86)']!, 'Codex', 'Codex.exe'),
    ].filter((candidate): candidate is string => typeof candidate === 'string')
    for (const candidate of candidates) {
      if (await this.exists(candidate, 'file')) return { path: candidate, kind: 'executable', label: 'Codex' }
    }
    return (await this.storeInstallations('Codex'))[0] ?? null
  }

  async isRunning(installation: CodexInstallation): Promise<boolean> {
    return (await this.runningPids(installation)).length > 0
  }

  async stop(installation: CodexInstallation, options: StopOptions = {}): Promise<void> {
    this.assertSupported(installation)
    const pids = await this.runningPids(installation)
    if (pids.length === 0) return

    for (const pid of pids) {
      try {
        if (this.platform === 'win32') {
          // Give the desktop a chance to close normally before any opted-in force.
          await this.run('taskkill.exe', ['/PID', String(pid), '/T'], { env: this.env })
        } else {
          await this.run('/bin/kill', ['-TERM', String(pid)], { env: this.env })
        }
      } catch {
        // The process may already have exited; verify below instead of assuming.
      }
    }

    if (await this.waitForState(installation, false, this.stopTimeoutMs)) return
    if (!options.force) {
      throw new Error('Codex did not close gracefully. Close its windows and try again.')
    }

    // The original PID may have exited or been reused during the grace period.
    // Refresh exact-path main processes, and verify each candidate again directly
    // before force termination. Never kill by image name or reuse the initial list.
    const remaining = await this.runningPids(installation)
    for (const pid of remaining) {
      if (!(await this.runningPids(installation)).includes(pid)) continue
      try {
        if (this.platform === 'win32') {
          await this.run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            env: this.env, timeout: this.forceTimeoutMs,
          })
        } else {
          await this.run('/bin/kill', ['-KILL', String(pid)], {
            env: this.env, timeout: this.forceTimeoutMs,
          })
        }
      } catch {
        // A process can exit between verification and termination. Only the final
        // exact-path check determines success, including permission failures.
      }
    }
    if (!(await this.waitForState(installation, false, this.forceTimeoutMs))) {
      throw new Error('Codex did not stop after force termination. Check application permissions and try again.')
    }
  }

  async launch(installation: CodexInstallation, env?: NodeJS.ProcessEnv, options: LaunchOptions = {}): Promise<void> {
    this.assertSupported(installation)
    const launchEnv = env ? { ...env } : { ...this.env }
    // AgentSwitcher can itself have been started by a Node tooling host. Passing
    // this Electron-specific flag would launch Codex as Node instead of a GUI.
    delete launchEnv.ELECTRON_RUN_AS_NODE
    try {
      if (installation.kind === 'app') {
        const args = ['-a', installation.path]
        // LaunchServices does not reliably inherit a shell environment. This
        // non-secret path is explicitly supplied to the new app instance.
        if (launchEnv.CODEX_HOME) args.push('--env', `CODEX_HOME=${launchEnv.CODEX_HOME}`)
        // Existing desktop chats resume with their saved modelProvider. Changing
        // config.toml alone can pair a new API model with the old ChatGPT provider.
        // Unified ChatGPT.app also has Chat/Work modes; explicitly select Codex.
        if (options.newThread) args.push('codex://threads/new?mode=codex')
        await this.run('/usr/bin/open', args, { env: launchEnv })
      } else if (installation.kind === 'store') {
        if (!installation.aumid || !/^[\w.-]+![\w.-]+$/.test(installation.aumid)) {
          throw new Error('Invalid Microsoft Store application ID')
        }
        await this.spawn('explorer.exe', [`shell:AppsFolder\\${installation.aumid}`], launchEnv)
      } else {
        await this.spawn(installation.path, [], launchEnv)
      }
    } catch {
      throw new Error('Could not launch Codex. Check its application path in Settings.')
    }
    if (!(await this.waitForState(installation, true, this.launchTimeoutMs))) {
      throw new Error('Codex did not start. Check its application path in Settings.')
    }
  }

  private async detectPreferred(preferredPath: string): Promise<CodexInstallation | null> {
    if (!safePath(preferredPath)) return null
    if (this.platform === 'darwin') {
      if (!path.posix.isAbsolute(preferredPath) || !preferredPath.endsWith('.app')) return null
      return this.macInstallation(path.posix.normalize(preferredPath))
    }
    if (!path.win32.isAbsolute(preferredPath) || !/^(codex|chatgpt)\.exe$/i.test(path.win32.basename(preferredPath))) {
      return null
    }
    // A user selecting the bundled CLI must not cause us to terminate CLI tasks.
    if (isBundledCliPath(preferredPath)) return null
    const normalized = path.win32.normalize(preferredPath)
    if (!(await this.exists(normalized, 'file'))) return null
    const name = /^chatgpt\.exe$/i.test(path.win32.basename(normalized)) ? 'ChatGPT' : 'Codex'
    if (/[\\/]WindowsApps[\\/]/i.test(normalized)) {
      return (await this.storeInstallations(name)).find((entry) => this.samePath(entry.path, normalized)) ?? null
    }
    return { path: normalized, kind: 'executable', label: name }
  }

  private async macInstallation(bundlePath: string): Promise<CodexInstallation | null> {
    if (!(await this.exists(bundlePath, 'directory'))) return null
    try {
      const { stdout } = await this.run('/usr/bin/plutil', [
        '-extract', 'CFBundleExecutable', 'raw', '-o', '-',
        path.posix.join(bundlePath, 'Contents', 'Info.plist'),
      ], { env: this.env })
      const executable = stdout.trim()
      if (!/^(Codex|ChatGPT)$/i.test(executable)) return null
      const executablePath = path.posix.join(bundlePath, 'Contents', 'MacOS', executable)
      if (!(await this.exists(executablePath, 'file'))) return null
      return {
        path: bundlePath,
        kind: 'app',
        label: path.posix.basename(bundlePath, '.app'),
        executablePath,
      }
    } catch {
      return null
    }
  }

  private async storeInstallations(name: 'Codex' | 'ChatGPT'): Promise<CodexInstallation[]> {
    try {
      const { stdout } = await this.powershell(WINDOWS_STORE_SCRIPT, {
        AGENT_SWITCHER_DESKTOP_NAME: name,
      })
      const entries = jsonArray<StoreRecord>(stdout).sort((a, b) => {
        const preferred = name.toLowerCase()
        const rank = (entry: StoreRecord) => typeof entry.packageName === 'string' &&
          entry.packageName.toLowerCase().includes(preferred) ? 0 : 1
        return rank(a) - rank(b)
      })
      const found: CodexInstallation[] = []
      for (const entry of entries) {
        if (
          typeof entry.path !== 'string' || !safePath(entry.path) || !path.win32.isAbsolute(entry.path) ||
          !/^(codex|chatgpt)\.exe$/i.test(path.win32.basename(entry.path)) || isBundledCliPath(entry.path) ||
          typeof entry.aumid !== 'string' || !/^[\w.-]+![\w.-]+$/.test(entry.aumid)
        ) continue
        if (found.some((candidate) => this.samePath(candidate.path, entry.path))) continue
        if (!(await this.exists(entry.path, 'file'))) continue
        found.push({
          path: path.win32.normalize(entry.path),
          kind: 'store',
          aumid: entry.aumid,
          label: typeof entry.label === 'string' ? entry.label : `${name} (Microsoft Store)`,
        })
      }
      return found
    } catch {
      return []
    }
  }

  private async runningPids(installation: CodexInstallation): Promise<number[]> {
    this.assertSupported(installation)
    if (this.platform === 'win32') {
      const { stdout } = await this.powershell(WINDOWS_PROCESS_SCRIPT, {
        AGENT_SWITCHER_DESKTOP_PATH: installation.path,
      })
      return jsonArray<WindowsProcessRecord>(stdout)
        .filter((record) => validPid(record.pid) && record.pid !== process.pid &&
          typeof record.path === 'string' && this.samePath(record.path, installation.path) &&
          !/(?:^|[\s"])--type(?:=|[\s"])/.test(record.commandLine ?? ''))
        .map((record) => record.pid)
    }
    const executable = installation.executablePath ?? path.posix.join(
      installation.path, 'Contents', 'MacOS', path.posix.basename(installation.path, '.app'),
    )
    const { stdout } = await this.run('/bin/ps', ['-ww', '-axo', 'pid=,comm='], { env: this.env })
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) return []
      const pid = Number(match[1])
      return validPid(pid) && pid !== process.pid && match[2] === executable ? [pid] : []
    })
  }

  private powershell(script: string, extraEnv: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...this.env, ...extraEnv },
      timeout: this.powershellTimeoutMs,
    })
  }

  private samePath(a: string, b: string): boolean {
    return this.platform === 'win32'
      ? path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
      : path.posix.normalize(a) === path.posix.normalize(b)
  }

  private assertSupported(installation: CodexInstallation): void {
    const compatible = this.platform === 'darwin' ? installation.kind === 'app' :
      this.platform === 'win32' && (installation.kind === 'executable' || installation.kind === 'store')
    const absolute = this.platform === 'win32' ? path.win32.isAbsolute(installation.path) :
      path.posix.isAbsolute(installation.path)
    if (!compatible || !absolute || !safePath(installation.path)) {
      throw new Error('Unsupported Codex desktop application path')
    }
  }

  private async waitForState(installation: CodexInstallation, running: boolean, timeoutMs: number): Promise<boolean> {
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, this.pollMs)))
    const deadline = Date.now() + timeoutMs
    for (let index = 0; index < attempts; index++) {
      if (await this.isRunning(installation) === running) return true
      if (Date.now() >= deadline || index === attempts - 1) return false
      await this.sleep(this.pollMs)
    }
    return false
  }
}
