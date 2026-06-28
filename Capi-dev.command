#!/bin/bash
# Lançador de desenvolvimento da Capi (com diagnóstico).
# Dê dois cliques. Abre a Capi a partir do SEU Terminal, o que faz o macOS
# pedir a permissão de Gravação de Tela do jeito certo.
ROOT="/Users/gilbertoluporini/cap/desktop"
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LAUNCHLOG="/tmp/capi-dev-launch.log"

unset ELECTRON_RUN_AS_NODE
: > "$LAUNCHLOG"

echo "🦫  Abrindo a Capi…"
echo "    (deixe esta janela aberta; feche-a pra encerrar o app)"
echo ""

if [ ! -x "$ELECTRON" ]; then
  echo "❌ Não achei o Electron em: $ELECTRON"
  echo "   Rode 'npm install' em $ROOT"
  echo ""
  echo "Pode fechar esta janela."
  exit 1
fi

# roda o app (passar $ROOT faz o Electron carregar nosso código)
"$ELECTRON" "$ROOT" > "$LAUNCHLOG" 2>&1
echo "Capi encerrada."
