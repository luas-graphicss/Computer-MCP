import fs from 'node:fs';
import path from 'node:path';

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
export const c = {
  dim: paint('2'),
  bold: paint('1'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  cyan: paint('36'),
  magenta: paint('35'),
  gray: paint('90')
};

function stamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export interface ActivityEntry {
  ts: string;
  kind: 'tool' | 'http' | 'auth' | 'system';
  name: string;
  summary?: string;
  ok?: boolean;
  ms?: number;
  via?: string;
}

export class Logger {
  private activityFile?: string;
  constructor(
    private verbose: boolean,
    logsDir?: string
  ) {
    if (logsDir) this.activityFile = path.join(logsDir, 'activity.log');
  }

  info(msg: string): void {
    console.log(`${c.gray(stamp())} ${msg}`);
  }
  ok(msg: string): void {
    console.log(`${c.gray(stamp())} ${c.green('OK')} ${msg}`);
  }
  warn(msg: string): void {
    console.log(`${c.gray(stamp())} ${c.yellow('AVISO')} ${msg}`);
  }
  error(msg: string): void {
    console.error(`${c.gray(stamp())} ${c.red('ERRO')} ${msg}`);
  }
  debug(msg: string): void {
    if (this.verbose) console.log(`${c.gray(stamp())} ${c.dim(msg)}`);
  }

  activity(entry: Omit<ActivityEntry, 'ts'>): void {
    const full: ActivityEntry = { ts: new Date().toISOString(), ...entry };
    if (entry.kind === 'tool') {
      const status = entry.ok === false ? c.red('falhou') : c.green('ok');
      const ms = entry.ms !== undefined ? c.dim(`${entry.ms}ms`) : '';
      const via = entry.via ? c.dim(`[${entry.via}]`) : '';
      console.log(`${c.gray(stamp())} ${c.cyan(entry.name)} ${entry.summary ? c.dim(entry.summary) : ''} ${status} ${ms} ${via}`);
    } else if (entry.kind === 'auth') {
      console.log(`${c.gray(stamp())} ${c.yellow('AUTH')} ${entry.summary || entry.name}`);
    } else if (this.verbose) {
      console.log(`${c.gray(stamp())} ${c.dim(`${entry.kind} ${entry.name} ${entry.summary || ''}`)}`);
    }
    if (this.activityFile) {
      fs.appendFile(this.activityFile, JSON.stringify(full) + '\n', () => {});
    }
  }
}
