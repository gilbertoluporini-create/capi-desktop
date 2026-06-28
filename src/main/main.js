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
  { id: "vscode", name: "VS Code", bundleId: "com.microsoft.VSCode", type: "ai", avatar: "code", color: "#7c5cff" },
  { id: "claude", name: "Claude", bundleId: "com.anthropic.claudefordesktop", type: "ai", avatar: "sparkles", color: "#5b3fd6" },
  { id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92", type: "ai", avatar: "terminal", color: "#22c55e" },
];

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

// achata apps+agentes numa lista de destinos pro overlay (captura — passo 1)
function flattenDestinations() {
  const out = [];
  (config.apps || []).forEach((app) => {
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
        out.push({ id: app.id, name: app.name, subject: "conversa atual", avatar: app.avatar || "message", color: app.color, bundleId: app.bundleId, windowMatch: null });
    } else if (mine.length) {
      mine.forEach((a) =>
        out.push({
          id: a.id, name: a.name, subject: a.subject || app.name,
          avatar: a.avatar || app.avatar, color: a.color || app.color,
          bundleId: app.bundleId,
          windowMatch: a.kind === "project" || a.target === "window" ? a.windowMatch : null,
        })
      );
    } else {
      out.push({ id: app.id, name: app.name, subject: "conversa atual", avatar: app.avatar, color: app.color, bundleId: app.bundleId, windowMatch: null });
    }
  });
  return out;
}

// contatos de um app mensageiro (WhatsApp): nível 2 = contatos diretos
function appContacts(app) {
  return (config.contacts || [])
    .filter((c) => c.appBundleId === app.bundleId)
    .map((c) => ({
      id: c.id, name: c.name, sub: c.hint || "contato",
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
      const conv = `${p.sessions} conversa${p.sessions > 1 ? "s" : ""}`;
      map.set(p.cwd, {
        id: "cwd:" + p.cwd, key: p.cwd,
        name: p.title || p.name,
        sub: p.title ? `${p.name} · ${conv}` : conv,
        // alvo de roteamento = TÍTULO do chat (aiTitle) p/ o `edt` achar a aba;
        // pasta (basename) só de fallback se não houver título
        windowMatch: p.title || p.windowMatch, cwd: p.cwd, auto: true, agents: [],
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
            ? { id: "geral:" + app.bundleId, key, name: "Geral", sub: "sem projeto", windowMatch: null, cwd: "", agents: [] }
            : { id: "k:" + key, key, name: (a.project && a.project.name) || a.windowMatch || "Projeto", sub: "", windowMatch: a.windowMatch || null, cwd: a.cwd || "", agents: [] };
        map.set(key, proj);
      }
      proj.agents.push({
        id: a.id, name: a.name, sub: a.subject || "agente",
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
    if (!hereKey) hereKey = currentClaudeCwd();
  }
  const archived = new Set(config.archivedProjects || []);
  arr.forEach((p) => {
    if (!p.sub) p.sub = p.agents.length ? `${p.agents.length} agente${p.agents.length > 1 ? "s" : ""}` : "conversa atual";
    p.archived = archived.has(p.key);
    p.here = !!hereKey && p.key === hereKey;
    if (p.here) p.sub = "você está aqui · " + p.sub;
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
function buildDestinationTree() {
  return (config.apps || []).map((app) => {
    const type = app.type || "ai";
    const base = {
      id: app.id, name: app.name, avatar: app.avatar, color: app.color,
      bundleId: app.bundleId, type,
      searchEnabled: app.searchEnabled !== false,
    };
    if (type === "messenger") return { ...base, contacts: appContacts(app) };
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
  const byCwd = new Map(); // cwd -> { sessions, mtime }
  for (const file of files) {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    const { cwds, title } = scanSession(file);
    for (const cwd of cwds) {
      if (cwd.startsWith("/private/tmp") || cwd.startsWith("/tmp")) continue; // worktrees
      const cur = byCwd.get(cwd) || { sessions: 0, mtime: 0, title: null };
      cur.sessions += 1;
      if (m > cur.mtime) { cur.mtime = m; if (title) cur.title = title; } // título do chat mais recente
      byCwd.set(cwd, cur);
    }
  }
  return [...byCwd.entries()]
    .map(([cwd, v]) => ({
      cwd,
      name: path.basename(cwd),
      title: v.title || null, // nome do chat (aiTitle) mais recente nesse projeto
      windowMatch: path.basename(cwd),
      sessions: v.sessions,
      mtime: v.mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
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
const FLOG = "/tmp/capi-status.log";
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
    title: "Capi precisa de permissão",
    body: "Ative a Gravação de Tela pra Capi nas Configurações do Sistema e reabra o app.",
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
  // cola a imagem (se houver) e ESPERA ela anexar (~700ms > 400ms genéricos)
  if (!textOnly) {
    await sh("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    await new Promise((r) => setTimeout(r, 700));
  }
  const text = (note || "").replace(/\s*\n\s*/g, " ").trim();
  if (text) {
    await typeNote(text);
    await new Promise((r) => setTimeout(r, 150));
  }
  // Enter ENVIA no Claude Desktop (Shift+Enter quebraria linha)
  if (submit) {
    await new Promise((r) => setTimeout(r, 250));
    await pressEnter();
  }
  return true;
}

// auto-colar completo: foca destino (janela certa) + imagem + texto + enviar
// opts: { bundleId, windowMatch, note, submit, returnTo }
async function runPaste(opts) {
  const { bundleId, windowMatch, note, submit, returnTo, textOnly, newProject } = opts || {};
  // Claude Desktop (app nativo) tem fluxo próprio — não passa pelo caminho genérico
  if (bundleId === CLAUDE_DESKTOP) {
    const ok = await pasteToClaudeDesktop({ note, submit, textOnly, newProject });
    if (returnTo && returnTo !== bundleId) {
      await new Promise((r) => setTimeout(r, 200));
      await activateApp(returnTo);
    }
    return { ok, tabMissed: false, wanted: null };
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
  // com imagem, espera ela ANEXAR antes de digitar; sem imagem, atraso curto
  await new Promise((r) => setTimeout(r, textOnly ? 200 : (focusChat ? 750 : 400)));
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

// ---------- Abrir frente: nova janela do VS Code + Claude Code + prompt inicial ----------
const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, () => res()));

// ---------- "Criar projeto": abre ABA NOVA do Claude Code + cola o briefing ----------
// nome curto do projeto a partir do que a pessoa falou
function makeProjectName(note) {
  const t = (note || "").replace(/\s+/g, " ").trim();
  if (!t) return "Novo projeto";
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
    id: "orq-" + key, name: "Orquestrador", subject: "cara que sabe de tudo",
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
  if (!a) return { ok: false, error: "agente não encontrado" };
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
    { id: "capi-desktop", name: "Capi-Desktop", subject: "Código do app (Electron)", avatar: "capi:desktop", color: "#5b3fd6", folder: path.join(root, "desktop"), wm: "desktop", brief: "briefing-desktop.md" },
    { id: "capi-web", name: "Capi-Web", subject: "Site, auth e dashboard", avatar: "capi:web", color: "#06b6d4", folder: path.join(root, "web"), wm: "web", brief: "briefing-web.md" },
    { id: "capi-marca", name: "Capi-Marca", subject: "Marca e divulgação", avatar: "capi:marca", color: "#ef4444", folder: path.join(root, "assets"), wm: "assets", brief: "briefing-marca.md" },
    { id: "capi-qa", name: "Capi-QA", subject: "Testes e qualidade", avatar: "capi:qa", color: "#22c55e", folder: root, wm: "cap", brief: "" },
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
      initPrompt: readBrief(f.brief) || `Você é o ${f.name}, uma das frentes do projeto Capi. Leia ~/cap/CLAUDE.md, ~/cap/ESTADO.md e ~/cap/COORDINATION.md antes de tudo.`,
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
  (app.isPackaged ? "https://capi-sigma.vercel.app" : "http://localhost:3000");

// ---------- Conta / Login (trial 20 usos → paywall) ----------
// A anon key é PÚBLICA por design (RLS protege os dados) — pode ficar embutida.
const SUPABASE_URL = "https://xvwzkvligwpntzjmyqkm.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2d3prdmxpZ3dwbnR6am15cWttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MDM2OTYsImV4cCI6MjA5Nzk3OTY5Nn0.QCLc1V3X8AP_GpMWYJWVC4y_P0XXk0hwTFJAeY2utGc";
// Payment Link Stripe (Founding R$97). client_reference_id = user_id do Supabase.
const FOUNDING_LINK = "https://buy.stripe.com/28EdR36QO9E7b8Ge67dby00";

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
        `Falha no login (${r.status})`;
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
    return { ok: false, error: "Sem conexão. Tente de novo." };
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

// Monta o link de pagamento já com o user_id pra casar com o webhook do Stripe.
function buildPayUrl() {
  const s = getSession();
  const ref = s ? encodeURIComponent(s.user_id) : "";
  return `${FOUNDING_LINK}?client_reference_id=${ref}`;
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
    title: "Entrar na Capi",
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
  // 1ª vez (pós-login): abre o onboarding pra escolher o destino do contexto
  if (res.ok && !config.onboarded) {
    setTimeout(() => openOnboardingWindow(), 250);
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
  shell.openExternal(payUrl || buildPayUrl());
});

// ---------- Onboarding (1ª vez, pós-login) — escolher destino ----------
// checa se um app está instalado pelo bundle id (sem abrir nada)
function isAppInstalled(bundleId) {
  return new Promise((resolve) => {
    if (!bundleId) return resolve(false);
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
    title: "Configurar a Capi",
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
  return { installed, name: ONBOARD_APP_NAMES[bundleId] || "esse app" };
});

// renderer confirma: vira destino padrão + onboarded=true
ipcMain.handle("onboarding:setDefault", (_e, bundleId) => {
  setOnboardingDefault(bundleId);
  markOnboarded();
  return { ok: true, name: ONBOARD_APP_NAMES[bundleId] || "esse app" };
});

ipcMain.on("onboarding:open-external", (_e, url) => {
  if (url) shell.openExternal(url);
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
    encodeURIComponent(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;
font:16px/1.5 -apple-system,system-ui,sans-serif;background:#efeaff;color:#1E1B2E}
.box{max-width:420px;text-align:center;padding:32px}h1{font-size:20px;margin:.2em 0}
small{color:#6b6580}code{background:#fff;border:1px solid #d9d2f5;border-radius:6px;padding:2px 6px}
button{margin-top:18px;background:#7C5CFF;color:#fff;border:0;border-radius:10px;
padding:10px 18px;font-weight:700;cursor:pointer}</style></head><body><div class="box">
<h1>Painel indisponível</h1><p>Não consegui carregar <code>${url}</code>.</p>
<small>${reason || ""}</small><br/>
<button onclick="location.reload()">Tentar de novo</button></div></body></html>`)
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
    title: "Capi — Painel",
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
  systemPreferences.isTrustedAccessibilityClient(true);
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
  );
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
    items.length ? items : [{ label: "(nenhum app novo aberto)", enabled: false }]
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
    return { ok: false, reason: "Use um modificador (⌘/Ctrl/Alt/Shift) + uma tecla.", ...cur };
  }
  if (accel === other) {
    return { ok: false, reason: "Esse atalho já é o outro da Capi (captura vs. só falar).", ...cur };
  }
  // testa registrar com handler vazio; se falhar, é inválido/ocupado
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(accel, () => {}); } catch { ok = false; }
  globalShortcut.unregisterAll();
  if (!ok) {
    registerShortcut(); // restaura os atuais
    return { ok: false, reason: "Combinação inválida ou já usada por outro app.", ...cur };
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

ipcMain.on("win:openPanel", () => openPanelWindow());

ipcMain.on("overlay:cancel", () => closeOverlay());

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
      // DEBUG: salva a última imagem montada pra inspeção
      try {
        fs.writeFileSync("/tmp/capi-last.png", img.toPNG());
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
        new Notification({ title: "Capi · nova conversa!", body: "Abri uma conversa nova no Claude Desktop com seu contexto.", silent: !config.playSound }).show();
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
        new Notification({ title: "Capi · projeto criado!", body: `Abri uma aba nova: "${projName}" com seu briefing.`, silent: !config.playSound }).show();
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
      const res = await runPaste({
        bundleId: bundle,
        windowMatch: isLast ? null : windowMatch,
        note,
        submit: config.autoSubmit !== false,
        returnTo,
        textOnly,
      });
      pasted = res.ok;
      tabMissed = res.tabMissed;
      wantedChat = res.wanted;
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
    }

    if (Notification.isSupported()) {
      // avisa quando a aba pedida não estava aberta (colou na aba ativa)
      const missTitle = tabMissed ? cleanTabQuery(wantedChat) : "";
      new Notification({
        title: tabMissed
          ? "Capi · colou na aba ativa"
          : pasted
          ? "Capi · colado no chat!"
          : "Capi · copiado!",
        body: tabMissed
          ? `O chat "${missTitle}" não estava aberto. Abra ele como aba pra eu mirar certo.`
          : pasted
          ? "Mandei direto pro app que estava aberto."
          : config.autoPaste
          ? "Copiado. Ative a Capi em Acessibilidade pra colar sozinho."
          : "Imagem + contexto no clipboard, pronto pra colar.",
        silent: !config.playSound,
      }).show();
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
      return { ok: false, error: `Transcrição falhou (${r.status})` };
    }
    const j = await r.json().catch(() => null);
    if (j && j.ok) return { ok: true, text: (j.text || "").trim() };
    return { ok: false, error: (j && j.error) || "Transcrição falhou" };
  } catch (e) {
    flog("transcribe backend erro: " + (e.message || e));
    return { ok: false, error: "Sem conexão com o servidor de transcrição" };
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
              "Transcreva este áudio em português do Brasil. " +
              "Responda APENAS com o texto falado, sem comentários, sem aspas.",
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
    return { ok: false, error: "Transcrição falhou (" + r.status + ")" };
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
  form.append("language", "pt");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    flog("openai HTTP " + r.status + " " + t.slice(0, 200));
    return { ok: false, error: "Transcrição falhou (" + r.status + ")" };
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
    return viaBackend.ok ? { ok: false, error: "Transcrição vazia" } : viaBackend;
  } catch (e) {
    flog("transcribe erro: " + (e.message || e));
    return { ok: false, error: "Erro na transcrição" };
  }
});

// ---------- Atalho global ----------
function registerShortcut() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(config.shortcut, startCapture);
  if (!ok) {
    console.warn("Não consegui registrar o atalho:", config.shortcut);
  }
  // ⌘+Shift+1 — "só falar" (voz sem print)
  const vs = config.voiceShortcut;
  if (vs) {
    const okV = globalShortcut.register(vs, startVoiceOnly);
    if (!okV) console.warn("Não consegui registrar o atalho de voz:", vs);
    flog("atalhos: print=" + config.shortcut + " (" + ok + ") voz=" + vs + " (" + okV + ")");
  }
  return ok;
}

// ---------- Tray ----------
function buildTray() {
  // contorno vazado da Capi como "template image": o macOS pinta de branco no
  // menu escuro e preto no claro, automaticamente. (@2x carrega sozinho no Retina)
  const iconPath = path.join(__dirname, "..", "..", "assets", "capiTemplate.png");
  const trayImg = nativeImage.createFromPath(iconPath);
  if (!trayImg.isEmpty()) trayImg.setTemplateImage(true);
  tray = new Tray(trayImg.isEmpty() ? nativeImage.createEmpty() : trayImg);
  tray.setToolTip("Capi — captura pro seu agente");
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: "Abrir Capi",
      click: () => openMainWindow(),
    },
    {
      label: `Capturar agora (${config.shortcut})`,
      click: () => startCapture(),
    },
    {
      label: "Painel da conta…",
      click: () => openPanelWindow(),
    },
    {
      label: "Configurar destino…",
      click: () => openOnboardingWindow(),
    },
    (() => {
      const s = getSession();
      return s
        ? {
            label: `Sair (${s.email || "conta"})`,
            click: () => {
              clearSession();
              if (Notification.isSupported())
                new Notification({ title: "Capi", body: "Você saiu da conta.", silent: true }).show();
            },
          }
        : { label: "Entrar…", click: () => openLoginWindow() };
    })(),
    { type: "separator" },
    {
      label: "Apagar imagem após copiar",
      type: "checkbox",
      checked: config.autoDelete,
      click: (item) => {
        config.autoDelete = item.checked;
        saveConfig(config);
      },
    },
    {
      label: "Colar direto no chat (auto-paste)",
      type: "checkbox",
      checked: config.autoPaste,
      click: (item) => {
        config.autoPaste = item.checked;
        saveConfig(config);
        if (item.checked && !systemPreferences.isTrustedAccessibilityClient(false)) {
          systemPreferences.isTrustedAccessibilityClient(true);
        }
      },
    },
    {
      label: "Som ao copiar",
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
        ? "Permissão de tela OK"
        : "Conceder permissão de tela…",
      enabled: !hasScreenPermission(),
      click: () => promptScreenPermission(),
    },
    { type: "separator" },
    { label: "Sair", role: "quit" },
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

  buildTray();
  registerShortcut();
  refreshClaudeProjects(); // popula o cache de projetos no boot
  refreshOpenTabs();

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

  // dispara o pedido de Gravação de Tela com o nome "Capi"
  if (process.platform === "darwin" && !hasScreenPermission()) {
    triggerScreenPrompt();
  }

  openMainWindow(); // mostra a interface ao abrir
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", (e) => {
  // não sair: é app de bandeja
});

// expõe pra futuros painéis de config
module.exports = { loadConfig, saveConfig };
