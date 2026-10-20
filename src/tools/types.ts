import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { TicketStore } from '../transfer/tickets.js';
import type { ProcessManager } from './processes.js';

export type ToolGroup = 'sistema' | 'arquivos' | 'zip' | 'transferencia' | 'terminal';

export interface ToolContext {
  config: Config;
  log: Logger;
  tickets: TicketStore;
  processes: ProcessManager;

  baseUrl: () => string;

  progress: (message: string, current?: number, total?: number) => Promise<void>;
  signal?: AbortSignal;
}

export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  input: Shape;
  annotations?: ToolAnnotations;

  mutating?: boolean;

  needsShell?: boolean;
  run: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function ok(text: string, data?: Record<string, unknown>): ToolResult {
  return { text, data };
}

export function fail(text: string, data?: Record<string, unknown>): ToolResult {
  return { text, data, isError: true };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const hints: Record<string, string> = {
      ENOENT: 'caminho nao existe',
      EACCES: 'sem permissao',
      EPERM: 'operacao nao permitida pelo sistema',
      EBUSY: 'arquivo em uso por outro programa',
      EEXIST: 'ja existe',
      ENOTEMPTY: 'pasta nao esta vazia',
      EISDIR: 'e uma pasta, nao um arquivo',
      ENOTDIR: 'nao e uma pasta',
      EXDEV: 'origem e destino em discos diferentes',
      ENOSPC: 'sem espaco em disco'
    };
    const hint = code && hints[code] ? ` (${hints[code]})` : '';
    return `${err.message}${hint}`;
  }
  return String(err);
}
