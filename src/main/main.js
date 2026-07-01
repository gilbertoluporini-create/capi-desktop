// Capi — processo principal (Electron)
// Fluxo: atalho global -> captura a tela -> overlay de seleção -> recorte + nota -> clipboard

const {
  app,
  BrowserWindow,
  globalShortcut,
  desktopCapturer,
  screen,
  clipboard,
  nativeImage,
  ipcMain,
  Tray,
  Menu,
  Notification,
  systemPreferences,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const os = require("os");
const { exec, execFile, execFileSync } = require("child_process");

// ---------- Config / estado ----------
const CONFIG_DIR = path.join(app.getPath("userData"));
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const CAPTURES_DIR = path.join(app.getPath("userData"), "captures");

const DEFAULT_CONFIG = {
  shortcut: "CommandOrControl+Shift+2", // ⌘+Shift+5 é reservado pelo macOS; usamos um livre
  voiceShortcut: "CommandOrControl+Shift+1", // "só falar": grava voz SEM print → mesmo picker
  autoDelete: true, // apaga o PNG do disco depois de copiar (não sobrecarregar)
  autoDeleteAfterMs: 60 * 1000, // se salvar, apaga após 60s
  saveHistory: false, // por ora não persiste; a Fase 3 liga o sync na nuvem
  playSound: true,
  autoPaste: true, // ao copiar, cola sozinho no app que estava na frente (Enter)
  autoSubmit: true, // após colar, aperta Enter no destino pra ENVIAR (ex: Claude)
  pasteTargets: [], // destinos: [{ name, bundleId, label?, windowMatch? }]
  pasteDefault: "__last__", // destino padrão: "__last__" (último app) ou um bundleId fixo
  focusMode: "switch", // "switch" = traz o destino pra frente | "stay" = manda e volta o foco
  autoRecord: true, // grava áudio automático ao terminar a seleção
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error("Falha ao salvar config:", e);
  }
}

let config = loadConfig();

// ---------- Agentes (evolução dos pasteTargets) ----------
// Um agente = persona (nome/assunto/avatar/cor) + alvo.
// kind "app"      -> cola no app (conversa atual)
// kind "project"  -> projeto do Claude Code: foca a janela (windowMatch) + conversa atual
const AVATARS = ["compass", "sparkles", "robot", "hub", "rocket", "bolt", "star", "target", "layers", "globe"];
function migrateAgents(cfg) {
  if (Array.isArray(cfg.agents)) return cfg;
  // primeira vez: converte os pasteTargets antigos em agentes
  const agents = (cfg.pasteTargets || []).map((t, i) => ({
    id: t.bundleId || "agent-" + i,
    name: t.name || t.bundleId,
    subject: "",
    avatar: AVATARS[i % AVATARS.length],
    color: "#7C5CFF",
    kind: "app",
    app: { bundleId: t.bundleId, name: t.name || t.bundleId },
    windowMatch: t.windowMatch || null,
    target: "current",
  }));
  cfg.agents = agents;
  cfg.agentDefault = cfg.pasteDefault || "__last__";
  saveConfig(cfg);
  return cfg;
}
config = migrateAgents(config);

// ---------- Apps (nível 1) — agrupam agentes (IA) ou contatos (mensageiro) ----------
const KNOWN_APPS = [
  { id: "vscode", name: "VS Code", bundleId: "com.microsoft.VSCode", type: "ai", avatar: "img:../../assets/integrations/vscode.png", color: "#7c5cff" },
  { id: "claude", name: "Claude", bundleId: "com.anthropic.claudefordesktop", type: "ai", avatar: "img:../../assets/integrations/claude-desktop.png", color: "#5b3fd6" },
  { id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92", type: "ai", avatar: "img:../../assets/integrations/cursor.png", color: "#22c55e" },
];

// Agentes que rodam no NAVEGADOR (não têm app nativo). O "bundleId" aqui é um
// pseudo-id estável (web.*) que serve só de chave; o envio real localiza a ABA
// pela urlMatch em qualquer navegador (Chrome-family + Safari) e cola lá.
const WEB_AGENTS = [
  { id: "chatgpt-web",   name: "ChatGPT",    bundleId: "web.chatgpt",    type: "web", urlMatch: "chatgpt.com",        openUrl: "https://chatgpt.com/",          avatar: "img:../../assets/integrations/chatgpt.png",    color: "#10a37f" },
  { id: "gemini-web",    name: "Gemini",     bundleId: "web.gemini",     type: "web", urlMatch: "gemini.google.com",   openUrl: "https://gemini.google.com/app", avatar: "img:../../assets/integrations/gemini.png",     color: "#1a73e8" },
  { id: "claude-web",    name: "Claude.ai",  bundleId: "web.claude",     type: "web", urlMatch: "claude.ai",           openUrl: "https://claude.ai/new",         avatar: "img:../../assets/integrations/claude-ai.png",  color: "#d97757" },
  { id: "perplexity-web",name: "Perplexity", bundleId: "web.perplexity", type: "web", urlMatch: "perplexity.ai",       openUrl: "https://www.perplexity.ai/",    avatar: "img:../../assets/integrations/perplexity.png", color: "#20808d" },
];
// urlMatch + openUrl por pseudo-bundle — usados no envio e na migração
const WEB_URLMATCH_BY_BUNDLE = Object.fromEntries(WEB_AGENTS.map((w) => [w.bundleId, w.urlMatch]));
const WEB_OPENURL_BY_MATCH = Object.fromEntries(WEB_AGENTS.map((w) => [w.urlMatch, w.openUrl]));

// Mensageiros (WhatsApp/Telegram): colar imagem abre um preview com legenda;
// digita a legenda e Enter envia na conversa ABERTA (v1 = "conversa atual").
const MESSENGER_APPS = [
  { id: "whatsapp", name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp", type: "messenger", avatar: "img:../../assets/integrations/whatsapp.png", color: "#25d366" },
  { id: "telegram", name: "Telegram", bundleId: "ru.keepcoder.Telegram", type: "messenger", avatar: "img:../../assets/integrations/telegram.png", color: "#2aabee" },
];
const MESSENGER_BUNDLES = new Set(MESSENGER_APPS.map((m) => m.bundleId));

// logo oficial por bundleId — usado pra atualizar avatares de apps já no config
const APP_LOGO_BY_BUNDLE = {
  "com.microsoft.VSCode": "img:../../assets/integrations/vscode.png",
  "com.anthropic.claudefordesktop": "img:../../assets/integrations/claude-desktop.png",
  "com.todesktop.230313mzl4w4u92": "img:../../assets/integrations/cursor.png",
};

// converte avatares antigos (emoji) -> nomes de ícone do set (icons.js)
const EMOJI_TO_ICON = {
  "🔧": "code", "🦫": "sparkles", "⚡": "terminal", "🧠": "compass", "💬": "message",
  "🤖": "robot", "👤": "person", "🚀": "rocket", "🎨": "star", "📊": "chart",
  "🌐": "globe", "💡": "star", "🐙": "grid", "🦦": "sparkles", "📦": "grid",
};
function migrateIcons(cfg) {
  if (cfg.iconsMigrated) return cfg;
  const fix = (v) => {
    if (!v || typeof v !== "string") return "robot";
    if (v.startsWith("img:")) return v;
    if (EMOJI_TO_ICON[v]) return EMOJI_TO_ICON[v];
    // qualquer emoji desconhecido -> ícone padrão
    if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u.test(v)) return "robot";
    return v; // já é nome de ícone
  };
  (cfg.apps || []).forEach((a) => (a.avatar = fix(a.avatar)));
  (cfg.agents || []).forEach((a) => (a.avatar = fix(a.avatar)));
  cfg.iconsMigrated = true;
  saveConfig(cfg);
  return cfg;
}
function migrateApps(cfg) {
  if (Array.isArray(cfg.apps)) return cfg;
  cfg.apps = KNOWN_APPS.map((a) => ({ ...a, searchEnabled: true }));
  // limpa os "agentes" que eram só o app em si (id == bundleId); mantém personas (ex: Orquestrador)
  const bids = new Set(KNOWN_APPS.map((k) => k.bundleId));
  cfg.agents = (cfg.agents || []).filter((a) => !bids.has(a.id));
  cfg.contacts = cfg.contacts || []; // [{id, name, hint, appBundleId}]
  cfg.captureDefault = cfg.agentDefault || "orquestrador";
  saveConfig(cfg);
  return cfg;
}
config = migrateApps(config);
config = migrateIcons(config);

// força logos oficiais nos apps conhecidos (mesmo pra quem já tinha config)
function migrateAppLogos(cfg) {
  if (cfg.appLogosMigrated) return cfg;
  let changed = false;
  (cfg.apps || []).forEach((a) => {
    const logo = APP_LOGO_BY_BUNDLE[a.bundleId];
    if (logo && a.avatar !== logo) { a.avatar = logo; changed = true; }
  });
  cfg.appLogosMigrated = true;
  if (changed) saveConfig(cfg);
  return cfg;
}
config = migrateAppLogos(config);

// injeta os agentes de navegador (ChatGPT/Gemini/Claude.ai/Perplexity) em quem
// já tinha config. Idempotente: só adiciona os que faltam; atualiza urlMatch/type.
function migrateWebAgents(cfg) {
  cfg.apps = cfg.apps || [];
  let changed = false;
  WEB_AGENTS.forEach((w) => {
    const existing = cfg.apps.find((a) => a.bundleId === w.bundleId);
    if (!existing) {
      cfg.apps.push({ ...w, searchEnabled: true });
      changed = true;
    } else {
      // mantém o que o user customizou, mas garante os campos do envio web
      if (existing.type !== "web") { existing.type = "web"; changed = true; }
      if (existing.urlMatch !== w.urlMatch) { existing.urlMatch = w.urlMatch; changed = true; }
    }
  });
  if (changed) saveConfig(cfg);
  return cfg;
}
// Só no macOS por ora: o envio web/messenger usa AppleScript. No Windows
// runPasteWindows ainda não trata web/messenger (colaria na janela errada),
// então NÃO os injetamos no picker até existir suporte nativo lá.
if (process.platform === "darwin") config = migrateWebAgents(config);

// injeta WhatsApp/Telegram (mensageiros). Idempotente.
function migrateMessengerApps(cfg) {
  cfg.apps = cfg.apps || [];
  let changed = false;
  MESSENGER_APPS.forEach((m) => {
    const existing = cfg.apps.find((a) => a.bundleId === m.bundleId);
    if (!existing) {
      cfg.apps.push({ ...m, searchEnabled: true });
      changed = true;
    } else if (existing.type !== "messenger") {
      existing.type = "messenger";
      changed = true;
    }
  });
  if (changed) saveConfig(cfg);
  return cfg;
}
if (process.platform === "darwin") config = migrateMessengerApps(config);

// achata apps+agentes numa lista de destinos pro overlay (captura — passo 1)
function flattenDestinations() {
  const out = [];
  platformVisibleApps().forEach((app) => {
    const mine = (config.agents || []).filter(
      (a) => a.app && a.app.bundleId === app.bundleId
    );
    if (app.type === "messenger") {
      const cts = (config.contacts || []).filter((c) => c.appBundleId === app.bundleId);
      cts.forEach((c) =>
        out.push({
          id: c.id, name: c.name, subject: app.name,
          avatar: app.avatar || "message", color: app.color || "#22c55e",
          bundleId: app.bundleId, windowMatch: null,
        })
      );
      if (!cts.length)
        out.push({ id: app.id, name: app.name, subject: "current conversation", avatar: app.avatar || "message", color: app.color, bundleId: app.bundleId, windowMatch: null });
    } else if (mine.length) {
      mine.forEach((a) =>
        out.push({
          id: a.id, name: a.name, subject: a.subject || app.name,
          avatar: a.avatar || app.avatar, color: a.color || app.color,
          bundleId: app.bundleId,
          windowMatch: a.kind === "project" || a.target === "window" ? a.windowMatch : null,
        })
      );
    } else if (app.type === "web") {
      out.push({ id: app.id, name: app.name, subject: app.name, avatar: app.avatar, color: app.color, bundleId: app.bundleId, windowMatch: null, web: true, urlMatch: app.urlMatch || null });
    } else {
      out.push({ id: app.id, name: app.name, subject: "current conversation", avatar: app.avatar, color: app.color, bundleId: app.bundleId, windowMatch: null });
    }
  });
  return out;
}

// contatos de um app mensageiro (WhatsApp): nível 2 = contatos diretos
function appContacts(app) {
  return (config.contacts || [])
    .filter((c) => c.appBundleId === app.bundleId)
    .map((c) => ({
      id: c.id, name: c.name, sub: c.hint || "contact",
      avatar: app.avatar, color: app.color,
      bundleId: app.bundleId, windowMatch: null, kind: "contact",
    }));
}

// chave do projeto a que um agente pertence
function agentProjectKey(a) {
  if (a.project && a.project.key) return a.project.key;
  if (a.cwd) return a.cwd;
  if (a.windowMatch) return a.windowMatch;
  return "__geral__";
}

// dois títulos de chat "casam" se um for prefixo do outro depois de limpos
// (o título da janela vem TRUNCADO com "…", então comparo por prefixo)
function titlesMatch(a, b) {
  const x = cleanTabQuery(a).toLowerCase();
  const y = cleanTabQuery(b).toLowerCase();
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

// projetos de um app de IA (nível 2): auto (Claude Code) + manuais + derivados dos agentes
function appProjects(app) {
  const isCC = CLAUDE_CODE_HOSTS.has(app.bundleId);
  const map = new Map(); // key -> { id, key, name, sub, windowMatch, cwd, agents:[] }

  // 1) auto: projetos do Claude Code (~/.claude/projects) — só p/ VS Code/Cursor
  // nome = título do chat (aiTitle, igual ao VS Code); pasta vai no subtítulo
  if (isCC) {
    for (const p of claudeProjectsCache) {
      const conv = `${p.sessions} conversation${p.sessions > 1 ? "s" : ""}`;
      const k = p.key || p.cwd; // chave única por chat (pasta + título)
      map.set(k, {
        id: "cwd:" + k, key: k,
        name: p.title || p.name,
        sub: p.title ? `${path.basename(p.cwd)} · ${conv}` : conv,
        // alvo de roteamento = TÍTULO do chat (aiTitle) p/ o `edt` achar a aba;
        // pasta (basename) só de fallback se não houver título
        windowMatch: p.title || p.windowMatch, cwd: p.cwd, mtime: p.mtime, auto: true, agents: [],
      });
    }
  }
  // 2) manuais (config.projects)
  for (const mp of (config.projects || []).filter((p) => p.appBundleId === app.bundleId)) {
    const key = mp.key || mp.id;
    if (!map.has(key))
      map.set(key, {
        id: mp.id, key, name: mp.name, sub: "",
        windowMatch: mp.windowMatch || mp.name, cwd: mp.cwd || "", manual: true, agents: [],
      });
  }
  // 3) agentes -> dentro do projeto (cria "Geral" / projeto solto se faltar)
  (config.agents || [])
    .filter((a) => a.app && a.app.bundleId === app.bundleId)
    .forEach((a) => {
      const key = agentProjectKey(a);
      let proj = map.get(key);
      if (!proj) {
        proj =
          key === "__geral__"
            ? { id: "geral:" + app.bundleId, key, name: "General", sub: "no project", windowMatch: null, cwd: "", agents: [] }
            : { id: "k:" + key, key, name: (a.project && a.project.name) || a.windowMatch || "Project", sub: "", windowMatch: a.windowMatch || null, cwd: a.cwd || "", agents: [] };
        map.set(key, proj);
      }
      proj.agents.push({
        id: a.id, name: a.name, sub: a.subject || "agent",
        avatar: a.avatar || app.avatar, color: a.color || app.color,
        bundleId: app.bundleId,
        windowMatch: a.windowMatch || proj.windowMatch || null,
        kind: "agent",
      });
    });

  const arr = [...map.values()];
  // "você está aqui": se a janela em foco é deste app, casa pelo TÍTULO dela;
  // senão cai no projeto mais recente. (dinâmico — segue a janela ativa do VS Code)
  let hereKey = null;
  if (isCC) {
    const fm = frontmostApp;
    if (fm && fm.bundleId === app.bundleId && fm.window) {
      // casa o título da janela ativa (truncado "…") com o chat por prefixo
      const hit = arr.find((p) => p.windowMatch && titlesMatch(p.windowMatch, fm.window));
      if (hit) hereKey = hit.key;
    }
    if (!hereKey) {
      // sem casar a janela ativa: marca o chat AUTO mais recente como "você está aqui"
      let best = null;
      for (const p of arr) if (p.auto && (!best || (p.mtime || 0) > (best.mtime || 0))) best = p;
      if (best) hereKey = best.key;
    }
  }
  const archived = new Set(config.archivedProjects || []);
  arr.forEach((p) => {
    if (!p.sub) p.sub = p.agents.length ? `${p.agents.length} agent${p.agents.length > 1 ? "s" : ""}` : "current conversation";
    p.archived = archived.has(p.key);
    p.here = !!hereKey && p.key === hereKey;
    if (p.here) p.sub = "you're here · " + p.sub;
  });
  // ordena: "aqui" primeiro, depois com agentes, depois por nome
  arr.sort((a, b) =>
    (b.here - a.here) || (b.agents.length - a.agents.length) || a.name.localeCompare(b.name));
  return arr;
}

// projeto do Claude Code mais recente = onde ele está rodando agora
function currentClaudeCwd() {
  return claudeProjectsCache.length ? claudeProjectsCache[0].cwd : null;
}

// embute o Orquestrador no projeto atual (1x) + dá o avatar-Capi dele
function ensureOrchestratorEmbedded() {
  const orch = (config.agents || []).find((a) => a.id === "orquestrador");
  if (!orch) return;
  let dirty = false;
  // avatar-Capi do Orquestrador (se ainda for ícone)
  if (!String(orch.avatar || "").startsWith("capi:")) {
    orch.avatar = "capi:orquestrador";
    dirty = true;
  }
  // embute no projeto onde o Claude está rodando (se ainda estiver solto)
  const cwd = currentClaudeCwd();
  // TÍTULO do chat (aiTitle) desse cwd — é o que o `edt` precisa pra achar a aba.
  // (basename da pasta NÃO casa com aba nenhuma -> ia pra aba errada)
  const proj = claudeProjectsCache.find((p) => p.cwd === cwd);
  const title = (proj && proj.title) || null;
  if (cwd && !orch.cwd && !(orch.project && orch.project.key)) {
    orch.cwd = cwd;
    orch.windowMatch = title; // título do chat, não o nome da pasta
    orch.kind = "project";
    orch.target = "window";
    orch.project = { key: cwd, name: path.basename(cwd) };
    dirty = true;
  }
  // MIGRAÇÃO: conserta o windowMatch que ficou como BASENAME da pasta (bug antigo)
  if (orch.cwd && title && orch.windowMatch === path.basename(orch.cwd)) {
    orch.windowMatch = title;
    flog("orquestrador: windowMatch corrigido de pasta -> chat '" + title + "'");
    dirty = true;
  }
  // fixa o Orquestrador por padrão (atalho no topo do picker)
  config.pinnedAgents = config.pinnedAgents || [];
  if (!config.pinnedAgents.includes("orquestrador")) {
    config.pinnedAgents.push("orquestrador");
    dirty = true;
  }
  if (dirty) saveConfig(config);
}

// destinos FIXADOS (atalhos no topo do picker) — resolve os agentes fixados
function buildPinned() {
  const pins = config.pinnedAgents || [];
  if (!pins.length) return [];
  const out = [];
  for (const a of config.agents || []) {
    if (!pins.includes(a.id) || !a.app) continue;
    out.push({
      id: a.id, name: a.name, sub: a.subject || (a.app.name || ""),
      avatar: a.avatar || "robot", color: a.color || "#7c5cff",
      bundleId: a.app.bundleId, windowMatch: a.windowMatch || null,
    });
  }
  // o destino padrão fica em 1º
  const def = config.captureDefault;
  out.sort((x, y) => (y.id === def) - (x.id === def));
  return out;
}

// árvore de destinos pro overlay. IA: App -> Projetos -> Agentes. Mensageiro: App -> Contatos.
// (o picker esconde projetos arquivados; a config mostra todos)
// no Windows, esconde web/messenger (sem suporte de envio nativo lá ainda)
function platformVisibleApps() {
  const apps = config.apps || [];
  if (process.platform === "darwin") return apps;
  return apps.filter((a) => a.type !== "web" && a.type !== "messenger");
}
function buildDestinationTree() {
  return platformVisibleApps().map((app) => {
    const type = app.type || "ai";
    const base = {
      id: app.id, name: app.name, avatar: app.avatar, color: app.color,
      bundleId: app.bundleId, type,
      urlMatch: app.urlMatch || null,
      searchEnabled: app.searchEnabled !== false,
    };
    if (type === "messenger") return { ...base, contacts: appContacts(app) };
    // agente de navegador: destino único (a aba do agente). Sem projetos/abas.
    if (type === "web") return { ...base, web: true, projects: [], openTabs: [] };
    const projects = appProjects(app).filter((p) => !p.archived);
    // abas ABERTAS agora (envio direto via `edt`) — só VS Code por ora
    let openTabs = [];
    if (app.bundleId === "com.microsoft.VSCode") {
      const fm = frontmostApp;
      const activeTitle = fm && fm.bundleId === app.bundleId ? fm.window : null;
      openTabs = openTabsCache.map((t) => ({
        title: t.title,
        here: activeTitle ? titlesMatch(t.title, activeTitle) : false,
      }));
    }
    return { ...base, projects, openTabs };
  });
}

// lê os 1ºs `bytes` de um arquivo (sem carregar arquivos grandes inteiros)
function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// cache dos projetos do Claude Code (varredura ~300ms; não bloquear cada overlay)
let claudeProjectsCache = [];
function refreshClaudeProjects() {
  try {
    claudeProjectsCache = listClaudeProjects();
    ensureOrchestratorEmbedded();
  } catch {}
}

// ---- ABAS ABERTAS do Claude Code (lidas do state.vscdb do VS Code) ----
// O VS Code NÃO expõe as abas via acessibilidade, mas persiste os editores
// abertos no SQLite do workspace. Cada chat do Claude Code é um "webviewInput"
// com viewType "...claudeVSCodePanel" e o título (truncado "…") do chat.
// Não-intrusivo: só lê o disco, não mexe na tela.
function vscodeWorkspaceDbs() {
  const dir = path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const db = path.join(dir, name, "state.vscdb");
      try { out.push({ db, mtime: fs.statSync(db).mtimeMs }); } catch {}
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime); // mais recente = janela ativa
  return out;
}
function listOpenClaudeTabs() {
  const dbs = vscodeWorkspaceDbs();
  if (!dbs.length) return [];
  let raw = "";
  try {
    // caminho absoluto: o LaunchAgent roda com PATH mínimo
    const sqlite3 = fs.existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3";
    raw = execFileSync(
      sqlite3,
      [dbs[0].db, "SELECT value FROM ItemTable WHERE key='memento/workbench.parts.editor';"],
      { encoding: "utf8", timeout: 4000 }
    );
  } catch { return []; }
  raw = (raw || "").trim();
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  // os editores vêm serializados como { id:"workbench.editors.webviewInput", value:"<json>" }
  const inputs = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.id === "workbench.editors.webviewInput" && typeof o.value === "string") inputs.push(o.value);
    for (const k in o) walk(o[k]);
  })(data);
  const tabs = [];
  const seen = new Set();
  for (const v of inputs) {
    try {
      const inner = JSON.parse(v);
      if (!/claude/i.test(inner.viewType || "")) continue;
      const title = (inner.title || "").trim();
      if (title && !seen.has(title)) { seen.add(title); tabs.push({ title }); }
    } catch {}
  }
  return tabs;
}
let openTabsCache = [];
function refreshOpenTabs() {
  try {
    openTabsCache = listOpenClaudeTabs();
    flog("openTabs: " + openTabsCache.length + " abas [" + openTabsCache.map((t) => t.title).join(" | ") + "]");
  } catch { openTabsCache = []; }
}

// regex pra extrair cwd(s) e o título (aiTitle = nome do chat no VS Code)
const CWD_RE = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const AITITLE_RE = /"aiTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
function decodeStr(raw) {
  try { return JSON.parse('"' + raw + '"'); } catch { return raw; }
}
// cwds distintos + o ÚLTIMO aiTitle do começo do arquivo (numa leitura só)
function scanSession(file) {
  const head = readHead(file, 131072);
  const cwds = new Set();
  let m;
  CWD_RE.lastIndex = 0;
  while ((m = CWD_RE.exec(head))) cwds.add(decodeStr(m[1]));
  let title = null;
  AITITLE_RE.lastIndex = 0;
  while ((m = AITITLE_RE.exec(head))) title = decodeStr(m[1]); // fica com o último
  return { cwds, title };
}

// varre .jsonl recursivamente (sessões ficam soltas e em subpastas de tasks)
function walkJsonl(dir, out, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.name.endsWith(".jsonl")) out.push(full);
  }
}

// lista projetos do Claude Code AGRUPANDO por cwd real (a pasta codificada
// mistura cwds e arquivos têm cwds variados). Ignora worktrees efêmeras.
function listClaudeProjects() {
  const base = path.join(os.homedir(), ".claude", "projects");
  const files = [];
  walkJsonl(base, files, 0);
  // Agrupa por (pasta + TÍTULO do chat). Assim, vários chats que rodam da MESMA
  // pasta (ex.: todos a partir da home) viram destinos SEPARADOS, cada um pelo seu
  // título — em vez de colapsar tudo num projeto só.
  const byChat = new Map(); // key -> { cwd, title, sessions, mtime }
  for (const file of files) {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    const { cwds, title } = scanSession(file);
    for (const cwd of cwds) {
      if (cwd.startsWith("/private/tmp") || cwd.startsWith("/tmp")) continue; // worktrees
      const key = cwd + "␟" + (title || "");
      const cur = byChat.get(key) || { cwd, title: title || null, sessions: 0, mtime: 0 };
      cur.sessions += 1;
      if (m > cur.mtime) cur.mtime = m;
      byChat.set(key, cur);
    }
  }
  return [...byChat.entries()]
    .map(([key, v]) => ({
      key,
      cwd: v.cwd,
      name: v.title || path.basename(v.cwd),
      title: v.title, // nome do chat (aiTitle)
      windowMatch: v.title || path.basename(v.cwd), // alvo de roteamento = título da aba
      sessions: v.sessions,
      mtime: v.mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40); // só os chats mais recentes (evita despejar dezenas de antigos)
}

// título da JANELA ATIVA (AXMain) de um app — mesmo com a Capi na frente.
// é o que a gente amarra pra rotear (o título real da janela do VS Code).
function getAppMainWindowTitle(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId) return resolve(null);
    const script =
      `tell application "System Events" to tell (first application process whose bundle identifier is "${bundleId}")\n` +
      `try\n` +
      `return value of attribute "AXTitle" of (first window whose value of attribute "AXMain" is true)\n` +
      `on error\n` +
      `try\n` +
      `return name of window 1\n` +
      `end try\n` +
      `end try\n` +
      `end tell`;
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return resolve(null);
      const t = (stdout || "").trim();
      resolve(t || null);
    });
  });
}

// lista os títulos das janelas abertas de um app (pra mirar projeto -> janela)
function listAppWindows(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId) return resolve([]);
    const script =
      `tell application "System Events"\n` +
      `set bp to first application process whose bundle identifier is "${bundleId}"\n` +
      `set ts to ""\n` +
      `repeat with w in (windows of bp)\n` +
      `set ts to ts & (name of w) & linefeed\n` +
      `end repeat\n` +
      `return ts\n` +
      `end tell`;
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        (stdout || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    });
  });
}

// log em arquivo (pra ver status mesmo lançando via `open`, sem stdout)
// os.tmpdir() = /tmp no Mac e %TEMP% no Windows (não hardcodar "/tmp": no Windows
// esse caminho não existe e todo flog() falharia silenciosamente).
const FLOG = path.join(os.tmpdir(), "capi-status.log");
function flog(msg) {
  try {
    fs.appendFileSync(FLOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
  console.log("[capi]", msg);
}

let tray = null;
let overlayWindow = null;
let mainWindow = null;
let panelWindow = null; // janela do painel web (Conta/Faturas/Config), só sob demanda
let loginWindow = null; // janela de login nativo (e-mail/senha via Supabase REST)
let onboardingWindow = null; // janela de onboarding pós-login (escolher destino)
let notifWindow = null; // telinha de notificação (agente respondeu) — canto da tela
let notifTimer = null; // auto-dismiss da notificação
let notifEndsAt = 0; // timestamp em que a notificação some (pra pausar/retomar)
let lastSentTarget = null; // último destino enviado: { from, avatar, bundleId, urlMatch, web } — pro botão Responder
let capturing = false;

// ---------- Permissão de gravação de tela (macOS) ----------
function hasScreenPermission() {
  if (process.platform !== "darwin") return true;
  try {
    return systemPreferences.getMediaAccessStatus("screen") === "granted";
  } catch {
    return true;
  }
}

function promptScreenPermission() {
  const n = new Notification({
    title: "Capi needs permission",
    body: "Enable Screen Recording for Capi in System Settings and reopen the app.",
  });
  n.show();
  // abre direto a aba de Gravação de Tela
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
  );
}

// ---------- Captura ----------
// Força o macOS a registrar o app na lista de Gravação de Tela e a mostrar o
// pop-up de permissão (só acontece quando o app de fato tenta capturar).
async function primeScreenAccess() {
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 256, height: 160 },
    });
  } catch (e) {
    console.warn("primeScreenAccess:", e.message);
  }
}

// Gatilho forte do diálogo de Gravação de Tela: abrir um stream via getUserMedia
// numa janela oculta. É o caminho que faz o macOS mostrar o pedido de permissão.
let permWindow = null;
function triggerScreenPrompt() {
  if (permWindow && !permWindow.isDestroyed()) return;
  permWindow = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "permission-preload.js"),
    },
  });
  permWindow.loadFile(path.join(__dirname, "permission.html"));
  setTimeout(() => {
    if (permWindow && !permWindow.isDestroyed()) permWindow.destroy();
    permWindow = null;
    refreshTrayMenu();
  }, 10000);
}

async function startCapture() {
  // auto-cura: se está "capturando" mas não há overlay vivo, destrava
  if (capturing) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // já tem overlay aberto — fecha (toggle) em vez de ignorar o atalho
      closeOverlay();
      return;
    }
    capturing = false;
  }
  capturing = true;
  // atualiza a lista de projetos do Claude Code em background (pro PRÓXIMO overlay)
  setImmediate(refreshClaudeProjects);
  setImmediate(refreshOpenTabs);
  setImmediate(refreshRunningApps);
  try {
    // guarda o app que está na frente ANTES do overlay roubar o foco
    frontmostApp = await getFrontmostApp();
    // display sob o cursor
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { bounds, scaleFactor } = display;

    // captura a tela inteira desse display em resolução nativa
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(bounds.width * scaleFactor),
        height: Math.round(bounds.height * scaleFactor),
      },
    });

    // casa a source com o display certo (display_id pode vir string)
    let source =
      sources.find((s) => String(s.display_id) === String(display.id)) ||
      sources[0];

    if (!source || source.thumbnail.isEmpty()) {
      capturing = false;
      promptScreenPermission();
      return;
    }

    const dataURL = source.thumbnail.toDataURL();
    openOverlay(display, dataURL, false);
  } catch (e) {
    console.error("Erro na captura:", e);
    capturing = false;
  }
}

// ⌘+Shift+1 — "só falar": abre o overlay SEM print, grava voz e manda só o texto
async function startVoiceOnly() {
  if (capturing) {
    if (overlayWindow && !overlayWindow.isDestroyed()) { closeOverlay(); return; }
    capturing = false;
  }
  capturing = true;
  setImmediate(refreshClaudeProjects);
  setImmediate(refreshOpenTabs);
  setImmediate(refreshRunningApps);
  try {
    frontmostApp = await getFrontmostApp();
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    openOverlay(display, null, true); // sem dataURL, modo voz
  } catch (e) {
    console.error("Erro no modo voz:", e);
    capturing = false;
  }
}

function openOverlay(display, dataURL, voiceOnly) {
  const { bounds } = display;
  // modo voz: janelinha no CANTO SUPERIOR DIREITO (tela livre). Print: tela inteira.
  const VW = 380, VH = 500, VM = 20;
  const win = voiceOnly
    ? { x: bounds.x + bounds.width - VW - VM, y: bounds.y + VM, width: VW, height: VH }
    : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  overlayWindow = new BrowserWindow({
    x: win.x,
    y: win.y,
    width: win.width,
    height: win.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // NSPanel: flutua sobre apps em TELA CHEIA e vira "key" pra receber teclado
    // SEM ativar o app / trocar de Space (igual ferramentas de screenshot)
    type: "panel",
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // aparece no Space ATUAL (inclusive apps em tela cheia) SEM pular pra área de
  // trabalho principal. skipTransformProcessType evita o "salto" de Space do app agente.
  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  overlayWindow.webContents.on("console-message", (_e, _lvl, msg) => {
    if (/error|fail|exception|denied|not-allowed/i.test(msg))
      flog("overlay: " + String(msg).slice(0, 200));
  });
  overlayWindow.loadFile(path.join(__dirname, "..", "overlay", "overlay.html"));

  overlayWindow.webContents.once("did-finish-load", () => {
    overlayWindow.webContents.send("overlay:init", {
      dataURL,
      voiceOnly: !!voiceOnly,
      autoPaste: config.autoPaste,
      frontmost: frontmostApp,
      agents: flattenDestinations(),
      appsTree: buildDestinationTree(),
      openApps: buildOpenApps(),
      pinned: buildPinned(),
      agentDefault: config.captureDefault || config.agentDefault || "__last__",
      focusMode: config.focusMode || "switch",
      autoRecord: config.autoRecord !== false,
    });
    overlayWindow.focus();
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    capturing = false;
  });
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
  capturing = false;
}

// ---------- Telinha de notificação ("o agente respondeu") ----------
// Toast no canto da tela: avatar de quem respondeu + trecho + Responder/Dispensar.
// Some sozinho (com barra de tempo); pausa quando o mouse está em cima.
const APP_ROOT = path.join(__dirname, "..", ".."); // .../desktop

// resolve um avatar "img:../../assets/integrations/x.png" para file:// absoluto
function avatarFileURL(av) {
  if (!av || typeof av !== "string") return null;
  const raw = av.replace(/^(img:|capi:)/, "").replace(/^(\.\.\/)+/, "");
  if (!raw || /^https?:/i.test(raw)) return av.replace(/^(img:|capi:)/, "");
  const abs = path.join(APP_ROOT, raw);
  try {
    if (!fs.existsSync(abs)) return null;
  } catch {}
  return pathToFileURL(abs).href;
}

function ensureNotifWindow() {
  if (notifWindow && !notifWindow.isDestroyed()) return notifWindow;
  const W = 384;
  const H = 184;
  const wa = screen.getPrimaryDisplay().workArea;
  notifWindow = new BrowserWindow({
    x: wa.x + wa.width - W - 14,
    y: wa.y + 14,
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // sem type:"panel" — a toast não precisa virar "key" (teclado); showInactive()
    // já evita roubar foco do app onde a pessoa está.
    webPreferences: {
      preload: path.join(__dirname, "..", "notif", "notif-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  notifWindow.setAlwaysOnTop(true, "screen-saver");
  notifWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  notifWindow.loadFile(path.join(__dirname, "..", "notif", "notif.html"));
  notifWindow.on("closed", () => {
    notifWindow = null;
    if (notifTimer) clearTimeout(notifTimer);
    notifTimer = null;
  });
  return notifWindow;
}

function scheduleNotifDismiss(ms) {
  if (notifTimer) clearTimeout(notifTimer);
  notifEndsAt = Date.now() + ms;
  notifTimer = setTimeout(() => dismissNotif(), ms);
}

// opts: { from, tag, text, avatar, duration, target } — target = pra onde o Responder leva
function showNotif(opts = {}) {
  const duration = opts.duration || 10000;
  const win = ensureNotifWindow();
  if (opts.target) lastSentTarget = opts.target;
  const payload = {
    from: opts.from || "Agente",
    tag: opts.tag || "respondeu você",
    text: opts.text || "",
    avatar: avatarFileURL(opts.avatar) || null,
    duration,
  };
  const send = () => {
    if (!notifWindow || notifWindow.isDestroyed()) return;
    notifWindow.showInactive(); // aparece SEM roubar foco
    notifWindow.webContents.send("notif:show", payload);
    scheduleNotifDismiss(duration);
    flog("notif mostrada: from=" + payload.from + " avatar=" + (payload.avatar ? "ok" : "none"));
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function dismissNotif() {
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = null;
  if (notifWindow && !notifWindow.isDestroyed()) notifWindow.hide();
}

// Responder: volta o foco pro agente que respondeu (aba do browser ou app nativo).
async function notifReply() {
  dismissNotif();
  const t = lastSentTarget;
  if (!t) return;
  try {
    if (t.web && t.urlMatch) {
      await focusBrowserTab(t.urlMatch);
    } else if (t.bundleId) {
      await activateApp(t.bundleId);
    }
  } catch (e) {
    flog("notifReply erro: " + (e.message || e));
  }
}

ipcMain.on("notif:reply", () => notifReply());
ipcMain.on("notif:dismiss", () => dismissNotif());
ipcMain.on("notif:hold", (_e, on) => {
  if (on) {
    // mouse em cima → segura o auto-dismiss
    if (notifTimer) clearTimeout(notifTimer);
    notifTimer = null;
  } else {
    // mouse saiu → retoma com o tempo que sobrou (mín. 2s pra dar pra agir)
    const remaining = Math.max(2000, notifEndsAt - Date.now());
    scheduleNotifDismiss(remaining);
  }
});

// ---------- Detecção de resposta do agente (vigia a janela e avisa) ----------
// Depois de enviar, o Capi observa a JANELA do agente pelo buffer do sistema
// (desktopCapturer — pega o conteúdo mesmo com a janela atrás de outras). Quando a
// resposta PARA de mudar (terminou de escrever), dispara a telinha de notificação.
// Não usa screencapture de tela (que falha entre Spaces). Precisa de screen recording
// (o app já tem) e da janela não estar minimizada.
let replyWatch = null; // { timer } — só um por vez

// fração de pixels que mudaram entre dois bitmaps BGRA do mesmo tamanho (0..1)
function bitmapDiffFraction(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  const step = 4 * 12; // amostra 1 px a cada 12
  let changed = 0;
  let total = 0;
  for (let i = 0; i + 2 < a.length; i += step) {
    total++;
    const d =
      Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 45) changed++;
  }
  return total ? changed / total : 0;
}

async function listWindowSources() {
  try {
    return await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 300, height: 190 },
      fetchWindowIcons: false,
    });
  } catch (e) {
    flog("getSources erro: " + (e.message || e));
    return [];
  }
}

// acha a fonte da janela do agente: por id travado, senão por título, senão keywords
function pickWindowSource(sources, { lockedId, title, keywords }) {
  if (lockedId) {
    const byId = sources.find((s) => s.id === lockedId);
    if (byId) return byId;
  }
  const t = (title || "").trim().toLowerCase();
  if (t) {
    // exato
    let s = sources.find((s) => (s.name || "").trim().toLowerCase() === t);
    if (s) return s;
    // bidirecional: o nome contém o título OU o título contém o nome (some sufixos
    // tipo " — usuário" / " - Google Chrome" que aparecem só de um lado)
    s = sources.find((s) => {
      const n = (s.name || "").trim().toLowerCase();
      if (!n || n.length < 4) return false;
      return n.includes(t) || (t.length > 4 && t.includes(n));
    });
    if (s) return s;
  }
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
  if (kws.length) {
    const s = sources.find((s) => {
      const n = (s.name || "").toLowerCase();
      return kws.some((k) => n.includes(k));
    });
    if (s) return s;
  }
  return null;
}

// palavras-chave pra reencontrar a janela do agente caso o título mude
function replyKeywords(from, url) {
  const f = (from || "").toLowerCase();
  const u = (url || "").toLowerCase();
  const list = [];
  if (f) list.push(f.split(" ")[0]);
  if (/chatgpt|openai/.test(f + u)) list.push("chatgpt", "openai");
  if (/gemini/.test(f + u)) list.push("gemini");
  if (/claude/.test(f + u)) list.push("claude");
  if (/perplexity/.test(f + u)) list.push("perplexity");
  if (/cursor/.test(f)) list.push("cursor");
  if (/code|vscode/.test(f)) list.push("visual studio code", "code");
  return [...new Set(list)];
}

// título da aba ativa do browser (ancora a vigia mesmo se o foco voltar pro app de origem)
async function frontTabTitle(browser) {
  if (!browser) return null;
  const lines =
    browser === "Safari"
      ? [`tell application "Safari" to return name of front document`]
      : [`tell application "${browser}" to return title of active tab of front window`];
  const { out } = await runOsa(lines, "x");
  return out || null;
}
async function frontAppWindowTitle(bundleId) {
  if (!bundleId) return null;
  const lines = [
    `tell application "System Events"`,
    `  try`,
    `    return name of front window of (first process whose bundle identifier is "${bundleId}")`,
    `  end try`,
    `end tell`,
  ];
  const { out } = await runOsa(lines, "x");
  return out || null;
}

let replyWatchGen = 0; // aborta loops de busca obsoletos quando vem outro envio

function stopReplyWatch() {
  if (replyWatch && replyWatch.timer) clearInterval(replyWatch.timer);
  replyWatch = null;
  replyWatchGen++;
}

// vigia a janela do agente; quando a resposta PARA de mudar, dispara a notificação.
// opts: { title, keywords, from, avatar, target }
async function watchForReply(opts = {}) {
  if (process.platform !== "darwin") return;
  stopReplyWatch(); // um envio por vez
  const myGen = replyWatchGen;
  const { title, keywords, from, avatar, target } = opts;

  // procura a janela do agente por até ~22s (ela pode demorar a ficar "capturável"
  // — ex.: você volta pra Área de Trabalho dela). Aborta se vier outro envio.
  let src0 = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    if (replyWatchGen !== myGen) return; // substituído
    const sources0 = await listWindowSources();
    const cand = pickWindowSource(sources0, { title, keywords });
    if (cand && cand.thumbnail && !cand.thumbnail.isEmpty()) {
      src0 = cand;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (replyWatchGen !== myGen) return;
  if (!src0) {
    flog(
      "replyWatch: janela do agente não encontrada após ~22s (" +
        (from || "?") +
        ", title=" +
        JSON.stringify(title || "") +
        ") — provável Space diferente/minimizada"
    );
    return;
  }
  const lockedId = src0.id;
  let prev = src0.thumbnail.toBitmap();
  let started = false;
  let stable = 0;
  let ticks = 0;
  const POLL = 1500;
  const START_TIMEOUT = 70; // ~105s pro agente começar
  const HARD_STOP = 220; // ~5,5min teto
  const STABLE_NEEDED = 2; // ~3s parado após mexer = pronto
  flog('replyWatch: vigiando "' + (src0.name || "") + '" (' + (from || "?") + ")");

  const watch = { timer: null };
  replyWatch = watch;
  watch.timer = setInterval(async () => {
    if (replyWatch !== watch) return; // substituído por outro envio
    ticks++;
    const sources = await listWindowSources();
    const src = pickWindowSource(sources, { lockedId, title, keywords });
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
      if (ticks > 4 && !started) stopReplyWatch(); // janela sumiu/minimizou
      return;
    }
    const cur = src.thumbnail.toBitmap();
    const diff = bitmapDiffFraction(prev, cur);
    prev = cur;
    if (diff > 0.01) {
      started = true;
      stable = 0;
    } else if (started) {
      stable++;
      if (stable >= STABLE_NEEDED) {
        stopReplyWatch();
        showNotif({ from, avatar, tag: "respondeu você", text: "", duration: 10000, target });
        flog("replyWatch: resposta detectada → notificou (" + (from || "?") + ")");
        return;
      }
    }
    if (!started && ticks >= START_TIMEOUT) {
      stopReplyWatch();
      flog("replyWatch: timeout sem início (" + (from || "?") + ")");
    }
    if (ticks >= HARD_STOP) stopReplyWatch();
  }, POLL);
}

// qual app estava na frente quando o atalho foi disparado (pra colar de volta nele)
let frontmostApp = null; // { bundleId, name }
function getFrontmostApp() {
  return new Promise((resolve) => {
    exec(
      `osascript -e 'tell application "System Events" to set fp to first application process whose frontmost is true' -e 'tell application "System Events" to try
set wt to name of first window of fp whose value of attribute "AXMain" is true
on error
set wt to ""
end try' -e 'tell application "System Events" to (bundle identifier of fp) & "|" & (name of fp) & "|" & wt'`,
      (err, stdout) => {
        if (err) return resolve(null);
        const [bundleId, name, win] = (stdout || "").trim().split("|");
        resolve(bundleId ? { bundleId, name: name || bundleId, window: win || "" } : null);
      }
    );
  });
}

// lista apps abertos (não-background) pra escolher como destino
function listRunningApps() {
  return new Promise((resolve) => {
    exec(
      `osascript -e 'set out to ""' -e 'tell application "System Events" to set procs to (every application process whose background only is false)' -e 'repeat with p in procs' -e 'set out to out & (name of p) & "|" & (bundle identifier of p) & linefeed' -e 'end repeat' -e 'return out'`,
      (err, stdout) => {
        if (err) return resolve([]);
        const apps = (stdout || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [name, bundleId] = l.split("|");
            return { name, bundleId };
          })
          .filter((a) => a.bundleId);
        resolve(apps);
      }
    );
  });
}

// cache dos apps abertos (pro "destino universal": mandar pra qualquer app)
let runningAppsCache = [];
function refreshRunningApps() {
  listRunningApps()
    .then((a) => { runningAppsCache = a || []; })
    .catch(() => {});
}
// monta os apps abertos AGORA que ainda não são destinos configurados
// (remove a própria Capi e os apps que já aparecem com seus sub-níveis)
function buildOpenApps() {
  const SELF = new Set(["com.luporini.capi", "com.github.Electron"]);
  const configured = new Set((config.apps || []).map((a) => a.bundleId));
  const seen = new Set();
  return (runningAppsCache || [])
    .filter((a) => {
      if (!a.bundleId || SELF.has(a.bundleId) || configured.has(a.bundleId)) return false;
      if (seen.has(a.bundleId)) return false;
      seen.add(a.bundleId);
      return true;
    })
    .map((a) => ({ name: a.name, bundleId: a.bundleId }));
}

// só ativa um app pelo bundleId (sem colar) — usado pra devolver o foco
function activateApp(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId || bundleId === "__last__") return resolve(false);
    execFile(
      "osascript",
      ["-e", `tell application id "${bundleId}" to activate`],
      (err) => resolve(!err)
    );
  });
}

// traz pra frente a janela específica de um app cujo título contém `match`
// (ex.: várias janelas do VS Code, uma por projeto). Best-effort.
function raiseWindow(bundleId, match) {
  return new Promise((resolve) => {
    if (!bundleId || bundleId === "__last__" || !match) return resolve(false);
    const safe = String(match).replace(/"/g, '\\"');
    const script =
      `tell application id "${bundleId}" to activate\n` +
      `delay 0.2\n` +
      `tell application "System Events"\n` +
      `set bp to first application process whose bundle identifier is "${bundleId}"\n` +
      `tell bp\n` +
      `set wins to (every window whose title contains "${safe}")\n` +
      `if (count of wins) > 0 then perform action "AXRaise" of (item 1 of wins)\n` +
      `set frontmost to true\n` +
      `end tell\n` +
      `end tell`;
    execFile("osascript", ["-e", script], (err) => {
      if (err) flog("raiseWindow erro: " + err.message);
      resolve(!err);
    });
  });
}

// apps que hospedam o Claude Code (input focável com ⌘+Esc)
const CLAUDE_CODE_HOSTS = new Set([
  "com.microsoft.VSCode",
  "com.todesktop.230313mzl4w4u92", // Cursor
]);

// Claude Desktop (app nativo da Anthropic) — destino de 1ª classe, fluxo próprio.
// NÃO é Claude Code: não usa ⌘+Esc; nova conversa = ⌘N; precisa esperar a imagem anexar.
const CLAUDE_DESKTOP = "com.anthropic.claudefordesktop";

// limpa o título do chat pra usar como busca no Quick Open `edt`:
// tira reticências de truncamento ("Implementar grupos de pr…") e o sufixo " — pasta".
function cleanTabQuery(title) {
  let q = String(title || "");
  q = q.split(" — ")[0]; // VS Code: "<aba> — <pasta>" -> fica só a aba
  q = q.replace(/[…]+\s*$/, "").replace(/\.\.\.\s*$/, ""); // tira "…" / "..."
  return q.trim();
}

// Vai pra ABA certa do chat dentro da MESMA janela do VS Code/Cursor.
// VS Code tem 1 janela com os chats em abas (título da janela = chat ativo);
// o Quick Open `edt <texto>` lista as abas ABERTAS e foca a que casa o título.
// Retorna { tried, switched }: switched=true só se a janela ativa virou o alvo
// (i.e. a aba estava aberta). Se não trocou, quem chamou avisa "chat não aberto".
async function focusEditorTab(bundleId, title) {
  let q = cleanTabQuery(title);
  // o `edt` faz fuzzy-match: query longa (título inteiro) falha por qualquer
  // diferencinha. Os casos que funcionam usam ~24 chars (título truncado da janela).
  // Corta pros 1ºs ~26 chars E num limite de palavra (evita "captura d" pela metade).
  if (q.length > 26) {
    q = q.slice(0, 26);
    const sp = q.lastIndexOf(" ");
    if (sp >= 12) q = q.slice(0, sp); // termina numa palavra inteira
    q = q.trim();
  }
  if (!CLAUDE_CODE_HOSTS.has(bundleId) || !q) return { tried: false, switched: false };

  // uma tentativa de ⌘P -> "edt q" -> Enter -> Esc. Delays folgados pro filtro assentar
  // ANTES do Enter (a flakiness era o Enter cair antes do `edt` narrowar -> abria a aba do topo).
  const attempt = () =>
    new Promise((resolve) => {
      execFile(
        "osascript",
        [
          "-e", "on run argv",
          "-e", "set q to item 1 of argv",
          "-e", "set bid to item 2 of argv",
          "-e", "tell application id bid to activate",
          "-e", "delay 0.35",
          "-e", 'tell application "System Events"',
          "-e", 'keystroke "p" using command down', // ⌘P = Quick Open
          "-e", "delay 0.45",
          "-e", 'keystroke ("edt " & q)',           // "edt " lista as abas abertas
          "-e", "delay 0.75",                        // <- deixa o fuzzy assentar antes do Enter
          "-e", "key code 36",                        // Enter -> foca a aba do topo (o melhor match)
          "-e", "delay 0.2",
          "-e", "key code 53",                        // Esc -> fecha o Quick Open se sobrou aberto
          "-e", "end tell",
          "-e", "end run",
          q, bundleId,
        ],
        (err) => {
          if (err) flog("focusEditorTab erro: " + err.message);
          resolve();
        }
      );
    });

  // tenta até 3×: confirma pelo título da janela ativa; só para quando casar o alvo.
  let switched = false;
  let now = null;
  for (let i = 0; i < 3 && !switched; i++) {
    await attempt();
    await new Promise((r) => setTimeout(r, 160));
    now = await getAppMainWindowTitle(bundleId);
    switched = now ? titlesMatch(title, now) : false;
    flog(`focusEditorTab try${i + 1}/3: alvo="${q}" janela="${now || "-"}" switched=${switched}`);
    if (!switched) await new Promise((r) => setTimeout(r, 140)); // respiro antes de retry
  }
  return { tried: true, switched };
}

// reativa o app de destino e cola a imagem (⌘V).
// focusChat: manda ⌘+Esc antes de colar pra focar o input do Claude (VS Code/Cursor)
function activateAndPasteImage(bundleId, focusChat, doPaste = true) {
  return new Promise((resolve) => {
    const args = [];
    if (bundleId && bundleId !== "__last__") {
      args.push("-e", `tell application id "${bundleId}" to activate`);
      args.push("-e", "delay 0.35");
    }
    if (focusChat) {
      // ⌘+Esc foca a caixa do Claude Code (key code 53 = Esc)
      args.push("-e", 'tell application "System Events" to key code 53 using command down');
      args.push("-e", "delay 0.2");
    }
    if (doPaste) {
      // ⌘V cola a imagem (modo "só voz" pula isso — não há imagem)
      args.push("-e", 'tell application "System Events" to keystroke "v" using command down');
    }
    execFile("osascript", args, (err) => {
      if (err) flog("paste img erro: " + err.message);
      resolve(!err);
    });
  });
}

// digita o texto da nota no campo (passa via argv -> sem problema de escaping/acentos)
function typeNote(text) {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'tell application "System Events" to keystroke (item 1 of argv)',
        "-e",
        "end run",
        text,
      ],
      (err) => {
        if (err) flog("type erro: " + err.message);
        resolve(!err);
      }
    );
  });
}

// aperta Return no app de destino (pra ENVIAR a mensagem)
function pressEnter() {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", 'tell application "System Events" to key code 36'],
      (err) => {
        if (err) flog("enter erro: " + err.message);
        resolve(!err);
      }
    );
  });
}

// ---------- Claude Desktop (app nativo) — envio dedicado ----------
// Diferente do Claude Code (VS Code/Cursor): SEM ⌘+Esc. O input já fica focado
// quando a janela está ativa; reforço a ativação 2× pra garantir o foco do
// compositor, espero a imagem ANEXAR (mais que os 400ms genéricos) e mando Enter.
// newProject = nova conversa => ⌘N antes de colar.
async function pasteToClaudeDesktop({ note, submit, textOnly, newProject }) {
  // ativa 2× com folga pra reforçar o foco do compositor (a caixa de mensagem)
  await activateApp(CLAUDE_DESKTOP);
  await new Promise((r) => setTimeout(r, 350));
  await activateApp(CLAUDE_DESKTOP);
  await new Promise((r) => setTimeout(r, 350));
  // nova conversa = ⌘N (NÃO ⌘+Esc — isso é do Claude Code)
  if (newProject) {
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "n" using command down']);
    await new Promise((r) => setTimeout(r, 600));
  }
  // cola a imagem (se houver) e ESPERA ela anexar de verdade. O Claude Desktop
  // demora pra subir o anexo; se o Enter dispara antes, o envio fica BLOQUEADO
  // (a caixa não envia com upload pendente) e o texto fica parado. Damos folga.
  if (!textOnly) {
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 1600));
  }
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  if (text) {
    await typeNote(text);
    await new Promise((r) => setTimeout(r, 200));
  }
  // Enter ENVIA no Claude Desktop (Shift+Enter quebraria linha).
  // Reforço o foco da janela (a caixa) imediatamente antes, senão o Enter pode
  // cair fora do compositor; e dou uma folga extra pro anexo terminar.
  if (submit) {
    await new Promise((r) => setTimeout(r, 400));
    await activateApp(CLAUDE_DESKTOP);
    await new Promise((r) => setTimeout(r, 250));
    await pressEnter();
  }
  return true;
}

// ---------- Agentes de navegador (ChatGPT/Gemini/Claude.ai/Perplexity) ----------
// Navegadores Chrome-family (compartilham o MESMO dialeto AppleScript do Chrome).
const CHROME_FAMILY = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Arc", "Vivaldi", "Google Chrome Canary", "Chromium"];
// um app está instalado? (checa /Applications e ~/Applications)
function appInstalled(name) {
  try {
    return fs.existsSync(`/Applications/${name}.app`) ||
      fs.existsSync(path.join(os.homedir(), "Applications", `${name}.app`));
  } catch { return false; }
}
// 1º navegador que o Capi consegue SCRIPTAR (achar/focar aba). Usado pra abrir o
// agente num navegador suportado — não no default do SO (que pode ser Firefox,
// onde não conseguiríamos colar e abriríamos uma aba inútil a cada envio).
function firstSupportedBrowser() {
  const chrome = CHROME_FAMILY.find(appInstalled);
  if (chrome) return chrome;
  if (appInstalled("Safari")) return "Safari";
  return null;
}
// app está RODANDO agora? (por bundleId). Na dúvida (erro), retorna true p/ não
// bloquear o envio à toa. Usado p/ não colar num mensageiro fechado.
function appRunning(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId || bundleId === "__last__") return resolve(true);
    execFile(
      "osascript",
      ["-e", `tell application "System Events" to return (exists (first application process whose bundle identifier is "${bundleId}"))`],
      (err, stdout) => resolve(err ? true : String(stdout || "").trim() === "true")
    );
  });
}
function runOsa(lines, arg) {
  return new Promise((resolve) => {
    const args = [];
    lines.forEach((l) => args.push("-e", l));
    args.push(arg);
    execFile("osascript", args, (err, stdout, stderr) => {
      // loga erro de AppleScript (ex: permissão de automação do Safari negada),
      // senão a falha vira NOTFOUND silencioso e ninguém descobre o porquê.
      if (err) flog("osascript err: " + String(stderr || err.message || "").trim().slice(0, 200));
      resolve({ out: String(stdout || "").trim(), err });
    });
  });
}
// Chrome-family: roda 1 osascript SÓ se houver pelo menos 1 instalado. Usa o
// PRIMEIRO instalado como fonte do dialeto (`using terms from`) — assim a falta
// do Google Chrome não quebra a busca (Brave/Edge/etc. servem de dialeto). Apps
// não instalados na lista só erram no `tell` em runtime (capturado pelo try).
async function focusTabChromeFamily(urlMatch) {
  const installed = CHROME_FAMILY.filter(appInstalled);
  if (!installed.length) return { found: false, browser: null };
  const dictSrc = installed[0];
  const listLiteral = "{" + installed.map((n) => `"${n}"`).join(", ") + "}";
  const lines = [
    "on run argv",
    "set needle to item 1 of argv",
    `set fam to ${listLiteral}`,
    "repeat with bname in fam",
    'tell application "System Events" to set isRunning to (exists (process (bname as string)))',
    "if isRunning then",
    "try",
    `using terms from application "${dictSrc}"`,
    "tell application (bname as string)",
    "repeat with wi from 1 to (count of windows)",
    "repeat with ti from 1 to (count of tabs of window wi)",
    "if (URL of tab ti of window wi) contains needle then",
    "set active tab index of window wi to ti",
    "set index of window wi to 1",
    "activate",
    'return "OK:" & bname',
    "end if",
    "end repeat",
    "end repeat",
    "end tell",
    "end using terms from",
    "end try",
    "end if",
    "end repeat",
    'return "NOTFOUND"',
    "end run",
  ];
  const { out } = await runOsa(lines, urlMatch);
  const found = out.indexOf("OK:") === 0;
  return { found, browser: found ? out.slice(3) : null };
}
// Safari: osascript SEPARADO (compilação independente — não depende do Chrome).
async function focusTabSafari(urlMatch) {
  if (!appInstalled("Safari")) return { found: false, browser: null };
  const lines = [
    "on run argv",
    "set needle to item 1 of argv",
    'tell application "System Events" to set safRunning to (exists (process "Safari"))',
    "if safRunning then",
    "try",
    'tell application "Safari"',
    "repeat with wi from 1 to (count of windows)",
    "repeat with ti from 1 to (count of tabs of window wi)",
    "if (URL of tab ti of window wi) contains needle then",
    "set current tab of window wi to tab ti of window wi",
    "set index of window wi to 1",
    "activate",
    'return "OK:Safari"',
    "end if",
    "end repeat",
    "end repeat",
    "end tell",
    "end try",
    "end if",
    'return "NOTFOUND"',
    "end run",
  ];
  const { out } = await runOsa(lines, urlMatch);
  const found = out.indexOf("OK:") === 0;
  return { found, browser: found ? "Safari" : null };
}
// Foca a ABA cuja URL contém `urlMatch`. Tenta Chrome-family, depois Safari.
// Retorna { found, browser }. NÃO cola nada — só posiciona.
async function focusBrowserTab(urlMatch) {
  if (!urlMatch) return { found: false, browser: null };
  let r = await focusTabChromeFamily(urlMatch);
  if (!r.found) r = await focusTabSafari(urlMatch);
  flog(`focusBrowserTab "${urlMatch}" -> ${r.found ? r.browser : "NOTFOUND"}`);
  return r;
}

// envio web: foca a aba do agente -> cola imagem -> digita texto -> Enter.
// Se a aba não estiver aberta, NÃO cola (evita jogar no lugar errado) e avisa.
async function runPasteWeb({ urlMatch, note, submit, returnTo, textOnly }) {
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  let { found, browser } = await focusBrowserTab(urlMatch);
  let opened = false;
  // aba não está aberta: ABRE o agente no navegador padrão e espera carregar.
  if (!found) {
    const openUrl = WEB_OPENURL_BY_MATCH[urlMatch] || ("https://" + urlMatch);
    // abre num navegador SUPORTADO (não no default do SO) pra garantir que
    // conseguimos achar+focar a aba depois. Sem suportado → falha cedo.
    const br = firstSupportedBrowser();
    if (!br) {
      flog(`runPasteWeb: nenhum navegador suportado (Chrome-family/Safari) instalado`);
      return { ok: false, tabMissed: true, wanted: urlMatch, notFound: true };
    }
    flog(`runPasteWeb: aba não aberta (${urlMatch}) — abrindo ${openUrl} em ${br}`);
    await sh("open", ["-a", br, openUrl]);
    opened = true;
    // poll até a aba aparecer e focar (até ~8s), depois uma folga p/ a página montar
    for (let i = 0; i < 16 && !found; i++) {
      await new Promise((r) => setTimeout(r, 500));
      ({ found, browser } = await focusBrowserTab(urlMatch));
    }
    if (!found) {
      flog(`runPasteWeb: abri ${openUrl} mas a aba não apareceu a tempo`);
      return { ok: false, tabMissed: true, wanted: urlMatch, notFound: true };
    }
    // composer da página recém-carregada precisa de mais tempo pra montar
    await new Promise((r) => setTimeout(r, 2200));
  }
  // navegador ganhar foco do teclado (conteúdo da página, não a barra)
  await new Promise((r) => setTimeout(r, opened ? 600 : 450));
  // cola a imagem: o handler de paste da página anexa e foca o composer.
  if (!textOnly) {
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 1400)); // tempo do upload anexar
  }
  // Voz-only (sem imagem): nada focou o composer de forma confiável — a imagem é
  // que ancora o cursor no campo. Então digitamos best-effort MAS não damos Enter
  // (evita submeter no escuro) nem devolvemos o foco; o usuário revisa e envia.
  const webManual = !!textOnly;
  if (text) {
    await typeNote(text);
    await new Promise((r) => setTimeout(r, 200));
  }
  // Enter envia (só com imagem colada, que garante o foco do composer)
  if (submit && !webManual) {
    await new Promise((r) => setTimeout(r, 300));
    await pressEnter();
  }
  // ao ABRIR uma aba nova do agente, NÃO devolve o foco — senão a conversa fica
  // pela metade numa aba que o usuário nem está vendo. Idem no modo manual (voz).
  if (returnTo && !opened && !webManual) {
    await new Promise((r) => setTimeout(r, 200));
    await activateApp(returnTo);
  }
  return { ok: true, tabMissed: false, wanted: urlMatch, browser, webManual };
}

// auto-colar completo: foca destino (janela certa) + imagem + texto + enviar
// opts: { bundleId, windowMatch, note, submit, returnTo }
async function runPaste(opts) {
  const { bundleId, windowMatch, note, submit, returnTo, textOnly, newProject, web, urlMatch } = opts || {};
  // Agente de navegador: localiza a ABA pela URL e cola lá
  if (web || String(bundleId || "").indexOf("web.") === 0) {
    return await runPasteWeb({
      urlMatch: urlMatch || WEB_URLMATCH_BY_BUNDLE[bundleId],
      note, submit, returnTo, textOnly,
    });
  }
  // Claude Desktop (app nativo) tem fluxo próprio — não passa pelo caminho genérico
  if (bundleId === CLAUDE_DESKTOP) {
    const ok = await pasteToClaudeDesktop({ note, submit, textOnly, newProject });
    if (returnTo && returnTo !== bundleId) {
      await new Promise((r) => setTimeout(r, 200));
      await activateApp(returnTo);
    }
    return { ok, tabMissed: false, wanted: null };
  }
  // Mensageiro FECHADO: não dá pra colar numa conversa que não existe. Em vez de
  // ativar/colar no escuro (cairia no app errado), aborta e pede pra abrir.
  if (MESSENGER_BUNDLES.has(bundleId) && !(await appRunning(bundleId))) {
    flog(`runPaste: ${bundleId} não está aberto — abortando (peça pra abrir)`);
    return { ok: false, appNotRunning: true, wanted: null };
  }
  const focusChat = CLAUDE_CODE_HOSTS.has(bundleId);
  let tab = { tried: false, switched: false };
  // foca o ALVO certo (se houver):
  // - Claude Code (VS Code/Cursor): 1 janela com abas -> vai pra ABA do chat via `edt`
  // - mensageiro/outros: levanta a JANELA pelo título
  if (windowMatch && bundleId && bundleId !== "__last__") {
    if (focusChat) {
      tab = await focusEditorTab(bundleId, windowMatch);
      await new Promise((r) => setTimeout(r, 250));
    } else {
      await raiseWindow(bundleId, windowMatch);
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  // modo "só voz": foca o input mas NÃO cola imagem (não há)
  const ok = await activateAndPasteImage(bundleId, focusChat, !textOnly);
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  // com imagem, espera ela ANEXAR antes de digitar; sem imagem, atraso curto.
  // mensageiro (WhatsApp/Telegram): colar abre um PREVIEW com campo de legenda —
  // demora mais que o input de um agente, então damos folga extra.
  const isMsg = MESSENGER_BUNDLES.has(bundleId);
  const pasteWait = textOnly ? 200 : (focusChat ? 750 : (isMsg ? 1200 : 400));
  await new Promise((r) => setTimeout(r, pasteWait));
  if (text) {
    await typeNote(text);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (submit) {
    await new Promise((r) => setTimeout(r, 250));
    await pressEnter();
  }
  // modo "ficar aqui": devolve o foco pro app onde a pessoa estava
  if (returnTo && returnTo !== bundleId) {
    await new Promise((r) => setTimeout(r, 200));
    await activateApp(returnTo);
  }
  // tabMissed = pediu uma aba específica mas ela não estava aberta (colou na ativa)
  return { ok, tabMissed: tab.tried && !tab.switched, wanted: windowMatch || null };
}

// ---------- Envio no Windows (PowerShell + WScript.Shell SendKeys) ----------
// bundleId (Mac) -> trecho do título da janela no Windows, p/ AppActivate
const WIN_APP_TITLES = {
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.anthropic.claudefordesktop": "Claude",
  "com.todesktop.230313mzl4w4u92": "Cursor",
};

function psRun(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      (err) => {
        if (err) flog("ps erro: " + err.message);
        resolve(!err);
      }
    );
  });
}
// traz a janela do app (por título) pra frente
function winActivate(title) {
  if (!title) return Promise.resolve(false);
  const t = String(title).replace(/'/g, "''");
  return psRun("$ws = New-Object -ComObject WScript.Shell; $ws.AppActivate('" + t + "') | Out-Null; Start-Sleep -Milliseconds 120");
}
// envia teclas pro app em foco (ex: '^v' = Ctrl+V, '{ENTER}')
function winSendKeys(keys) {
  const k = String(keys).replace(/'/g, "''");
  return psRun("$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('" + k + "')");
}

// equivalente Windows do runPaste: ativa destino -> cola imagem -> cola texto -> Enter
async function runPasteWindows(opts) {
  const { bundleId, note, submit, textOnly } = opts || {};
  const title = WIN_APP_TITLES[bundleId] || null;
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  // 1) traz o app destino pra frente (se conhecido)
  if (title) {
    await winActivate(title);
    await new Promise((r) => setTimeout(r, 400));
  }
  // 2) cola a imagem (o clipboard já tem a imagem)
  if (!textOnly) {
    await winSendKeys("^v");
    await new Promise((r) => setTimeout(r, 900)); // espera anexar
  }
  // 3) cola o texto (via clipboard p/ preservar acentos)
  if (text) {
    clipboard.writeText(text);
    await new Promise((r) => setTimeout(r, 150));
    await winSendKeys("^v");
    await new Promise((r) => setTimeout(r, 180));
  }
  // 4) envia
  if (submit) {
    await new Promise((r) => setTimeout(r, 250));
    await winSendKeys("{ENTER}");
  }
  flog("winPaste: title=" + (title || "-") + " img=" + !textOnly + " text=" + !!text + " submit=" + !!submit);
  return { ok: true, tabMissed: false, wanted: null };
}

// ---------- Abrir frente: nova janela do VS Code + Claude Code + prompt inicial ----------
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, () => res()));

// ---------- "Criar projeto": abre ABA NOVA do Claude Code + cola o briefing ----------
// nome curto do projeto a partir do que a pessoa falou
function makeProjectName(note) {
  const t = (note || "").replace(/\s+/g, " ").trim();
  if (!t) return "New project";
  const words = t.split(" ").slice(0, 6).join(" ");
  return words.length > 42 ? words.slice(0, 42).trim() + "…" : words;
}
// cria o projeto na config JÁ com o Orquestrador embutido (aparece na subtela)
function createCapiProjectWithOrchestrator(name) {
  const cwd = currentClaudeCwd() || "";
  const key = "newproj-" + Date.now();
  config.projects = config.projects || [];
  config.projects.push({ id: key, key, name, appBundleId: "com.microsoft.VSCode", windowMatch: null, cwd });
  config.agents = config.agents || [];
  config.agents.push({
    id: "orq-" + key, name: "Orchestrator", subject: "the one who knows everything",
    avatar: "capi:orquestrador", color: "#7c5cff",
    app: { bundleId: "com.microsoft.VSCode" }, project: { key, name },
    windowMatch: null, kind: "agent",
  });
  saveConfig(config);
  return key;
}
// liga o projeto/Orquestrador ao chat real depois que o Claude nomeia a aba (aiTitle)
function linkProjectToActiveChat(projKey, title) {
  if (!projKey || !title) return;
  const p = (config.projects || []).find((x) => x.key === projKey);
  if (p) p.windowMatch = title;
  (config.agents || []).forEach((a) => {
    if (a.project && a.project.key === projKey) a.windowMatch = title;
  });
  saveConfig(config);
  flog("linkProjectToActiveChat: " + projKey + " -> " + title);
}
// roda um comando do VS Code pela paleta (⌘+Shift+P) — confiável, independe de foco
function runPaletteCommand(query) {
  return new Promise((resolve) => {
    execFile(
      "osascript",
      [
        "-e", "on run argv",
        "-e", "set q to item 1 of argv",
        "-e", 'tell application "System Events"',
        "-e", 'keystroke "p" using {command down, shift down}', // ⌘⇧P = Command Palette
        "-e", "delay 0.45",
        "-e", "keystroke q",
        "-e", "delay 0.55",
        "-e", "key code 36", // Enter -> roda o comando do topo
        "-e", "end tell",
        "-e", "end run",
        query,
      ],
      () => resolve()
    );
  });
}

// abre aba NOVA do Claude Code e cola o briefing (imagem já no clipboard se houver)
async function runNewProjectPaste({ bundleId, note, textOnly, submit }) {
  bundleId = bundleId || "com.microsoft.VSCode";
  await activateApp(bundleId);
  await new Promise((r) => setTimeout(r, 350));
  // paleta -> "Claude Code: Open in New Tab" (ABA nova, estilo browser; NÃO ⌘N que cria arquivo)
  await runPaletteCommand("Claude Code: Open in New Tab");
  await new Promise((r) => setTimeout(r, 1600));
  // ⌘+Esc foca o input do Claude
  await sh("osascript", ["-e", 'tell application "System Events" to key code 53 using command down']);
  await new Promise((r) => setTimeout(r, 400));
  // cola a imagem (se houver)
  if (!textOnly) {
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 750));
  }
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  if (text) { await typeNote(text); await new Promise((r) => setTimeout(r, 150)); }
  if (submit) { await new Promise((r) => setTimeout(r, 250)); await pressEnter(); }
  return true;
}

// caminho do app pelo bundle id (mdfind) — pega onde o VS Code/Cursor estiver
function appPathFor(bundleId) {
  return new Promise((res) => {
    execFile("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], (e, out) => {
      res(((out || "").split("\n").filter(Boolean))[0] || null);
    });
  });
}
// acha o bin de CLI (code/cursor) dentro do bundle real — necessário p/ abrir janela
// nova quando o app JÁ está aberto (open --args não passa args num app já rodando)
async function findEditorCli(bundleId) {
  const isCursor = bundleId.includes("todesktop");
  const binName = isCursor ? "cursor" : "code";
  const fixed = [
    `/usr/local/bin/${binName}`, `/opt/homebrew/bin/${binName}`,
    `/Applications/${isCursor ? "Cursor" : "Visual Studio Code"}.app/Contents/Resources/app/bin/${binName}`,
  ];
  for (const c of fixed) { try { if (fs.existsSync(c)) return c; } catch {} }
  const app = await appPathFor(bundleId);
  if (app) {
    const bin = path.join(app, "Contents/Resources/app/bin", binName);
    try { if (fs.existsSync(bin)) return bin; } catch {}
  }
  return null;
}

// abre a frente: janela nova na pasta, abre o Claude Code (⌘+Esc), cola o briefing e envia
async function launchFrente(agentId) {
  const a = (config.agents || []).find((x) => x.id === agentId);
  if (!a) return { ok: false, error: "agent not found" };
  const folder = a.folder || a.cwd || os.homedir();
  const bundleId = (a.app && a.app.bundleId) || "com.microsoft.VSCode";
  flog(`launchFrente: ${a.name} -> ${folder}`);
  // 1) abre janela NOVA do editor na pasta (bin do CLI é o jeito confiável)
  const cli = await findEditorCli(bundleId);
  if (cli) await sh(cli, ["-n", folder]);
  else await sh("open", ["-b", bundleId, "--args", "-n", folder]); // fallback (pode falhar se já aberto)
  flog(`launchFrente: cli=${cli || "(open fallback)"}`);
  // 2) espera carregar + extensão do Claude Code subir
  await new Promise((r) => setTimeout(r, 4000));
  await activateApp(bundleId);
  await new Promise((r) => setTimeout(r, 700));
  // 3) ⌘+Esc abre/foca o Claude Code
  await sh("osascript", ["-e", 'tell application "System Events" to key code 53 using command down']);
  await new Promise((r) => setTimeout(r, 1400));
  // 4) cola o prompt inicial (briefing) e envia
  const prompt = (a.initPrompt || "").trim();
  if (prompt) {
    clipboard.write({ text: prompt });
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 500));
    await pressEnter();
  }
  return { ok: true };
}

// cria as frentes da Capi como AGENTES de UM projeto "Capi" (cada um mira sua janela)
function seedCapiFrentes() {
  const root = path.join(os.homedir(), "cap");
  const CAPKEY = root; // chave do projeto-container "Capi"
  const docs = path.join(__dirname, "..", "..", "docs");
  const readBrief = (f) => {
    try { return fs.readFileSync(path.join(docs, f), "utf8"); } catch { return ""; }
  };
  // 1) projeto-container "Capi" (agrupa as frentes num lugar só)
  config.projects = config.projects || [];
  if (!config.projects.some((p) => (p.key || p.id) === CAPKEY)) {
    config.projects.push({ id: "capi-suite", key: CAPKEY, name: "Capi", appBundleId: "com.microsoft.VSCode", windowMatch: "cap", cwd: root });
  }
  const CAPPROJ = { key: CAPKEY, name: "Capi" };
  const FRENTES = [
    { id: "capi-desktop", name: "Capi-Desktop", subject: "App code (Electron)", avatar: "capi:desktop", color: "#5b3fd6", folder: path.join(root, "desktop"), wm: "desktop", brief: "briefing-desktop.md" },
    { id: "capi-web", name: "Capi-Web", subject: "Site, auth and dashboard", avatar: "capi:web", color: "#06b6d4", folder: path.join(root, "web"), wm: "web", brief: "briefing-web.md" },
    { id: "capi-marca", name: "Capi-Brand", subject: "Brand and marketing", avatar: "capi:marca", color: "#ef4444", folder: path.join(root, "assets"), wm: "assets", brief: "briefing-marca.md" },
    { id: "capi-qa", name: "Capi-QA", subject: "Tests and quality", avatar: "capi:qa", color: "#22c55e", folder: root, wm: "cap", brief: "" },
  ];
  config.agents = config.agents || [];
  let created = 0, dirty = true; // projeto-container já pode ter sido adicionado
  for (const f of FRENTES) {
    if (config.agents.some((x) => x.id === f.id)) continue;
    config.agents.push({
      id: f.id, name: f.name, subject: f.subject, avatar: f.avatar, color: f.color,
      app: { bundleId: "com.microsoft.VSCode", name: "VS Code" },
      kind: "project", target: "window",
      windowMatch: f.wm, cwd: f.folder, folder: f.folder, // alvo = janela própria
      project: CAPPROJ,                                    // agrupamento = projeto "Capi"
      initPrompt: readBrief(f.brief) || `You are ${f.name}, one of the workstreams of the Capi project. Read ~/cap/CLAUDE.md, ~/cap/ESTADO.md and ~/cap/COORDINATION.md before anything else.`,
    });
    created++;
  }
  // 2) traz o Orquestrador pro projeto "Capi" também (mantém a janela dele)
  const orch = config.agents.find((a) => a.id === "orquestrador");
  if (orch && (!orch.project || orch.project.key !== CAPKEY)) {
    orch.project = CAPPROJ;
    if (!orch.folder) orch.folder = root;
  }
  if (dirty) saveConfig(config);
  return { ok: true, created };
}

// ---------- Janela principal (interface do app) ----------
function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    resizable: true,
    fullscreenable: true,
    title: "Capi",
    backgroundColor: "#efeaff",
    webPreferences: {
      preload: path.join(__dirname, "..", "window", "window-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "window", "window.html"));
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    setDockIcon();
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform === "darwin" && app.dock && (!panelWindow || panelWindow.isDestroyed()))
      app.dock.hide();
  });
}

// URL do painel web. Dev = servidor local; empacotado = site publicado. Override: CAPI_WEB_URL.
const WEB_URL =
  process.env.CAPI_WEB_URL ||
  (app.isPackaged ? "https://trycapi.com" : "http://localhost:3000");

// ---------- Conta / Login (trial 20 usos → paywall) ----------
// A anon key é PÚBLICA por design (RLS protege os dados) — pode ficar embutida.
const SUPABASE_URL = "https://xvwzkvligwpntzjmyqkm.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2d3prdmxpZ3dwbnR6am15cWttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MDM2OTYsImV4cCI6MjA5Nzk3OTY5Nn0.QCLc1V3X8AP_GpMWYJWVC4y_P0XXk0hwTFJAeY2utGc";
// Stripe Payment Link (Pro $12.99/month). client_reference_id = Supabase user_id.
const PRO_PAY_LINK = "https://buy.stripe.com/9B69AN2AybMf4KibXZdby01";

// session = { access_token, refresh_token, user_id, email }
function getSession() {
  const s = config.session;
  if (s && s.access_token && s.user_id) return s;
  return null;
}
function setSession(s) {
  config.session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    user_id: s.user_id,
    email: s.email || null,
  };
  saveConfig(config);
  try { refreshTrayMenu(); } catch {}
}
function clearSession() {
  delete config.session;
  saveConfig(config);
  try { refreshTrayMenu(); } catch {}
}

// Login nativo via Supabase REST (e-mail+senha). Em 200, guarda a session.
async function supabaseLogin(email, password) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) {
      const msg =
        (j && (j.error_description || j.msg || j.error || j.message)) ||
        `Login failed (${r.status})`;
      flog("login falhou: HTTP " + r.status + " " + String(msg).slice(0, 120));
      return { ok: false, error: msg };
    }
    setSession({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      user_id: j.user && j.user.id,
      email: (j.user && j.user.email) || email,
    });
    flog("login ok: " + ((j.user && j.user.email) || email));
    return { ok: true };
  } catch (e) {
    flog("login erro de rede: " + (e.message || e));
    return { ok: false, error: "No connection. Try again." };
  }
}

// Renova o access_token com o refresh_token (quando /api/usage devolve 401).
async function supabaseRefresh() {
  const s = getSession();
  if (!s || !s.refresh_token) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) {
      flog("refresh falhou: HTTP " + r.status);
      return false;
    }
    setSession({
      access_token: j.access_token,
      refresh_token: j.refresh_token || s.refresh_token,
      user_id: (j.user && j.user.id) || s.user_id,
      email: (j.user && j.user.email) || s.email,
    });
    return true;
  } catch (e) {
    flog("refresh erro de rede: " + (e.message || e));
    return false;
  }
}

// Chama POST /api/usage. Conta 1 uso (a menos que pago). Renova o token 1x no 401.
// Retorno: { status:"allowed"|"denied"|"needLogin"|"neterror", remaining, payload? }
async function checkUsage(retried) {
  const s = getSession();
  if (!s) return { status: "needLogin" };
  try {
    const r = await fetch(`${WEB_URL}/api/usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.access_token}`,
        "x-capi-key": TRANSCRIBE_SECRET,
      },
      body: "{}",
    });
    if (r.status === 401) {
      if (!retried && (await supabaseRefresh())) return checkUsage(true);
      flog("usage 401 (sem refresh válido) → needLogin");
      return { status: "needLogin" };
    }
    if (!r.ok) {
      // erro de servidor (5xx etc): FAIL-OPEN, não trava o usuário por infra.
      flog("usage HTTP " + r.status + " → fail-open (deixa enviar)");
      return { status: "allowed", remaining: null, failOpen: true };
    }
    const j = await r.json().catch(() => null);
    if (!j || j.allowed === undefined) {
      flog("usage resposta inesperada → fail-open");
      return { status: "allowed", remaining: null, failOpen: true };
    }
    if (j.allowed === false) {
      return { status: "denied", remaining: 0, payload: j };
    }
    return {
      status: "allowed",
      remaining: j.remaining === undefined ? null : j.remaining,
      payload: j,
    };
  } catch (e) {
    // offline / DNS / servidor inacessível → FAIL-OPEN (deixa enviar).
    flog("usage erro de rede → fail-open: " + (e.message || e));
    return { status: "allowed", remaining: null, failOpen: true };
  }
}

// Devolve 1 uso quando o gate contou mas o envio falhou de fato (ex.: aba do
// agente não abriu). Best-effort: se falhar, o usuário só perde 1 uso (= hoje).
async function refundUsage() {
  const s = getSession();
  if (!s) return;
  try {
    await fetch(`${WEB_URL}/api/usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.access_token}`,
        "x-capi-key": TRANSCRIBE_SECRET,
      },
      body: JSON.stringify({ refund: true }),
    });
    flog("usage refund (envio falhou) ok");
  } catch (e) {
    flog("usage refund falhou: " + (e.message || e));
  }
}

// Monta o link de pagamento já com o user_id pra casar com o webhook do Stripe.
function buildPayUrl() {
  const s = getSession();
  const ref = s ? encodeURIComponent(s.user_id) : "";
  return `${PRO_PAY_LINK}?client_reference_id=${ref}`;
}

// ---------- Janela de LOGIN nativo ----------
function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    title: "Sign in to Capi",
    backgroundColor: "#efeaff",
    webPreferences: {
      preload: path.join(__dirname, "..", "window", "login-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    setDockIcon();
  }
  loginWindow.loadFile(path.join(__dirname, "..", "window", "login.html"));
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  loginWindow.on("closed", () => {
    loginWindow = null;
    if (process.platform === "darwin" && app.dock && (!mainWindow || mainWindow.isDestroyed()) && (!panelWindow || panelWindow.isDestroyed()))
      app.dock.hide();
  });
}

// IPC do login.html
ipcMain.handle("login:submit", async (_e, { email, password }) => {
  const res = await supabaseLogin((email || "").trim(), password || "");
  if (res.ok && loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
  // pós-login: 1ª vez abre o onboarding (permissões + destino); senão, abre o app
  if (res.ok) {
    if (!config.onboarded) setTimeout(() => openOnboardingWindow(), 250);
    else setTimeout(() => openMainWindow(), 250);
  }
  return res;
});
ipcMain.on("login:signup", () => {
  shell.openExternal(`${WEB_URL}/signup`);
});
ipcMain.on("login:cancel", () => {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
});

// IPC do overlay: abrir login / abrir pagamento (a partir do paywall)
ipcMain.on("overlay:openLogin", () => openLoginWindow());
ipcMain.on("overlay:openPay", (_e, payUrl) => {
  closeOverlay();          // fecha a telinha do paywall
  openPayWindow(payUrl);   // checkout DENTRO do Capi (mesma Space — não arranca pro browser)
});

// Janela de checkout do próprio Capi: abre o Stripe numa BrowserWindow na Space
// atual, em vez de jogar no browser externo (que pode estar em tela cheia noutra
// Space e "puxar" o usuário pra lá).
let payWindow = null;
function openPayWindow(payUrl) {
  const url = payUrl || buildPayUrl();
  if (payWindow && !payWindow.isDestroyed()) {
    payWindow.show(); payWindow.focus(); payWindow.loadURL(url);
    return;
  }
  payWindow = new BrowserWindow({
    width: 460, height: 720,
    resizable: false, fullscreenable: false, minimizable: true, maximizable: false,
    title: "Capi Pro", backgroundColor: "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform === "darwin" && app.dock) { app.dock.show(); setDockIcon(); }
  payWindow.loadURL(url);
  // links que o Stripe tenta abrir em nova aba (termos, etc.) vão pro browser
  payWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  payWindow.on("closed", () => { payWindow = null; });
  payWindow.show();
}

// ---------- Onboarding (1ª vez, pós-login) — escolher destino ----------
// checa se um app está instalado pelo bundle id (sem abrir nada)
function isAppInstalled(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId) return resolve(false);
    // agentes web rodam no navegador — sempre "instalados"
    if (String(bundleId).startsWith("web.")) return resolve(true);
    // Windows/Linux não têm bundle id nem osascript: a checagem por AppleScript
    // sempre falharia e prenderia o usuário no "não instalado". Confia no usuário
    // (ele clicou em "I already installed it") e deixa seguir.
    if (process.platform !== "darwin") return resolve(true);
    const script = `tell application "Finder" to return (exists application file id "${bundleId}")`;
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) return resolve(false);
      resolve(/true/i.test((stdout || "").trim()));
    });
  });
}

// marca o app `bundleId` como destino padrão da captura (reaproveita a lógica
// de default existente: captureDefault casa com o app.id quando não há agente).
function setOnboardingDefault(bundleId) {
  const app = (config.apps || []).find((a) => a.bundleId === bundleId);
  if (app) {
    config.captureDefault = app.id;
    config.agentDefault = app.id;
  }
  // também fixa o destino "fixo" do paste antigo (compatibilidade)
  config.pasteDefault = bundleId;
  saveConfig(config);
}

function markOnboarded() {
  config.onboarded = true;
  saveConfig(config);
}

function openOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    fullscreenable: false,
    minimizable: true,
    maximizable: false,
    title: "Set up Capi",
    backgroundColor: "#efeaff",
    webPreferences: {
      preload: path.join(__dirname, "..", "window", "onboarding-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    setDockIcon();
  }
  onboardingWindow.loadFile(path.join(__dirname, "..", "window", "onboarding.html"));
  onboardingWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
    if (
      process.platform === "darwin" && app.dock &&
      (!mainWindow || mainWindow.isDestroyed()) &&
      (!loginWindow || loginWindow.isDestroyed()) &&
      (!panelWindow || panelWindow.isDestroyed())
    )
      app.dock.hide();
  });
}

// nomes amigáveis dos destinos do onboarding (pra label de "Tudo pronto")
const ONBOARD_APP_NAMES = {
  "com.anthropic.claudefordesktop": "Claude Desktop",
  "com.microsoft.VSCode": "VS Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
};

// renderer pergunta: o usuário escolheu um destino. Devolve se está instalado.
ipcMain.handle("onboarding:pick", async (_e, bundleId) => {
  const installed = await isAppInstalled(bundleId);
  return { installed, name: ONBOARD_APP_NAMES[bundleId] || "this app" };
});

// renderer confirma: vira destino padrão + onboarded=true
ipcMain.handle("onboarding:setDefault", (_e, bundleId) => {
  setOnboardingDefault(bundleId);
  markOnboarded();
  return { ok: true, name: ONBOARD_APP_NAMES[bundleId] || "this app" };
});

ipcMain.on("onboarding:open-external", (_e, url) => {
  if (url) shell.openExternal(url);
});

// status ao vivo das permissões (pro passo guiado do onboarding)
ipcMain.handle("onboarding:permStatus", () => {
  const platform = process.platform;
  if (process.platform === "win32") {
    // Windows: tela e "acessibilidade" não se aplicam (SendKeys não pede permissão),
    // mas o MICROFONE sim — a mãe do dono não gravava porque o status vinha "true"
    // falsamente e mascarava o pedido real. Consulta o status de verdade.
    // getMediaAccessStatus pode devolver 'granted'|'denied'|'not-determined'|'unknown';
    // só travamos como pendente quando explicitamente 'denied'.
    let mic = true;
    try {
      mic = systemPreferences.getMediaAccessStatus("microphone") !== "denied";
    } catch (_) {}
    return { platform, screen: true, ax: true, mic };
  }
  if (process.platform !== "darwin") return { platform, screen: true, ax: true, mic: true };
  return {
    platform,
    screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
    ax: systemPreferences.isTrustedAccessibilityClient(false),
    mic: systemPreferences.getMediaAccessStatus("microphone") === "granted",
  };
});

// abre o painel de permissão certo e dispara o prompt nativo
ipcMain.on("onboarding:openPerm", (_e, which) => {
  // Windows: só o microfone é uma permissão real (tela/AX não se aplicam ao
  // SendKeys). Abre direto a página de Privacidade do Microfone do Windows, onde
  // fica o "Let desktop apps access your microphone" — o que faltava pra mãe.
  if (process.platform === "win32") {
    if (which === "mic") {
      shell.openExternal("ms-settings:privacy-microphone").catch(() => {});
    }
    return;
  }
  if (process.platform !== "darwin") return;
  if (which === "screen") {
    triggerScreenPrompt();
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
  } else if (which === "ax") {
    systemPreferences.isTrustedAccessibilityClient(true); // dispara o prompt
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    );
  } else if (which === "mic") {
    try { systemPreferences.askForMediaAccess("microphone"); } catch (_) {}
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    );
  } else if (which === "notif") {
    // dispara uma notificação de teste do Capi → registra o app na lista de
    // Notificações do macOS (e mostra um exemplo) + abre o painel certo.
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: "Capi 🦫 — notifications on!",
          body: "You'll get a heads-up like this when your agent replies.",
          silent: false,
        }).show();
      }
    } catch (_) {}
    shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    );
  }
});

// "Outro app" -> abre a config nativa pra escolher manualmente
ipcMain.on("onboarding:openSettings", () => {
  markOnboarded();
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
  openMainWindow();
});

// fecha o onboarding (Tudo pronto / Pular por agora) marcando onboarded=true
ipcMain.on("onboarding:done", () => {
  markOnboarded();
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
});

function panelFallbackHtml(url, reason) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;
font:16px/1.5 -apple-system,system-ui,sans-serif;background:#efeaff;color:#1E1B2E}
.box{max-width:420px;text-align:center;padding:32px}h1{font-size:20px;margin:.2em 0}
small{color:#6b6580}code{background:#fff;border:1px solid #d9d2f5;border-radius:6px;padding:2px 6px}
button{margin-top:18px;background:#7C5CFF;color:#fff;border:0;border-radius:10px;
padding:10px 18px;font-weight:700;cursor:pointer}</style></head><body><div class="box">
<h1>Panel unavailable</h1><p>Couldn't load <code>${url}</code>.</p>
<small>${reason || ""}</small><br/>
<button onclick="location.reload()">Try again</button></div></body></html>`)
  );
}

// ---------- Janela do PAINEL web (Conta/Faturas/Config) ----------
// Abre SÓ sob demanda (nunca no boot) pra não roubar o foco do envio.
function openPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show();
    panelWindow.focus();
    return;
  }
  panelWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    fullscreenable: true,
    title: "Capi — Panel",
    backgroundColor: "#efeaff",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
    setDockIcon();
  }
  panelWindow.loadURL(`${WEB_URL}/dashboard`);
  panelWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  panelWindow.webContents.on("did-fail-load", (_e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED
    panelWindow.loadURL(panelFallbackHtml(`${WEB_URL}/dashboard`, desc));
  });
  panelWindow.on("closed", () => {
    panelWindow = null;
    if (process.platform === "darwin" && app.dock && (!mainWindow || mainWindow.isDestroyed()))
      app.dock.hide();
  });
}

function winState() {
  return {
    config,
    version: app.getVersion(),
    screen:
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted",
    ax:
      process.platform === "darwin"
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : true,
  };
}

ipcMain.handle("win:getState", () => winState());
ipcMain.on("win:setOption", (_e, { key, value }) => {
  if (["autoPaste", "autoDelete", "playSound"].includes(key)) {
    config[key] = value;
    saveConfig(config);
    refreshTrayMenu();
  }
});
ipcMain.on("win:capture", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  setTimeout(() => startCapture(), 250);
});
ipcMain.on("win:openScreenPrefs", () => promptScreenPermission());
ipcMain.on("win:openAxPrefs", () => {
  // Acessibilidade só existe no macOS; no Windows não há painel equivalente pro
  // SendKeys e a API lançaria. Guarda por plataforma.
  if (process.platform !== "darwin") return;
  systemPreferences.isTrustedAccessibilityClient(true);
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
});
ipcMain.on("win:openNotifPrefs", () => {
  // dispara uma notificação de teste (registra o Capi na lista) + abre o painel
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "Capi 🦫 — notifications on!",
        body: "You'll get a heads-up like this when your agent replies.",
        silent: false,
      }).show();
    }
  } catch (_) {}
  // painel de notificações certo por SO (o URL x-apple não faz nada no Windows)
  if (process.platform === "win32") {
    shell.openExternal("ms-settings:notifications").catch(() => {});
  } else if (process.platform === "darwin") {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
    );
  }
});

function sendWinState() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("win:state", winState());
}

// escolher um app de destino: mostra menu nativo dos apps abertos
ipcMain.on("win:pickTarget", async () => {
  const apps = await listRunningApps();
  const existing = new Set((config.pasteTargets || []).map((t) => t.bundleId));
  const skip = new Set(["com.github.Electron", "com.apple.systempreferences"]);
  const items = apps
    .filter((a) => !existing.has(a.bundleId) && !skip.has(a.bundleId))
    .map((a) => ({
      label: a.name,
      click: () => {
        config.pasteTargets = [...(config.pasteTargets || []), a];
        saveConfig(config);
        sendWinState();
      },
    }));
  const menu = Menu.buildFromTemplate(
    items.length ? items : [{ label: "(no new app open)", enabled: false }]
  );
  menu.popup({ window: mainWindow });
});

ipcMain.on("win:removeTarget", (_e, bundleId) => {
  config.pasteTargets = (config.pasteTargets || []).filter(
    (t) => t.bundleId !== bundleId
  );
  if (config.pasteDefault === bundleId) config.pasteDefault = "__last__";
  saveConfig(config);
  sendWinState();
});

ipcMain.on("win:setDefault", (_e, bundleId) => {
  config.pasteDefault = bundleId || "__last__";
  saveConfig(config);
  sendWinState();
});

// ---------- Agentes ----------
ipcMain.handle("win:listClaudeProjects", () => listClaudeProjects());
ipcMain.handle("win:listAppWindows", (_e, bundleId) => listAppWindows(bundleId));
ipcMain.handle("win:grabActiveWindow", (_e, bundleId) => getAppMainWindowTitle(bundleId));
ipcMain.handle("win:listRunningApps", () => listRunningApps());

// troca um atalho (which: "capture"|"voice") com detecção de conflito.
// Retorna { ok, reason?, shortcut, voiceShortcut }.
ipcMain.handle("win:setShortcut", (_e, { which, accel } = {}) => {
  accel = String(accel || "").trim();
  const cur = { shortcut: config.shortcut, voiceShortcut: config.voiceShortcut };
  const other = which === "voice" ? config.shortcut : config.voiceShortcut;
  if (!accel || !/\+/.test(accel) || !/(Command|Control|Alt|Shift)/.test(accel)) {
    return { ok: false, reason: "Use a modifier (⌘/Ctrl/Alt/Shift) + a key.", ...cur };
  }
  if (accel === other) {
    return { ok: false, reason: "That shortcut is already Capi's other one (capture vs. voice only).", ...cur };
  }
  // testa registrar com handler vazio; se falhar, é inválido/ocupado
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(accel, () => {}); } catch { ok = false; }
  globalShortcut.unregisterAll();
  if (!ok) {
    registerShortcut(); // restaura os atuais
    return { ok: false, reason: "Invalid combination or already used by another app.", ...cur };
  }
  if (which === "voice") config.voiceShortcut = accel; else config.shortcut = accel;
  saveConfig(config);
  registerShortcut();
  flog("setShortcut: " + which + " -> " + accel);
  return { ok: true, shortcut: config.shortcut, voiceShortcut: config.voiceShortcut };
});

// projetos de um app pra config (TODOS, com flag archived/here)
ipcMain.handle("win:listProjects", (_e, bundleId) => {
  const app = (config.apps || []).find((a) => a.bundleId === bundleId);
  if (!app || (app.type || "ai") === "messenger") return [];
  return appProjects(app);
});

// arquivar / desarquivar projeto (esconde do picker; continua na config)
ipcMain.on("win:archiveProject", (_e, key) => {
  if (!key) return;
  config.archivedProjects = config.archivedProjects || [];
  if (!config.archivedProjects.includes(key)) config.archivedProjects.push(key);
  saveConfig(config);
  sendWinState();
});
ipcMain.on("win:unarchiveProject", (_e, key) => {
  config.archivedProjects = (config.archivedProjects || []).filter((k) => k !== key);
  saveConfig(config);
  sendWinState();
});

// abrir frente (nova janela + Claude Code + briefing)
ipcMain.handle("win:launchFrente", (_e, id) => launchFrente(id));
ipcMain.on("overlay:launchFrente", (_e, id) => { closeOverlay(); launchFrente(id); });

// criar as frentes da Capi de uma vez
ipcMain.handle("win:seedCapiFrentes", () => seedCapiFrentes());

// fixar / desafixar agente (atalho no topo do picker)
ipcMain.on("win:togglePinAgent", (_e, id) => {
  if (!id) return;
  config.pinnedAgents = config.pinnedAgents || [];
  const i = config.pinnedAgents.indexOf(id);
  if (i >= 0) config.pinnedAgents.splice(i, 1);
  else config.pinnedAgents.push(id);
  saveConfig(config);
  sendWinState();
});

// criar projeto manual
ipcMain.on("win:saveProject", (_e, proj) => {
  if (!proj || !proj.appBundleId || !proj.name) return;
  config.projects = config.projects || [];
  const key = proj.key || proj.id;
  const i = config.projects.findIndex((p) => (p.key || p.id) === key);
  const rec = { id: proj.id, key, name: proj.name, appBundleId: proj.appBundleId, windowMatch: proj.windowMatch || proj.name, cwd: proj.cwd || "" };
  if (i >= 0) config.projects[i] = rec;
  else config.projects.push(rec);
  saveConfig(config);
  sendWinState();
});

ipcMain.on("win:saveAgent", (_e, agent) => {
  if (!agent || !agent.id) return;
  config.agents = config.agents || [];
  const i = config.agents.findIndex((a) => a.id === agent.id);
  if (i >= 0) config.agents[i] = agent;
  else config.agents.push(agent);
  saveConfig(config);
  sendWinState();
});

ipcMain.on("win:removeAgent", (_e, id) => {
  config.agents = (config.agents || []).filter((a) => a.id !== id);
  if (config.agentDefault === id) config.agentDefault = "__last__";
  saveConfig(config);
  sendWinState();
});

ipcMain.on("win:setAgentDefault", (_e, id) => {
  config.agentDefault = id || "__last__";
  config.captureDefault = config.agentDefault;
  saveConfig(config);
  sendWinState();
});

// ---------- Apps (nível 1) ----------
ipcMain.on("win:saveApp", (_e, app) => {
  if (!app || !app.bundleId) return;
  config.apps = config.apps || [];
  const i = config.apps.findIndex((a) => a.bundleId === app.bundleId);
  if (i >= 0) config.apps[i] = { ...config.apps[i], ...app };
  else config.apps.push(app);
  saveConfig(config);
  sendWinState();
});
ipcMain.on("win:removeApp", (_e, bundleId) => {
  config.apps = (config.apps || []).filter((a) => a.bundleId !== bundleId);
  config.agents = (config.agents || []).filter(
    (a) => !(a.app && a.app.bundleId === bundleId)
  );
  config.contacts = (config.contacts || []).filter((c) => c.appBundleId !== bundleId);
  saveConfig(config);
  sendWinState();
});

// ---------- Contatos (mensageiros) ----------
ipcMain.on("win:saveContact", (_e, contact) => {
  if (!contact || !contact.id) return;
  config.contacts = config.contacts || [];
  const i = config.contacts.findIndex((c) => c.id === contact.id);
  if (i >= 0) config.contacts[i] = contact;
  else config.contacts.push(contact);
  saveConfig(config);
  sendWinState();
});
ipcMain.on("win:removeContact", (_e, id) => {
  config.contacts = (config.contacts || []).filter((c) => c.id !== id);
  saveConfig(config);
  sendWinState();
});

// ---------- IPC vindo do overlay ----------
ipcMain.on("perm:result", (_e, r) => {
  flog(
    "getUserMedia -> " +
      r +
      " | status agora: " +
      (process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "n/a")
  );
  refreshTrayMenu();
});

// Account panel abre o dashboard NO NAVEGADOR (não no pop-up nativo do Capi).
ipcMain.on("win:openPanel", () => shell.openExternal(`${WEB_URL}/dashboard`));

ipcMain.on("overlay:cancel", () => closeOverlay());

// diagnóstico do microfone (vindo do overlay) — registra o erro + o status do SO
// no capi-status.log. Essencial pra debugar o caso "não grava no Windows".
ipcMain.on("overlay:micError", (_e, name) => {
  let osStatus = "n/a";
  try {
    if (process.platform === "win32" || process.platform === "darwin")
      osStatus = systemPreferences.getMediaAccessStatus("microphone");
  } catch (err) { osStatus = "erro:" + (err.message || err); }
  flog("MIC FAIL (" + process.platform + "): getUserMedia -> " + (name || "?") +
    " | OS mic status: " + osStatus);
});

// toggle "ir pra tela" vs "mandar e ficar aqui" (persiste)
ipcMain.on("overlay:setFocusMode", (_e, mode) => {
  config.focusMode = mode === "stay" ? "stay" : "switch";
  saveConfig(config);
  sendWinState();
});

// toggle "gravar áudio ao selecionar" (persiste)
ipcMain.on("overlay:setAutoRecord", (_e, on) => {
  config.autoRecord = !!on;
  saveConfig(config);
  sendWinState();
});

// "Criar agente/projeto" no picker: fecha o overlay e abre a config no contexto certo
// arg pode ser string (bundleId) OU objeto { bundleId, projectKey, projectName, cwd, windowMatch }
ipcMain.on("overlay:openAgentEditor", (_e, arg) => {
  const info = typeof arg === "string" ? { bundleId: arg } : (arg || {});
  closeOverlay();
  openMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => mainWindow.webContents.send("win:focusApp", info);
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
});

ipcMain.handle("overlay:commit", async (_evt, payload) => {
  // payload: { imageDataURL, note, targetId, targetBundle, windowMatch, focusMode }
  const {
    imageDataURL,
    note,
    targetBundle,
    windowMatch,
    focusMode: fm,
    newProject,
    web,
    urlMatch,
  } = payload || {};
  const focusMode = fm === "stay" ? "stay" : "switch";
  // modo "só voz": sem imagem -> manda só o texto transcrito
  const textOnly = !imageDataURL;

  // ===== GATE: login + trial 20 usos =====
  // Roda ANTES de qualquer clipboard/paste/closeOverlay, pra que o overlay continue
  // aberto e mostre login/paywall quando precisar. Só conta 1 uso por commit válido.
  let gateRemaining = null;
  {
    const s = getSession();
    if (!s) {
      flog("commit bloqueado: sem sessão → needLogin");
      openLoginWindow();
      return { ok: false, needLogin: true };
    }
    const usage = await checkUsage(false);
    if (usage.status === "needLogin") {
      openLoginWindow();
      return { ok: false, needLogin: true };
    }
    if (usage.status === "denied") {
      flog("commit bloqueado: paywall (20 usos esgotados)");
      return {
        ok: false,
        paywall: true,
        remaining: 0,
        payUrl: buildPayUrl(),
      };
    }
    // allowed (inclui fail-open por erro de rede/servidor) → segue o envio.
    gateRemaining = usage.remaining;
  }
  // ===== fim do GATE =====

  try {
    const img = textOnly ? null : nativeImage.createFromDataURL(imageDataURL);

    if (textOnly) {
      flog("commit (só voz): nota=" + JSON.stringify((note || "").slice(0, 60)));
    } else {
      // DEBUG: salva a última imagem montada pra inspeção (os.tmpdir p/ Windows)
      try {
        fs.writeFileSync(path.join(os.tmpdir(), "capi-last.png"), img.toPNG());
        flog("commit: imagem salva, nota=" + JSON.stringify((note || "").slice(0, 60)));
      } catch {}
      // clipboard SÓ com a imagem: com imagem+texto juntos, o editor do Claude Code
      // cola o texto e ignora a foto. O texto da nota é DIGITADO (typeNote), não colado.
      clipboard.write({ image: img });
    }

    // opcionalmente salva em disco (histórico / sync futuro)
    let savedPath = null;
    if (!textOnly && (config.saveHistory || !config.autoDelete)) {
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      savedPath = path.join(CAPTURES_DIR, `capi-${stamp}.png`);
      fs.writeFileSync(savedPath, img.toPNG());
      if (config.autoDelete && config.autoDeleteAfterMs > 0) {
        const p = savedPath;
        setTimeout(() => {
          fs.promises.unlink(p).catch(() => {});
        }, config.autoDeleteAfterMs);
      }
    }

    closeOverlay();

    // auto-colar no app de destino. NÃO checamos isTrustedAccessibilityClient
    // (é instável no Electron e abria a tela de Ajustes à toa); tentamos direto.
    let pasted = false;
    let tabMissed = false;
    let wantedChat = null;
    let wasWeb = false;
    let webNotFound = false;
    let webManual = false;
    let appNotRunning = false;
    // "Criar projeto"/nova conversa no Claude Desktop = ⌘N + cola + envia (fluxo próprio).
    if (newProject && targetBundle === CLAUDE_DESKTOP && process.platform === "darwin") {
      await new Promise((r) => setTimeout(r, 320));
      const res = await runPaste({
        bundleId: CLAUDE_DESKTOP,
        note,
        submit: config.autoSubmit !== false,
        textOnly,
        newProject: true,
      });
      pasted = res.ok;
      flog("newProject (Claude Desktop): ⌘N + colado=" + pasted);
      if (Notification.isSupported()) {
        new Notification({ title: "Capi · new conversation!", body: "Opened a new conversation in Claude Desktop with your context.", silent: !config.playSound }).show();
      }
      return { ok: true, savedPath: null, pasted, newProject: true, remaining: gateRemaining };
    }

    // "Criar projeto": cria projeto+Orquestrador, abre ABA NOVA do Claude Code e
    // cola o briefing (a imagem já está no clipboard). Depois linka ao chat real.
    if (newProject && process.platform === "darwin") {
      const bundle = targetBundle && targetBundle !== "__last__" ? targetBundle : "com.microsoft.VSCode";
      const projName = makeProjectName(note);
      const projKey = createCapiProjectWithOrchestrator(projName);
      flog("newProject: criado '" + projName + "' (" + projKey + ")");
      await new Promise((r) => setTimeout(r, 320));
      pasted = await runNewProjectPaste({
        bundleId: bundle, note, textOnly, submit: config.autoSubmit !== false,
      });
      // depois que o Claude nomeia a aba, linka o projeto/Orquestrador ao chat real
      setTimeout(async () => {
        const title = await getAppMainWindowTitle(bundle);
        if (title) { linkProjectToActiveChat(projKey, title); refreshOpenTabs(); }
      }, 6000);
      if (Notification.isSupported()) {
        new Notification({ title: "Capi · project created!", body: `Opened a new tab: "${projName}" with your briefing.`, silent: !config.playSound }).show();
      }
      return { ok: true, savedPath: null, pasted, newProject: true, remaining: gateRemaining };
    }

    if (config.autoPaste && process.platform === "darwin") {
      const isLast = !targetBundle || targetBundle === "__last__";
      // app ESCOLHIDO -> ativa; "último app" -> NÃO ativa, deixa o foco voltar
      // sozinho pro campo de texto onde a pessoa estava.
      const bundle = isLast ? null : targetBundle;
      // modo "ficar aqui": devolve o foco pro app de origem depois de enviar.
      // (no destino "último app" não faz sentido — já estamos voltando pra lá.)
      const returnTo =
        focusMode === "stay" && !isLast && frontmostApp
          ? frontmostApp.bundleId
          : null;
      // NOTA: auto-tirar-do-fullscreen NÃO é possível — um app em tela cheia em
      // outro Space expõe 0 janelas à automação até ser ativado (= a própria troca
      // que queremos evitar). "Ficar" suave só com o VS Code em JANELA no mesmo Space.
      await new Promise((r) => setTimeout(r, 320)); // foco volta pro app anterior
      const isWeb = web || String(bundle || "").indexOf("web.") === 0;
      const res = await runPaste({
        bundleId: bundle,
        windowMatch: isLast ? null : windowMatch,
        note,
        submit: config.autoSubmit !== false,
        returnTo,
        textOnly,
        web: isWeb,
        urlMatch: urlMatch || WEB_URLMATCH_BY_BUNDLE[bundle],
      });
      pasted = res.ok;
      tabMissed = res.tabMissed;
      wantedChat = res.wanted;
      wasWeb = isWeb;
      webNotFound = !!res.notFound;
      webManual = !!res.webManual;
      appNotRunning = !!res.appNotRunning;
      flog(
        "autoPaste: isLast=" +
          isLast +
          " target=" +
          (bundle || (frontmostApp && frontmostApp.bundleId)) +
          " win=" +
          (windowMatch || "-") +
          " focus=" +
          focusMode +
          " pasted=" +
          pasted +
          " tabMissed=" +
          tabMissed
      );
      // memoriza pra onde acabamos de mandar — o botão "Responder" da notificação
      // leva de volta a esse destino (aba do browser ou app nativo).
      if (pasted) {
        const effUrl = urlMatch || WEB_URLMATCH_BY_BUNDLE[bundle] || null;
        const dest = flattenDestinations().find(
          (d) => (bundle && d.bundleId === bundle) || (effUrl && d.urlMatch === effUrl)
        );
        lastSentTarget = {
          from: (dest && dest.name) || (bundle || "o agente"),
          avatar: dest && dest.avatar,
          bundleId: isWeb ? null : bundle,
          urlMatch: isWeb ? effUrl : null,
          web: isWeb,
        };
        // liga a vigia de resposta (não pra mensageiros — lá "resposta" é a pessoa).
        if (!MESSENGER_BUNDLES.has(bundle)) {
          const kw = replyKeywords(lastSentTarget.from, effUrl);
          (async () => {
            let title = null;
            try {
              if (isWeb) title = await frontTabTitle(res.browser);
              else if (bundle) title = await frontAppWindowTitle(bundle);
            } catch {}
            watchForReply({
              title,
              keywords: kw,
              from: lastSentTarget.from,
              avatar: lastSentTarget.avatar,
              target: lastSentTarget,
            });
          })();
        }
      }
    } else if (config.autoPaste && process.platform === "win32") {
      const isLast = !targetBundle || targetBundle === "__last__";
      const res = await runPasteWindows({
        bundleId: isLast ? null : targetBundle,
        note,
        submit: config.autoSubmit !== false,
        textOnly,
      });
      pasted = res.ok;
    }

    // envio falhou de fato (aba web não abriu OU mensageiro fechado) E o gate
    // CONTOU este uso (gateRemaining numérico = não é paid nem fail-open) → estorna.
    if (((wasWeb && webNotFound) || appNotRunning) && typeof gateRemaining === "number") {
      await refundUsage();
    }

    if (Notification.isSupported()) {
      // avisa quando a aba pedida não estava aberta (colou na aba ativa)
      const missTitle = tabMissed ? cleanTabQuery(wantedChat) : "";
      let title, body;
      if (appNotRunning) {
        // mensageiro fechado — nada foi colado (evitamos cair no app errado)
        title = "Capi · open the app first";
        body = "That app isn't open. Open it (with the conversation you want), then send again — your free use wasn't spent.";
      } else if (wasWeb && webNotFound) {
        // tentamos abrir o agente no navegador e a aba não subiu a tempo
        title = "Capi · couldn't reach the agent";
        body = "I tried to open it in your browser but it didn't load in time. Open the agent tab and try again.";
      } else if (wasWeb && webManual) {
        // voz-only no navegador: digitamos mas não enviamos (composer pode não ter foco)
        title = "Capi · text ready in your agent";
        body = "Voice text typed into the agent tab. Click the box and press Enter to send (no screenshot = I don't auto-send in the browser).";
      } else if (pasted && config.autoSubmit === false) {
        // autoSubmit desligado: colou mas NÃO enviou — não dizer "sent"
        title = "Capi · pasted — your turn";
        body = "Image + context are in the box. Press Enter to send.";
      } else if (wasWeb && pasted) {
        title = "Capi · sent to your agent!";
        body = "Pasted the image + context into the agent tab in your browser.";
      } else if (tabMissed) {
        title = "Capi · pasted into the active tab";
        body = `The chat "${missTitle}" wasn't open. Open it as a tab so I can aim right.`;
      } else if (pasted) {
        title = "Capi · pasted into the chat!";
        body = "Sent straight to the app that was open.";
      } else {
        title = "Capi · copied!";
        body = config.autoPaste
          ? "Copied. Enable Capi in Accessibility so it can paste on its own."
          : "Image + context on the clipboard, ready to paste.";
      }
      new Notification({ title, body, silent: !config.playSound }).show();
    }
    return { ok: true, savedPath, pasted, remaining: gateRemaining };
  } catch (e) {
    console.error("Erro ao commitar captura:", e);
    closeOverlay();
    return { ok: false, error: String(e) };
  }
});

// ---------- Transcrição de áudio (Gemini preferido, OpenAI fallback) ----------
function readEnvLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "..", ".env.local"),
      "utf8"
    );
    const m = raw.match(new RegExp("^\\s*" + name + "\\s*=\\s*(.+)$", "m"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  return null;
}

// segredo que autentica o app no endpoint /api/transcribe do site.
// (lê de env/.env.local no dev; no app empacotado usa o embutido — guarda leve anti-abuso)
const TRANSCRIBE_SECRET =
  process.env.CAPI_TRANSCRIBE_SECRET ||
  readEnvLocal("CAPI_TRANSCRIBE_SECRET") ||
  "capitx_3e30c58befa81163ca7cfa497bfb31c41d467b66";

// Transcrição via BACKEND (a chave do Whisper fica no servidor). Funciona no app
// empacotado também, pois não depende de chave local.
async function transcribeViaBackend(base64, mime) {
  try {
    const r = await fetch(`${WEB_URL}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-capi-key": TRANSCRIBE_SECRET },
      body: JSON.stringify({ base64, mime }),
    });
    if (!r.ok) {
      flog("transcribe backend HTTP " + r.status);
      return { ok: false, error: `Transcription failed (${r.status})` };
    }
    const j = await r.json().catch(() => null);
    if (j && j.ok) return { ok: true, text: (j.text || "").trim() };
    return { ok: false, error: (j && j.error) || "Transcription failed" };
  } catch (e) {
    flog("transcribe backend erro: " + (e.message || e));
    return { ok: false, error: "No connection to the transcription server" };
  }
}

async function transcribeGemini(base64, mime, key) {
  const model = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              "Transcribe this audio in its original spoken language. " +
              "Reply with ONLY the spoken text, no comments, no quotes.",
          },
          { inline_data: { mime_type: mime || "audio/wav", data: base64 } },
        ],
      },
    ],
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    flog("gemini HTTP " + r.status + " " + t.slice(0, 200));
    return { ok: false, error: "Transcription failed (" + r.status + ")" };
  }
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join(" ")
    .trim();
  return { ok: true, text };
}

async function transcribeOpenAI(base64, mime, key) {
  const buf = Buffer.from(base64, "base64");
  const form = new FormData();
  const ext = (mime || "audio/wav").includes("wav") ? "wav" : "webm";
  form.append("file", new Blob([buf], { type: mime || "audio/wav" }), "audio." + ext);
  form.append("model", "whisper-1");
  // no fixed language → Whisper auto-detects (app is international)
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    flog("openai HTTP " + r.status + " " + t.slice(0, 200));
    return { ok: false, error: "Transcription failed (" + r.status + ")" };
  }
  const j = await r.json();
  return { ok: true, text: (j.text || "").trim() };
}

ipcMain.handle("overlay:transcribe", async (_e, { base64, mime }) => {
  try {
    // 1) backend primeiro (chave no servidor — funciona no app empacotado e no dev)
    const viaBackend = await transcribeViaBackend(base64, mime);
    if (viaBackend.ok && viaBackend.text) return viaBackend;
    // 2) fallback: chave local (só existe no dev) caso o backend esteja fora do ar
    const gem = readEnvLocal("GEMINI_API_KEY");
    if (gem) return await transcribeGemini(base64, mime, gem);
    const oa = readEnvLocal("OPENAI_API_KEY");
    if (oa) return await transcribeOpenAI(base64, mime, oa);
    // 3) sem fallback local -> devolve o erro do backend
    return viaBackend.ok ? { ok: false, error: "Empty transcription" } : viaBackend;
  } catch (e) {
    flog("transcribe erro: " + (e.message || e));
    return { ok: false, error: "Transcription error" };
  }
});

// ---------- Atalho global ----------
function registerShortcut() {
  globalShortcut.unregisterAll();
  // globalShortcut.register pode LANÇAR (acelerador inválido) além de devolver
  // false (já registrado por outro app) — protege com try pra não derrubar o boot.
  let ok = false;
  try { ok = globalShortcut.register(config.shortcut, startCapture); }
  catch (e) { flog("register erro (" + config.shortcut + "): " + (e.message || e)); }
  if (!ok) {
    console.warn("Não consegui registrar o atalho:", config.shortcut);
    // feedback ao usuário: o atalho principal falhou (comum no Windows quando
    // outro app já usa Ctrl+Shift+2). Sem isso, a Capi parecia "morta".
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: "Capi · shortcut unavailable",
          body: `Couldn't register ${config.shortcut} (another app may be using it). Open Capi and set a different shortcut, or use the tray icon.`,
          silent: true,
        }).show();
      }
    } catch (_) {}
  }
  // ⌘+Shift+1 — "só falar" (voz sem print)
  const vs = config.voiceShortcut;
  let okV = false;
  if (vs) {
    try { okV = globalShortcut.register(vs, startVoiceOnly); }
    catch (e) { flog("register voz erro (" + vs + "): " + (e.message || e)); }
    if (!okV) console.warn("Não consegui registrar o atalho de voz:", vs);
    flog("atalhos: print=" + config.shortcut + " (" + ok + ") voz=" + vs + " (" + okV + ")");
  }
  return ok;
}

// ---------- Tray ----------
function buildTray() {
  let trayImg;
  if (process.platform === "darwin") {
    // macOS: contorno vazado como "template image" — o SO pinta de branco no menu
    // escuro e preto no claro. (@2x carrega sozinho no Retina)
    const iconPath = path.join(__dirname, "..", "..", "assets", "capiTemplate.png");
    trayImg = nativeImage.createFromPath(iconPath);
    if (!trayImg.isEmpty()) trayImg.setTemplateImage(true);
  } else {
    // Windows/Linux: NÃO usar template image (renderiza silhueta preta invisível
    // na barra de tarefas). Usa o ícone colorido do app. .ico é o ideal na tray
    // do Windows; caímos pro .png se não existir.
    const ico = path.join(__dirname, "..", "..", "assets", "capi-app-icon.ico");
    const png = path.join(__dirname, "..", "..", "assets", "capi-app-icon.png");
    let src = null;
    try { if (fs.existsSync(ico)) src = ico; } catch (_) {}
    if (!src) { try { if (fs.existsSync(png)) src = png; } catch (_) {} }
    trayImg = src ? nativeImage.createFromPath(src) : nativeImage.createEmpty();
    // a tray do Windows espera ~16x16; redimensiona se o PNG for grande
    if (!trayImg.isEmpty()) {
      try { trayImg = trayImg.resize({ width: 16, height: 16 }); } catch (_) {}
    }
  }
  tray = new Tray(trayImg.isEmpty() ? nativeImage.createEmpty() : trayImg);
  tray.setToolTip("Capi — capture to your agent");
  // Windows: clique esquerdo no ícone da bandeja normalmente abre o app (no Mac o
  // clique já abre o menu de contexto, então só ligamos isso fora do Mac).
  if (process.platform !== "darwin") {
    tray.on("click", () => openMainWindow());
  }
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Capi",
      click: () => openMainWindow(),
    },
    {
      label: `Capture now (${config.shortcut})`,
      click: () => startCapture(),
    },
    {
      label: "Account panel…",
      click: () => shell.openExternal(`${WEB_URL}/dashboard`),
    },
    {
      label: "Set up destination…",
      click: () => openOnboardingWindow(),
    },
    (() => {
      const s = getSession();
      return s
        ? {
            label: `Sign out (${s.email || "account"})`,
            click: () => {
              clearSession();
              if (Notification.isSupported())
                new Notification({ title: "Capi", body: "You've been signed out.", silent: true }).show();
            },
          }
        : { label: "Sign in…", click: () => openLoginWindow() };
    })(),
    { type: "separator" },
    {
      label: "Delete image after copying",
      type: "checkbox",
      checked: config.autoDelete,
      click: (item) => {
        config.autoDelete = item.checked;
        saveConfig(config);
      },
    },
    {
      label: "Paste straight into the chat (auto-paste)",
      type: "checkbox",
      checked: config.autoPaste,
      click: (item) => {
        config.autoPaste = item.checked;
        saveConfig(config);
        // isTrustedAccessibilityClient é macOS-only e LANÇA no Windows — guarda por
        // plataforma pra não derrubar o clique do menu da bandeja no Windows.
        if (
          process.platform === "darwin" &&
          item.checked &&
          !systemPreferences.isTrustedAccessibilityClient(false)
        ) {
          systemPreferences.isTrustedAccessibilityClient(true);
        }
      },
    },
    {
      label: "Sound on copy",
      type: "checkbox",
      checked: config.playSound,
      click: (item) => {
        config.playSound = item.checked;
        saveConfig(config);
      },
    },
    { type: "separator" },
    {
      label: hasScreenPermission()
        ? "Screen permission OK"
        : "Grant screen permission…",
      enabled: !hasScreenPermission(),
      click: () => promptScreenPermission(),
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
  tray.setContextMenu(menu);
}

// ---------- Ciclo de vida ----------
function setDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    const p = path.join(__dirname, "..", "..", "assets", "capi-mascote.png");
    const di = nativeImage.createFromPath(p);
    const sz = di.getSize();
    flog(`setDockIcon: empty=${di.isEmpty()} size=${sz.width}x${sz.height} path=${p}`);
    if (!di.isEmpty()) {
      app.dock.setIcon(di);
      // re-tenta após o dock estabilizar (Electron às vezes reverte pós-show)
      setTimeout(() => { try { app.dock.setIcon(di); } catch {} }, 600);
    }
  } catch (e) {
    flog("setDockIcon erro: " + (e.message || e));
  }
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide(); // app de menu bar
    setDockIcon();
  }

  // libera mídia/áudio (captura de tela, microfone, reconhecimento de fala)
  const allowPerms = new Set(["media", "audioCapture", "microphone", "speech"]);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(allowPerms.has(perm));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) =>
    allowPerms.has(perm)
  );
  // CRÍTICO (Windows): sem este handler, o Chromium do Electron NEGA por padrão
  // o acesso ao DISPOSITIVO de mídia (câmera/microfone), mesmo com o request handler
  // acima liberado — foi o que impediu a gravação do microfone no Windows. Aqui
  // liberamos os devices de áudio (o getUserMedia do overlay só pede `audio`).
  try {
    session.defaultSession.setDevicePermissionHandler((details) => {
      // details.deviceType: 'hid' | 'serial' | 'usb'... e p/ mídia vem via
      // permission 'media' — liberamos áudio/entrada por padrão pro fluxo da Capi.
      return true;
    });
  } catch (_) {}
  // No Windows, mostrar o prompt/registro de privacidade do microfone cedo evita
  // o erro silencioso de "sem permissão" na 1ª gravação. askForMediaAccess é
  // macOS-only, então guardamos por plataforma (no Mac o onboarding já cuida disso).
  if (process.platform === "win32") {
    try {
      const st = systemPreferences.getMediaAccessStatus("microphone");
      flog("BOOT win mic status: " + st);
    } catch (e) {
      flog("BOOT win mic status erro: " + (e.message || e));
    }
  }

  buildTray();
  registerShortcut();
  refreshClaudeProjects(); // popula o cache de projetos no boot
  refreshOpenTabs();
  refreshRunningApps(); // popula a lista de apps abertos (destino universal)

  flog(
    "BOOT pid=" +
      process.pid +
      " screen: " +
      (process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "n/a") +
      " | AX: " +
      (process.platform === "darwin"
        ? systemPreferences.isTrustedAccessibilityClient(false)
        : "n/a")
  );

  // Fluxo de abertura guiado (NÃO pedir permissão no boot — só depois do login):
  //  - sem sessão  -> tela de LOGIN primeiro (não dá pra usar sem conta)
  //  - logado + 1ª vez -> ONBOARDING (permissões guiadas + escolher destino)
  //  - logado + já configurado -> app normal
  if (!getSession()) {
    openLoginWindow();
  } else if (!config.onboarded) {
    openOnboardingWindow();
  } else {
    openMainWindow();
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", (e) => {
  // não sair: é app de bandeja
});

// expõe pra futuros painéis de config
module.exports = { loadConfig, saveConfig };
