import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { VERSION } from '../config.js';
import { handleDownload, handleUpload, sendJson, sendText } from '../transfer/http.js';
import type { ServerDeps } from './deps.js';
import { createMcpServer } from './mcp.js';
import { handleTerminalPort, helpText, type TerminalRoute } from './terminal-port.js';
import { renderStatusPage } from './status-page.js';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-File-Name, X-Api-Key',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, X-File-Size, X-Checksum-Sha256, Content-Disposition',
  'Access-Control-Max-Age': '86400'
};

type AuthSource = 'path' | 'header' | 'query';

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'desconhecido';
}

function isLocalRequest(req: IncomingMessage, port: number): boolean {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  const remote = req.socket.remoteAddress || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return loopback && allowedHosts.includes(host);
}

class AuthThrottle {
  private failures = new Map<string, { count: number; resetAt: number }>();
  blocked(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (f.resetAt < Date.now()) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= 20;
  }
  fail(ip: string): void {
    const f = this.failures.get(ip);
    if (f && f.resetAt > Date.now()) f.count++;
    else this.failures.set(ip, { count: 1, resetAt: Date.now() + 60_000 });
  }
}

interface LegacySession {
  transport: SSEServerTransport;
  server: ReturnType<typeof createMcpServer>;
}

export function createHttpServer(deps: ServerDeps): http.Server {
  const { config, log } = deps;
  const throttle = new AuthThrottle();
  const legacySessions = new Map<string, LegacySession>();

  const authenticate = (req: IncomingMessage, url: URL, segments: string[]): { ok: true; source: AuthSource; rest: string[]; base: string } | { ok: false } => {
    const [first, ...others] = segments;
    if (others[0] && tokenMatches(others[0], config.token)) {
      return { ok: true, source: 'path', rest: others.slice(1), base: `/${first}/${others[0]}` };
    }
    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (m && tokenMatches(m[1].trim(), config.token)) return { ok: true, source: 'header', rest: others, base: `/${first}` };
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && tokenMatches(apiKey.trim(), config.token)) return { ok: true, source: 'header', rest: others, base: `/${first}` };
    const query = url.searchParams.get('token');
    if (query && tokenMatches(query, config.token)) return { ok: true, source: 'query', rest: others, base: `/${first}` };
    return { ok: false };
  };

  const handleStreamable = async (req: IncomingMessage, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: config.jsonResponse,
      maxRequestBodySize: 128 * 1024 * 1024,

      keepAliveMs: config.jsonResponse ? undefined : 15_000
    });
    const server = createMcpServer(deps, 'mcp');
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const handleLegacySse = async (req: IncomingMessage, res: ServerResponse, base: string, source: AuthSource) => {
    const endpoint = `${base}/messages${source === 'query' ? `?token=${encodeURIComponent(config.token)}` : ''}`;
    const transport = new SSEServerTransport(endpoint, res);
    const server = createMcpServer(deps, 'sse');
    legacySessions.set(transport.sessionId, { transport, server });
    transport.onclose = () => legacySessions.delete(transport.sessionId);
    await server.connect(transport);
    log.debug(`sessao SSE legada aberta: ${transport.sessionId}`);
  };

  const handleLegacyMessage = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const sessionId = url.searchParams.get('sessionId') || '';
    const session = legacySessions.get(sessionId);
    if (!session) return sendJson(res, 404, { error: 'Sessao SSE nao encontrada; reconecte em /sse.' });
    await session.transport.handlePostMessage(req, res);
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${config.port}`}`);
    const segments = url.pathname.split('/').filter(Boolean);
    const ip = clientIp(req);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

      if (!segments.length) {
        const local = isLocalRequest(req, config.port);
        const html = renderStatusPage(deps, local);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
        return res.end(html);
      }

      if (segments[0] === 'health') {
        return sendJson(res, 200, { ok: true, name: 'pc-mcp', version: VERSION, uptime_s: Math.round((Date.now() - deps.startedAt) / 1000), tunnel: !!deps.publicUrl() });
      }

      if (segments[0] === 'favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

      if (segments[0] === 'dl' && segments[1]) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Use GET.');
        return await handleDownload(req, res, segments[1], { tickets: deps.tickets, log, maxUploadBytes: config.maxUploadBytes });
      }

      if (segments[0] === 'ul' && segments[1]) {
        return await handleUpload(req, res, segments[1], segments.slice(2), url, { tickets: deps.tickets, log, maxUploadBytes: config.maxUploadBytes });
      }

      if (segments[0] === 'mcp' || segments[0] === 'sse' || segments[0] === 'messages') {
        if (throttle.blocked(ip)) return sendJson(res, 429, { error: 'Muitas tentativas de autenticacao; aguarde um minuto.' });
        const auth = authenticate(req, url, segments);
        if (!auth.ok) {
          throttle.fail(ip);
          log.activity({ kind: 'auth', name: 'recusado', summary: `token invalido de ${ip} em ${url.pathname}` });
          res.setHeader('WWW-Authenticate', 'Bearer realm="pc-mcp"');
          return sendJson(res, 401, {
            error: 'Token invalido ou ausente.',
            how_to: 'Use a URL com o token embutido (/mcp/<token>) ou envie Authorization: Bearer <token>. O token aparece no terminal onde o pc-mcp esta rodando.'
          });
        }
        const route: TerminalRoute = { base: auth.base, tokenInPath: auth.source === 'path' };
        const head = segments[0];
        const rest = head === 'mcp' ? auth.rest : [head, ...auth.rest];

        if (!rest.length) {
          const accept = String(req.headers.accept || '');
          if (req.method === 'GET' && !accept.includes('text/event-stream')) return sendText(res, 200, helpText(deps, deps.baseUrl(), route));
          return await handleStreamable(req, res);
        }
        if (rest[0] === 'sse' && rest.length === 1) {
          if (req.method !== 'GET') return sendText(res, 405, 'Use GET para abrir o fluxo SSE.');
          return await handleLegacySse(req, res, auth.base, auth.source);
        }
        if (rest[0] === 'messages' && rest.length === 1) {
          if (req.method !== 'POST') return sendText(res, 405, 'Use POST.');
          return await handleLegacyMessage(req, res, url);
        }
        return await handleTerminalPort(req, res, url, rest, route, deps);
      }

      return sendText(res, 404, 'pc-mcp: rota nao encontrada. Rotas: /mcp/<token>, /dl/<ticket>, /ul/<ticket>, /health');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`falha ao atender ${req.method} ${url.pathname}: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    } finally {
      log.activity({ kind: 'http', name: `${req.method} ${url.pathname.replace(config.token, '<token>')}`, summary: `${res.statusCode} ${Date.now() - started}ms ${ip}` });
    }
  });

  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;
  return server;
}
