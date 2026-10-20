import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { exists, formatDate, humanSize, resolvePath, statOrNull, uniquePath } from '../paths.js';
import { createZip, extractZip, listZip, type ZipSource } from '../zip.js';
import { defineTool, describeError, fail, ok, type ToolContext } from './types.js';

export async function sourcesFromPaths(paths: string[], ctx: ToolContext): Promise<ZipSource[]> {
  const sources: ZipSource[] = [];
  for (const p of paths) {
    const abs = resolvePath(p, ctx.config);
    const st = await statOrNull(abs);
    if (!st) throw new Error(`Caminho nao existe: ${abs}`);
    let name = path.basename(abs);
    if (!name || /^[A-Za-z]:\\?$/.test(abs)) name = abs.replace(/[^A-Za-z0-9]/g, '') || 'disco';
    sources.push({ path: abs, name, isDirectory: st.isDirectory() });
  }
  return sources;
}

export const zipCreate = defineTool({
  name: 'zip_create',
  title: 'Criar zip no PC',
  group: 'zip',
  description: 'Compacta arquivos/pastas em um .zip salvo no PC (ex.: backup antes de alterar um projeto). Para levar para o seu sandbox use export_zip, que ja gera o link.',
  input: {
    paths: z.array(z.string()).min(1).describe('Arquivos ou pastas a compactar'),
    output: z.string().describe('Caminho do .zip de saida'),
    exclude: z.array(z.string()).optional().describe('Padroes a excluir (padrao: node_modules, .git, __pycache__, .venv...). Passe [] para nao excluir nada'),
    compression: z.enum(['store', 'fast', 'normal', 'max']).optional().describe('Nivel (padrao normal)'),
    overwrite: z.boolean().optional().describe('Substituir o zip se existir (padrao false)')
  },
  annotations: { destructiveHint: false },
  mutating: true,
  async run(args, ctx) {
    try {
      let output = resolvePath(args.output, ctx.config);
      if (!/\.zip$/i.test(output)) output += '.zip';
      if (await exists(output)) {
        if (args.overwrite) await fsp.rm(output, { force: true });
        else output = await uniquePath(output);
      }
      await fsp.mkdir(path.dirname(output), { recursive: true });
      const sources = await sourcesFromPaths(args.paths, ctx);
      let lastReport = 0;
      const result = await createZip({
        sources,
        output,
        exclude: args.exclude,
        compression: args.compression,
        signal: ctx.signal,
        onProgress: (info) => {
          if (Date.now() - lastReport > 1500) {
            lastReport = Date.now();
            void ctx.progress(`compactando ${info.files} arquivos (${humanSize(info.bytes)}) - ${info.current}`);
          }
        }
      });
      return ok(`Zip criado: ${output}\n${result.files} arquivos, ${humanSize(result.bytes)} -> ${humanSize(result.zipBytes)}${result.skipped ? ` (${result.skipped} itens ignorados por exclude/inacessiveis)` : ''}`, { output, ...result });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const zipList = defineTool({
  name: 'zip_list',
  title: 'Listar conteudo de zip',
  group: 'zip',
  description: 'Lista as entradas de um arquivo .zip sem extrair.',
  input: {
    path: z.string().describe('Caminho do .zip'),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximo de entradas listadas (padrao 300)')
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    try {
      const file = resolvePath(args.path, ctx.config);
      const limit = args.limit ?? 300;
      const { entries, total, totalBytes } = await listZip(file, limit);
      const lines = entries.map((e) => `${e.isDirectory ? 'd' : 'f'}  ${humanSize(e.size).padStart(9)}  ${formatDate(e.mtime)}  ${e.name}`);
      return ok(`${file}: ${total} entradas, ${humanSize(totalBytes)} descompactado${total > entries.length ? ` (mostrando ${entries.length})` : ''}\n${lines.join('\n')}`, { path: file, total, totalBytes });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const zipExtract = defineTool({
  name: 'zip_extract',
  title: 'Extrair zip',
  group: 'zip',
  description: 'Extrai um .zip do PC para uma pasta. Protege contra caminhos maliciosos (zip slip). strip_root remove a pasta raiz unica do zip (ex.: projeto-main/).',
  input: {
    path: z.string().describe('Caminho do .zip'),
    destination: z.string().describe('Pasta de destino (criada se nao existir)'),
    overwrite: z.boolean().optional().describe('Sobrescrever arquivos existentes (padrao false)'),
    strip_root: z.boolean().optional().describe('Remover a pasta raiz unica do zip (padrao false)')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  async run(args, ctx) {
    try {
      const file = resolvePath(args.path, ctx.config);
      const destination = resolvePath(args.destination, ctx.config);
      let lastReport = 0;
      const result = await extractZip({
        file,
        destination,
        overwrite: !!args.overwrite,
        stripRoot: !!args.strip_root,
        signal: ctx.signal,
        onProgress: (info) => {
          if (Date.now() - lastReport > 1500) {
            lastReport = Date.now();
            void ctx.progress(`extraindo ${info.files} arquivos (${humanSize(info.bytes)})`);
          }
        }
      });
      return ok(`Extraido para ${destination}: ${result.files} arquivos (${humanSize(result.bytes)})${result.skipped ? `, ${result.skipped} ja existiam (nao sobrescritos)` : ''}${result.unsafe ? `, ${result.unsafe} entradas inseguras ignoradas` : ''}${result.rootStripped ? `, raiz "${result.rootStripped}/" removida` : ''}`, { destination, ...result });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});
