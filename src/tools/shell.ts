import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { humanSize, resolvePath } from '../paths.js';
import { execCommand, pickShell } from './processes.js';
import { defineTool, describeError, fail, ok } from './types.js';

const shellArg = z
  .enum(['auto', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh'])
  .optional()
  .describe('Shell a usar (padrao auto: PowerShell no Windows, bash no Linux/macOS)');

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}\n... [${text.length - max} caracteres omitidos] ...\n${text.slice(text.length - tail)}`,
    truncated: true
  };
}

export const shellExec = defineTool({
  name: 'shell_exec',
  title: 'Executar comando',
  group: 'terminal',
  description:
    'Executa um comando no terminal do PC e devolve stdout, stderr e codigo de saida. Padrao: PowerShell no Windows (use shell=cmd para comandos do CMD), bash no Linux/macOS. Para processos longos (servidores, builds demorados) use process_start. Saida forcada em UTF-8.',
  input: {
    command: z.string().min(1).describe('Comando completo, pode ter varias linhas'),
    cwd: z.string().optional().describe('Pasta de trabalho (padrao: home do usuario)'),
    shell: shellArg,
    timeout_ms: z.number().int().min(1000).max(3_600_000).optional().describe('Tempo maximo (padrao 120000 = 2 min)'),
    stdin: z.string().optional().describe('Texto enviado na entrada padrao'),
    env: z.record(z.string(), z.string()).optional().describe('Variaveis de ambiente adicionais'),
    max_output_chars: z
      .number()
      .int()
      .min(1000)
      .max(500_000)
      .optional()
      .describe('Limite de caracteres devolvidos por fluxo (padrao 30000; o restante vai para um arquivo de log)')
  },
  annotations: { destructiveHint: true, openWorldHint: true },
  mutating: true,
  needsShell: true,
  async run(args, ctx) {
    try {
      const cwd = args.cwd ? resolvePath(args.cwd, ctx.config) : os.homedir();
      const shell = pickShell(args.shell ?? 'auto', ctx.config.defaultShell);
      const timeoutMs = args.timeout_ms ?? 120_000;
      let lastReport = 0;
      const result = await execCommand({
        command: args.command,
        cwd,
        shell,
        timeoutMs,
        env: args.env,
        stdin: args.stdin,
        signal: ctx.signal,
        onActivity: () => {
          if (Date.now() - lastReport > 5000) {
            lastReport = Date.now();
            void ctx.progress('comando em execucao...');
          }
        }
      });
      const max = args.max_output_chars ?? 30_000;
      const out = clip(result.stdout, max);
      const err = clip(result.stderr, max);
      let logNote = '';
      if (out.truncated || err.truncated) {
        const logFile = path.join(ctx.config.dataDir, 'logs', `exec-${Date.now().toString(36)}.log`);
        await fsp
          .writeFile(logFile, `$ ${args.command}\n\n[stdout]\n${result.stdout}\n\n[stderr]\n${result.stderr}\n`, 'utf8')
          .catch(() => {});
        logNote = `\n[saida completa salva em ${logFile} - leia com fs_read]`;
      }
      const status = result.timedOut
        ? `TEMPO ESGOTADO apos ${timeoutMs}ms (processo finalizado)`
        : `exit ${result.exitCode ?? result.signal ?? '?'}`;
      const text = [
        `[${shell} @ ${cwd}] ${status} em ${result.durationMs}ms`,
        out.text ? `--- stdout ---\n${out.text}` : '--- stdout vazio ---',
        err.text ? `--- stderr ---\n${err.text}` : '',
        logNote
      ]
        .filter(Boolean)
        .join('\n');
      return {
        text,
        data: { exit_code: result.exitCode, timed_out: result.timedOut, duration_ms: result.durationMs, shell, cwd },
        isError: result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)
      };
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const processStart = defineTool({
  name: 'process_start',
  title: 'Iniciar processo em segundo plano',
  group: 'terminal',
  description:
    'Inicia um processo de longa duracao (servidor de dev, build, watch) sem bloquear. Devolve um id para usar em process_read, process_write e process_kill.',
  input: {
    command: z.string().min(1).describe('Comando a executar'),
    cwd: z.string().optional().describe('Pasta de trabalho (padrao: home)'),
    name: z.string().optional().describe('Apelido para identificar o processo'),
    shell: shellArg,
    env: z.record(z.string(), z.string()).optional().describe('Variaveis de ambiente adicionais'),
    wait_ms: z.number().int().min(0).max(60000).optional().describe('Esperar este tempo e ja devolver a saida inicial (padrao 1500)')
  },
  annotations: { destructiveHint: true, openWorldHint: true },
  mutating: true,
  needsShell: true,
  async run(args, ctx) {
    try {
      const cwd = args.cwd ? resolvePath(args.cwd, ctx.config) : os.homedir();
      const shell = pickShell(args.shell ?? 'auto', ctx.config.defaultShell);
      const proc = ctx.processes.start({ command: args.command, cwd, shell, name: args.name, env: args.env });
      await new Promise((r) => setTimeout(r, args.wait_ms ?? 1500));
      const tail = proc.buffer.slice(-4000);
      return ok(
        `Processo ${proc.id} (${proc.name}) ${proc.running ? 'em execucao' : `ja terminou com exit ${proc.exitCode}`} | pid ${proc.pid ?? '?'} | ${shell} @ ${cwd}\n--- saida inicial ---\n${tail || '(sem saida ainda)'}`,
        { id: proc.id, pid: proc.pid, running: proc.running, exit_code: proc.exitCode, log_file: proc.logFile }
      );
    } catch (err) {
      return fail(describeError(err));
    }
  }
});

export const processRead = defineTool({
  name: 'process_read',
  title: 'Ler saida de processo',
  group: 'terminal',
  description:
    'Le a saida acumulada (stdout+stderr) de um processo iniciado com process_start. tail_chars limita ao final da saida; wait_ms espera por saida nova antes de responder.',
  input: {
    id: z.string().describe('Id do processo (ex.: p1)'),
    tail_chars: z.number().int().min(100).max(200_000).optional().describe('Quantos caracteres finais devolver (padrao 8000)'),
    wait_ms: z.number().int().min(0).max(60000).optional().describe('Esperar ate este tempo por saida nova (padrao 0)')
  },
  annotations: { readOnlyHint: true },
  needsShell: true,
  async run(args, ctx) {
    const proc = ctx.processes.get(args.id);
    if (!proc) return fail(`Processo ${args.id} nao encontrado. Use process_list.`);
    if (args.wait_ms) {
      const before = proc.totalBytes;
      const deadline = Date.now() + args.wait_ms;
      while (Date.now() < deadline && proc.totalBytes === before && proc.running) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const text = proc.buffer.slice(-(args.tail_chars ?? 8000));
    const status = proc.running ? 'em execucao' : `terminou com exit ${proc.exitCode ?? proc.signal}`;
    return ok(
      `Processo ${proc.id} (${proc.name}) ${status} | ${humanSize(proc.totalBytes)} de saida total | log: ${proc.logFile}\n${text || '(sem saida)'}`,
      { id: proc.id, running: proc.running, exit_code: proc.exitCode, total_bytes: proc.totalBytes }
    );
  }
});

export const processWrite = defineTool({
  name: 'process_write',
  title: 'Enviar entrada a processo',
  group: 'terminal',
  description: 'Escreve texto na entrada padrao (stdin) de um processo em execucao. Inclua "\\n" ao final para simular Enter.',
  input: {
    id: z.string().describe('Id do processo'),
    input: z.string().describe('Texto a enviar')
  },
  annotations: { destructiveHint: true },
  mutating: true,
  needsShell: true,
  async run(args, ctx) {
    const done = ctx.processes.write(args.id, args.input);
    return done ? ok(`Enviado para ${args.id}.`) : fail(`Processo ${args.id} nao esta em execucao.`);
  }
});

export const processKill = defineTool({
  name: 'process_kill',
  title: 'Encerrar processo',
  group: 'terminal',
  description: 'Encerra um processo iniciado com process_start (e seus filhos).',
  input: { id: z.string().describe('Id do processo') },
  annotations: { destructiveHint: true },
  mutating: true,
  needsShell: true,
  async run(args, ctx) {
    const found = ctx.processes.kill(args.id);
    if (!found) return fail(`Processo ${args.id} nao encontrado.`);
    await new Promise((r) => setTimeout(r, 500));
    const proc = ctx.processes.get(args.id);
    return ok(`Processo ${args.id} ${proc?.running ? 'recebeu o sinal de encerramento' : 'encerrado'}.`);
  }
});

export const processList = defineTool({
  name: 'process_list',
  title: 'Listar processos gerenciados',
  group: 'terminal',
  description: 'Lista os processos iniciados por process_start nesta sessao do servidor, com estado e tempo de execucao.',
  input: {},
  annotations: { readOnlyHint: true },
  needsShell: true,
  async run(_args, ctx) {
    const list = ctx.processes.list();
    if (!list.length) return ok('Nenhum processo gerenciado.');
    const lines = list.map((p) => {
      const secs = Math.round(((p.endedAt ?? Date.now()) - p.startedAt) / 1000);
      return `${p.id}  ${p.running ? 'rodando ' : `exit ${p.exitCode ?? p.signal}`}  ${secs}s  pid ${p.pid ?? '?'}  ${p.name}  @ ${p.cwd}`;
    });
    return ok(lines.join('\n'), { processes: list.map((p) => ({ id: p.id, running: p.running, pid: p.pid, name: p.name })) });
  }
});
