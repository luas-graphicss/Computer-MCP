@echo off
setlocal
title pc-mcp - seu PC como servidor MCP
chcp 65001 >nul

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Node.js nao foi encontrado neste computador.
  echo  Instale a versao LTS em https://nodejs.org/  ^(ou rode: winget install OpenJS.NodeJS.LTS^)
  echo  Depois abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 18 (
  echo.
  echo  Seu Node.js e antigo ^(v%NODE_MAJOR%^). O pc-mcp precisa do Node 18.17 ou mais novo.
  echo  Atualize em https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0dist\pc-mcp.mjs" (
  echo  dist\pc-mcp.mjs nao existe. Gerando a partir do codigo-fonte ^(precisa de internet na primeira vez^)...
  pushd "%~dp0"
  call npm install --no-audit --no-fund && call npm run build
  popd
  if not exist "%~dp0dist\pc-mcp.mjs" (
    echo  Falha ao gerar o pc-mcp. Veja as mensagens acima.
    pause
    exit /b 1
  )
)

echo  Iniciando pc-mcp... ^(Ctrl+C encerra; feche esta janela para parar o servidor^)
echo.
node "%~dp0dist\pc-mcp.mjs" %*

echo.
echo  pc-mcp encerrado.
pause
