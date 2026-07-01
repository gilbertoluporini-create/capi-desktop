# 🦫 ESTADO / HANDOFF — Capi (repo desktop)

> Estado vivo pra um agente novo continuar (migração de ambiente 01/07/2026).
> Repo web = separado (Vercel, ver seção Web). Board de tracks: `~/cap/BOARD_ORQUESTRADOR.md`.

## Onde está NO AR
- **Windows 0.1.3** LIVE (release `win-v0.1.0` → `Capi.Setup.0.1.3.exe`). Fixes: mic (`setDevicePermissionHandler`) + onboarding (isAppInstalled era osascript Mac-only → travava Windows).
- **Mac 0.1.2** publicado em `gilbertoluporini-create/capi-downloads` (release `v0.1.0` → `Capi.dmg`).
- Landing `trycapi.com` aponta pro `Capi.Setup.0.1.3.exe` (env `NEXT_PUBLIC_EXE_URL` na Vercel).
- **branch `main`** = 0.1.3 (pushado). **branch `smooth-stt`** = Track A Deepgram (este handoff).

## 🅰️ TRACK A — Deepgram streaming (EM ANDAMENTO / DEBUG) — branch `smooth-stt`
Objetivo: transcrição fluida palavra-por-palavra (hoje era Whisper em blocos de 2s = lento).

**O que já está feito (nesta branch):**
- `web/app/api/deepgram-token/route.ts` (NOVO, JÁ DEPLOYADO em prod): gera token temporário do Deepgram. Auth por `x-capi-key`. A chave do Deepgram é "básica" (sem escopo de gestão) → `/auth/grant` e criação de sub-chave dão `INSUFFICIENT_PERMISSIONS`, então o endpoint **cai pro fallback e devolve a própria chave-mestra** (`kind:"token", ephemeral:false`). Testado em prod: retorna `ok:true`. Pra PRODUÇÃO segura, criar chave **Owner** no Deepgram → o endpoint sobe automático pro token efêmero.
- `desktop/src/main/main.js`: handler IPC `overlay:deepgramToken` (fetch no `${WEB_URL}/api/deepgram-token`) + handler debug `overlay:dbg` → `flog` no `capi-status.log`.
- `desktop/src/main/preload.js`: bridges `deepgramToken` e `dbg`.
- `desktop/src/overlay/overlay.js`: módulo Deepgram — `dgStart(stream)` abre WS `wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&...&encoding=linear16&sample_rate=16000` com subprotocolo `["token", key]`, pipa PCM 16k via ScriptProcessor; `dgStop()`; integração: `dgStart` no `startRecording` (após `mediaRecorder.start`), `ondataavailable` só chama Whisper `if(!dgActive)`, `finalizeTranscription` usa `dgFinalText` (só cai pro Whisper se DG não trouxe nada). Debug (`window.capi.dbg`) instrumentado em token/open/msg/error/close.

**⚠️ PROBLEMA ATUAL (parar aqui):** Giba testou (⌘⇧1) e **demorou = caiu pro Whisper** (Deepgram não engatou). Faltou ler o `capi-status.log` (em `os.tmpdir()/capi-status.log`) com os logs `[overlay] DG ...` pra ver ONDE falha: token? `ws CLOSE code=...` (auth/param inválido?)? pipe? 
**PRÓXIMO PASSO:** rodar o app dev instrumentado e ler o log:
```
cd ~/cap/desktop && env -u ELECTRON_RUN_AS_NODE CAPI_WEB_URL=https://trycapi.com npm start
# testar ⌘⇧1, falar, parar; depois:
cat "$(node -e 'console.log(require("os").tmpdir())')/capi-status.log" | grep "\[overlay\] DG"
```
Hipóteses prováveis: (a) `nova-3`+`language=multi` inválido no streaming → WS fecha com code 1008/400 (trocar pra `nova-2` + `language=pt` ou `multi` válido); (b) subprotocolo de auth do WS; (c) ScriptProcessor não dispara. O `ws CLOSE code/reason` no log resolve.
NÃO commitado ainda quando este doc foi escrito? (ver git log). Debug logs (`dbg`) são temporários — remover quando resolver.

## Como testar sem build (Mac)
`env -u ELECTRON_RUN_AS_NODE CAPI_WEB_URL=https://trycapi.com npm start` — usa backend de prod, sem precisar buildar. (Shell tem `ELECTRON_RUN_AS_NODE=1`, por isso o `env -u`.)

## Instrumentação / analytics (web, JÁ NO AR)
- PostHog (funil + autocapture + erros + session replay) via reverse proxy `/ingest` + Vercel Analytics + Reddit Pixel (gated). Projeto PostHog 438840 é COMPARTILHADO com o Lumio → queries do /admin filtram `host=trycapi.com`.
- Painel PostHog dentro de `trycapi.com/admin` (`web/lib/posthog-query.ts`).

## Aberto (fila (ver BOARD_ORQUESTRADOR.md))
- Track A: resolver o Deepgram (acima).
- Track C (auth/Resend) — JÁ FEITO no working tree do web (redirect força trycapi.com; Resend `trycapi.com` verificado). **Pendente Giba:** Supabase dashboard (ref `xvwzkvligwpntzjmyqkm`) → remover `capi-sigma.vercel.app` das Redirect URLs.
- Track B (Windows: colar na janela certa — hoje é AppleScript, só Mac).
- Track D (landing: hero dinâmico/vídeo). Track G (assinatura Windows p/ matar SmartScreen).
- Deepgram: criar chave **Owner** pra token efêmero seguro antes de distribuir.

## Web (repo separado, ~/cap/web)
- Deploy = Vercel CLI (`vercel --prod`), NÃO git. **Sem remote GitHub** até a migração 01/07.
- SEGREDOS: `.env.local` (ignorado) + `.supabase-db-password.txt` (NÃO commitar!). Chaves relevantes: SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, DEEPGRAM_API_KEY, STRIPE_SECRET_KEY, RESEND_API_KEY, CAPI_TRANSCRIBE_SECRET, ADMIN_TOKEN, POSTHOG_PERSONAL_API_KEY.
- Supabase ref do Capi: `xvwzkvligwpntzjmyqkm` (auth/profiles/beta_signups/support_tickets).
