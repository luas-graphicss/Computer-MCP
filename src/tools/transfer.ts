import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { exists, humanSize, resolvePath, safeFileName, statOrNull, uniquePath } from '../paths.js';
import { sha256File } from '../transfer/http.js';
import { createZip, extractZip } from '../zip.js';
import { defineTool, describeError, fail, ok } from './types.js';
import { sourcesFromPaths } from './zip-tools.js';

const ttlArg = z.number().int().min(1).max(10080).optional().describe('Validade do link em minutos (padrao: configuracao do servidor, 120)');

function expiresText(ts: number): string {
  return new Date(ts).toLocaleString('pt-BR');
}

export const exportZip = defineTool({
  name: 'export_zip',
  title: 'Exportar pasta/arquivos como zip (link)',
  group: 'transferencia',
  description:
    'PRINCIPAL FORMA DE TRAZER ARQUIVOS DO PC PARA O SEU SANDBOX. Compacta pastas/arquivos do PC em um zip temporario e devolve uma URL publica para voce baixar com curl/wget no seu ambiente (sem autenticacao, link aleatorio e com validade). Exclui node_modules/.git por padrao (passe exclude=[] para incluir tudo). Para um unico arquivo ja pronto (ex.: helix.zip), use export_file.',
  input: {
    paths: z.array(z.string()).min(1).describe('Pastas e/ou arquivos a exportar'),
    name: z.string().optional().describe('Nome do zip (padrao: nome da primeira pasta)'),
    exclude: z.array(z.string()).optional().describe('Padroes glob a excluir. Padrao: node_modules, .git, __pycache__, .venv, caches'),
    compression: z.enum(['store', 'fast', 'normal', 'max']).optional().describe('Nivel de compressao (padrao fast, bom equilibrio)'),
    ttl_minutes: ttlArg,
    max_downloads: z.number().int().min(1).max(1000).optional().describe('Quantas vezes o link pode ser baixado (padrao 25)')
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    try {
      const sources = await sourcesFromPaths(args.paths, ctx);
      const baseName = safeFileName((args.name || sources[0].name).replace(/\.zip$/i, ''), 'export');
      const fileName = `${baseName}.zip`;
      const output = ctx.tickets.exportPath(fileName);
      let lastReport = 0;
      const started = Date.now();
      const result = await createZip({
        sources,
        output,
        exclude: args.exclude,
        compression: args.compression ?? 'fast',
        signal: ctx.signal,
        onProgress: (info) => {
          if (Date.now() - lastReport > 1500) {
            lastReport = Date.now();
            void ctx.progress(`compactando ${info.files} arquivos (${humanSize(info.bytes)})`);
          }
        }
      });
      const sha256 = await sha256File(output);
      const ticket = ctx.tickets.createDownload({
        filePath: output,
        fileName,
        size: result.zipBytes,
        sha256,
        ttlMinutes: args.ttl_minutes,
        maxDownloads: args.max_downloads,
        temporary: true,
        label: fileName
      });
      const url = `${ctx.baseUrl()}/dl/${ticket.id}/${encodeURIComponent(fileName)}`;
      const text = [
        `Zip pronto: ${fileName} | ${result.files} arquivos | ${humanSize(result.bytes)} -> ${humanSize(result.zipBytes)} | ${Math.round((Date.now() - started) / 100) / 10}s${result.skipped ? ` | ${result.skipped} itens excluidos/inacessiveis` : ''}`,
        `URL (valida ate ${expiresText(ticket.expiresAt)}, ate ${ticket.maxDownloads} downloads):`,
        url,
        `Baixe no seu sandbox:  curl -L -o "${fileName}" "${url}"  &&  unzip -o "${fileName}" -d ./${baseName}`,
        `sha256: ${sha256}`
      ].join('\n');
      return ok(text, { url, file_name: fileName, files: result.files, bytes: result.zipBytes, sha256, expires_at: new Date(ticket.expiresAt).toISOString() });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const exportFile = defineTool({
  name: 'export_file',
  title: 'Exportar um arquivo (link direto)',
  group: 'transferencia',
  description: 'Gera uma URL publica temporaria para baixar um unico arquivo do PC exatamente como esta (sem zipar). Ideal para zips ja prontos, binarios, videos, PDFs.',
  input: {
    path: z.string().describe('Arquivo a exportar'),
    ttl_minutes: ttlArg,
    max_downloads: z.number().int().min(1).max(1000).optional().describe('Limite de downloads (padrao 25)')
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    try {
      const file = resolvePath(args.path, ctx.config);
      const st = await statOrNull(file);
      if (!st) return fail(`Arquivo nao existe: ${file}`);
      if (st.isDirectory()) return fail(`${file} e uma pasta. Use export_zip.`);
      const sha256 = st.size < 2 * 1024 * 1024 * 1024 ? await sha256File(file) : undefined;
      const fileName = path.basename(file);
      const ticket = ctx.tickets.createDownload({
        filePath: file,
        fileName,
        size: st.size,
        sha256,
        ttlMinutes: args.ttl_minutes,
        maxDownloads: args.max_downloads,
        temporary: false,
        label: fileName
      });
      const url = `${ctx.baseUrl()}/dl/${ticket.id}/${encodeURIComponent(fileName)}`;
      return ok(
        [
          `${fileName} | ${humanSize(st.size)} | valido ate ${expiresText(ticket.expiresAt)} (${ticket.maxDownloads} downloads)`,
          url,
          `Baixe:  curl -L -o "${fileName}" "${url}"`,
          sha256 ? `sha256: ${sha256}` : ''
        ]
          .filter(Boolean)
          .join('\n'),
        { url, file_name: fileName, bytes: st.size, sha256, expires_at: new Date(ticket.expiresAt).toISOString() }
      );
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

function normalizeDownloadUrl(input: string): string {
  const url = input.trim();
  const tmp = /^https?:\/\/tmpfiles\.org\/(?!dl\/)(\w+)\/(.+)$/i.exec(url);
  if (tmp) return `https://tmpfiles.org/dl/${tmp[1]}/${tmp[2]}`;
  return url;
}

export const importUrl = defineTool({
  name: 'import_url',
  title: 'Baixar URL para o PC',
  group: 'transferencia',
  description:
    'Baixa um arquivo de uma URL publica diretamente para o PC (ex.: um zip corrigido que voce publicou, um instalador, um release do GitHub). Com extract=true, extrai o zip na pasta de destino. Links de pagina do tmpfiles.org sao convertidos automaticamente para o link direto. Para enviar arquivos do seu sandbox sem hospedagem externa, use upload_ticket.',
  input: {
    url: z.string().url().describe('URL http(s) do arquivo'),
    destination: z.string().describe('Arquivo de destino ou pasta (se terminar com / ou ja for pasta, o nome vem da URL)'),
    extract: z.boolean().optional().describe('Extrair zip no destino apos baixar (padrao false)'),
    overwrite: z.boolean().optional().describe('Sobrescrever existentes (padrao false)'),
    strip_root: z.boolean().optional().describe('Ao extrair, remover a pasta raiz unica do zip (padrao false)'),
    headers: z.record(z.string(), z.string()).optional().describe('Cabecalhos HTTP extras (ex.: Authorization)'),
    timeout_s: z.number().int().min(5).max(3600).optional().describe('Tempo maximo em segundos (padrao 600)')
  },
  annotations: { destructiveHint: false, openWorldHint: true },
  mutating: true,
  async run(args, ctx) {
    try {
      const url = normalizeDownloadUrl(args.url);
      const destination = resolvePath(args.destination, ctx.config);
      const destStat = await statOrNull(destination);
      const destIsDir = destStat?.isDirectory() || /[\\/]$/.test(args.destination);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (args.timeout_s ?? 600) * 1000);
      ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'pc-mcp/1.0', ...(args.headers || {}) }, redirect: 'follow', signal: controller.signal });
        if (!res.ok || !res.body) return fail(`HTTP ${res.status} ${res.statusText} ao baixar ${url}`);
        const type = res.headers.get('content-type') || '';
        const dispositionName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '')?.[1];
        const urlName = decodeURIComponent(new URL(res.url || url).pathname.split('/').filter(Boolean).pop() || '');
        const fileName = safeFileName(dispositionName ? decodeURIComponent(dispositionName) : urlName || 'download.bin');
        if (type.includes('text/html') && !/\.html?$/i.test(fileName)) {
          return fail(`A URL devolveu uma pagina HTML em vez de um arquivo (${type}). Use o link direto de download.`);
        }
        const total = Number(res.headers.get('content-length') || 0);
        const tmpFile = path.join(ctx.config.dataDir, 'uploads', `import-${Date.now().toString(36)}.part`);
        let received = 0;
        let lastReport = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length;
            if (Date.now() - lastReport > 1500) {
              lastReport = Date.now();
              void ctx.progress(`baixando ${humanSize(received)}${total ? ` de ${humanSize(total)}` : ''}`, received, total || undefined);
            }
            cb(null, chunk);
          }
        });
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, fs.createWriteStream(tmpFile));
        const sha256 = await sha256File(tmpFile);

        if (args.extract) {
          const extractTo = destIsDir ? destination : destination.replace(/\.zip$/i, '');
          const result = await extractZip({ file: tmpFile, destination: extractTo, overwrite: !!args.overwrite, stripRoot: !!args.strip_root, signal: ctx.signal });
          await fsp.rm(tmpFile, { force: true });
          return ok(`Baixado ${humanSize(received)} de ${url} e extraido em ${extractTo}: ${result.files} arquivos${result.skipped ? `, ${result.skipped} ja existiam` : ''}${result.rootStripped ? `, raiz "${result.rootStripped}/" removida` : ''}\nsha256 do zip: ${sha256}`, { url, extracted_to: extractTo, sha256, ...result, zip_bytes: received });
        }
        let target = destIsDir ? path.join(destination, fileName) : destination;
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (await exists(target)) {
          if (args.overwrite) await fsp.rm(target, { force: true });
          else target = await uniquePath(target);
        }
        try {
          await fsp.rename(tmpFile, target);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await fsp.copyFile(tmpFile, target);
          await fsp.rm(tmpFile, { force: true });
        }
        return ok(`Baixado ${humanSize(received)} -> ${target}\nsha256: ${sha256}`, { url, saved_to: target, bytes: received, sha256 });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return fail('Download cancelado ou tempo esgotado.');
      return fail(describeError(err));
    }
  }
});

export const uploadTicket = defineTool({
  name: 'upload_ticket',
  title: 'Criar link para enviar arquivo ao PC',
  group: 'transferencia',
  description:
    'PRINCIPAL FORMA DE DEVOLVER ARQUIVOS DO SEU SANDBOX PARA O PC. Cria uma URL temporaria que aceita PUT/POST com o arquivo no corpo (curl -T arquivo URL). O servidor salva no destino informado e, com extract=true, extrai o zip la. Suporta envio em partes para arquivos grandes (?part=N e /finish). A resposta inclui os comandos prontos.',
  input: {
    destination: z.string().describe('Arquivo de destino (ex.: C:/Projetos/helix-corrigido.zip) ou pasta (termine com /)'),
    extract: z.boolean().optional().describe('Extrair o zip recebido na pasta de destino (padrao false)'),
    overwrite: z.boolean().optional().describe('Sobrescrever arquivos existentes (padrao false; sem isso, gera " (2)" ou pula na extracao)'),
    strip_root: z.boolean().optional().describe('Na extracao, remover a pasta raiz unica do zip (padrao false)'),
    ttl_minutes: ttlArg
  },
  annotations: { destructiveHint: true, openWorldHint: true },
  mutating: true,
  async run(args, ctx) {
    try {
      const destination = resolvePath(args.destination, ctx.config);
      const ticket = ctx.tickets.createUpload({
        destination,
        extract: !!args.extract,
        overwrite: !!args.overwrite,
        stripRoot: !!args.strip_root,
        ttlMinutes: args.ttl_minutes,
        label: path.basename(destination) || destination
      });
      const url = `${ctx.baseUrl()}/ul/${ticket.id}`;
      const text = [
        `Link de upload criado (valido ate ${expiresText(ticket.expiresAt)}). Destino no PC: ${destination}${args.extract ? ' (zip sera extraido aqui)' : ''}`,
        url,
        'Envio simples (ate ~90 MB por requisicao quando passa pelo tunel):',
        `  curl -sS -T "arquivo.zip" "${url}"`,
        'Arquivo grande (dividir em partes de 80 MB e finalizar):',
        `  split -b 80m arquivo.zip parte_ && i=1; for p in parte_*; do curl -sS -T "$p" "${url}?part=$i"; i=$((i+1)); done; curl -sS -X POST "${url}/finish"`,
        `Status a qualquer momento: curl -sS "${url}/status"`,
        'A resposta JSON traz saved_to/extracted_to, bytes e sha256 para voce conferir.'
      ].join('\n');
      return ok(text, { url, destination, extract: !!args.extract, expires_at: new Date(ticket.expiresAt).toISOString() });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});
