import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_NAME, HELP_TEXT, VERSION, loadConfig, parseCli, type Config } from './config.js';
import { Logger, c } from './log.js';
import { IS_WINDOWS, humanSize } from './paths.js';
import type { ServerDeps } from './server/deps.js';
import { createHttpServer } from './server/http.js';
import { ProcessManager } from './tools/processes.js';
import { TicketStore } from './transfer/tickets.js';
import { Tunnel } from './tunnel.js';

function printBanner(config: Config, publicUrl: string | undefined, log: Logger): void {
  const local = `http://127.0.0.1:${config.port}`;
  const base = publicUrl || local;
  const lines = [
    '',
    c.bold(`${APP_NAME} ${VERSION} ${publicUrl ? c.green('online com URL publica') : c.yellow('online apenas na rede local')}`),
    '',
    c.bold('  Cole no agente (URL com token embutido):'),
    `  ${c.cyan(`${base}/mcp/${config.token}`)}`,
    '',
    c.dim('  Alternativa com cabecalho:'),
    c.dim(`  URL ${base}/mcp   +   Authorization: Bearer ${config.token}`),
    '',
    `  Local:     ${local}/   ${c.dim('(pagina com botoes de copiar; abre so neste PC)')}`,
    `  Pastas:    ${config.roots.length ? config.roots.join('; ') : 'PC inteiro'}${config.roots.length ? '' : c.dim('   (restrinja com --roots "C:\\Projetos;D:\\Dados")')}`,
    `  Terminal:  ${config.shellEnabled ? 'ativado' : c.yellow('desligado')}   Modo: ${config.readOnly ? c.yellow('somente leitura') : 'leitura e escrita'}`,
    `  Links:     validos por ${config.ticketTtlMinutes} min   Dados: ${config.dataDir}`,
    publicUrl ? c.dim('  A URL publica muda a cada reinicio (tunel rapido). Para URL fixa: --cf-token + --public-url.') : c.yellow('  Sem tunel. Agentes na internet nao alcancam este PC; use --tunnel cloudflared ou --public-url.'),
    c.dim('  Ctrl+C encerra. Cada acao do agente aparece abaixo e fica em logs/activity.log.'),
    ''
  ];
  console.log(lines.join('\n'));
  log.debug('banner exibido');
}

function openInBrowser(url: string): void {
  const [file, args] = IS_WINDOWS ? ['cmd.exe', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function trashSummary(dataDir: string): Promise<string | undefined> {
  const trash = path.join(dataDir, 'trash');
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(trash);
  } catch {
    return undefined;
  }
  if (!entries.length) return undefined;
  return `Lixeira do pc-mcp tem ${entries.length} lote(s) em ${trash} - apague quando quiser liberar espaco.`;
}

export async function main(argv: string[]): Promise<void> {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (err) {
    console.error(c.red((err as Error).message));
    console.error(HELP_TEXT);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (opts.version) {
    console.log(VERSION);
    return;
  }
  const { config, configFile, tokenIsNew } = loadConfig(opts);
  if (opts.showToken) {
    console.log(config.token);
    return;
  }
  const log = new Logger(config.verbose, path.join(config.dataDir, 'logs'));
  if (tokenIsNew) log.ok(`Token ${opts.newToken ? 'novo' : 'gerado'} e salvo em ${configFile}`);

  const tickets = new TicketStore(path.join(config.dataDir, 'exports'), path.join(config.dataDir, 'uploads'), config.ticketTtlMinutes * 60_000);
  const purged = await tickets.purgeStaleFiles();
  if (purged) log.debug(`${purged} arquivo(s) temporario(s) de execucoes anteriores removidos`);
  const processes = new ProcessManager(path.join(config.dataDir, 'logs'));

  let publicUrl: string | undefined = config.tunnel === 'none' ? config.publicUrl : undefined;
  const deps: ServerDeps = {
    config,
    log,
    tickets,
    processes,
    startedAt: Date.now(),
    publicUrl: () => publicUrl,
    baseUrl: () => publicUrl || `http://127.0.0.1:${config.port}`
  };

  const server = createHttpServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`A porta ${config.port} ja esta em uso. Feche o outro pc-mcp ou use --port 4748.`));
      else reject(err);
    });
    server.listen(config.port, config.host, () => resolve());
  }).catch((err: Error) => {
    log.error(err.message);
    process.exit(1);
  });
  const address = server.address();
  if (address && typeof address === 'object') config.port = address.port;
  log.ok(`Servidor local em http://${config.host}:${config.port}`);

  const summary = await trashSummary(config.dataDir);
  if (summary) log.info(c.dim(summary));

  let tunnel: Tunnel | undefined;
  if (config.tunnel === 'cloudflared') {
    tunnel = new Tunnel(config, log);
    tunnel.on('url', (url: string) => {
      publicUrl = url;
      log.ok(`Tunel ativo: ${url}`);
      printBanner(config, publicUrl, log);
    });
    tunnel.on('down', (reason: string) => {
      log.warn(`${reason}. Links antigos deixam de funcionar ate o tunel voltar.`);
    });
    log.info('Abrindo tunel publico (cloudflared)...');
    tunnel.start().catch((err: Error) => {
      log.error(`Nao foi possivel iniciar o tunel: ${err.message}`);
      log.warn('Seguindo apenas em modo local. Opcoes: --public-url <sua url> ou --tunnel none para silenciar.');
      printBanner(config, undefined, log);
    });
  } else {
    printBanner(config, publicUrl, log);
  }

  if (config.openBrowser) openInBrowser(`http://127.0.0.1:${config.port}/`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    log.info(`${signal}: encerrando...`);
    tunnel?.stop();
    processes.killAll();
    await tickets.disposeAll();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (IS_WINDOWS) {
    process.stdin.resume?.();
    process.on('SIGHUP', () => void shutdown('SIGHUP'));
  }
  process.on('uncaughtException', (err) => log.error(`erro inesperado: ${err.stack || err.message}`));
  process.on('unhandledRejection', (reason) => log.error(`promessa rejeitada: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`));

  if (config.verbose) log.debug(`exports em ${path.join(config.dataDir, 'exports')}, limite de upload ${humanSize(config.maxUploadBytes)}`);
}
