import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { fsCopy, fsDelete, fsEdit, fsList, fsMkdir, fsMove, fsOrganize, fsRead, fsSearch, fsStat, fsWrite } from './fs.js';
import { processKill, processList, processRead, processStart, processWrite, shellExec } from './shell.js';
import { openPath, systemInfo } from './system.js';
import { exportFile, exportZip, importUrl, uploadTicket } from './transfer.js';
import type { ToolContext, ToolDef, ToolResult } from './types.js';
import { zipCreate, zipExtract, zipList } from './zip-tools.js';


export const ALL_TOOLS: ToolDef<any>[] = [
  systemInfo,
  fsList,
  fsStat,
  fsRead,
  fsWrite,
  fsEdit,
  fsMkdir,
  fsMove,
  fsCopy,
  fsDelete,
  fsSearch,
  fsOrganize,
  zipCreate,
  zipList,
  zipExtract,
  exportZip,
  exportFile,
  uploadTicket,
  importUrl,
  shellExec,
  processStart,
  processRead,
  processWrite,
  processKill,
  processList,
  openPath
];

export function toolsFor(config: Config): ToolDef[] {
  return ALL_TOOLS.filter((t) => {
    if (config.readOnly && t.mutating) return false;
    if (!config.shellEnabled && t.needsShell) return false;
    return true;
  });
}

export function findTool(config: Config, name: string): ToolDef | undefined {
  return toolsFor(config).find((t) => t.name === name);
}

export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length > 70) s = `${s.slice(0, 67)}...`;
    parts.push(`${k}=${s.replace(/\n/g, '\\n')}`);
  }
  return parts.join(' ');
}

export async function runTool(tool: ToolDef, rawArgs: unknown, ctx: ToolContext, log: Logger, via: string): Promise<ToolResult> {
  const schema = z.object(tool.input);
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
    log.activity({ kind: 'tool', name: tool.name, summary: 'argumentos invalidos', ok: false, via });
    return { text: `Argumentos invalidos para ${tool.name}: ${issues}`, isError: true };
  }
  const started = Date.now();
  const args = parsed.data as Record<string, unknown>;
  try {
    const result = await tool.run(args, ctx);
    log.activity({ kind: 'tool', name: tool.name, summary: summarizeArgs(args), ok: !result.isError, ms: Date.now() - started, via });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.activity({ kind: 'tool', name: tool.name, summary: summarizeArgs(args), ok: false, ms: Date.now() - started, via });
    return { text: `Erro em ${tool.name}: ${message}`, isError: true };
  }
}

export function toolJsonSchema(tool: ToolDef): Record<string, unknown> {
  return z.toJSONSchema(z.object(tool.input), { io: 'input' }) as Record<string, unknown>;
}
