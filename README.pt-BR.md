# Computer MCP

[Read in English](README.md)

O Computer MCP, ou pc-mcp, é um servidor pequeno que dá a agentes de IA acesso controlado ao seu computador pelo Model Context Protocol. Com ele rodando, um agente consegue navegar e editar arquivos, fazer buscas, organizar pastas, criar e extrair arquivos zip, rodar comandos no terminal, iniciar e controlar processos em segundo plano e transferir arquivos entre o seu PC e a sandbox onde ele trabalha.

Quando inicia, o servidor cria um token de acesso e abre um endereço público por um túnel do Cloudflare, baixando o cloudflared na primeira vez caso ele não esteja instalado. Depois ele mostra o endereço e o token para colar em qualquer cliente MCP e abre uma página de status no navegador. Se preferir, dá para desligar o túnel e usar só a rede local, ou apontar para um endereço seu do ngrok ou de um túnel nomeado do Cloudflare.

Como isso dá bastante poder para um agente, existem algumas formas de limitar. Por padrão ele enxerga o computador inteiro, mas você pode restringir o acesso a pastas específicas, iniciar em modo somente leitura, que bloqueia gravação, movimentação, exclusão, terminal e importação, ou deixar os arquivos liberados e desligar só o terminal. Os links de download e upload expiram depois de duas horas por padrão.

## Como usar

Você precisa do Node.js 18.17 ou mais novo. No Windows, dê dois cliques em Iniciar pc-mcp.bat, ou na versão somente leitura que fica ao lado. No Mac ou no Linux rode o iniciar.sh, que também compila o projeto na primeira vez. Depois é só copiar o endereço e o token para o seu cliente MCP.

Se quiser fazer na mão, rode npm install, npm run build e npm start. Rodando com a opção --help aparece tudo o que dá para mudar, como a porta, o modo do túnel, as pastas liberadas e o shell padrão. As opções podem ser salvas para as próximas execuções e também podem vir de variáveis de ambiente como PC_MCP_TOKEN e PC_MCP_PORT.

## Tempo de desenvolvimento

O Computer MCP foi feito em uma hora.

## Licença

GNU General Public License versão 3. O texto completo está no arquivo LICENSE.
