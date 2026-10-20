import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.js';
import { expandHome } from './config.js';

export const IS_WINDOWS = process.platform === 'win32';

export class PathError extends Error {
  constructor(
    message: string,
    public code: string = 'EPATH'
  ) {
    super(message);
    this.name = 'PathError';
  }
}

function expandEnvVars(p: string): string {
  return p
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m);
}

export function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase().replace(/\//g, '\\') : resolved;
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}


export function resolvePath(input: string, config: Config, base?: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new PathError('Caminho vazio');
  let p = expandEnvVars(expandHome(input.trim()));
  if (IS_WINDOWS && /^[A-Za-z]:$/.test(p)) p += '\\';
  if (!path.isAbsolute(p)) p = path.resolve(base || os.homedir(), p);
  p = path.normalize(p);
  assertAllowed(p, config);
  return p;
}

export function assertAllowed(absPath: string, config: Config): void {
  if (!config.roots.length) return;
  const ok = config.roots.some((root) => isInside(root, absPath));
  if (!ok) {
    throw new PathError(
      `Acesso negado: "${absPath}" esta fora das pastas liberadas (${config.roots.join(', ')})`,
      'EACCES_ROOTS'
    );
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


export function globToRegExp(glob: string, caseInsensitive = IS_WINDOWS): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/\\\\]*';
      }
    } else if (ch === '?') {
      re += '[^/\\\\]';
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alts = glob
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else re += ch;
  }
  return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '');
}

export function matchesAnyGlob(name: string, relPath: string, patterns: RegExp[]): boolean {
  const normalizedRel = relPath.replace(/\\/g, '/');
  return patterns.some((re) => re.test(name) || re.test(normalizedRel));
}

export const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash',
  '.cache'
];

export async function uniquePath(target: string): Promise<string> {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 2; i < 10000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new PathError(`Nao foi possivel gerar um nome unico para ${target}`);
}

export function safeFileName(name: string, fallback = 'arquivo'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function sanitizeZipEntryPath(entry: string): string | null {
  const normalized = entry.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}
