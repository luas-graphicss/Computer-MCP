import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Logger } from '../log.js';
import { exists, humanSize, safeFileName, statOrNull, uniquePath } from '../paths.js';
import { extractZip } from '../zip.js';
import type { TicketStore, UploadTicket } from './tickets.js';

const MIME: Record<string, string> = {
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.exe': 'application/vnd.microsoft.portable-executable'
};

export function mimeFor(fileName: string): string {
  return MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

interface TransferDeps {
  tickets: TicketStore;
  log: Logger;
  maxUploadBytes: number;
}


export async function handleDownload(req: IncomingMessage, res: ServerResponse, ticketId: string, deps: TransferDeps): Promise<void> {
  const ticket = deps.tickets.get(ticketId);
  if (!ticket || ticket.kind !== 'download') return sendText(res, 404, 'Link de download invalido ou expirado. Peca ao agente para gerar outro com export_zip/export_file.');
  if (ticket.downloads >= ticket.maxDownloads) return sendText(res, 410, 'Este link atingiu o limite de downloads.');
  const st = await statOrNull(ticket.filePath);
  if (!st || !st.isFile()) return sendText(res, 404, 'O arquivo deste link nao esta mais disponivel no PC.');

  const headers: Record<string, string> = {
    'Content-Type': mimeFor(ticket.fileName),
    'Content-Disposition': `attachment; filename="${encodeURIComponent(ticket.fileName)}"; filename*=UTF-8''${encodeURIComponent(ticket.fileName)}`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-File-Size': String(st.size)
  };
  if (ticket.sha256) headers['X-Checksum-Sha256'] = ticket.sha256;

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': String(st.size) });
    res.end();
    return;
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[1] && m[2]) {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      end = Math.min(end, st.size - 1);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  ticket.downloads++;
  deps.log.activity({ kind: 'http', name: 'download', summary: `${ticket.fileName} (${humanSize(st.size)}) #${ticket.downloads}` });
  res.writeHead(status, { ...headers, 'Content-Length': String(end - start + 1) });
  try {
    await pipeline(fs.createReadStream(ticket.filePath, { start, end }), res);
  } catch {

  }
}

function readBodyToFile(req: IncomingMessage, target: string, limit: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const out = fs.createWriteStream(target);
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) {
        req.destroy();
        out.destroy();
        reject(Object.assign(new Error(`Upload maior que o limite de ${humanSize(limit)}`), { status: 413 }));
      }
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve(received));
    req.pipe(out);
  });
}

async function finalizeUpload(ticket: UploadTicket, fileNameHint: string | undefined, deps: TransferDeps): Promise<Record<string, unknown>> {
  const indices = [...ticket.parts.keys()].sort((a, b) => a - b);
  if (!indices.length) throw Object.assign(new Error('Nenhuma parte recebida ainda'), { status: 400 });
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i + 1) throw Object.assign(new Error(`Faltou a parte ${i + 1} (recebidas: ${indices.join(', ')})`), { status: 400 });
  }
  const assembled = path.join(ticket.tmpDir, 'assembled.bin');
  if (indices.length === 1) {
    await fsp.rename(ticket.parts.get(1)!.path, assembled);
  } else {
    const out = fs.createWriteStream(assembled);
    for (const idx of indices) {
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(ticket.parts.get(idx)!.path);
        input.on('error', reject);
        input.on('end', resolve);
        input.pipe(out, { end: false });
      });
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  const st = await fsp.stat(assembled);
  const sha256 = await sha256File(assembled);

  const destStat = await statOrNull(ticket.destination);
  const destLooksLikeDir = destStat?.isDirectory() || /[\\/]$/.test(ticket.destination) || ticket.extract;
  const result: Record<string, unknown> = { ok: true, bytes: st.size, size: humanSize(st.size), sha256, parts: indices.length };

  if (ticket.extract) {
    const destination = destLooksLikeDir ? ticket.destination : path.dirname(ticket.destination);
    const extracted = await extractZip({ file: assembled, destination, overwrite: ticket.overwrite, stripRoot: ticket.stripRoot });
    Object.assign(result, {
      extracted_to: destination,
      files: extracted.files,
      skipped_existing: extracted.skipped,
      unsafe_entries_ignored: extracted.unsafe,
      root_folder_stripped: extracted.rootStripped ?? null
    });
  } else {
    let target = ticket.destination;
    if (destLooksLikeDir) {
      const name = safeFileName(fileNameHint || `upload-${ticket.id.slice(0, 6)}.bin`);
      await fsp.mkdir(ticket.destination, { recursive: true });
      target = path.join(ticket.destination, name);
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
    }
    if (!ticket.overwrite && (await exists(target))) target = await uniquePath(target);
    try {
      await fsp.rename(assembled, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fsp.copyFile(assembled, target);
    }
    result.saved_to = target;
  }
  ticket.finished = true;
  ticket.result = result;
  deps.log.activity({ kind: 'http', name: 'upload', summary: `${ticket.label} -> ${result.saved_to || result.extracted_to} (${humanSize(st.size)})`, ok: true });
  await fsp.rm(ticket.tmpDir, { recursive: true, force: true }).catch(() => {});
  return result;
}


export async function handleUpload(req: IncomingMessage, res: ServerResponse, ticketId: string, rest: string[], url: URL, deps: TransferDeps): Promise<void> {
  const ticket = deps.tickets.get(ticketId);
  if (!ticket || ticket.kind !== 'upload') return sendJson(res, 404, { ok: false, error: 'Link de upload invalido ou expirado. Peca ao agente para gerar outro com upload_ticket.' });
  const action = rest[0];

  if (req.method === 'GET' && (action === 'status' || action === undefined)) {
    return sendJson(res, 200, {
      ok: true,
      finished: ticket.finished,
      parts_received: [...ticket.parts.keys()].sort((a, b) => a - b),
      bytes_received: [...ticket.parts.values()].reduce((a, p) => a + p.size, 0),
      destination: ticket.destination,
      extract: ticket.extract,
      expires_at: new Date(ticket.expiresAt).toISOString(),
      result: ticket.result ?? null,
      how_to: [
        `curl -T arquivo.zip "${url.origin}/ul/${ticket.id}"  (envia tudo de uma vez; limite por requisicao atraves do tunel: ~90 MB)`,
        `Para arquivos grandes: split -b 80m arquivo.zip parte_ ; i=1; for p in parte_*; do curl -T "$p" "${url.origin}/ul/${ticket.id}?part=$i"; i=$((i+1)); done; curl -X POST "${url.origin}/ul/${ticket.id}/finish"`
      ]
    });
  }

  if (ticket.finished) return sendJson(res, 409, { ok: false, error: 'Este ticket ja foi concluido. Gere outro com upload_ticket.', result: ticket.result });
  if (ticket.busy) return sendJson(res, 409, { ok: false, error: 'Ticket ocupado processando outra requisicao; tente novamente em instantes.' });

  if (req.method === 'POST' && action === 'finish') {
    ticket.busy = true;
    try {
      const result = await finalizeUpload(ticket, url.searchParams.get('name') || undefined, deps);
      return sendJson(res, 200, result);
    } catch (err) {
      const e = err as Error & { status?: number };
      deps.log.activity({ kind: 'http', name: 'upload', summary: `falha ao finalizar ${ticket.label}: ${e.message}`, ok: false });
      return sendJson(res, e.status || 500, { ok: false, error: e.message });
    } finally {
      ticket.busy = false;
    }
  }

  if (req.method !== 'PUT' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use PUT ou POST com o arquivo no corpo da requisicao.' });

  const partParam = url.searchParams.get('part');
  const part = partParam ? Number(partParam) : 1;
  if (!Number.isInteger(part) || part < 1 || part > 10000) return sendJson(res, 400, { ok: false, error: 'Parametro part invalido (1..10000).' });
  const nameHint = action && action !== 'finish' ? decodeURIComponent(action) : url.searchParams.get('name') || headerFileName(req) || undefined;

  ticket.busy = true;
  try {
    const partPath = path.join(ticket.tmpDir, `part-${String(part).padStart(5, '0')}`);
    const size = await readBodyToFile(req, partPath, deps.maxUploadBytes);
    ticket.parts.set(part, { index: part, path: partPath, size });
    const multi = partParam !== null;
    if (!multi) {
      const result = await finalizeUpload(ticket, nameHint, deps);
      return sendJson(res, 200, result);
    }
    return sendJson(res, 200, {
      ok: true,
      part,
      bytes: size,
      parts_received: [...ticket.parts.keys()].sort((a, b) => a - b),
      next: `Envie as demais partes e depois POST ${url.origin}/ul/${ticket.id}/finish`
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    deps.log.activity({ kind: 'http', name: 'upload', summary: `falha em ${ticket.label}: ${e.message}`, ok: false });
    return sendJson(res, e.status || 500, { ok: false, error: e.message });
  } finally {
    ticket.busy = false;
  }
}

function headerFileName(req: IncomingMessage): string | undefined {
  const header = req.headers['x-file-name'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const disposition = req.headers['content-disposition'];
  if (typeof disposition === 'string') {
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}
