const $ = (id) => document.getElementById(id);

// logos (img:/capi:) ficam em tile branco limpo (igual à landing) — sem fundo roxo
function isLogoAvatar(av) {
  return typeof av === "string" && (av.indexOf("img:") === 0 || av.indexOf("capi:") === 0);
}
// atributos do tile do ícone: logo -> classe is-logo; glifo -> fundo colorido
function icoAttrs(av, color) {
  return isLogoAvatar(av)
    ? `class="agent-ico is-logo"`
    : `class="agent-ico" style="background:${color || "#7c5cff"}"`;
}
// aplica o tratamento num elemento de cabeçalho já existente
function applyIco(el, av, color) {
  if (!el) return;
  const logo = isLogoAvatar(av);
  el.classList.toggle("is-logo", logo);
  el.style.background = logo ? "" : (color || "#7c5cff");
}

// avatares-Capi (imagens) primeiro, depois ícones SVG
const CAPI_AVATARS = ["capi:orquestrador", "capi:desktop", "capi:web", "capi:marca", "capi:qa", "capi:generico"];
const ICON_AVATARS = ["compass", "sparkles", "robot", "hub", "rocket", "bolt", "star", "target", "layers", "globe", "chart", "cpu", "flask", "bookmark", "terminal", "code"];
const AVATARS = [...CAPI_AVATARS, ...ICON_AVATARS];
const COLORS = ["#7c5cff", "#5b3fd6", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4", "#ec4899", "#1e1b2e"];

let lastState = null;
let currentApp = null;     // bundleId do app aberto (nível 2) — null = nível 1
let currentProject = null; // key do projeto aberto (nível 3) — null = nível 2
let projectsCache = [];    // projetos do app atual (do listProjects)
let capturingShortcut = null; // "capture" | "voice" enquanto grava nova combinação

// accel do Electron ("CommandOrControl+Shift+2") -> símbolos (⌘⇧2)
function fmtAccel(a) {
  if (!a) return "";
  return String(a)
    .replace(/CommandOrControl/g, "⌘").replace(/Command/g, "⌘").replace(/Control/g, "⌃")
    .replace(/Alt/g, "⌥").replace(/Shift/g, "⇧")
    .replace(/Space/g, "␣").replace(/Return/g, "⏎")
    .replace(/\+/g, "");
}

// constrói o accel a partir de um keydown (usa e.code pra evitar símbolos com Shift)
function accelFromEvent(e) {
  const mods = [];
  if (e.metaKey) mods.push("CommandOrControl");
  if (e.ctrlKey && !e.metaKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const c = e.code;
  let key = null;
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) key = m[1];
  else if ((m = /^Digit([0-9])$/.exec(c))) key = m[1];
  else if (/^F([0-9]{1,2})$/.test(c)) key = c;
  else {
    const map = {
      Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Backspace",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
      Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
    };
    key = map[c] || null;
  }
  if (!key) return { needKey: true }; // só modificador / tecla não suportada
  if (!mods.length) return { needMod: true };
  return { accel: mods.join("+") + "+" + key };
}

function appByBundle(s, bundleId) {
  return (s.config.apps || []).find((a) => a.bundleId === bundleId) || null;
}

function render(s) {
  if (!s) return;
  lastState = s;
  const screenOk = s.screen === "granted";
  $("perm-screen").classList.toggle("ok", screenOk);
  $("perm-screen").classList.toggle("no", !screenOk);
  $("perm-ax").classList.toggle("ok", !!s.ax);
  $("perm-ax").classList.toggle("no", !s.ax);
  $("opt-autoPaste").checked = !!s.config.autoPaste;
  $("opt-autoDelete").checked = !!s.config.autoDelete;
  $("opt-playSound").checked = !!s.config.playSound;
  if (!capturingShortcut) {
    $("shortcut").textContent = fmtAccel(s.config.shortcut) || "⌘⇧2";
    $("voiceShortcut").textContent = fmtAccel(s.config.voiceShortcut) || "⌘⇧1";
  }
  $("version").textContent = "Capi · v" + (s.version || "dev");

  // se o app aberto sumiu, volta pro nível 1
  if (currentApp && !appByBundle(s, currentApp)) { currentApp = null; currentProject = null; }
  $("screen-apps").hidden = !!currentApp;
  $("screen-app").hidden = !(currentApp && !currentProject);
  $("screen-project").hidden = !(currentApp && currentProject);
  if (currentApp && currentProject) renderProjectScreen(s);
  else if (currentApp) renderAppScreen(s);
  else renderApps(s);
}

// ---------- NÍVEL 1: apps ----------
function renderApps(s) {
  $("screen-apps").hidden = false;
  $("screen-app").hidden = true;
  const def = s.config.captureDefault || "__last__";
  $("cdef-last").checked = def === "__last__";
  const list = $("apps-list");
  list.innerHTML = "";
  (s.config.apps || []).forEach((app) => {
    const n =
      app.type === "messenger"
        ? (s.config.contacts || []).filter((c) => c.appBundleId === app.bundleId).length + " contacts"
        : (s.config.agents || []).filter((a) => a.app && a.app.bundleId === app.bundleId).length + " agents";
    const div = document.createElement("div");
    div.className = "app-item";
    div.innerHTML =
      `<span ${icoAttrs(app.avatar, app.color)}></span>` +
      `<div class="agent-txt"><b></b><small></small></div>` +
      `<span class="chev">${capiIcon("chevronRight", 18)}</span>`;
    div.querySelector(".agent-ico").innerHTML = avatarHTML(app.avatar || "grid", 20);
    div.querySelector("b").textContent = app.name;
    div.querySelector("small").textContent =
      (app.type === "messenger" ? "Messenger · " : "AI/code · ") + n;
    div.addEventListener("click", () => { currentApp = app.bundleId; render(lastState); });
    list.appendChild(div);
  });
}

// ---------- NÍVEL 2: dentro de um app (IA = projetos | mensageiro = contatos) ----------
function renderAppScreen(s) {
  const app = appByBundle(s, currentApp);
  if (!app) { currentApp = null; currentProject = null; return renderApps(s); }
  $("app-head-ico").innerHTML = avatarHTML(app.avatar || "grid", 22);
  applyIco($("app-head-ico"), app.avatar, app.color);
  $("app-head-name").textContent = app.name;
  $("app-head-type").textContent = app.type === "messenger" ? "Messenger" : "AI / code";
  $("app-search").checked = !!app.searchEnabled;

  const box = $("app-children");

  if (app.type === "messenger") {
    $("addChild").hidden = false;
    $("addChild").textContent = "+ Add contact";
    $("addProject").hidden = true;
    $("seedFrentes").hidden = true;
    const def = s.config.captureDefault || "__last__";
    box.innerHTML = "";
    const cts = (s.config.contacts || []).filter((c) => c.appBundleId === app.bundleId);
    cts.forEach((c) => {
      const div = document.createElement("div");
      div.className = "agent-item";
      div.innerHTML =
        `<span class="agent-ico" style="background:${app.color}">${capiIcon("person", 18)}</span>` +
        `<div class="agent-txt"><b></b><small></small></div>` +
        `<input type="radio" name="cdef" class="radio" ${def === c.id ? "checked" : ""} />` +
        `<button class="agent-rm" title="Remove">${capiIcon("close", 14)}</button>`;
      div.querySelector("b").textContent = c.name;
      div.querySelector("small").textContent = c.hint || "";
      div.querySelector(".radio").addEventListener("change", () => window.capiWin.setAgentDefault(c.id));
      div.querySelector(".agent-rm").addEventListener("click", () => {
        if (confirm(`Remove "${c.name}"?`)) window.capiWin.removeContact(c.id);
      });
      box.appendChild(div);
    });
    if (!cts.length) box.innerHTML = `<p class="empty-sm">No contacts yet.</p>`;
    return;
  }

  // IA: nível 2 = PROJETOS (busca async)
  $("addChild").hidden = true;
  $("addProject").hidden = false;
  $("seedFrentes").hidden = false;
  if (!box.children.length) box.innerHTML = `<p class="empty-sm">Loading projects…</p>`;
  window.capiWin.listProjects(app.bundleId).then((projs) => {
    projectsCache = projs || [];
    if (currentApp !== app.bundleId || currentProject) return; // mudou de tela
    paintProjects(app);
  });
}

let importedOpen = false, archivedOpen = false;

function projectRow(app, p) {
  const div = document.createElement("div");
  div.className = "app-item" + (p.archived ? " archived" : "");
  div.innerHTML =
    `<span class="agent-ico" style="background:${app.color || "#7c5cff"}"></span>` +
    `<div class="agent-txt"><b></b><small></small></div>` +
    `<button class="proj-arch" title="${p.archived ? "Unarchive" : "Archive"}">${p.archived ? capiIcon("back", 16) : capiIcon("archive", 16)}</button>` +
    `<span class="chev">${capiIcon("chevronRight", 18)}</span>`;
  div.querySelector(".agent-ico").innerHTML = avatarHTML(p.here ? "target" : "grid", 18);
  div.querySelector("b").textContent = p.name;
  div.querySelector("small").textContent = p.sub || "";
  div.querySelector(".proj-arch").addEventListener("click", (e) => {
    e.stopPropagation();
    if (p.archived) window.capiWin.unarchiveProject(p.key);
    else window.capiWin.archiveProject(p.key);
  });
  div.addEventListener("click", () => { currentProject = p.key; render(lastState); });
  return div;
}

function groupHeader(label, open, onToggle) {
  const h = document.createElement("div");
  h.className = "proj-group";
  const caret = open
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`;
  h.innerHTML = `<span class="pg-caret">${caret}</span><span class="pg-label"></span>`;
  h.querySelector(".pg-label").textContent = label;
  h.addEventListener("click", onToggle);
  return h;
}

function paintProjects(app) {
  const box = $("app-children");
  box.innerHTML = "";
  const all = projectsCache.slice();
  // frentes = têm agente, ou é onde você está, ou criado à mão. resto = chats importados.
  const isFrente = (p) => p.agents.length > 0 || p.here || p.manual;
  const frentes = all.filter((p) => !p.archived && isFrente(p))
    .sort((a, b) => (b.here - a.here) || (b.agents.length - a.agents.length) || a.name.localeCompare(b.name));
  const imported = all.filter((p) => !p.archived && !isFrente(p))
    .sort((a, b) => a.name.localeCompare(b.name));
  const archived = all.filter((p) => p.archived).sort((a, b) => a.name.localeCompare(b.name));

  frentes.forEach((p) => box.appendChild(projectRow(app, p)));
  if (!frentes.length)
    box.insertAdjacentHTML("beforeend", `<p class="empty-sm">No workstreams yet. Open an imported chat and create an agent in it.</p>`);

  if (imported.length) {
    box.appendChild(groupHeader(`Imported chats (${imported.length})`, importedOpen, () => { importedOpen = !importedOpen; paintProjects(app); }));
    if (importedOpen) imported.forEach((p) => box.appendChild(projectRow(app, p)));
  }
  if (archived.length) {
    box.appendChild(groupHeader(`Archived (${archived.length})`, archivedOpen, () => { archivedOpen = !archivedOpen; paintProjects(app); }));
    if (archivedOpen) archived.forEach((p) => box.appendChild(projectRow(app, p)));
  }
}

// ---------- NÍVEL 3: agentes dentro de um projeto ----------
function renderProjectScreen(s) {
  const app = appByBundle(s, currentApp);
  if (!app) { currentApp = null; currentProject = null; return renderApps(s); }
  // sempre rebusca pra refletir agentes recém-criados
  window.capiWin.listProjects(app.bundleId).then((projs) => {
    projectsCache = projs || [];
    if (currentApp !== app.bundleId || !currentProject) return;
    const proj = projectsCache.find((p) => p.key === currentProject);
    if (!proj) { currentProject = null; return render(lastState); }
    paintProjectAgents(s, app, proj);
  });
}

function paintProjectAgents(s, app, proj) {
  $("proj-head-ico").innerHTML = avatarHTML(proj.here ? "target" : "grid", 22);
  $("proj-head-ico").style.background = app.color || "#7c5cff";
  $("proj-head-name").textContent = proj.name;
  if (proj.here) {
    $("proj-head-sub").innerHTML =
      `<svg width="9" height="9" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:5px"><circle cx="12" cy="12" r="9" fill="#22C55E"/></svg>you're here · <span class="phs-app"></span>`;
    $("proj-head-sub").querySelector(".phs-app").textContent = app.name;
  } else {
    $("proj-head-sub").textContent = app.name;
  }
  const def = s.config.captureDefault || "__last__";
  const pinned = new Set(s.config.pinnedAgents || []);
  const box = $("proj-agents");
  box.innerHTML = "";
  (proj.agents || []).forEach((a) => {
    const full = (s.config.agents || []).find((x) => x.id === a.id) || a;
    const isPinned = pinned.has(a.id);
    const canLaunch = !!(full.folder || full.cwd);
    const div = document.createElement("div");
    div.className = "agent-item";
    div.innerHTML =
      `<span ${icoAttrs(a.avatar, a.color)}></span>` +
      `<div class="agent-txt"><b></b><small></small></div>` +
      (canLaunch ? `<button class="agent-go" title="Open workstream (window + Claude Code + prompt)">${capiIcon("play", 15)}</button>` : ``) +
      `<button class="agent-pin ${isPinned ? "on" : ""}" title="${isPinned ? "Unpin" : "Pin to the top of the picker"}">${isPinned ? capiIcon("pinFilled", 16) : capiIcon("star", 16)}</button>` +
      `<input type="radio" name="cdef" class="radio" ${def === a.id ? "checked" : ""} title="Default destination" />` +
      `<button class="agent-edit" title="Edit">${capiIcon("edit", 15)}</button>` +
      `<button class="agent-rm" title="Remove">${capiIcon("close", 15)}</button>`;
    div.querySelector(".agent-ico").innerHTML = avatarHTML(a.avatar || "robot", 18);
    div.querySelector("b").textContent = a.name;
    div.querySelector("small").textContent = a.sub || "";
    if (canLaunch) div.querySelector(".agent-go").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.textContent = "…"; btn.disabled = true;
      await window.capiWin.launchFrente(a.id);
      btn.innerHTML = capiIcon("play", 15); btn.disabled = false;
    });
    div.querySelector(".agent-pin").addEventListener("click", () => window.capiWin.togglePinAgent(a.id));
    div.querySelector(".radio").addEventListener("change", () => window.capiWin.setAgentDefault(a.id));
    div.querySelector(".agent-edit").addEventListener("click", () => openAgentEditor(app, full));
    div.querySelector(".agent-rm").addEventListener("click", () => {
      if (confirm(`Remove the agent "${a.name}"?`)) window.capiWin.removeAgent(a.id);
    });
    box.appendChild(div);
  });
  if (!(proj.agents || []).length)
    box.innerHTML = `<p class="empty-sm">Just "Current conversation" for now. Create an agent below.</p>`;
}

function slug(s) {
  return (s || "x").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
}
const uid = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

// ---------- editor de AGENTE ----------
let aeAgent = null, aeApp = null, pickAvatar = AVATARS[0], pickColor = COLORS[0], pickKind = "current";

function buildPickers() {
  const av = $("ae-avatars"); av.innerHTML = "";
  AVATARS.forEach((e) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pick-cell" + (e === pickAvatar ? " sel" : "");
    b.innerHTML = avatarHTML(e, 20); b.addEventListener("click", () => { pickAvatar = e; buildPickers(); });
    av.appendChild(b);
  });
  const co = $("ae-colors"); co.innerHTML = "";
  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pick-cell color" + (c === pickColor ? " sel" : "");
    b.style.background = c; b.addEventListener("click", () => { pickColor = c; buildPickers(); });
    co.appendChild(b);
  });
}
function setKind(kind) {
  pickKind = kind;
  document.querySelectorAll("#ae-seg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.kind === kind));
  $("ae-project-row").hidden = kind !== "project";
}
let aePreset = null;       // {projectKey,projectName,cwd,windowMatch} quando criado dentro de um projeto
let aeWindowTitle = null;  // título REAL da janela mirada (o que roteia certo)

function renderAimLabel() {
  const el = $("ae-aim-label");
  const aimIco = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/></svg>`;
  if (aeWindowTitle) {
    el.innerHTML = `Aiming at: <b></b>`;
    el.querySelector("b").textContent = aeWindowTitle;
    $("ae-aim").innerHTML = aimIco + "Re-aim at the active window";
  } else {
    el.textContent = "Bring the right chat to the front in VS Code, then click here.";
    $("ae-aim").innerHTML = aimIco + "Aim at the active VS Code window";
  }
}

function openAgentEditor(app, agent, preset) {
  aeApp = app; aeAgent = agent || null; aePreset = preset || null;
  const projName = (preset && preset.projectName) || (agent && agent.project && agent.project.name) || "";
  $("ae-title").textContent = (agent ? "Edit agent" : "New agent") + (projName ? ` · ${projName}` : "");
  $("ae-name").value = agent ? agent.name : "";
  $("ae-subject").value = agent ? agent.subject || "" : "";
  pickAvatar = (agent && agent.avatar) || AVATARS[0];
  pickColor = (agent && agent.color) || COLORS[0];
  buildPickers();
  // alvo: janela específica (se o agente já mira uma) ou conversa atual
  aeWindowTitle = (agent && agent.kind === "project" && agent.windowMatch) ? agent.windowMatch : null;
  setKind(aeWindowTitle ? "project" : "current");
  $("ae-seg").style.display = "";
  renderAimLabel();
  // campos de "abrir frente"
  $("ae-folder").value = (agent && agent.folder) || (preset && preset.cwd) || "";
  $("ae-initprompt").value = (agent && agent.initPrompt) || "";
  $("agent-editor").hidden = false;
}

function saveAgentForm() {
  const name = $("ae-name").value.trim();
  if (!name) return $("ae-name").focus();
  const folder = $("ae-folder").value.trim();
  const initPrompt = $("ae-initprompt").value;
  // GRUPO (projeto) — separado do ALVO: vem do preset ou do agente existente
  const project = (aePreset && aePreset.projectKey)
    ? { key: aePreset.projectKey, name: aePreset.projectName || name }
    : (aeAgent && aeAgent.project) ? aeAgent.project : undefined;
  const base = {
    id: aeAgent ? aeAgent.id : slug(name) + "-" + uid(),
    name, subject: $("ae-subject").value.trim(),
    avatar: pickAvatar, color: pickColor,
    app: { bundleId: aeApp.bundleId, name: aeApp.name },
    folder: folder || undefined,
    initPrompt: initPrompt || undefined,
    project,
    cwd: (aePreset && aePreset.cwd) || (aeAgent && aeAgent.cwd) || undefined,
  };
  // ALVO: "janela específica" usa o título REAL mirado (casa de verdade); senão conversa atual
  const agent = (pickKind === "project" && aeWindowTitle)
    ? { ...base, kind: "project", target: "window", windowMatch: aeWindowTitle }
    : { ...base, kind: "app", target: "current", windowMatch: null };
  window.capiWin.saveAgent(agent);
  $("agent-editor").hidden = true;
  aePreset = null; aeWindowTitle = null;
}

// ---------- editor de CONTATO ----------
let ceApp = null;
function openContactEditor(app) {
  ceApp = app;
  $("ce-name").value = ""; $("ce-hint").value = "";
  $("contact-editor").hidden = false;
}
function saveContactForm() {
  const name = $("ce-name").value.trim();
  if (!name) return $("ce-name").focus();
  window.capiWin.saveContact({
    id: slug(name) + "-" + uid(), name,
    hint: $("ce-hint").value.trim(), appBundleId: ceApp.bundleId,
  });
  $("contact-editor").hidden = true;
}

// ---------- adicionar app ----------
let apType = "ai";
async function openAppPicker() {
  apType = "ai";
  document.querySelectorAll("#ap-seg .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === "ai"));
  const sel = $("ap-app");
  sel.innerHTML = `<option value="">loading…</option>`;
  const apps = await window.capiWin.listRunningApps();
  const have = new Set((lastState.config.apps || []).map((a) => a.bundleId));
  sel.innerHTML = "";
  apps.filter((a) => !have.has(a.bundleId)).forEach((a) => {
    const o = document.createElement("option");
    o.value = a.bundleId; o.textContent = a.name; sel.appendChild(o);
  });
  $("app-picker").hidden = false;
}
function saveAppForm() {
  const sel = $("ap-app");
  const bundleId = sel.value;
  if (!bundleId) return;
  const name = sel.selectedOptions[0].textContent;
  const avatar = apType === "messenger" ? "message" : "robot";
  window.capiWin.saveApp({
    id: slug(name), name, bundleId, type: apType,
    avatar, color: "#7c5cff", searchEnabled: true, agents: [], contacts: [],
  });
  $("app-picker").hidden = true;
}

// ---------- eventos ----------
async function refresh() { render(await window.capiWin.getState()); }
$("captureBtn").addEventListener("click", () => window.capiWin.capture());
$("openPanelBtn")?.addEventListener("click", () => window.capiWin.openPanel());
["autoPaste", "autoDelete", "playSound"].forEach((key) =>
  $("opt-" + key).addEventListener("change", (e) => window.capiWin.setOption(key, e.target.checked)));
document.querySelectorAll(".mini").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.act === "screen") window.capiWin.openScreenPrefs();
    else window.capiWin.openAxPrefs();
  }));
$("cdef-last").addEventListener("change", () => window.capiWin.setAgentDefault("__last__"));

// ---- atalhos editáveis (clique e tecle a combinação) ----
function scHint(msg, isErr) {
  const h = $("sc-hint");
  h.textContent = msg || "";
  h.hidden = !msg;
  h.classList.toggle("err", !!isErr);
}
function startCaptureShortcut(which, btn) {
  if (capturingShortcut) stopCaptureShortcut();
  capturingShortcut = which;
  btn.classList.add("capturing");
  btn.textContent = "Press…";
  scHint("Press the combination (⌘/⌥/⌃/⇧ + key). Esc cancels.", false);
}
function stopCaptureShortcut() {
  const prev = capturingShortcut;
  capturingShortcut = null;
  document.querySelectorAll(".shortcut.capturing").forEach((b) => b.classList.remove("capturing"));
  if (lastState) render(lastState); // restaura o texto dos botões
  return prev;
}
["shortcut", "voiceShortcut"].forEach((id) =>
  $(id).addEventListener("click", () => startCaptureShortcut($(id).dataset.which, $(id))));

window.addEventListener("keydown", async (e) => {
  if (!capturingShortcut) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") { stopCaptureShortcut(); scHint("", false); return; }
  const r = accelFromEvent(e);
  if (r.needMod) { scHint("Add a modifier (⌘, ⌥, ⌃ or ⇧).", true); return; }
  if (r.needKey) return; // ainda só apertou modificadores — espera a tecla
  const which = stopCaptureShortcut();
  const res = await window.capiWin.setShortcut(which, r.accel);
  if (res && res.ok) {
    scHint("Shortcut saved: " + fmtAccel(r.accel), false);
    setTimeout(() => scHint("", false), 2500);
  } else {
    scHint((res && res.reason) || "Couldn't use that shortcut.", true);
  }
}, true);

// nível 2
$("app-back").addEventListener("click", () => { currentApp = null; currentProject = null; render(lastState); });
$("app-search").addEventListener("change", (e) => {
  const app = appByBundle(lastState, currentApp);
  if (app) window.capiWin.saveApp({ ...app, searchEnabled: e.target.checked });
});
$("removeApp").addEventListener("click", () => {
  const app = appByBundle(lastState, currentApp);
  if (app && confirm(`Remove the app "${app.name}" and its destinations?`)) {
    window.capiWin.removeApp(app.bundleId); currentApp = null; currentProject = null;
  }
});
$("addChild").addEventListener("click", () => {
  const app = appByBundle(lastState, currentApp);
  if (!app) return;
  if (app.type === "messenger") openContactEditor(app);
  else openAgentEditor(app, null);
});
$("addProject").addEventListener("click", () => {
  const app = appByBundle(lastState, currentApp);
  if (!app) return;
  const name = (prompt("Project name (e.g. the folder/window it aims at):") || "").trim();
  if (!name) return;
  window.capiWin.saveProject({
    id: "mnl-" + slug(name) + "-" + uid(), key: "mnl:" + slug(name),
    name, appBundleId: app.bundleId, windowMatch: name, cwd: "",
  });
});
$("seedFrentes").addEventListener("click", async (e) => {
  const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Creating…";
  const r = await window.capiWin.seedCapiFrentes();
  btn.disabled = false;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/></svg>Create Capi's 5 workstreams`;
  alert(r && r.created ? `${r.created} workstream(s) created! Open a project to see them, or use the open-workstream button.` : "The workstreams already exist.");
});

// nível 3 (projeto)
$("proj-back").addEventListener("click", () => { currentProject = null; render(lastState); });
$("addAgentInProj").addEventListener("click", () => {
  const app = appByBundle(lastState, currentApp);
  const proj = projectsCache.find((p) => p.key === currentProject);
  if (!app || !proj) return;
  openAgentEditor(app, null, {
    projectKey: proj.key, projectName: proj.name, cwd: proj.cwd, windowMatch: proj.windowMatch,
  });
});

// modais
$("ae-cancel").addEventListener("click", () => ($("agent-editor").hidden = true));
$("ae-save").addEventListener("click", saveAgentForm);
document.querySelectorAll("#ae-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => setKind(b.dataset.kind)));
// mirar a janela ATIVA do VS Code (pega o título real, mesmo com a Capi na frente)
$("ae-aim").addEventListener("click", async () => {
  const btn = $("ae-aim"); btn.disabled = true;
  const t = await window.capiWin.grabActiveWindow(aeApp ? aeApp.bundleId : "com.microsoft.VSCode");
  btn.disabled = false;
  if (t) { aeWindowTitle = t; renderAimLabel(); }
  else $("ae-aim-label").textContent = "Couldn't read the active window. Is VS Code open?";
});
$("ce-cancel").addEventListener("click", () => ($("contact-editor").hidden = true));
$("ce-save").addEventListener("click", saveContactForm);
$("addApp").addEventListener("click", openAppPicker);
$("ap-cancel").addEventListener("click", () => ($("app-picker").hidden = true));
$("ap-save").addEventListener("click", saveAppForm);
document.querySelectorAll("#ap-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    apType = b.dataset.type;
    document.querySelectorAll("#ap-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  }));

window.capiWin.onState(render);
// veio do picker da captura ("Criar projeto/agente") -> abre no contexto certo
if (window.capiWin.onFocusApp) {
  window.capiWin.onFocusApp((info) => {
    const d = typeof info === "string" ? { bundleId: info } : (info || {});
    if (d.bundleId) currentApp = d.bundleId;
    // tem projeto? abre direto o editor de agente travado nele
    const preset = (d.cwd || d.windowMatch || d.projectName)
      ? { projectKey: d.projectKey, projectName: d.projectName, cwd: d.cwd, windowMatch: d.windowMatch }
      : null;
    if (preset && d.projectKey) currentProject = d.projectKey;
    const go = () => {
      render(lastState);
      if (preset) {
        const app = appByBundle(lastState, currentApp);
        if (app) openAgentEditor(app, null, preset);
      }
    };
    if (lastState) go();
    else refresh().then(go);
  });
}
refresh();
window.addEventListener("focus", refresh);
