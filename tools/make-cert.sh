#!/bin/bash
# Cria um certificado self-signed de Code Signing ("Capi Dev") num keychain
# dedicado, pra dar à Capi.app uma IDENTIDADE ESTÁVEL. Sem isso, o macOS nega
# Gravação de Tela pra apps ad-hoc. Idempotente: se já existe, não recria.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
mkdir -p "$BUILD"
KC="$BUILD/capi-signing.keychain-db"
KCPASS="capi"
CN="Capi Dev"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CN"; then
  echo "==> identidade '$CN' já existe; ok"
  exit 0
fi

cd "$BUILD"

echo "==> gerando cert self-signed de code signing"
cat > openssl-codesign.cnf <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = v3_codesign
prompt = no
[ dn ]
CN = Capi Dev
[ v3_codesign ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout capi-dev.key -out capi-dev.crt -days 3650 \
  -config openssl-codesign.cnf -extensions v3_codesign >/dev/null 2>&1

openssl pkcs12 -export -inkey capi-dev.key -in capi-dev.crt \
  -out capi-dev.p12 -passout pass:$KCPASS -name "$CN" >/dev/null 2>&1

echo "==> criando keychain dedicado e importando"
security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPASS" "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security set-keychain-settings "$KC"  # sem timeout de lock
security import capi-dev.p12 -k "$KC" -P "$KCPASS" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KCPASS" "$KC" >/dev/null 2>&1

# adiciona o keychain à lista de busca (preserva os existentes)
EXISTING=$(security list-keychains -d user | sed 's/[" ]//g')
security list-keychains -d user -s "$KC" $EXISTING >/dev/null 2>&1

echo "==> identidades de codesigning disponíveis:"
security find-identity -v -p codesigning | grep "$CN" || {
  echo "ERRO: identidade não encontrada"; exit 1; }
echo "==> ok"
