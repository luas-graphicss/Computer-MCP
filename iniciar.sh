#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado. Instale a versao LTS em https://nodejs.org/ (ou: brew install node / apt install nodejs)."
  exit 1
fi

major=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$major" -lt 18 ]; then
  echo "Seu Node.js e antigo (v$major). O pc-mcp precisa do Node 18.17 ou mais novo."
  exit 1
fi

if [ ! -f dist/pc-mcp.mjs ]; then
  echo "dist/pc-mcp.mjs nao existe. Gerando a partir do codigo-fonte..."
  npm install --no-audit --no-fund && npm run build
fi

exec node dist/pc-mcp.mjs "$@"
