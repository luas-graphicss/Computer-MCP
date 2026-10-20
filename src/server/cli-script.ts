import { VERSION } from '../config.js';


export function renderCliScript(base: string, _tokenInPath: boolean): string {
  return `#!/usr/bin/env bash
set -euo pipefail

PC_BASE="\${PC_MCP_URL:-${base}}"

pc_curl() {
  if [ -n "\${PC_MCP_TOKEN:-}" ]; then
    curl -sS -L --connect-timeout 20 -H "Authorization: Bearer \$PC_MCP_TOKEN" "\$@"
  else
    curl -sS -L --connect-timeout 20 "\$@"
  fi
}

fix_home() {
  local p=\$1
  if [ -n "\${HOME:-}" ] && [ "\$HOME" != "/" ]; then
    case \$p in
      "\$HOME") p='~' ;;
      "\$HOME"/*) p="~\${p#"\$HOME"}" ;;
    esac
  fi
  printf '%s' "\$p"
}

json_escape() {
  local s=\$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//\\"/\\\\\\"}
  s=\${s//\$'\\n'/\\\\n}
  s=\${s//\$'\\r'/\\\\r}
  s=\${s//\$'\\t'/\\\\t}
  printf '%s' "\$s"
}

build_json() {
  local out="" k v arg
  for arg in "\$@"; do
    if [[ \$arg == *:=* ]]; then
      k=\${arg%%:=*}; v=\${arg#*:=}
    elif [[ \$arg == *=* ]]; then
      k=\${arg%%=*}; v=\${arg#*=}
      if [[ \$v =~ ^(true|false|null|-?[0-9]+(\\.[0-9]+)?)\$ ]]; then :; else v="\\"\$(json_escape "\$(fix_home "\$v")")\\""; fi
    else
      echo "argumento invalido: \$arg (use chave=valor ou chave:='{\\"json\\":1}')" >&2; exit 2
    fi
    out+="\${out:+,}\\"\$k\\":\$v"
  done
  printf '{%s}' "\$out"
}

call() {
  local tool=\$1; shift
  local body code
  body=\$(mktemp)
  code=\$(pc_curl -o "\$body" -w '%{http_code}' -X POST "\$PC_BASE/call/\$tool" -H 'Content-Type: application/json' --data-binary "\$(build_json "\$@")") || { rm -f "\$body"; return 7; }
  cat "\$body"; echo
  rm -f "\$body"
  [ "\$code" -lt 400 ] || return 22
}

json_list() {
  local out="" item
  for item in "\$@"; do out+="\${out:+,}\\"\$(json_escape "\$(fix_home "\$item")")\\""; done
  printf '[%s]' "\$out"
}

extract_url() { grep -oE 'https?://[^ "]+/(dl|ul)/[^ "?]+' | head -1; }

base_name() {
  local s=\${1%/}; s=\${s##*/}; s=\${s##*\\\\}
  printf '%s' "\${s:-arquivo}"
}

url_encode() {
  local s=\$1 out="" c i
  for ((i = 0; i < \${#s}; i++)); do
    c=\${s:i:1}
    case \$c in
      [a-zA-Z0-9.~_/-]) out+=\$c ;;
      *) out+=\$(printf '%%%02X' "'\$c") ;;
    esac
  done
  printf '%s' "\$out"
}

need() { [ \$# -ge "\$1" ] || { echo "uso: ./pc \$2" >&2; exit 2; }; }

cmd=\${1:-help}
[ \$# -gt 0 ] && shift

case \$cmd in
  help|-h|--help)
    cat <<EOF
pc - o computador do usuario pelo terminal (pc-mcp ${VERSION})
Servidor: \$PC_BASE

Explorar
  ./pc info                                  sistema, pastas conhecidas, discos, politicas
  ./pc ls <pasta> [depth=2] [glob=*.zip]      listar (d=pasta f=arquivo)
  ./pc stat <caminho>                        detalhes
  ./pc read <arquivo> [start_line=1 end_line=80]
  ./pc search <pasta> [name=*.zip] [content=TODO] [regex=true]
Trazer para ca (sandbox)
  ./pc get <arquivo-no-pc> [saida-local]      baixa um arquivo como esta (ex.: helix.zip)
  ./pc zip <pasta-no-pc> [saida.zip]          compacta a pasta no PC (sem node_modules/.git) e baixa
Devolver ao PC
  ./pc put <arquivo-local> <destino-no-pc> [overwrite=true]
  ./pc push <zip-local> <pasta-no-pc> [overwrite=true] [strip_root=true]   envia e extrai
  ./pc write <arquivo-no-pc> @local.txt | - | 'texto'
  ./pc edit <arquivo-no-pc> 'trecho antigo' 'trecho novo' [all=true]
Organizar
  ./pc mkdir <pasta>...        ./pc mv <origem> <destino>        ./pc cp <origem> <destino>
  ./pc rm <caminho>            (vai para a lixeira do pc-mcp; permanent=true apaga)
  ./pc organize <pasta> [strategy=type|extension|date] [dry_run=false]   (comeca em simulacao)
  ./pc unzip <zip-no-pc> <pasta-destino> [strip_root=true]
Terminal do PC
  ./pc sh '<comando>' [cwd=~/Projetos] [shell=cmd] [timeout_ms=600000]
  ./pc bg '<comando>' [name=dev]   ./pc out <id> [wait_ms=5000]   ./pc kill <id>   ./pc ps
Outros
  ./pc open <caminho>          abre no Explorer / app padrao do usuario
  ./pc tools | ./pc tool <nome> | ./pc status
  ./pc call <ferramenta> chave=valor chave:='{"json":true}'   qualquer ferramenta

Caminhos sao do PC do usuario: C:/Users/..., C:\\\\Users\\\\... ou ~/... (~ = home do PC; use ./pc info para ver as pastas).
Respostas sao texto limpo; erros comecam com "ERRO:" e o comando sai com codigo 22.
EOF
    ;;
  info) call system_info ;;
  ls|list) need 1 "ls <pasta>" "\$@"; call fs_list path="\$1" "\${@:2}" ;;
  stat) need 1 "stat <caminho>" "\$@"; call fs_stat path="\$1" ;;
  read|cat) need 1 "read <arquivo>" "\$@"; call fs_read path="\$1" "\${@:2}" ;;
  search|grep|find) need 1 "search <pasta> [name=..] [content=..]" "\$@"; call fs_search root="\$1" "\${@:2}" ;;
  get|download)
    need 1 "get <arquivo-no-pc> [saida-local]" "\$@"
    out=\${2:-\$(base_name "\$1")}
    pc_curl -f -o "\$out" "\$PC_BASE/file/\$(url_encode "\$(fix_home "\$1")")"
    echo "salvo em \$out (\$(wc -c <"\$out" | tr -d ' ') bytes)"
    ;;
  zip|export)
    need 1 "zip <pasta-no-pc> [saida.zip]" "\$@"
    res=\$(call export_zip paths:="\$(json_list "\$1")" "\${@:3}") || { printf '%s\\n' "\$res" >&2; exit 1; }
    url=\$(printf '%s' "\$res" | extract_url) || true
    [ -n "\$url" ] || { printf '%s\\n' "\$res" >&2; exit 1; }
    out=\${2:-\$(base_name "\$1").zip}
    pc_curl -f -o "\$out" "\$url"
    printf '%s\\n' "\$res" | head -1
    echo "baixado: \$out (\$(wc -c <"\$out" | tr -d ' ') bytes). Extraia com: unzip -o \$out -d ./\$(base_name "\$1")"
    ;;
  put|upload)
    need 2 "put <arquivo-local> <destino-no-pc>" "\$@"
    [ -f "\$1" ] || { echo "arquivo local nao existe: \$1" >&2; exit 1; }
    res=\$(call upload_ticket destination="\$2" "\${@:3}") || { printf '%s\\n' "\$res" >&2; exit 1; }
    url=\$(printf '%s' "\$res" | extract_url) || true
    [ -n "\$url" ] || { printf '%s\\n' "\$res" >&2; exit 1; }
    pc_curl -T "\$1" "\$url?name=\$(url_encode "\$(base_name "\$1")")"
    echo
    ;;
  push|deploy)
    need 2 "push <zip-local> <pasta-no-pc>" "\$@"
    [ -f "\$1" ] || { echo "zip local nao existe: \$1" >&2; exit 1; }
    res=\$(call upload_ticket destination="\$2" extract:=true "\${@:3}") || { printf '%s\\n' "\$res" >&2; exit 1; }
    url=\$(printf '%s' "\$res" | extract_url) || true
    [ -n "\$url" ] || { printf '%s\\n' "\$res" >&2; exit 1; }
    pc_curl -T "\$1" "\$url"
    echo
    ;;
  write)
    need 2 "write <arquivo-no-pc> @local | - | texto" "\$@"
    target="\$PC_BASE/file/\$(url_encode "\$(fix_home "\$1")")"
    case \$2 in
      @*) pc_curl -X PUT "\$target" --data-binary "\$2" ;;
      -) pc_curl -X PUT "\$target" --data-binary @- ;;
      *) pc_curl -X PUT "\$target" --data-binary "\$2" ;;
    esac
    echo
    ;;
  edit|replace) need 3 "edit <arquivo> 'antigo' 'novo'" "\$@"; call fs_edit path="\$1" find="\$2" replace="\$3" "\${@:4}" ;;
  mkdir) need 1 "mkdir <pasta>..." "\$@"; call fs_mkdir paths:="\$(json_list "\$@")" ;;
  mv|move|rename) need 2 "mv <origem> <destino>" "\$@"; call fs_move sources:="\$(json_list "\$1")" destination="\$2" "\${@:3}" ;;
  cp|copy) need 2 "cp <origem> <destino>" "\$@"; call fs_copy sources:="\$(json_list "\$1")" destination="\$2" "\${@:3}" ;;
  rm|del|delete)
    need 1 "rm <caminho> [permanent=true]" "\$@"
    extra=(); paths=()
    for a in "\$@"; do case \$a in permanent=*) extra+=("\$a") ;; *) paths+=("\$a") ;; esac; done
    call fs_delete paths:="\$(json_list "\${paths[@]}")" \${extra[@]+"\${extra[@]}"}
    ;;
  organize|organizar) need 1 "organize <pasta> [dry_run=false]" "\$@"; call fs_organize path="\$1" "\${@:2}" ;;
  unzip|extract) need 2 "unzip <zip-no-pc> <pasta-destino>" "\$@"; call zip_extract path="\$1" destination="\$2" "\${@:3}" ;;
  sh|exec|run) need 1 "sh '<comando>' [cwd=..]" "\$@"; call shell_exec command="\$1" "\${@:2}" ;;
  bg|start) need 1 "bg '<comando>' [name=..]" "\$@"; call process_start command="\$1" "\${@:2}" ;;
  out|logs) need 1 "out <id> [wait_ms=..]" "\$@"; call process_read id="\$1" "\${@:2}" ;;
  kill|stop) need 1 "kill <id>" "\$@"; call process_kill id="\$1" ;;
  ps) call process_list ;;
  open|reveal) need 1 "open <caminho>" "\$@"; call open_path path="\$1" "\${@:2}" ;;
  tools) pc_curl "\$PC_BASE/tools"; echo ;;
  tool) need 1 "tool <nome>" "\$@"; pc_curl "\$PC_BASE/tools/\$1"; echo ;;
  status) pc_curl "\$PC_BASE/status"; echo ;;
  call) need 1 "call <ferramenta> [chave=valor...]" "\$@"; call "\$@" ;;
  *) echo "comando desconhecido: \$cmd (veja ./pc help)" >&2; exit 2 ;;
esac
`;
}
