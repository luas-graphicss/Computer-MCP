import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { DEFAULT_IGNORE, globToRegExp, matchesAnyGlob, sanitizeZipEntryPath } from './paths.js';

export type CompressionLevel = 'store' | 'fast' | 'normal' | 'max';

const LEVELS: Record<CompressionLevel, number> = { store: 0, fast: 1, normal: 6, max: 9 };

export interface ZipSource {

  path: string;

  name: string;
  isDirectory: boolean;
}

export interface CreateZipOptions {
  sources: ZipSource[];
  output: string;
  exclude?: string[];
  compression?: CompressionLevel;
  onProgress?: (info: { files: number; bytes: number; current: string }) => void;
  signal?: AbortSignal;
}

export interface CreateZipResult {
  files: number;
  bytes: number;
  zipBytes: number;
  skipped: number;
}

async function* walk(dir: string, rel: string, exclude: RegExp[], counters: { skipped: number }): AsyncGenerator<{ abs: string; rel: string; size: number; mtime: Date }> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    counters.skipped++;
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (matchesAnyGlob(entry.name, entryRel, exclude)) {
      counters.skipped++;
      continue;
    }
    if (entry.isSymbolicLink()) {
      counters.skipped++;
      continue;
    }
    if (entry.isDirectory()) {
      yield* walk(abs, entryRel, exclude, counters);
    } else if (entry.isFile()) {
      try {
        const st = await fsp.stat(abs);
        yield { abs, rel: entryRel, size: st.size, mtime: st.mtime };
      } catch {
        counters.skipped++;
      }
    }
  }
}

export function compileExcludes(patterns: string[] | undefined): RegExp[] {
  const list = patterns === undefined ? DEFAULT_IGNORE : patterns;
  return list.map((p) => globToRegExp(p));
}

export async function createZip(opts: CreateZipOptions): Promise<CreateZipResult> {
  const exclude = compileExcludes(opts.exclude);
  const level = LEVELS[opts.compression || 'normal'];
  const archive = new ZipArchive({ zlib: { level }, store: level === 0 });
  const output = fs.createWriteStream(opts.output);
  const counters = { skipped: 0 };
  let files = 0;
  let bytes = 0;
  let aborted = false;

  const onAbort = () => {
    aborted = true;
    archive.abort();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const finished = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') counters.skipped++;
      else reject(err);
    });
  });
  archive.pipe(output);

  try {
    for (const source of opts.sources) {
      if (aborted) break;
      if (source.isDirectory) {
        for await (const file of walk(source.path, source.name, exclude, counters)) {
          if (aborted) break;
          archive.file(file.abs, { name: file.rel, date: file.mtime, stats: undefined });
          files++;
          bytes += file.size;
          if (files % 25 === 0) opts.onProgress?.({ files, bytes, current: file.rel });
        }
      } else {
        const st = await fsp.stat(source.path);
        archive.file(source.path, { name: source.name, date: st.mtime });
        files++;
        bytes += st.size;
      }
    }
    opts.onProgress?.({ files, bytes, current: 'finalizando' });
    await archive.finalize();
    await finished;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (aborted) throw new Error('Compactacao cancelada');
  const zipStat = await fsp.stat(opts.output);
  return { files, bytes, zipBytes: zipStat.size, skipped: counters.skipped };
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  mtime: Date;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err || new Error('Falha ao abrir zip'));
      else resolve(zip);
    });
  });
}

export async function listZip(file: string, limit = 2000): Promise<{ entries: ZipEntryInfo[]; total: number; totalBytes: number }> {
  const zip = await openZip(file);
  const entries: ZipEntryInfo[] = [];
  let total = 0;
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      total++;
      totalBytes += entry.uncompressedSize;
      if (entries.length < limit) {
        entries.push({
          name: entry.fileName,
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          isDirectory: /\/$/.test(entry.fileName),
          mtime: entry.getLastModDate()
        });
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return { entries, total, totalBytes };
}

export interface ExtractOptions {
  file: string;
  destination: string;
  overwrite?: boolean;

  stripRoot?: boolean;
  onProgress?: (info: { files: number; bytes: number; current: string }) => void;
  signal?: AbortSignal;
}

export interface ExtractResult {
  files: number;
  bytes: number;
  skipped: number;
  unsafe: number;
  rootStripped?: string;
}

async function detectCommonRoot(file: string): Promise<string | undefined> {
  const { entries, total } = await listZip(file, 5000);
  if (total !== entries.length || !entries.length) return undefined;
  let root: string | undefined;
  for (const e of entries) {
    const first = e.name.replace(/\\/g, '/').split('/')[0];
    if (!first) return undefined;
    if (root === undefined) root = first;
    else if (root !== first) return undefined;
  }
  const hasNested = entries.some((e) => e.name.replace(/\\/g, '/').split('/').filter(Boolean).length > 1);
  return hasNested ? root : undefined;
}

export async function extractZip(opts: ExtractOptions): Promise<ExtractResult> {
  const root = opts.stripRoot ? await detectCommonRoot(opts.file) : undefined;
  const zip = await openZip(opts.file);
  const result: ExtractResult = { files: 0, bytes: 0, skipped: 0, unsafe: 0, rootStripped: root };
  await fsp.mkdir(opts.destination, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };
    zip.on('error', fail);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      if (opts.signal?.aborted) return fail(new Error('Extracao cancelada'));
      void (async () => {
        try {
          let safe = sanitizeZipEntryPath(entry.fileName);
          if (safe === null) {
            result.unsafe++;
            return zip.readEntry();
          }
          if (root && (safe === root || safe.startsWith(`${root}/`))) safe = safe.slice(root.length + 1);
          if (!safe) return zip.readEntry();
          const target = path.join(opts.destination, ...safe.split('/'));
          const isDir = /\/$/.test(entry.fileName);
          if (isDir) {
            await fsp.mkdir(target, { recursive: true });
            return zip.readEntry();
          }
          await fsp.mkdir(path.dirname(target), { recursive: true });
          if (!opts.overwrite) {
            try {
              await fsp.access(target);
              result.skipped++;
              return zip.readEntry();
            } catch {

            }
          }
          await new Promise<void>((res, rej) => {
            zip.openReadStream(entry, (err, stream) => {
              if (err || !stream) return rej(err || new Error('Falha ao ler entrada do zip'));
              pipeline(stream, fs.createWriteStream(target))
                .then(() => res())
                .catch(rej);
            });
          });
          const mtime = entry.getLastModDate();
          await fsp.utimes(target, mtime, mtime).catch(() => {});
          result.files++;
          result.bytes += entry.uncompressedSize;
          if (result.files % 25 === 0) opts.onProgress?.({ files: result.files, bytes: result.bytes, current: safe });
          zip.readEntry();
        } catch (err) {
          fail(err as Error);
        }
      })();
    });
    zip.readEntry();
  });
  zip.close();
  return result;
}
