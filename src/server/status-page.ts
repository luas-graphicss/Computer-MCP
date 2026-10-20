import { VERSION } from '../config.js';
import { toolsFor } from '../tools/index.js';
import type { ServerDeps } from './deps.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

export function renderStatusPage(deps: ServerDeps, local: boolean): string {
  const { config } = deps;
  const publicUrl = deps.publicUrl();
  const base = deps.baseUrl();
  const mcpUrl = `${base}/mcp/${config.token}`;
  const uptime = Math.round((Date.now() - deps.startedAt) / 1000);
  const tools = toolsFor(config);

  const connection = local
    ? `
      <section>
        <h2>URL para colar no agente</h2>
        <div class="row"><code id="u">${esc(mcpUrl)}</code><button data-copy="u">copiar</button></div>
        <p class="hint">Essa URL ja contem o token. Em clientes que pedem URL + cabecalho, use <code>${esc(base)}/mcp</code> com <code>Authorization: Bearer &lt;token&gt;</code>.</p>
        <div class="row"><span>Token</span><code id="t">${esc(config.token)}</code><button data-copy="t">copiar</button></div>
        ${publicUrl ? '' : '<p class="warn">Sem tunel ativo: a URL acima so funciona na sua rede local. Inicie com --tunnel cloudflared (padrao) para uma URL publica.</p>'}
      </section>
      <section>
        <h2>Mensagem pronta para o agente</h2>
        <pre id="m">Conecte-se ao meu computador pelo MCP nesta URL: ${esc(mcpUrl)}
Se voce nao tiver cliente MCP, use o terminal: curl -fsSL ${esc(mcpUrl)}/cli.sh -o pc &amp;&amp; chmod +x pc &amp;&amp; ./pc help
(um GET simples na URL tambem devolve as rotas REST equivalentes)
Comece com system_info (ou ./pc info) e me diga o que encontrou.</pre>
        <button data-copy="m">copiar mensagem</button>
      </section>`
    : `
      <section>
        <h2>Servidor online</h2>
        <p>Este e um pc-mcp em execucao. A URL com token e exibida apenas no terminal do computador (e em http://127.0.0.1:${config.port}/ nele).</p>
      </section>`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pc-mcp ${esc(VERSION)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #f6f6f3; --card: #ffffff; --line: #d9d9d4; --accent: #0f6e56; --muted: #5f5f5a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececea; --bg: #141414; --card: #1d1d1d; --line: #333; --accent: #3fb48f; --muted: #a0a09a; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; display: flex; flex-direction: column; gap: 20px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 22px; }
  h2 { margin: 0 0 10px; font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 0; }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; word-break: break-all; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; }
  button { font: inherit; border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: var(--accent); color: var(--card); }
  .hint, .meta { color: var(--muted); font-size: 13px; }
  .warn { color: #b45309; }
  .ok { color: var(--accent); font-weight: 600; }
  ul { margin: 0; padding-left: 18px; columns: 2; }
  @media (max-width: 600px) { ul { columns: 1; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>pc-mcp <span class="meta">${esc(VERSION)}</span></h1>
    <span class="ok">online ha ${uptime}s</span>
  </header>
  ${connection}
  <section>
    <h2>Estado</h2>
    <p class="meta">
      Tunel: ${publicUrl ? `ativo (${esc(publicUrl)})` : 'desligado'} ·
      Modo: ${config.readOnly ? 'somente leitura' : 'leitura e escrita'} ·
      Terminal: ${config.shellEnabled ? 'ativado' : 'desligado'} ·
      Pastas liberadas: ${config.roots.length ? esc(config.roots.join('; ')) : 'PC inteiro'} ·
      Links validos por ${config.ticketTtlMinutes} min
    </p>
  </section>
  <section>
    <h2>Ferramentas disponiveis (${tools.length})</h2>
    <ul>${tools.map((t) => `<li><strong>${esc(t.name)}</strong> <span class="meta">${esc(t.title)}</span></li>`).join('')}</ul>
  </section>
</main>
<script>
  document.querySelectorAll('button[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      const el = document.getElementById(b.dataset.copy);
      try { await navigator.clipboard.writeText(el.textContent); b.textContent = 'copiado'; setTimeout(() => (b.textContent = b.dataset.copy === 'm' ? 'copiar mensagem' : 'copiar'), 1500); } catch { alert('Selecione e copie manualmente.'); }
    });
  });
</script>
</body>
</html>`;
}
