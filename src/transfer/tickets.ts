import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface DownloadTicket {
  kind: 'download';
  id: string;
  filePath: string;
  fileName: string;
  size: number;
  sha256?: string;
  createdAt: number;
  expiresAt: number;
  maxDownloads: number;
  downloads: number;

  temporary: boolean;
  label: string;
}

export interface UploadPart {
  index: number;
  path: string;
  size: number;
}

export interface UploadTicket {
  kind: 'upload';
  id: string;
  destination: string;
  extract: boolean;
  overwrite: boolean;
  stripRoot: boolean;
  createdAt: number;
  expiresAt: number;
  tmpDir: string;
  parts: Map<number, UploadPart>;
  finished: boolean;
  busy: boolean;
  result?: Record<string, unknown>;
  label: string;
}

export type Ticket = DownloadTicket | UploadTicket;

export class TicketStore {
  private tickets = new Map<string, Ticket>();
  private timer?: NodeJS.Timeout;

  constructor(
    private exportsDir: string,
    private uploadsDir: string,
    private defaultTtlMs: number
  ) {
    this.timer = setInterval(() => void this.cleanup(), 60_000);
    this.timer.unref();
  }

  private newId(): string {
    return crypto.randomBytes(18).toString('base64url');
  }

  ttl(minutes?: number): number {
    const ms = minutes && minutes > 0 ? minutes * 60_000 : this.defaultTtlMs;
    return Math.min(ms, 7 * 24 * 60 * 60_000);
  }

  exportPath(fileName: string): string {
    return path.join(this.exportsDir, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${fileName}`);
  }

  createDownload(params: {
    filePath: string;
    fileName: string;
    size: number;
    sha256?: string;
    ttlMinutes?: number;
    maxDownloads?: number;
    temporary: boolean;
    label: string;
  }): DownloadTicket {
    const now = Date.now();
    const ticket: DownloadTicket = {
      kind: 'download',
      id: this.newId(),
      filePath: params.filePath,
      fileName: params.fileName,
      size: params.size,
      sha256: params.sha256,
      createdAt: now,
      expiresAt: now + this.ttl(params.ttlMinutes),
      maxDownloads: params.maxDownloads && params.maxDownloads > 0 ? params.maxDownloads : 25,
      downloads: 0,
      temporary: params.temporary,
      label: params.label
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  createUpload(params: {
    destination: string;
    extract: boolean;
    overwrite: boolean;
    stripRoot: boolean;
    ttlMinutes?: number;
    label: string;
  }): UploadTicket {
    const now = Date.now();
    const id = this.newId();
    const ticket: UploadTicket = {
      kind: 'upload',
      id,
      destination: params.destination,
      extract: params.extract,
      overwrite: params.overwrite,
      stripRoot: params.stripRoot,
      createdAt: now,
      expiresAt: now + this.ttl(params.ttlMinutes),
      tmpDir: path.join(this.uploadsDir, id),
      parts: new Map(),
      finished: false,
      busy: false,
      label: params.label
    };
    fs.mkdirSync(ticket.tmpDir, { recursive: true });
    this.tickets.set(id, ticket);
    return ticket;
  }

  get(id: string): Ticket | undefined {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    if (t.expiresAt < Date.now()) {
      void this.dispose(t);
      return undefined;
    }
    return t;
  }

  list(): Ticket[] {
    return [...this.tickets.values()];
  }

  async dispose(t: Ticket): Promise<void> {
    this.tickets.delete(t.id);
    try {
      if (t.kind === 'download' && t.temporary) await fsp.rm(t.filePath, { force: true });
      if (t.kind === 'upload') await fsp.rm(t.tmpDir, { recursive: true, force: true });
    } catch {

    }
  }

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const t of this.tickets.values()) {
      const exhausted = t.kind === 'download' && t.downloads >= t.maxDownloads && now - t.createdAt > 60_000;
      if (t.expiresAt < now || exhausted) await this.dispose(t);
    }
  }


  async purgeStaleFiles(): Promise<number> {
    let removed = 0;
    for (const dir of [this.exportsDir, this.uploadsDir]) {
      let entries: string[] = [];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        try {
          await fsp.rm(path.join(dir, name), { recursive: true, force: true });
          removed++;
        } catch {

        }
      }
    }
    return removed;
  }

  async disposeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.tickets.values()) await this.dispose(t);
  }
}
