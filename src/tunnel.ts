import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { IS_WINDOWS, humanSize } from './paths.js';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function assetName(): { asset: string; archive: boolean } {
  const arch = os.arch();
  if (IS_WINDOWS) {
    if (arch === 'x64') return { asset: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { asset: 'cloudflared-windows-386.exe', archive: false };
    throw new Error(`cloudflared nao tem build para Windows ${arch}; use --public-url com outro tunel`);
  }
  if (process.platform === 'darwin') {
    return { asset: arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz', archive: true };
  }
  const linux: Record<string, string> = { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' };
  const asset = linux[arch];
  if (!asset) throw new Error(`cloudflared nao tem build para ${process.platform} ${arch}`);
  return { asset, archive: false };
}

function onPath(cmd: string): string | undefined {
  const probe = IS_WINDOWS ? spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true }) : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  if (probe.status !== 0) return undefined;
  const first = (probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || undefined;
}

export async function ensureCloudflared(config: Config, log: Logger): Promise<string> {
  const fromPath = onPath('cloudflared');
  if (fromPath) return fromPath;
  const binDir = path.join(config.dataDir, 'bin');
  const binary = path.join(binDir, IS_WINDOWS ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(binary)) return binary;

  const { asset, archive } = assetName();
  const url = `${RELEASES}/${asset}`;
  log.info(`Baixando cloudflared (uma vez so) de ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar cloudflared: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${binary}.download`;
  let received = 0;
  let lastLog = 0;
  const { Transform } = await import('node:stream');
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (Date.now() - lastLog > 1000) {
        lastLog = Date.now();
        process.stdout.write(`\r  ${humanSize(received)}${total ? ` / ${humanSize(total)}` : ''}   `);
      }
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, fs.createWriteStream(tmp));
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  if (archive) {
    const extractDir = path.join(binDir, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tmp, '-C', extractDir], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`Falha ao extrair cloudflared: ${tar.stderr}`);
    await fsp.rename(path.join(extractDir, 'cloudflared'), binary);
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.rm(tmp, { force: true });
  } else {
    await fsp.rename(tmp, binary);
  }
  if (!IS_WINDOWS) await fsp.chmod(binary, 0o755);
  log.ok(`cloudflared instalado em ${binary}`);
  return binary;
}

export interface TunnelEvents {
  url: (url: string) => void;
  down: (reason: string) => void;
}

export class Tunnel extends EventEmitter {
  url?: string;
  private child?: ChildProcess;
  private stopping = false;
  private attempts = 0;
  private binary?: string;

  constructor(
    private config: Config,
    private log: Logger
  ) {
    super();
  }

  async start(): Promise<void> {
    this.binary = await ensureCloudflared(this.config, this.log);
    this.spawnTunnel();
  }

  private spawnTunnel(): void {
    if (!this.binary || this.stopping) return;
    const local = `http://127.0.0.1:${this.config.port}`;
    const args = this.config.cloudflaredToken
      ? ['tunnel', '--no-autoupdate', 'run', '--token', this.config.cloudflaredToken, '--url', local]
      : ['tunnel', '--no-autoupdate', '--url', local];
    this.attempts++;
    this.log.debug(`iniciando cloudflared (tentativa ${this.attempts})`);
    const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) this.handleLine(line);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      this.log.error(`cloudflared nao pode ser executado: ${err.message}`);
      this.scheduleRestart('erro ao executar');
    });
    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      const reason = `cloudflared encerrou (${code ?? signal})`;
      if (this.url) {
        this.emit('down', reason);
        this.url = undefined;
      }
      this.scheduleRestart(reason);
    });
  }

  private handleLine(line: string): void {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
    if (match && !this.config.cloudflaredToken && this.url !== match[0]) {
      this.url = match[0];
      this.attempts = 0;
      this.emit('url', this.url);
      return;
    }
    if (/Registered tunnel connection/i.test(line)) {
      this.log.debug('tunel conectado a borda da Cloudflare');
      if (this.config.cloudflaredToken && this.config.publicUrl && this.url !== this.config.publicUrl) {
        this.url = this.config.publicUrl;
        this.emit('url', this.url);
      }
      return;
    }
    if (/ERR|error|failed/i.test(line) && !/context canceled/i.test(line)) {
      this.log.debug(`cloudflared: ${line.replace(/^\S+\s+/, '')}`);
    }
  }

  private scheduleRestart(reason: string): void {
    if (this.stopping) return;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.attempts, 4));
    this.log.warn(`${reason}; tentando reconectar o tunel em ${Math.round(delay / 1000)}s`);
    setTimeout(() => this.spawnTunnel(), delay).unref();
  }

  stop(): void {
    this.stopping = true;
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {

      }
    }
  }
}
