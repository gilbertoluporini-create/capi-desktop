# Empacotamento do Capi (macOS)

Empacotamento do app Electron da Capi em `.dmg` via **electron-builder**.

## Como gerar o .dmg

```bash
cd ~/cap/desktop
npm install            # garante electron + electron-builder
npm run dist           # = electron-builder --mac dmg
```

Saída:
- `dist/Capi-<versão>-arm64.dmg` (o instalador distribuível)
- `dist/mac-arm64/Capi.app` (o app desempacotado)

> Dica: o build assina **ad-hoc** (sem certificado). Se o macOS reclamar de
> identidade durante o build, force a descoberta desligada:
> `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist`

Depois de gerar, copie o `.dmg` pra landing servir o download:

```bash
mkdir -p ~/cap/web/public/download
cp dist/Capi-*-arm64.dmg ~/cap/web/public/download/Capi.dmg
```

## Config (em `package.json` → campo `build`)

- `appId`: `com.luporini.capi`
- `productName`: `Capi`
- `mac.target`: `dmg`
- `mac.category`: `public.app-category.developer-tools`
- `mac.icon`: `assets/capi-app-icon.icns` (gerado de `capi-app-icon.png`)
- `mac.identity`: `null` → **força build unsigned/ad-hoc** (sem certificado)
- `asar`: `true` → código empacotado em `app.asar`
- `files`: `src/**`, `assets/**`, `package.json`

### Ícone

O `.icns` é gerado a partir de `assets/capi-app-icon.png` (1444×1444 RGBA):

```bash
cd ~/cap/desktop/assets
mkdir -p capi.iconset
for s in 16 32 128 256 512; do
  s2=$((s*2))
  sips -z $s  $s  capi-app-icon.png --out capi.iconset/icon_${s}x${s}.png
  sips -z $s2 $s2 capi-app-icon.png --out capi.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns capi.iconset -o capi-app-icon.icns
rm -rf capi.iconset
```

O `capi-app-icon.icns` fica versionado em `assets/` e é referenciado em `mac.icon`.

### Segredos NÃO vão pro bundle

O `.env.local` (com chaves Gemini/OpenAI) **não** está nos globs de `files`, então
não entra no `app.asar`. O app lê `.env.local` em runtime do diretório do app; num
.dmg distribuído ele simplesmente não acha a chave e pede pro usuário configurar
(transcrição/IA ficam indisponíveis até configurar). Isso é esperado — nunca
empacote segredos.

## Instalando o app UNSIGNED (pro usuário final)

O `.dmg` é **ad-hoc/unsigned** — não passou por notarização Apple. Por isso o
Gatekeeper bloqueia o duplo-clique normal. Pra abrir:

1. Abra o `Capi.dmg` e arraste **Capi** pra pasta **Applications**.
2. Em **Applications**, **clique com o botão direito** (ou Ctrl+clique) no
   **Capi** → **Abrir**.
3. No aviso "desenvolvedor não verificado", clique em **Abrir** de novo.
4. A partir daí o macOS lembra a escolha e abre normal no duplo-clique.

Se mesmo assim travar (macOS Sequoia+ é mais rígido), rode uma vez no Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Capi.app
```

> O app pede permissões de **Gravação de Tela** e **Acessibilidade** no
> primeiro uso (System Settings → Privacy & Security). Isso é normal pra um app
> de captura de tela.

## O que falta pra notarizar (distribuição "limpa")

Pra o usuário abrir com duplo-clique sem aviso, é preciso assinar com Developer ID
e notarizar com a Apple:

1. **Conta Apple Developer** (US$ 99/ano) → gerar um certificado
   **Developer ID Application** no Apple Developer portal e exportar como `.p12`.

2. **Variáveis de ambiente** pro electron-builder assinar:
   ```bash
   export CSC_LINK=/caminho/para/DeveloperID.p12   # ou base64 do .p12
   export CSC_KEY_PASSWORD=senha_do_p12
   ```
   Com isso, remover (ou não usar) o `mac.identity: null` — electron-builder
   passa a assinar com o Developer ID automaticamente.

3. **Notarização** via hook `afterSign` usando `@electron/notarize`:
   ```bash
   npm install -D @electron/notarize
   ```
   Criar `build/notarize.js`:
   ```js
   const { notarize } = require("@electron/notarize");
   exports.default = async function (context) {
     if (context.electronPlatformName !== "darwin") return;
     const appName = context.packager.appInfo.productFilename;
     await notarize({
       appBundleId: "com.luporini.capi",
       appPath: `${context.appOutDir}/${appName}.app`,
       appleId: process.env.APPLE_ID,
       appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, // app-specific password
       teamId: process.env.APPLE_TEAM_ID,
     });
   };
   ```
   E em `package.json` → `build`:
   ```json
   "afterSign": "build/notarize.js",
   "mac": {
     "hardenedRuntime": true,
     "gatekeeperAssess": false,
     "entitlements": "build/entitlements.mac.plist",
     "entitlementsInherit": "build/entitlements.mac.plist"
   }
   ```
   (entitlements precisam liberar JIT/screen-capture conforme o uso do app.)

4. Variáveis pra notarização:
   ```bash
   export APPLE_ID=seu@email.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=XXXXXXXXXX
   ```

Com Developer ID + notarização + stapling, o `.dmg` abre no duplo-clique sem
nenhum aviso de Gatekeeper.

> Nota: o build atual gera só **arm64** (Apple Silicon) porque foi empacotado num
> Mac ARM. Pra também cobrir Intel, usar `--universal` (target universal) ou
> buildar com `--x64` também.
