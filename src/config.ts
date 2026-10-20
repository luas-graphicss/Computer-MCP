import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '1.0.0';
export const APP_NAME = 'pc-mcp';

export type TunnelMode = 'cloudflared' | 'none';
export type ShellKind = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'zsh' | 'sh';

export interface Config {
  dataDir: string;
  token: string;
  host: string;
  port: number;
  tunnel: TunnelMode;
  cloudflaredToken?: string;
  publicUrl?: string;
  roots: string[];
  readOnly: boolean;
  shellEnabled: boolean;
  defaultShell: ShellKind;
  ticketTtlMinutes: number;
  maxUploadBytes: number;
  jsonResponse: boolean;
  verbose: boolean;
  openBrowser: boolean;
}

interface PersistedConfig {
  token?: string;
  host?: string;
  port?: number;
  tunnel?: TunnelMode;
  cloudflaredToken?: string;
  publicUrl?: string;
  roots?: string[];
  readOnly?: boolean;
  shell?: boolean;
  defaultShell?: ShellKind;
  ticketTtlMinutes?: number;
  maxUploadMb?: number;
  jsonResponse?: boolean;
}

export interface CliOptions {
  help: boolean;
  version: boolean;
  newToken: boolean;
  showToken: boolean;
  save: boolean;
  overrides: PersistedConfig;
  dataDir?: string;
  verbose: boolean;
  noBrowser: boolean;
}

export const HELP_TEXT = `
${APP_NAME} ${VERSION} - seu PC como servidor MCP para agentes de IA

Uso: node dist/pc-mcp.mjs [opcoes]

Opcoes principais
  --port <n>              Porta local (padrao 4747)
  --tunnel <modo>         cloudflared (padrao, URL publica automatica) ou none (so rede local)
  --public-url <url>      URL publica propria (ngrok, tunel nomeado, etc.). Desliga o tunel automatico
  --cf-token <token>      Token de tunel NOMEADO do Cloudflare (URL fixa). Use junto com --public-url
  --token <valor>         Usa este token em vez do token salvo
  --new-token             Gera um token novo e salva
  --show-token            Mostra o token atual e sai

Seguranca
  --roots <a;b;c>         Restringe o acesso a estas pastas (separe com ';'). Padrao: PC inteiro
  --read-only             Bloqueia gravacao, movimentacao, exclusao, terminal e importacao
  --no-shell              Desliga terminal e processos (arquivos continuam liberados)
  --shell <tipo>          Shell padrao: auto | powershell | pwsh | cmd | bash | zsh | sh

Outros
  --ttl <min>             Validade dos links de download/upload em minutos (padrao 120)
  --max-upload-mb <n>     Tamanho maximo por upload (padrao 4096)
  --json-response         Respostas MCP em JSON puro em vez de SSE (util atras de alguns proxies)
  --host <ip>             Interface local (padrao 127.0.0.1)
  --data-dir <pasta>      Pasta de dados (padrao ~/.pc-mcp)
  --save                  Salva as opcoes informadas em config.json para as proximas execucoes
  --no-browser            Nao abre a pagina de status no navegador
  --verbose               Log detalhado
  -h, --help              Esta ajuda
  -v, --version           Versao

Variaveis de ambiente: PC_MCP_TOKEN, PC_MCP_PORT, PC_MCP_DATA_DIR, PC_MCP_TUNNEL, PC_MCP_PUBLIC_URL
`.trim();

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    version: false,
    newToken: false,
    showToken: false,
    save: false,
    overrides: {},
    verbose: false,
    noBrowser: false
  };
  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Opcao ${flag} precisa de um valor`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--new-token':
        opts.newToken = true;
        break;
      case '--show-token':
        opts.showToken = true;
        break;
      case '--save':
        opts.save = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--no-browser':
        opts.noBrowser = true;
        break;
      case '--read-only':
        opts.overrides.readOnly = true;
        break;
      case '--no-shell':
        opts.overrides.shell = false;
        break;
      case '--json-response':
        opts.overrides.jsonResponse = true;
        break;
      case '--port':
        opts.overrides.port = parsePort(next(i++, a));
        break;
      case '--host':
        opts.overrides.host = next(i++, a);
        break;
      case '--token':
        opts.overrides.token = next(i++, a).trim();
        break;
      case '--tunnel': {
        const v = next(i++, a).toLowerCase();
        if (v !== 'cloudflared' && v !== 'none') throw new Error(`--tunnel aceita cloudflared ou none (recebido: ${v})`);
        opts.overrides.tunnel = v;
        break;
      }
      case '--public-url':
        opts.overrides.publicUrl = normalizePublicUrl(next(i++, a));
        break;
      case '--cf-token':
        opts.overrides.cloudflaredToken = next(i++, a).trim();
        break;
      case '--roots':
        opts.overrides.roots = splitRoots(next(i++, a));
        break;
      case '--shell': {
        const v = next(i++, a).toLowerCase() as ShellKind;
        const allowed: ShellKind[] = ['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh'];
        if (!allowed.includes(v)) throw new Error(`--shell aceita ${allowed.join(' | ')}`);
        opts.overrides.defaultShell = v;
        break;
      }
      case '--ttl':
        opts.overrides.ticketTtlMinutes = parsePositiveInt(next(i++, a), '--ttl');
        break;
      case '--max-upload-mb':
        opts.overrides.maxUploadMb = parsePositiveInt(next(i++, a), '--max-upload-mb');
        break;
      case '--data-dir':
        opts.dataDir = next(i++, a);
        break;
      default:
        if (a.startsWith('-')) throw new Error(`Opcao desconhecida: ${a} (use --help)`);
    }
  }
  return opts;
}

function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Porta invalida: ${v}`);
  return n;
}

function parsePositiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} precisa de um inteiro positivo`);
  return n;
}

export function normalizePublicUrl(v: string): string {
  let url = v.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

function splitRoots(v: string): string[] {
  return v
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function defaultDataDir(): string {
  return process.env.PC_MCP_DATA_DIR || path.join(os.homedir(), '.pc-mcp');
}

export function generateToken(): string {
  return crypto.randomBytes(30).toString('base64url');
}

function readPersisted(file: string): PersistedConfig {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePersisted(file: string, data: PersistedConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function loadConfig(opts: CliOptions): { config: Config; configFile: string; tokenIsNew: boolean } {
  const dataDir = path.resolve(opts.dataDir || defaultDataDir());
  for (const sub of ['bin', 'exports', 'uploads', 'trash', 'logs']) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  const configFile = path.join(dataDir, 'config.json');
  const persisted = readPersisted(configFile);

  let tokenIsNew = false;
  let token = opts.overrides.token || process.env.PC_MCP_TOKEN || persisted.token || '';
  if (opts.newToken || !token) {
    token = generateToken();
    tokenIsNew = true;
  }
  if (token.length < 16) throw new Error('O token precisa ter pelo menos 16 caracteres');

  const merged: PersistedConfig = { ...persisted, ...opts.overrides, token };
  if (tokenIsNew || opts.save) {
    const toSave: PersistedConfig = opts.save ? { ...merged } : { ...persisted, token };
    writePersisted(configFile, toSave);
  }

  const envPort = process.env.PC_MCP_PORT ? parsePort(process.env.PC_MCP_PORT) : undefined;
  const envTunnel = process.env.PC_MCP_TUNNEL as TunnelMode | undefined;
  const publicUrl = merged.publicUrl || (process.env.PC_MCP_PUBLIC_URL ? normalizePublicUrl(process.env.PC_MCP_PUBLIC_URL) : undefined);

  let tunnel: TunnelMode = merged.tunnel || (envTunnel === 'none' ? 'none' : 'cloudflared');
  if (publicUrl && !merged.cloudflaredToken) tunnel = 'none';

  const config: Config = {
    dataDir,
    token,
    host: merged.host || '127.0.0.1',
    port: merged.port ?? envPort ?? 4747,
    tunnel,
    cloudflaredToken: merged.cloudflaredToken,
    publicUrl,
    roots: (merged.roots || []).map((r) => path.resolve(expandHome(r))),
    readOnly: !!merged.readOnly,
    shellEnabled: merged.shell !== false && !merged.readOnly,
    defaultShell: merged.defaultShell || 'auto',
    ticketTtlMinutes: merged.ticketTtlMinutes ?? 120,
    maxUploadBytes: (merged.maxUploadMb ?? 4096) * 1024 * 1024,
    jsonResponse: !!merged.jsonResponse,
    verbose: opts.verbose,
    openBrowser: !opts.noBrowser
  };
  return { config, configFile, tokenIsNew };
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
