#!/bin/bash
# Empacota uma Capi.app de DEV com identidade própria (bundle id + nome "Capi"),
# pra ganhar uma identidade TCC limpa (permissão de tela aparece como "Capi").
# Não é o build de distribuição final — é pra desenvolver sem a dança do "Electron".
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/node_modules/electron/dist/Electron.app"
OUT="$ROOT/build"
APP="$OUT/Capi.app"
BUNDLE_ID="com.luporini.capi"

echo "==> limpando build anterior"
rm -rf "$APP"
mkdir -p "$OUT"

echo "==> copiando runtime Electron -> Capi.app"
cp -R "$DIST" "$APP"

echo "==> injetando código do app em Resources/app"
APPDIR="$APP/Contents/Resources/app"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
cp -R "$ROOT/src" "$APPDIR/src"
cp -R "$ROOT/assets" "$APPDIR/assets"
cp "$ROOT/package.json" "$APPDIR/package.json"

echo "==> ajustando Info.plist (identidade + menu bar)"
PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
$PB -c "Set :CFBundleName Capi" "$PLIST"
$PB -c "Set :CFBundleDisplayName Capi" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string Capi" "$PLIST"
$PB -c "Set :CFBundleExecutable Electron" "$PLIST"
# app de barra de menu (sem ícone no Dock)
$PB -c "Set :LSUIElement true" "$PLIST" 2>/dev/null || $PB -c "Add :LSUIElement bool true" "$PLIST"

echo "==> assinando com identidade estável 'Capi Dev'"
KC="$OUT/capi-signing.keychain-db"
if security find-identity "$KC" 2>/dev/null | grep -q "Capi Dev"; then
  security unlock-keychain -p capi "$KC" 2>/dev/null || true
  codesign --force --deep --sign "Capi Dev" --keychain "$KC" "$APP" 2>&1 | tail -2
else
  echo "   (sem 'Capi Dev' — caindo pra ad-hoc; rode tools/make-cert.sh)"
  codesign --force --deep --sign - "$APP" 2>/dev/null
fi

echo "==> remove quarentena (foi gerado localmente)"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "==> pronto: $APP"
