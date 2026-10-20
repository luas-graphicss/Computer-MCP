import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../config.js';
import { runTool, toolsFor } from '../tools/index.js';
import type { ToolContext } from '../tools/types.js';
import type { ServerDeps } from './deps.js';

export const INSTRUCTIONS = `Voce esta conectado ao computador pessoal do usuario atraves do pc-mcp. Use as ferramentas com cuidado: elas agem no PC real.

Fluxo recomendado:
1. Chame system_info primeiro: mostra sistema operacional, usuario, pastas conhecidas (downloads, desktop, documents...), discos e politicas (somente leitura, pastas liberadas).
2. Para TRAZER arquivos ou projetos do PC para o seu ambiente: export_zip (pastas; node_modules/.git excluidos por padrao) ou export_file (um arquivo pronto, ex.: helix.zip). Ambos devolvem uma URL publica temporaria; baixe-a no seu sandbox com curl/wget e extraia.
3. Para DEVOLVER arquivos ao PC: upload_ticket devolve uma URL que aceita "curl -T arquivo URL" (com extract=true o zip e extraido no destino). Se o arquivo ja esta publicado em alguma URL, use import_url.
4. Pequenas correcoes podem ser feitas direto no PC com fs_read + fs_edit (substituicao de trecho) ou fs_write. Projetos grandes: exporte, trabalhe no sandbox e devolva com upload_ticket.
5. fs_organize comeca em simulacao (dry_run=true): mostre o plano ao usuario e so execute com dry_run=false depois de confirmar. fs_delete manda para a lixeira do pc-mcp; permanent=true apenas com pedido explicito.
6. shell_exec executa comandos (PowerShell no Windows por padrao; use shell=cmd quando o comando for de CMD). Processos longos (servidores, builds) devem usar process_start/process_read/process_kill.

Caminhos: aceite tanto C:/Users/... quanto C:\\Users\\... e ~/...; o servidor normaliza. Prefira caminhos absolutos. Se uma ferramenta devolver erro de acesso fora das pastas liberadas, explique ao usuario que ele pode liberar a pasta reiniciando o pc-mcp com --roots.`;

function buildContext(deps: ServerDeps, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): ToolContext {
  const progressToken = extra._meta?.progressToken;
  return {
    config: deps.config,
    log: deps.log,
    tickets: deps.tickets,
    processes: deps.processes,
    baseUrl: deps.baseUrl,
    signal: extra.signal,
    progress: async (message, current, total) => {
      try {
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: current ?? 0, total, message }
          });
        } else {
          await extra.sendNotification({ method: 'notifications/message', params: { level: 'info', logger: 'pc-mcp', data: message } });
        }
      } catch {

      }
    }
  };
}

export function createMcpServer(deps: ServerDeps, via: string): McpServer {
  const server = new McpServer(
    { name: 'pc-mcp', title: 'PC do usuario (pc-mcp)', version: VERSION },
    { capabilities: { logging: {}, tools: { listChanged: false } }, instructions: INSTRUCTIONS }
  );
  for (const tool of toolsFor(deps.config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, ...tool.annotations }
      },
      async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        const ctx = buildContext(deps, extra);
        const result = await runTool(tool, args, ctx, deps.log, via);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          structuredContent: result.data,
          isError: result.isError
        };
      }
    );
  }
  return server;
}
