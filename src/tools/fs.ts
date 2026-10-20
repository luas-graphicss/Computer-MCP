import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_IGNORE,
  IS_WINDOWS,
  exists,
  formatDate,
  globToRegExp,
  humanSize,
  matchesAnyGlob,
  resolvePath,
  safeFileName,
  statOrNull,
  uniquePath
} from '../paths.js';
import { isProbablyBinary } from '../util/encoding.js';
import { defineTool, describeError, fail, ok, type ToolContext, type ToolResult } from './types.js';

const pathArg = z.string().describe('Caminho absoluto (ex.: C:/Users/joao/Downloads ou ~/Projetos). "~" e %VAR% sao expandidos.');

interface ListedEntry {
  rel: string;
  type: 'd' | 'f' | 'l' | '?';
  size: number;
  mtime: Date;
}

async function collect(root: string, depth: number, includeHidden: boolean, filter: RegExp | undefined, limit: number): Promise<{ entries: ListedEntry[]; truncated: boolean; dirs: number; files: number; bytes: number }> {
  const entries: ListedEntry[] = [];
  let truncated = false;
  let dirs = 0;
  let files = 0;
  let bytes = 0;
  const visit = async (dir: string, rel: string, level: number) => {
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (level === 0) throw err;
      return;
    }
    dirents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const d of dirents) {
      if (truncated) return;
      if (!includeHidden && d.name.startsWith('.')) continue;
      const entryRel = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      let type: ListedEntry['type'] = d.isDirectory() ? 'd' : d.isSymbolicLink() ? 'l' : d.isFile() ? 'f' : '?';
      let size = 0;
      let mtime = new Date(0);
      try {
        const st = await fsp.lstat(abs);
        size = st.size;
        mtime = st.mtime;
        if (type === 'l') {
          const target = await statOrNull(abs);
          if (target?.isDirectory()) type = 'd';
        }
      } catch {

      }
      const matches = !filter || filter.test(d.name);
      if (matches || type === 'd') {
        if (matches) {
          if (entries.length >= limit) {
            truncated = true;
            return;
          }
          entries.push({ rel: entryRel, type, size, mtime });
          if (type === 'd') dirs++;
          else {
            files++;
            bytes += size;
          }
        }
        if (type === 'd' && level + 1 < depth && !d.isSymbolicLink()) await visit(abs, entryRel, level + 1);
      }
    }
  };
  await visit(root, '', 0);
  return { entries, truncated, dirs, files, bytes };
}

function renderEntries(entries: ListedEntry[]): string {
  const lines = entries.map((e) => {
    const size = e.type === 'd' ? '-' : humanSize(e.size);
    const name = e.type === 'd' ? `${e.rel}/` : e.rel;
    return `${e.type}  ${size.padStart(9)}  ${formatDate(e.mtime)}  ${name}`;
  });
  return lines.join('\n');
}

export const fsList = defineTool({
  name: 'fs_list',
  title: 'Listar pasta',
  group: 'arquivos',
  description:
    'Lista o conteudo de uma pasta (tipo d=pasta f=arquivo l=link, tamanho, data de modificacao e nome). depth>1 mostra subpastas em forma de arvore com caminhos relativos. Use glob (ex.: *.zip) para filtrar por nome.',
  input: {
    path: pathArg,
    depth: z.number().int().min(1).max(8).optional().describe('Niveis de profundidade (padrao 1)'),
    glob: z.string().optional().describe('Filtro de nome, ex.: "*.zip" ou "helix*"'),
    include_hidden: z.boolean().optional().describe('Incluir itens que comecam com ponto (padrao false)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Maximo de itens retornados (padrao 400)')
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    try {
      const root = resolvePath(args.path, ctx.config);
      const st = await statOrNull(root);
      if (!st) return fail(`Caminho nao existe: ${root}`);
      if (!st.isDirectory()) return fail(`${root} e um arquivo (${humanSize(st.size)}). Use fs_read ou fs_stat.`);
      const filter = args.glob ? globToRegExp(args.glob, true) : undefined;
      const limit = args.limit ?? 400;
      const result = await collect(root, args.depth ?? 1, !!args.include_hidden, filter, limit);
      const header = `${root}  (${result.dirs} pastas, ${result.files} arquivos, ${humanSize(result.bytes)}${result.truncated ? `, LISTA CORTADA em ${limit} itens - use glob/limit/depth` : ''})`;
      const body = result.entries.length ? renderEntries(result.entries) : '(vazio)';
      return ok(`${header}\n${body}`, { path: root, dirs: result.dirs, files: result.files, bytes: result.bytes, truncated: result.truncated });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

async function folderSummary(dir: string, maxEntries = 20000): Promise<{ files: number; dirs: number; bytes: number; partial: boolean }> {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let partial = false;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      partial = true;
      continue;
    }
    for (const d of dirents) {
      if (files + dirs > maxEntries) return { files, dirs, bytes, partial: true };
      const abs = path.join(current, d.name);
      if (d.isDirectory()) {
        dirs++;
        stack.push(abs);
      } else if (d.isFile()) {
        files++;
        try {
          bytes += (await fsp.stat(abs)).size;
        } catch {
          partial = true;
        }
      }
    }
  }
  return { files, dirs, bytes, partial };
}

export const fsStat = defineTool({
  name: 'fs_stat',
  title: 'Detalhes de arquivo ou pasta',
  group: 'arquivos',
  description: 'Mostra detalhes de um caminho: tipo, tamanho, datas, se e texto ou binario, numero de linhas (texto) ou totais de arquivos/pastas (pasta).',
  input: { path: pathArg },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    try {
      const target = resolvePath(args.path, ctx.config);
      const st = await fsp.lstat(target).catch(() => null);
      if (!st) return fail(`Caminho nao existe: ${target}`);
      const data: Record<string, unknown> = {
        path: target,
        name: path.basename(target),
        type: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
        size: st.size,
        size_human: humanSize(st.size),
        modified: st.mtime.toISOString(),
        created: st.birthtime.toISOString(),
        extension: path.extname(target).toLowerCase() || null
      };
      const lines = [`${target}`, `tipo: ${data.type} | modificado: ${formatDate(st.mtime)} | criado: ${formatDate(st.birthtime)}`];
      if (st.isDirectory()) {
        const sum = await folderSummary(target);
        Object.assign(data, { files: sum.files, dirs: sum.dirs, total_bytes: sum.bytes, partial: sum.partial });
        lines.push(`conteudo: ${sum.files} arquivos em ${sum.dirs} pastas, ${humanSize(sum.bytes)}${sum.partial ? ' (contagem parcial)' : ''}`);
      } else if (st.isFile()) {
        const fh = await fsp.open(target, 'r');
        try {
          const sample = Buffer.alloc(Math.min(8192, st.size));
          await fh.read(sample, 0, sample.length, 0);
          const binary = isProbablyBinary(sample);
          data.binary = binary;
          lines.push(`tamanho: ${humanSize(st.size)} (${st.size} bytes) | ${binary ? 'binario' : 'texto'}`);
          if (!binary && st.size < 20 * 1024 * 1024) {
            const content = await fsp.readFile(target, 'utf8');
            const count = content.length ? content.split('\n').length : 0;
            data.lines = count;
            lines.push(`linhas: ${count}`);
          }
        } finally {
          await fh.close();
        }
      } else if (st.isSymbolicLink()) {
        const link = await fsp.readlink(target).catch(() => '?');
        data.target = link;
        lines.push(`aponta para: ${link}`);
      }
      return ok(lines.join('\n'), data);
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const fsRead = defineTool({
  name: 'fs_read',
  title: 'Ler arquivo',
  group: 'arquivos',
  description:
    'Le um arquivo de texto (com intervalo opcional de linhas) ou devolve um arquivo binario pequeno em base64. Para arquivos grandes ou projetos inteiros use export_zip/export_file e baixe no seu sandbox.',
  input: {
    path: pathArg,
    start_line: z.number().int().min(1).optional().describe('Primeira linha (1-based)'),
    end_line: z.number().int().min(1).optional().describe('Ultima linha (inclusive)'),
    max_bytes: z.number().int().min(1).max(20 * 1024 * 1024).optional().describe('Limite de bytes lidos (padrao 256 KB)'),
    encoding: z.enum(['auto', 'utf8', 'base64']).optional().describe('auto detecta binario (padrao)')
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    try {
      const target = resolvePath(args.path, ctx.config);
      const st = await statOrNull(target);
      if (!st) return fail(`Arquivo nao existe: ${target}`);
      if (st.isDirectory()) return fail(`${target} e uma pasta. Use fs_list.`);
      const maxBytes = args.max_bytes ?? 256 * 1024;
      const fh = await fsp.open(target, 'r');
      let buffer: Buffer;
      try {
        const toRead = Math.min(st.size, args.encoding === 'base64' ? maxBytes : Math.max(maxBytes, 8192));
        buffer = Buffer.alloc(toRead);
        const { bytesRead } = await fh.read(buffer, 0, toRead, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      const binary = args.encoding === 'base64' || (args.encoding !== 'utf8' && isProbablyBinary(buffer));
      if (binary) {
        if (st.size > maxBytes) {
          return fail(`Arquivo binario de ${humanSize(st.size)} excede max_bytes (${humanSize(maxBytes)}). Use export_file para baixar via URL.`);
        }
        return ok(`[binario ${humanSize(st.size)} em base64]\n${buffer.toString('base64')}`, { path: target, size: st.size, encoding: 'base64' });
      }
      let text = buffer.toString('utf8');
      const truncatedBytes = st.size > buffer.length;
      const allLines = text.split(/\r?\n/);
      const totalLines = truncatedBytes ? `>=${allLines.length}` : String(allLines.length);
      let selected = allLines;
      const start = args.start_line ?? 1;
      const end = args.end_line ?? allLines.length;
      if (args.start_line || args.end_line) selected = allLines.slice(start - 1, end);
      text = selected.join('\n');
      if (text.length > maxBytes) text = text.slice(0, maxBytes);
      const header = `${target} | ${humanSize(st.size)} | linhas: ${totalLines}${args.start_line || args.end_line ? ` | exibindo ${start}-${Math.min(end, allLines.length)}` : ''}${truncatedBytes ? ` | CORTADO em ${humanSize(buffer.length)} (use start_line/end_line ou export_file)` : ''}`;
      return ok(`${header}\n${text}`, { path: target, size: st.size, truncated: truncatedBytes });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const fsWrite = defineTool({
  name: 'fs_write',
  title: 'Gravar arquivo',
  group: 'arquivos',
  description: 'Cria ou sobrescreve um arquivo com texto (ou base64 para binario). Cria as pastas necessarias. mode=append acrescenta ao final; mode=create falha se ja existir.',
  input: {
    path: pathArg,
    content: z.string().describe('Conteudo do arquivo'),
    encoding: z.enum(['utf8', 'base64']).optional().describe('utf8 (padrao) ou base64'),
    mode: z.enum(['overwrite', 'append', 'create']).optional().describe('overwrite (padrao), append ou create')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  async run(args, ctx) {
    try {
      const target = resolvePath(args.path, ctx.config);
      const data = args.encoding === 'base64' ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf8');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const mode = args.mode ?? 'overwrite';
      if (mode === 'create' && (await exists(target))) return fail(`Arquivo ja existe: ${target} (use mode=overwrite para substituir)`);
      if (mode === 'append') await fsp.appendFile(target, data);
      else await fsp.writeFile(target, data);
      const st = await fsp.stat(target);
      return ok(`Gravado ${humanSize(data.length)} em ${target}${mode === 'append' ? ` (total ${humanSize(st.size)})` : ''}`, { path: target, bytes: data.length, size: st.size });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const fsEdit = defineTool({
  name: 'fs_edit',
  title: 'Editar trecho de arquivo',
  group: 'arquivos',
  description:
    'Substitui um trecho de texto dentro de um arquivo sem reescrever o arquivo inteiro. Por padrao exige que o trecho ocorra exatamente uma vez (seguro); use all=true para substituir todas as ocorrencias ou regex=true para expressao regular.',
  input: {
    path: pathArg,
    find: z.string().min(1).describe('Texto exato (ou regex) a localizar'),
    replace: z.string().describe('Texto substituto'),
    all: z.boolean().optional().describe('Substituir todas as ocorrencias (padrao false)'),
    regex: z.boolean().optional().describe('Tratar find como expressao regular JavaScript (padrao false)')
  },
  annotations: { destructiveHint: true, idempotentHint: false },
  mutating: true,
  async run(args, ctx) {
    try {
      const target = resolvePath(args.path, ctx.config);
      const st = await statOrNull(target);
      if (!st || !st.isFile()) return fail(`Arquivo nao existe: ${target}`);
      if (st.size > 20 * 1024 * 1024) return fail('Arquivo maior que 20 MB; edite via terminal ou baixe com export_file.');
      const original = await fsp.readFile(target, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const find = args.regex ? new RegExp(args.find, args.all ? 'g' : '') : null;
      const needle = args.regex ? null : args.find.replace(/\r\n/g, '\n').split('\n').join(eol);
      const replacement = args.replace.replace(/\r\n/g, '\n').split('\n').join(eol);
      let count = 0;
      let updated: string;
      if (find) {
        const matches = original.match(new RegExp(find.source, 'g' + find.flags.replace('g', '')));
        count = matches ? matches.length : 0;
        if (!count) return fail('Nenhuma ocorrencia encontrada para a regex informada.');
        if (count > 1 && !args.all) return fail(`A regex ocorre ${count} vezes; use all=true ou torne-a mais especifica.`);
        updated = original.replace(find, () => replacement);
      } else {
        count = original.split(needle!).length - 1;
        if (!count) return fail('Trecho nao encontrado. Confira espacos, quebras de linha e maiusculas (use fs_read para ver o conteudo exato).');
        if (count > 1 && !args.all) return fail(`O trecho ocorre ${count} vezes; inclua mais contexto para torna-lo unico ou use all=true.`);
        updated = args.all ? original.split(needle!).join(replacement) : original.replace(needle!, () => replacement);
      }
      await fsp.writeFile(target, updated, 'utf8');
      const firstIndex = find ? original.search(new RegExp(find.source, find.flags.replace('g', ''))) : original.indexOf(needle!);
      const line = original.slice(0, Math.max(firstIndex, 0)).split(/\r?\n/).length;
      return ok(`${count} substituicao(oes) em ${target} (primeira na linha ${line}). Tamanho: ${humanSize(st.size)} -> ${humanSize(Buffer.byteLength(updated))}`, { path: target, replacements: count, first_line: line });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const fsMkdir = defineTool({
  name: 'fs_mkdir',
  title: 'Criar pastas',
  group: 'arquivos',
  description: 'Cria uma ou mais pastas (inclusive intermediarias).',
  input: { paths: z.array(z.string()).min(1).describe('Pastas a criar') },
  annotations: { idempotentHint: true },
  mutating: true,
  async run(args, ctx) {
    const created: string[] = [];
    const errors: string[] = [];
    for (const p of args.paths) {
      try {
        const target = resolvePath(p, ctx.config);
        await fsp.mkdir(target, { recursive: true });
        created.push(target);
      } catch (err) {
        errors.push(`${p}: ${describeError(err)}`);
      }
    }
    const text = [`Criadas: ${created.length}`, ...created.map((c) => `  ${c}`), ...(errors.length ? ['Erros:', ...errors.map((e) => `  ${e}`)] : [])].join('\n');
    return { text, data: { created, errors }, isError: !created.length && errors.length > 0 };
  }
});

async function moveOne(src: string, dst: string): Promise<void> {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.cp(src, dst, { recursive: true, force: true, errorOnExist: false });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

async function transfer(args: { sources: string[]; destination: string; overwrite?: boolean }, ctx: ToolContext, mode: 'move' | 'copy'): Promise<ToolResult> {
  const results: string[] = [];
  const errors: string[] = [];
  let destination: string;
  try {
    destination = resolvePath(args.destination, ctx.config);
  } catch (err) {
    return fail(describeError(err));
  }
  const destStat = await statOrNull(destination);
  const multiple = args.sources.length > 1;
  const treatAsDir = multiple || destStat?.isDirectory() || /[\\/]$/.test(args.destination);
  if (treatAsDir) await fsp.mkdir(destination, { recursive: true });
  else await fsp.mkdir(path.dirname(destination), { recursive: true });

  for (const s of args.sources) {
    try {
      const src = resolvePath(s, ctx.config);
      const srcStat = await statOrNull(src);
      if (!srcStat) throw new Error(`origem nao existe: ${src}`);
      let target = treatAsDir ? path.join(destination, path.basename(src)) : destination;
      if (path.resolve(target) === path.resolve(src)) throw new Error('origem e destino sao o mesmo caminho');
      if (srcStat.isDirectory() && target.startsWith(src + path.sep)) throw new Error('nao e possivel mover/copiar uma pasta para dentro dela mesma');
      if (await exists(target)) {
        if (args.overwrite) await fsp.rm(target, { recursive: true, force: true });
        else target = await uniquePath(target);
      }
      if (mode === 'move') await moveOne(src, target);
      else await fsp.cp(src, target, { recursive: true, force: true });
      results.push(`${src} -> ${target}`);
    } catch (err) {
      errors.push(`${s}: ${describeError(err)}`);
    }
  }
  const verb = mode === 'move' ? 'Movidos' : 'Copiados';
  const text = [`${verb}: ${results.length}`, ...results.map((r) => `  ${r}`), ...(errors.length ? ['Erros:', ...errors.map((e) => `  ${e}`)] : [])].join('\n');
  return { text, data: { done: results, errors }, isError: !results.length && errors.length > 0 };
}

export const fsMove = defineTool({
  name: 'fs_move',
  title: 'Mover / renomear',
  group: 'arquivos',
  description:
    'Move ou renomeia arquivos e pastas. Com uma origem e destino inexistente, renomeia. Com varias origens (ou destino que e pasta), move para dentro da pasta. Sem overwrite, conflitos ganham sufixo " (2)". Funciona entre discos diferentes.',
  input: {
    sources: z.array(z.string()).min(1).describe('Caminhos de origem'),
    destination: z.string().describe('Novo caminho (renomear) ou pasta de destino'),
    overwrite: z.boolean().optional().describe('Substituir se o destino existir (padrao false)')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  run: (args, ctx) => transfer(args, ctx, 'move')
});

export const fsCopy = defineTool({
  name: 'fs_copy',
  title: 'Copiar',
  group: 'arquivos',
  description: 'Copia arquivos ou pastas (recursivo). Mesmas regras de destino do fs_move.',
  input: {
    sources: z.array(z.string()).min(1).describe('Caminhos de origem'),
    destination: z.string().describe('Caminho de destino ou pasta'),
    overwrite: z.boolean().optional().describe('Substituir se o destino existir (padrao false)')
  },
  annotations: { destructiveHint: false },
  mutating: true,
  run: (args, ctx) => transfer(args, ctx, 'copy')
});

export const fsDelete = defineTool({
  name: 'fs_delete',
  title: 'Excluir (com lixeira)',
  group: 'arquivos',
  description:
    'Exclui arquivos ou pastas. Por padrao move para a lixeira do pc-mcp (~/.pc-mcp/trash/<data>/), de onde o usuario pode recuperar. permanent=true apaga de verdade - use apenas quando o usuario pedir explicitamente.',
  input: {
    paths: z.array(z.string()).min(1).describe('Caminhos a excluir'),
    permanent: z.boolean().optional().describe('Apagar definitivamente (padrao false = lixeira)')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  async run(args, ctx) {
    const done: string[] = [];
    const errors: string[] = [];
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const trashDir = path.join(ctx.config.dataDir, 'trash', stamp);
    for (const p of args.paths) {
      try {
        const target = resolvePath(p, ctx.config);
        const st = await statOrNull(target);
        if (!st) throw new Error(`nao existe: ${target}`);
        if (ctx.config.roots.length === 0 && isCriticalPath(target)) throw new Error(`recusado: ${target} e um caminho critico do sistema`);
        if (args.permanent) {
          await fsp.rm(target, { recursive: true, force: true });
          done.push(`${target} (apagado)`);
        } else {
          await fsp.mkdir(trashDir, { recursive: true });
          const dest = await uniquePath(path.join(trashDir, safeFileName(path.basename(target))));
          await moveOne(target, dest);
          done.push(`${target} -> lixeira ${dest}`);
        }
      } catch (err) {
        errors.push(`${p}: ${describeError(err)}`);
      }
    }
    const text = [`${args.permanent ? 'Apagados' : 'Enviados para a lixeira'}: ${done.length}`, ...done.map((d) => `  ${d}`), ...(errors.length ? ['Erros:', ...errors.map((e) => `  ${e}`)] : [])].join('\n');
    return { text, data: { done, errors, trash: args.permanent ? null : trashDir }, isError: !done.length && errors.length > 0 };
  }
});

function isCriticalPath(p: string): boolean {
  const norm = IS_WINDOWS ? p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '') : p.replace(/\/+$/, '');
  if (IS_WINDOWS) {
    const home = (process.env.USERPROFILE || '').toLowerCase();
    const critical = [/^[a-z]:$/, /^[a-z]:\\windows$/, /^[a-z]:\\program files( \(x86\))?$/, /^[a-z]:\\users$/];
    return critical.some((re) => re.test(norm)) || (!!home && norm === home);
  }
  return ['', '/', '/bin', '/usr', '/etc', '/home', '/var', '/lib', '/boot', '/System', '/Applications', process.env.HOME || '~'].includes(norm);
}

export const fsSearch = defineTool({
  name: 'fs_search',
  title: 'Buscar arquivos ou texto',
  group: 'arquivos',
  description:
    'Procura arquivos por nome (glob ou parte do nome) e/ou por conteudo (texto ou regex, estilo grep) a partir de uma pasta. Ignora node_modules, .git etc. por padrao. Tem limite de tempo e resultados para nao travar em discos grandes.',
  input: {
    root: z.string().describe('Pasta inicial da busca'),
    name: z.string().optional().describe('Padrao de nome: "*.zip", "helix*" ou trecho do nome'),
    content: z.string().optional().describe('Texto ou regex a procurar dentro dos arquivos'),
    regex: z.boolean().optional().describe('Interpretar content como regex (padrao false)'),
    case_sensitive: z.boolean().optional().describe('Diferenciar maiusculas (padrao false)'),
    max_results: z.number().int().min(1).max(2000).optional().describe('Limite de resultados (padrao 200)'),
    max_file_kb: z.number().int().min(1).optional().describe('Tamanho maximo de arquivo para busca de conteudo em KB (padrao 2048)'),
    ignore: z.array(z.string()).optional().describe('Pastas/padroes a ignorar (substitui a lista padrao)'),
    include_hidden: z.boolean().optional().describe('Incluir itens ocultos (padrao false)'),
    context_lines: z.number().int().min(0).max(5).optional().describe('Linhas de contexto ao redor de cada ocorrencia (padrao 0)'),
    timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Tempo maximo (padrao 20000)')
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    if (!args.name && !args.content) return fail('Informe name e/ou content.');
    try {
      const root = resolvePath(args.root, ctx.config);
      const st = await statOrNull(root);
      if (!st?.isDirectory()) return fail(`Pasta nao existe: ${root}`);
      const ignore = (args.ignore ?? DEFAULT_IGNORE).map((p) => globToRegExp(p));
      const hasGlobChars = /[*?[\]{}]/.test(args.name || '');
      const nameRe = args.name ? (hasGlobChars ? globToRegExp(args.name, true) : new RegExp(args.name.replace(/[.+^$()|[\]\\]/g, '\\$&'), 'i')) : undefined;
      const flags = args.case_sensitive ? '' : 'i';
      const contentRe = args.content ? new RegExp(args.regex ? args.content : args.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) : undefined;
      const maxResults = args.max_results ?? 200;
      const maxFileBytes = (args.max_file_kb ?? 2048) * 1024;
      const deadline = Date.now() + (args.timeout_ms ?? 20000);
      const ctxLines = args.context_lines ?? 0;

      const results: string[] = [];
      let scannedFiles = 0;
      let scannedDirs = 0;
      let timedOut = false;
      const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }];
      while (stack.length && results.length < maxResults) {
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }
        const { dir, rel } = stack.pop()!;
        scannedDirs++;
        let dirents: fs.Dirent[];
        try {
          dirents = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const d of dirents) {
          if (results.length >= maxResults) break;
          if (!args.include_hidden && d.name.startsWith('.')) continue;
          const entryRel = rel ? `${rel}/${d.name}` : d.name;
          if (matchesAnyGlob(d.name, entryRel, ignore)) continue;
          const abs = path.join(dir, d.name);
          if (d.isDirectory()) {
            stack.push({ dir: abs, rel: entryRel });
            if (nameRe && !contentRe && nameRe.test(d.name)) results.push(`d  ${abs}${path.sep}`);
            continue;
          }
          if (!d.isFile()) continue;
          if (nameRe && !nameRe.test(d.name)) continue;
          scannedFiles++;
          if (!contentRe) {
            const fst = await statOrNull(abs);
            results.push(`f  ${abs}  (${fst ? humanSize(fst.size) : '?'}, ${fst ? formatDate(fst.mtime) : '?'})`);
            continue;
          }
          const fst = await statOrNull(abs);
          if (!fst || fst.size > maxFileBytes) continue;
          let buf: Buffer;
          try {
            buf = await fsp.readFile(abs);
          } catch {
            continue;
          }
          if (isProbablyBinary(buf.subarray(0, 8192))) continue;
          const text = buf.toString('utf8');
          if (!contentRe.test(text)) continue;
          const lines = text.split(/\r?\n/);
          let hitsInFile = 0;
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (!contentRe.test(lines[i])) continue;
            hitsInFile++;
            if (hitsInFile > 20) {
              results.push(`   ${abs}: (mais ocorrencias omitidas)`);
              break;
            }
            if (ctxLines) {
              const from = Math.max(0, i - ctxLines);
              const to = Math.min(lines.length - 1, i + ctxLines);
              for (let j = from; j <= to; j++) results.push(`${abs}:${j + 1}${j === i ? ':' : '-'} ${lines[j].slice(0, 300)}`);
              results.push('--');
            } else {
              results.push(`${abs}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            }
          }
        }
      }
      const header = `Busca em ${root} | ${scannedDirs} pastas, ${scannedFiles} arquivos examinados | ${results.length} resultado(s)${results.length >= maxResults ? ' (LIMITE atingido)' : ''}${timedOut ? ' (TEMPO esgotado - refine a busca)' : ''}`;
      return ok(`${header}\n${results.join('\n') || '(nada encontrado)'}`, { root, results: results.length, truncated: results.length >= maxResults || timedOut });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

const CATEGORIES: Record<string, string[]> = {
  Imagens: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff', 'ico', 'avif', 'psd', 'raw', 'cr2'],
  Videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'mid', 'midi'],
  Documentos: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'tex', 'epub', 'mobi'],
  Planilhas: ['xls', 'xlsx', 'csv', 'ods', 'tsv'],
  Apresentacoes: ['ppt', 'pptx', 'odp', 'key'],
  Compactados: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso', 'cab'],
  Instaladores: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bat', 'cmd'],
  Codigo: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'sh', 'ps1', 'sql', 'ipynb', 'lua', 'kt', 'swift', 'dart'],
  Fontes: ['ttf', 'otf', 'woff', 'woff2'],
  Torrents: ['torrent'],
  Atalhos: ['lnk', 'url', 'webloc']
};

function categoryFor(ext: string, rules: Record<string, string[]>): string {
  for (const [folder, exts] of Object.entries(rules)) if (exts.includes(ext)) return folder;
  return 'Outros';
}

export const fsOrganize = defineTool({
  name: 'fs_organize',
  title: 'Organizar pasta',
  group: 'arquivos',
  description:
    'Organiza os arquivos de uma pasta em subpastas por tipo (Imagens, Videos, Documentos, Compactados, Instaladores, Codigo...), por extensao ou por mes de modificacao. Por padrao e apenas simulacao (dry_run=true): mostra o plano. Rode de novo com dry_run=false para executar. Nao mexe em subpastas existentes a menos que include_dirs=true.',
  input: {
    path: pathArg,
    strategy: z.enum(['type', 'extension', 'date']).optional().describe('type (padrao), extension ou date (AAAA-MM)'),
    dry_run: z.boolean().optional().describe('Apenas mostrar o plano (padrao true)'),
    include_dirs: z.boolean().optional().describe('Tambem mover subpastas para "Pastas" (padrao false)'),
    rules: z.record(z.string(), z.array(z.string())).optional().describe('Regras proprias: { "Jogos": ["exe","iso"] } (substitui as categorias padrao na estrategia type)'),
    min_age_days: z.number().min(0).optional().describe('So mexer em arquivos modificados ha pelo menos N dias')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  async run(args, ctx) {
    try {
      const root = resolvePath(args.path, ctx.config);
      const st = await statOrNull(root);
      if (!st?.isDirectory()) return fail(`Pasta nao existe: ${root}`);
      const strategy = args.strategy ?? 'type';
      const dryRun = args.dry_run !== false;
      const rules = args.rules ? Object.fromEntries(Object.entries(args.rules).map(([k, v]) => [k, v.map((e) => e.toLowerCase().replace(/^\./, ''))])) : CATEGORIES;
      const minAgeMs = (args.min_age_days ?? 0) * 86400_000;
      const knownFolders = new Set([...Object.keys(rules), 'Outros', 'Pastas']);
      const dirents = await fsp.readdir(root, { withFileTypes: true });
      const plan: Array<{ from: string; to: string; folder: string }> = [];
      const skipped: string[] = [];
      for (const d of dirents) {
        if (d.name.startsWith('.') || d.name === 'desktop.ini' || d.name === 'Thumbs.db') continue;
        const abs = path.join(root, d.name);
        if (d.isDirectory()) {
          if (!args.include_dirs || knownFolders.has(d.name) || /^\d{4}-\d{2}$/.test(d.name)) continue;
          plan.push({ from: abs, to: path.join(root, 'Pastas', d.name), folder: 'Pastas' });
          continue;
        }
        if (!d.isFile()) continue;
        const fst = await statOrNull(abs);
        if (!fst) continue;
        if (minAgeMs && Date.now() - fst.mtimeMs < minAgeMs) {
          skipped.push(`${d.name} (recente)`);
          continue;
        }
        if (/\.(crdownload|part|tmp|download)$/i.test(d.name)) {
          skipped.push(`${d.name} (download em andamento)`);
          continue;
        }
        const ext = path.extname(d.name).slice(1).toLowerCase();
        let folder: string;
        if (strategy === 'extension') folder = ext ? ext.toUpperCase() : 'SEM-EXTENSAO';
        else if (strategy === 'date') folder = fst.mtime.toISOString().slice(0, 7);
        else folder = categoryFor(ext, rules);
        plan.push({ from: abs, to: path.join(root, folder, d.name), folder });
      }
      const byFolder = new Map<string, number>();
      for (const p of plan) byFolder.set(p.folder, (byFolder.get(p.folder) || 0) + 1);
      const summary = [...byFolder.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `  ${f}/: ${n}`);

      if (dryRun) {
        const preview = plan.slice(0, 150).map((p) => `  ${path.basename(p.from)} -> ${p.folder}/`);
        return ok(
          [`SIMULACAO (dry_run=true) em ${root}: ${plan.length} item(ns) seriam movidos para ${byFolder.size} pasta(s)`, ...summary, 'Movimentos:', ...preview, ...(plan.length > 150 ? [`  ... e mais ${plan.length - 150}`] : []), ...(skipped.length ? [`Ignorados (${skipped.length}): ${skipped.slice(0, 20).join(', ')}`] : []), 'Para executar, chame novamente com dry_run=false.'].join('\n'),
          { path: root, planned: plan.length, folders: Object.fromEntries(byFolder), dry_run: true }
        );
      }
      const moved: string[] = [];
      const errors: string[] = [];
      for (const [i, p] of plan.entries()) {
        try {
          await fsp.mkdir(path.dirname(p.to), { recursive: true });
          const target = (await exists(p.to)) ? await uniquePath(p.to) : p.to;
          await moveOne(p.from, target);
          moved.push(target);
        } catch (err) {
          errors.push(`${path.basename(p.from)}: ${describeError(err)}`);
        }
        if (i % 20 === 0) await ctx.progress(`organizando ${i + 1}/${plan.length}`, i + 1, plan.length);
      }
      return {
        text: [`Organizado ${root}: ${moved.length} movido(s), ${errors.length} erro(s)`, ...summary, ...(errors.length ? ['Erros:', ...errors.map((e) => `  ${e}`)] : []), ...(skipped.length ? [`Ignorados: ${skipped.length}`] : [])].join('\n'),
        data: { path: root, moved: moved.length, errors, folders: Object.fromEntries(byFolder), dry_run: false },
        isError: !moved.length && errors.length > 0
      };
    } catch (err) {
      return fail(describeError(err));
    }
  }
});
