import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { VERSION } from '../config.js';
import { humanSize, resolvePath, statOrNull } from '../paths.js';
import { findTool, runTool, toolJsonSchema, toolsFor } from '../tools/index.js';
import type { ToolContext, ToolDef } from '../tools/types.js';
import { mimeFor, sendJson, sendText } from '../transfer/http.js';
import { renderCliScript } from './cli-script.js';
import type { ServerDeps } from './deps.js';

export interface TerminalRoute {

  base: string;

  tokenInPath: boolean;
}

function restContext(deps: ServerDeps): ToolContext {
  return {
    config: deps.config,
    log: deps.log,
    tickets: deps.tickets,
    processes: deps.processes,
    baseUrl: deps.baseUrl,
    progress: async () => {}
  };
}

export function helpText(deps: ServerDeps, origin: string, route: TerminalRoute): string {
  const base = `${origin}${route.base}`;
  const auth = route.tokenInPath ? '' : `\nAutenticacao: envie o cabecalho  Authorization: Bearer <token>  (ou ?token=<token>) em todas as chamadas.\n`;
  const tools = toolsFor(deps.config);
  const groups = new Map<string, ToolDef[]>();
  for (const t of tools) groups.set(t.group, [...(groups.get(t.group) || []), t]);
  const catalog = [...groups.entries()].map(([g, list]) => `  [${g}] ${list.map((t) => t.name).join(', ')}`).join('\n');
  return `pc-mcp ${VERSION} - este computador esta disponivel para voce (agente) por MCP ou por REST.
${auth}
MODO 1 - Cliente MCP (Streamable HTTP): aponte seu cliente para  ${base}
         (SSE legado: GET ${base}/sse)

MODO 2 - Somente terminal (sem cliente MCP). Atalho recomendado, uma CLI bash ja configurada:
  curl -fsSL ${base}/cli.sh -o pc && chmod +x pc && ./pc help
  ./pc ls ~/Downloads   ./pc zip ~/Projetos/helix   ./pc get ~/Downloads/helix.zip   ./pc push corrigido.zip ~/Projetos/helix/   ./pc sh 'npm test' cwd=~/Projetos/helix

MODO 3 - curl puro (as mesmas rotas que a CLI usa):
  GET  ${base}/tools                  catalogo de ferramentas (acrescente ?format=json para JSON Schema)
  GET  ${base}/tools/<nome>           detalhes e parametros de uma ferramenta
  POST ${base}/call/<nome>            executa; corpo JSON {"param": valor} ou linhas chave=valor. ?format=json devolve objeto
  GET  ${base}/file/<caminho>         baixa um arquivo do PC (caminho absoluto, URL-encoded)
  PUT  ${base}/file/<caminho>         grava o corpo da requisicao no arquivo (cria pastas)
  DELETE ${base}/file/<caminho>       envia para a lixeira do pc-mcp
  GET  ${base}/status                 estado do servidor

Exemplos:
  curl -s ${base}/tools
  curl -s -X POST ${base}/call/system_info
  curl -s -X POST ${base}/call/fs_list -H 'Content-Type: application/json' -d '{"path":"~/Downloads"}'
  curl -s -X POST ${base}/call/export_zip -d '{"paths":["~/Projetos/helix"]}'      -> devolve URL para baixar o zip
  curl -s -X POST ${base}/call/upload_ticket -d '{"destination":"~/Projetos/helix-novo/","extract":true}'
  curl -s -X POST ${base}/call/shell_exec -d '{"command":"dir","cwd":"~"}'

Ferramentas (${tools.length}):
${catalog}

Fluxo tipico: system_info -> fs_list/fs_search -> export_zip (baixe no seu sandbox) -> trabalhe -> upload_ticket (devolva) -> shell_exec para testar.
Lixeira: fs_delete nao apaga de verdade a menos que permanent=true. fs_organize comeca em dry_run.`;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Corpo da requisicao muito grande');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function coerce(value: string): unknown {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function parseArgs(body: Buffer, contentType: string, url: URL): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) if (k !== 'format' && k !== 'token') args[k] = coerce(v);
  const text = body.toString('utf8').trim();
  if (!text) return args;
  if (contentType.includes('json') || text.startsWith('{')) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return { ...args, ...parsed };
  }
  if (contentType.includes('x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(text)) args[k] = coerce(v);
    return args;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
    if (m) args[m[1]] = coerce(m[2]);
  }
  return args;
}


function startKeepAlive(res: ServerResponse, contentType: string, delayMs = 15_000): { end: (status: number, body: string) => void } {
  let streaming = false;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (!streaming) {
      streaming = true;
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    }
    res.write('\n');
  }, delayMs);
  return {
    end(status, body) {
      clearInterval(timer);
      if (res.writableEnded || res.destroyed) return;
      if (streaming) {
        res.end(body);
        return;
      }
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    }
  };
}

export async function handleTerminalPort(req: IncomingMessage, res: ServerResponse, url: URL, rest: string[], route: TerminalRoute, deps: ServerDeps): Promise<void> {
  const [section, ...tail] = rest;
  const origin = deps.baseUrl();
  const wantsJson = url.searchParams.get('format') === 'json';

  if (section === 'cli.sh' || section === 'cli') {
    const script = renderCliScript(`${origin}${route.base}`, route.tokenInPath);
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Content-Length': Buffer.byteLength(script), 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="pc"' });
    res.end(script);
    return;
  }

  if (section === 'status') {
    return sendJson(res, 200, {
      ok: true,
      name: 'pc-mcp',
      version: VERSION,
      uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
      public_url: deps.publicUrl() ?? null,
      read_only: deps.config.readOnly,
      shell_enabled: deps.config.shellEnabled,
      allowed_roots: deps.config.roots,
      tools: toolsFor(deps.config).length
    });
  }

  if (section === 'tools') {
    const tools = toolsFor(deps.config);
    if (tail[0]) {
      const tool = findTool(deps.config, tail[0]);
      if (!tool) return sendText(res, 404, `Ferramenta "${tail[0]}" nao existe. Lista: GET ${origin}${route.base}/tools`);
      return sendJson(res, 200, { name: tool.name, title: tool.title, group: tool.group, description: tool.description, input_schema: toolJsonSchema(tool), annotations: tool.annotations ?? {} });
    }
    if (wantsJson) {
      return sendJson(res, 200, tools.map((t) => ({ name: t.name, title: t.title, group: t.group, description: t.description, input_schema: toolJsonSchema(t) })));
    }
    const lines = tools.map((t) => {
      const params = Object.entries(t.input)
        .map(([k, v]) => `${k}${(v as { isOptional?: () => boolean }).isOptional?.() ? '?' : ''}`)
        .join(', ');
      return `${t.name}(${params})\n    ${t.description}`;
    });
    return sendText(res, 200, `Ferramentas (${tools.length}) - detalhes: GET ${origin}${route.base}/tools/<nome>\n\n${lines.join('\n\n')}`);
  }

  if (section === 'call') {
    if (req.method !== 'POST') return sendText(res, 405, 'Use POST.');
    const name = tail[0];
    if (!name) return sendText(res, 400, `Informe a ferramenta: POST ${origin}${route.base}/call/<nome>`);
    const tool = findTool(deps.config, name);
    if (!tool) return sendText(res, 404, `Ferramenta "${name}" nao existe (ou esta bloqueada pela politica). Lista: GET ${origin}${route.base}/tools`);
    let args: Record<string, unknown>;
    try {
      args = parseArgs(await readBody(req), String(req.headers['content-type'] || ''), url);
    } catch (err) {
      return sendText(res, 400, `Corpo invalido: ${(err as Error).message}`);
    }
    const keepAlive = startKeepAlive(res, wantsJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    const result = await runTool(tool, args, restContext(deps), deps.log, 'rest');
    const status = result.isError ? 400 : 200;
    if (wantsJson) return keepAlive.end(status, JSON.stringify({ ok: !result.isError, text: result.text, data: result.data ?? null }, null, 2));
    return keepAlive.end(status, result.isError ? `ERRO: ${result.text}` : result.text);
  }

  if (section === 'file') {
    const raw = tail.map((s) => decodeURIComponent(s)).join('/');
    if (!raw) return sendText(res, 400, `Informe o caminho: ${origin}${route.base}/file/<caminho absoluto>`);
    let target: string;
    try {
      target = resolvePath(raw, deps.config);
    } catch (err) {
      return sendText(res, 403, (err as Error).message);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const st = await statOrNull(target);
      if (!st) return sendText(res, 404, `Nao existe: ${target}`);
      if (st.isDirectory()) {
        const tool = findTool(deps.config, 'fs_list')!;
        const result = await runTool(tool, { path: target }, restContext(deps), deps.log, 'rest');
        return sendText(res, 200, result.text);
      }
      res.writeHead(200, {
        'Content-Type': mimeFor(target),
        'Content-Length': String(st.size),
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(target))}"`,
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      deps.log.activity({ kind: 'tool', name: 'file_get', summary: `${target} (${humanSize(st.size)})`, ok: true, via: 'rest' });
      await pipeline(fs.createReadStream(target), res).catch(() => {});
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      if (deps.config.readOnly) return sendText(res, 403, 'Servidor em modo somente leitura.');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let size = 0;
      const out = fs.createWriteStream(target);
      req.on('data', (c: Buffer) => (size += c.length));
      await pipeline(req, out);
      deps.log.activity({ kind: 'tool', name: 'file_put', summary: `${target} (${humanSize(size)})`, ok: true, via: 'rest' });
      return sendJson(res, 200, { ok: true, saved_to: target, bytes: size });
    }
    if (req.method === 'DELETE') {
      const tool = findTool(deps.config, 'fs_delete');
      if (!tool) return sendText(res, 403, 'Exclusao bloqueada pela politica do servidor.');
      const result = await runTool(tool, { paths: [target] }, restContext(deps), deps.log, 'rest');
      return sendText(res, result.isError ? 400 : 200, result.text);
    }
    return sendText(res, 405, 'Metodos: GET, PUT, DELETE');
  }

  return sendText(res, 404, `Rota desconhecida: /${rest.join('/')}. Rotas: GET ${origin}${route.base} (ajuda), /cli.sh, /tools, /tools/<nome>, /call/<nome>, /file/<caminho>, /status, /sse`);
}
