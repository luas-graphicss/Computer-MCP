import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { VERSION } from '../config.js';
import { IS_WINDOWS, exists, humanSize, resolvePath, statOrNull } from '../paths.js';
import { availableShells, pickShell } from './processes.js';
import { defineTool, describeError, fail, ok } from './types.js';

async function listDrives(): Promise<string[]> {
  if (IS_WINDOWS) {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZB'.split('');
    const checks = letters.map(async (l) => ((await exists(`${l}:\\`)) ? `${l}:\\` : null));
    const timeout = new Promise<null[]>((resolve) => setTimeout(() => resolve([]), 1500));
    const found = await Promise.race([Promise.all(checks), timeout]);
    return (found.filter(Boolean) as string[]).sort();
  }
  const mounts: string[] = ['/'];
  for (const base of ['/mnt', '/media', '/Volumes', `/media/${os.userInfo().username}`]) {
    try {
      const entries = await fsp.readdir(base);
      for (const e of entries) mounts.push(path.join(base, e));
    } catch {

    }
  }
  return [...new Set(mounts)];
}

async function knownFolders(): Promise<Record<string, string>> {
  const home = os.homedir();
  const candidates: Record<string, string[]> = {
    desktop: ['Desktop', 'Área de Trabalho', 'Area de Trabalho'],
    downloads: ['Downloads', 'Transferências'],
    documents: ['Documents', 'Documentos'],
    pictures: ['Pictures', 'Imagens'],
    videos: ['Videos', 'Vídeos'],
    music: ['Music', 'Músicas', 'Musicas']
  };
  const out: Record<string, string> = { home };
  for (const [key, names] of Object.entries(candidates)) {
    for (const name of names) {
      const p = path.join(home, name);
      if (await exists(p)) {
        out[key] = p;
        break;
      }
    }
  }
  if (IS_WINDOWS && process.env.OneDrive) out.onedrive = process.env.OneDrive;
  return out;
}

export const systemInfo = defineTool({
  name: 'system_info',
  title: 'Informacoes do PC',
  group: 'sistema',
  description:
    'Mostra o sistema operacional, usuario, pastas conhecidas (Downloads, Desktop, Documentos...), discos, shells disponiveis, politicas de acesso (pastas liberadas, somente leitura) e a URL base para links de download/upload. Chame primeiro para se orientar.',
  input: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(_args, ctx) {
    const [drives, folders] = await Promise.all([listDrives(), knownFolders()]);
    const shells = availableShells();
    const data = {
      pc_mcp_version: VERSION,
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      hostname: os.hostname(),
      user: os.userInfo().username,
      home: os.homedir(),
      temp: os.tmpdir(),
      path_separator: path.sep,
      known_folders: folders,
      drives,
      cpus: os.cpus().length,
      memory: { total: humanSize(os.totalmem()), free: humanSize(os.freemem()) },
      uptime_hours: Math.round(os.uptime() / 360) / 10,
      local_time: new Date().toString(),
      node: process.version,
      shells_available: shells,
      default_shell: ctx.config.shellEnabled ? pickShell('auto', ctx.config.defaultShell) : null,
      shell_enabled: ctx.config.shellEnabled,
      read_only: ctx.config.readOnly,
      allowed_roots: ctx.config.roots.length ? ctx.config.roots : 'PC inteiro',
      base_url: ctx.baseUrl(),
      links_ttl_minutes: ctx.config.ticketTtlMinutes,
      trash_folder: path.join(ctx.config.dataDir, 'trash')
    };
    const lines = [
      `Sistema: ${data.os} (${data.arch}) | usuario: ${data.user} | host: ${data.hostname}`,
      `Home: ${data.home}`,
      `Pastas conhecidas: ${Object.entries(folders)
        .filter(([k]) => k !== 'home')
        .map(([k, v]) => `${k}=${v}`)
        .join(' | ')}`,
      `Discos/montagens: ${drives.join(', ')}`,
      `Separador de caminho: "${path.sep}" | temp: ${data.temp}`,
      `Memoria: ${data.memory.free} livres de ${data.memory.total} | CPUs: ${data.cpus} | uptime: ${data.uptime_hours}h`,
      `Shells: ${shells.join(', ') || 'nenhum'} | shell padrao: ${data.default_shell ?? 'terminal desligado'}`,
      `Politica: ${data.read_only ? 'SOMENTE LEITURA' : 'leitura e escrita'} | pastas liberadas: ${Array.isArray(data.allowed_roots) ? data.allowed_roots.join('; ') : data.allowed_roots}`,
      `Base para links: ${data.base_url} (validade padrao ${data.links_ttl_minutes} min)`,
      `Lixeira do pc-mcp (fs_delete sem permanent): ${data.trash_folder}`,
      `Hora local: ${data.local_time}`
    ];
    return ok(lines.join('\n'), data);
  }
});

export const openPath = defineTool({
  name: 'open_path',
  title: 'Abrir no Explorer / app padrao',
  group: 'sistema',
  description:
    'Abre uma pasta no Explorer (Windows), Finder (macOS) ou gerenciador de arquivos (Linux), ou abre um arquivo no aplicativo padrao do usuario. Com reveal=true, abre a pasta pai com o arquivo selecionado. Util para mostrar ao usuario o resultado de uma tarefa.',
  input: {
    path: z.string().describe('Caminho do arquivo ou pasta'),
    reveal: z.boolean().optional().describe('Selecionar o item na pasta pai em vez de abrir diretamente')
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    try {
      const target = resolvePath(args.path, ctx.config);
      const st = await statOrNull(target);
      if (!st) return fail(`Caminho nao existe: ${target}`);
      let file: string;
      let argv: string[];
      if (IS_WINDOWS) {
        file = 'explorer.exe';
        argv = args.reveal && st.isFile() ? [`/select,${target}`] : [target];
      } else if (process.platform === 'darwin') {
        file = 'open';
        argv = args.reveal ? ['-R', target] : [target];
      } else {
        file = 'xdg-open';
        argv = [args.reveal && st.isFile() ? path.dirname(target) : target];
      }
      const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return ok(`Aberto no sistema: ${target}`, { path: target });
    } catch (err) {
      return fail(describeError(err));
    }
  }
});
