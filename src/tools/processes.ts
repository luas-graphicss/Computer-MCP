import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShellKind } from '../config.js';
import { IS_WINDOWS } from '../paths.js';
import { StreamingConsoleDecoder } from '../util/encoding.js';

export interface ShellInvocation {
  file: string;
  args: string[];
  shell: Exclude<ShellKind, 'auto'>;
  windowsVerbatimArguments?: boolean;
}

const availabilityCache = new Map<string, boolean>();

export function commandExists(cmd: string): boolean {
  const cached = availabilityCache.get(cmd);
  if (cached !== undefined) return cached;
  const probe = IS_WINDOWS
    ? spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  const found = probe.status === 0;
  availabilityCache.set(cmd, found);
  return found;
}

export function availableShells(): Exclude<ShellKind, 'auto'>[] {
  const candidates: Exclude<ShellKind, 'auto'>[] = IS_WINDOWS ? ['powershell', 'pwsh', 'cmd', 'bash'] : ['bash', 'zsh', 'sh'];
  return candidates.filter((s) => (s === 'cmd' ? true : commandExists(s)));
}

export function pickShell(requested: ShellKind, configured: ShellKind): Exclude<ShellKind, 'auto'> {
  const wanted = requested !== 'auto' ? requested : configured;
  if (wanted !== 'auto') return wanted;
  if (IS_WINDOWS) return commandExists('powershell') ? 'powershell' : 'cmd';
  if (commandExists('bash')) return 'bash';
  if (commandExists('zsh')) return 'zsh';
  return 'sh';
}


export function buildInvocation(command: string, shell: Exclude<ShellKind, 'auto'>): ShellInvocation {
  switch (shell) {
    case 'powershell':
    case 'pwsh': {
      const script = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ErrorActionPreference = 'Continue'",
        'try {',
        command,
        '} catch { Write-Error $_; exit 1 }',
        'if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 } else { exit 0 }'
      ].join('\n');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      return {
        file: shell === 'pwsh' ? 'pwsh' : 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        shell
      };
    }
    case 'cmd':
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
        shell,
        windowsVerbatimArguments: true
      };
    case 'bash':
    case 'zsh':
      return { file: shell, args: ['-lc', command], shell };
    case 'sh':
    default:
      return { file: 'sh', args: ['-c', command], shell: 'sh' };
  }
}

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (IS_WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {

    }
  }
}

export interface ExecOptions {
  command: string;
  cwd: string;
  shell: Exclude<ShellKind, 'auto'>;
  timeoutMs: number;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  onActivity?: (bytes: number) => void;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  shell: string;
}

export function execCommand(opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const inv = buildInvocation(opts.command, opts.shell);
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(inv.file, inv.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}), PYTHONIOENCODING: 'utf-8', PC_MCP: '1' },
        windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
        detached: !IS_WINDOWS,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      reject(err);
      return;
    }

    const outDec = new StreamingConsoleDecoder();
    const errDec = new StreamingConsoleDecoder();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const MAX_BUFFER = 8 * 1024 * 1024;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    const onAbort = () => killTree(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      opts.onActivity?.(chunk.length);
      if (stdout.length < MAX_BUFFER) stdout += outDec.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      opts.onActivity?.(chunk.length);
      if (stderr.length < MAX_BUFFER) stderr += errDec.write(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stdout += outDec.end();
      stderr += errDec.end();
      resolve({
        exitCode: code,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        shell: inv.shell
      });
    });

    if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}

export interface ManagedProcess {
  id: string;
  pid: number | undefined;
  name: string;
  command: string;
  cwd: string;
  shell: string;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  buffer: string;
  totalBytes: number;
  child: ChildProcess;
  logFile: string;
}

const PROCESS_BUFFER_LIMIT = 512 * 1024;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private counter = 0;

  constructor(private logsDir: string) {}

  start(params: {
    command: string;
    cwd: string;
    shell: Exclude<ShellKind, 'auto'>;
    name?: string;
    env?: Record<string, string>;
  }): ManagedProcess {
    const inv = buildInvocation(params.command, params.shell);
    const id = `p${++this.counter}`;
    const logFile = path.join(this.logsDir, `process-${id}.log`);
    const child = spawn(inv.file, inv.args, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env || {}), PYTHONIOENCODING: 'utf-8', PC_MCP: '1', FORCE_COLOR: '0' },
      windowsHide: true,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
      detached: !IS_WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const proc: ManagedProcess = {
      id,
      pid: child.pid,
      name: params.name || params.command.slice(0, 40),
      command: params.command,
      cwd: params.cwd,
      shell: inv.shell,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      running: true,
      buffer: '',
      totalBytes: 0,
      child,
      logFile
    };
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const outDec = new StreamingConsoleDecoder();
    const errDec = new StreamingConsoleDecoder();
    const push = (text: string) => {
      if (!text) return;
      proc.totalBytes += Buffer.byteLength(text);
      proc.buffer += text;
      if (proc.buffer.length > PROCESS_BUFFER_LIMIT) {
        proc.buffer = proc.buffer.slice(proc.buffer.length - PROCESS_BUFFER_LIMIT);
      }
      logStream.write(text);
    };
    child.stdout?.on('data', (chunk: Buffer) => push(outDec.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => push(errDec.write(chunk)));
    child.on('error', (err) => push(`\n[pc-mcp] erro ao iniciar processo: ${err.message}\n`));
    child.on('close', (code, signal) => {
      push(outDec.end() + errDec.end());
      proc.running = false;
      proc.exitCode = code;
      proc.signal = signal ?? null;
      proc.endedAt = Date.now();
      logStream.end();
    });
    this.processes.set(id, proc);
    return proc;
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  write(id: string, input: string): boolean {
    const proc = this.processes.get(id);
    if (!proc || !proc.running || !proc.child.stdin) return false;
    proc.child.stdin.write(input);
    return true;
  }

  kill(id: string): boolean {
    const proc = this.processes.get(id);
    if (!proc) return false;
    if (proc.running) killTree(proc.child);
    return true;
  }

  remove(id: string): void {
    const proc = this.processes.get(id);
    if (proc && !proc.running) this.processes.delete(id);
  }

  killAll(): void {
    for (const proc of this.processes.values()) if (proc.running) killTree(proc.child);
  }
}
