// Overlay da Capi — voz primeiro, com seletor de destinos
const shot = document.getElementById("shot");
const veil = document.getElementById("veil");
const hint = document.getElementById("hint");
const selection = document.getElementById("selection");
const dims = document.getElementById("dims");
const toolbar = document.getElementById("toolbar");
const note = document.getElementById("note");
const noteListening = document.getElementById("note-listening");
const fsBtn = document.getElementById("fullscreen-btn");
const capiFace = document.getElementById("capi-face");
const statusEl = document.getElementById("status");
const recDot = document.getElementById("rec-dot");
const recLabel = document.getElementById("rec-label");
const recTimer = document.getElementById("rec-timer");
const micBtn = document.getElementById("mic-btn");
const cancelBtn = document.getElementById("cancel-btn");
const idleCancel = document.getElementById("idle-cancel");
const autorecPill = document.getElementById("autorec-pill");
const arLabel = document.getElementById("ar-label");
const vu = document.getElementById("vu");
const vuBars = Array.from(vu.querySelectorAll("span"));
const picker = document.getElementById("picker");
const pickerList = document.getElementById("picker-list");
const pickerTitle = document.getElementById("picker-title");
const pickerBack = document.getElementById("picker-back");
const pickerSearch = document.getElementById("picker-search");
const focusToggle = document.getElementById("focus-toggle");
const ftLabel = document.getElementById("ft-label");
const ftIco = document.getElementById("ft-ico");
const tbFoot = document.getElementById("tb-foot");
const xcribe = document.getElementById("xcribe");
const xcribeBar = document.getElementById("xcribe-bar");
const xcribeLabel = document.getElementById("xcribe-label");

let imgReady = false;
let dragging = false;
let start = null;
let rect = null;
let committed = false;
let voiceOnly = false; // ⌘+Shift+1: grava voz SEM print, manda só o texto

// fluxo: "idle" | "recording" | "transcribing" | "picking"
let state = "idle";

// picker em 2 níveis: apps (nível 1) -> agentes/contatos (nível 2)
let tree = [];          // [{id,name,avatar,color,bundleId,type,searchEnabled,children:[]}]
let pickLevel = "apps"; // "apps" | "projects" | "agents"
let curApp = null;      // app aberto no nível 2
let rows = [];          // linhas visíveis no nível atual (já filtradas pela busca)
let selIdx = 0;
let searchQuery = "";
let defaultId = "__last__";
let autoPaste = true;
let focusMode = "switch"; // "switch" = ir pra tela | "stay" = ficar onde estou
let autoRecord = true; // grava sozinho ao selecionar?
let editing = false; // está editando o texto manualmente?

window.capi.onInit((data) => {
  voiceOnly = !!data.voiceOnly;
  autoPaste = data.autoPaste !== false;
  focusMode = data.focusMode === "stay" ? "stay" : "switch";
  autoRecord = data.autoRecord !== false;
  buildTargets(data);
  renderFocusToggle();
  renderAutoRecPill();
  if (voiceOnly) {
    startVoiceMode();
  } else {
    shot.src = data.dataURL;
    shot.onload = () => (imgReady = true);
  }
});

// ⌘+Shift+1: sem print — janelinha no canto, tela livre, já grava
function startVoiceMode() {
  document.body.classList.add("voice-only");
  veil.hidden = true; hint.hidden = true; fsBtn.hidden = true;
  selection.hidden = true; shot.hidden = true;
  idleCancel.hidden = true; autorecPill.hidden = true;
  toolbar.hidden = false; // o CSS .voice-only posiciona ele na janelinha
  startRecording(); // o ponto do modo voz é gravar na hora
}

function renderAutoRecPill() {
  autorecPill.classList.toggle("off", !autoRecord);
  arLabel.innerHTML = autoRecord
    ? "Gravar ao selecionar: <b>ligado</b>"
    : "Gravar ao selecionar: <b>desligado</b>";
}
autorecPill.addEventListener("click", (e) => {
  e.stopPropagation();
  autoRecord = !autoRecord;
  renderAutoRecPill();
  window.capi.setAutoRecord(autoRecord);
});

// botões clicáveis de cancelar (tela inicial + barrinha)
idleCancel.addEventListener("click", (e) => {
  e.stopPropagation();
  window.capi.cancel();
});
cancelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  window.capi.cancel();
});

// botão de microfone: grava / para (ou regrava na telinha)
micBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (state === "recording") {
    stopRecording();
  } else {
    startRecording();
  }
});

function setStatus(msg) {
  statusEl.textContent = msg || "";
  tbFoot.hidden = !msg;
}

// ---------- destinos: App -> Projeto -> Agente (IA) | App -> Contatos (mensageiro) ----------
let frontmostName = "onde eu estava";
// pickLevel: "apps" | "projects" | "agents"  (curProject só em "agents")
let curProject = null;

let pinnedList = [];
function buildTargets(data) {
  frontmostName = data.frontmost && data.frontmost.name ? data.frontmost.name : "onde eu estava";
  tree = Array.isArray(data.appsTree) ? data.appsTree : [];
  pinnedList = Array.isArray(data.pinned) ? data.pinned : [];
  defaultId = data.agentDefault || "__last__";
  enterAppsLevel();
}

// quantos destinos um app oferece (pro subtítulo do nível 1)
function appSub(app) {
  if (app.type === "messenger") {
    const n = (app.contacts || []).length;
    return n ? `${n} contato${n > 1 ? "s" : ""}` : "conversa atual";
  }
  const n = (app.projects || []).length;
  return n ? `${n} projeto${n > 1 ? "s" : ""}` : "criar projeto";
}

// NÍVEL 1 — Fixados (atalhos diretos) + apps + "Último app"
function appsRows() {
  const out = [];
  pinnedList.forEach((p) =>
    out.push({
      kind: "pin", pin: p, name: p.name, sub: p.sub || "fixado",
      avatar: p.avatar, color: p.color, pinned: true,
    })
  );
  tree.forEach((app) =>
    out.push({
      kind: "app", app, name: app.name, sub: appSub(app),
      avatar: app.avatar, color: app.color, descend: true,
    })
  );
  out.push({ kind: "last", name: "Último app", sub: frontmostName, avatar: "back", color: "#9b95ad" });
  return out;
}

// NÍVEL 2 — dentro de um app
function midRows(app) {
  if (app.type === "messenger") {
    // mensageiro: conversa atual + contatos + novo contato
    const out = [{ kind: "conv-app", app, name: "Conversa atual", sub: "no que estiver aberto", avatar: app.avatar, color: app.color }];
    (app.contacts || []).forEach((c) =>
      out.push({ kind: "contact", app, child: c, name: c.name, sub: c.sub || "", avatar: c.avatar, color: c.color })
    );
    out.push({ kind: "new-contact", app, name: "Novo contato", sub: "abre a configuração", avatar: "person", color: "#7c5cff" });
    return out;
  }
  // IA: conversa atual (app) + ABAS ABERTAS (envio direto) + projetos (histórico) + criar projeto
  const out = [{ kind: "conv-app", app, name: "Conversa atual", sub: "no que estiver aberto agora", avatar: app.avatar, color: app.color }];
  // abas abertas AGORA no VS Code — vai direto pra aba via `edt` (o que o Giba pediu)
  (app.openTabs || []).forEach((t) =>
    out.push({
      kind: "tab", app, name: t.title, windowMatch: t.title,
      sub: t.here ? "aberta · você está aqui" : "aba aberta no VS Code",
      here: !!t.here,
      avatar: app.avatar, color: app.color,
    })
  );
  (app.projects || []).forEach((p) =>
    out.push({ kind: "project", app, project: p, name: p.name, sub: p.sub || "", here: !!p.here, avatar: app.avatar, color: app.color, descend: true })
  );
  out.push({ kind: "new-project", app, name: "Criar projeto", sub: "abre aba nova do Claude com seu briefing", avatar: "grid", color: "#7c5cff" });
  return out;
}

// NÍVEL 3 — dentro de um projeto: conversa atual + agentes + criar agente
function agentRows(app, project) {
  const out = [{
    kind: "conv-proj", app, project,
    name: "Abrir este chat", sub: project.windowMatch ? `vai pra aba: ${project.windowMatch}` : "no que estiver aberto",
    avatar: app.avatar, color: app.color,
  }];
  (project.agents || []).forEach((a) =>
    out.push({ kind: "agent", app, project, child: a, name: a.name, sub: a.sub || "", avatar: a.avatar, color: a.color })
  );
  out.push({ kind: "new-agent", app, project, name: "Criar agente", sub: "abre a configuração", avatar: "robot", color: "#7c5cff" });
  return out;
}

function enterAppsLevel() {
  pickLevel = "apps"; curApp = null; curProject = null; searchQuery = "";
  rows = appsRows();
  // pré-seleciona: o FIXADO padrão (atalho), senão o app dono do default, senão "Último app"
  let idx = rows.findIndex((r) => r.kind === "pin" && r.pin.id === defaultId);
  if (idx < 0 && pinnedList.length) idx = rows.findIndex((r) => r.kind === "pin");
  if (idx < 0) {
    if (defaultId === "__last__") {
      idx = rows.findIndex((r) => r.kind === "last");
    } else {
      idx = rows.findIndex((r) =>
        r.kind === "app" &&
        (r.app.id === defaultId ||
          (r.app.projects || []).some((p) => p.id === defaultId || (p.agents || []).some((a) => a.id === defaultId))));
    }
  }
  selIdx = idx < 0 ? 0 : idx;
  applySearchVisibility(); renderPicker();
}

function enterMidLevel(app) {
  pickLevel = "projects"; curApp = app; curProject = null; searchQuery = "";
  rows = midRows(app);
  // pré-seleciona a aba ATIVA (a "aqui"), senão a 1ª aba/projeto (pula "conversa atual")
  let idx = rows.findIndex((r) => r.kind === "tab" && /você está aqui/.test(r.sub || ""));
  if (idx < 0) idx = rows.length > 1 ? 1 : 0;
  selIdx = idx;
  applySearchVisibility(); renderPicker();
}

function enterAgentsLevel(app, project) {
  pickLevel = "agents"; curApp = app; curProject = project; searchQuery = "";
  rows = agentRows(app, project);
  const idx = rows.findIndex((r) => r.child && r.child.id === defaultId);
  selIdx = idx >= 0 ? idx : (rows.length > 1 ? 1 : 0);
  applySearchVisibility(); renderPicker();
}

// quantos itens "de verdade" (fora conversa-atual e criar) o nível atual tem
function realCount() {
  return rows.filter((r) => r.kind === "tab" || r.kind === "project" || r.kind === "agent" || r.kind === "contact").length;
}
function applySearchVisibility() {
  const show =
    pickLevel !== "apps" &&
    curApp && curApp.searchEnabled !== false &&
    realCount() > 4;
  pickerSearch.hidden = !show;
  if (show && document.activeElement !== pickerSearch) pickerSearch.value = searchQuery;
}

// recomputa as linhas do nível atual (aplicando a busca)
function currentRows() {
  if (pickLevel === "apps") return appsRows();
  if (pickLevel === "projects") return midRows(curApp);
  return agentRows(curApp, curProject);
}
function refilter() {
  const all = currentRows();
  const q = searchQuery.trim().toLowerCase();
  rows = q
    ? all.filter((r) => !(r.kind === "tab" || r.kind === "project" || r.kind === "agent" || r.kind === "contact") || r.name.toLowerCase().includes(q))
    : all;
  if (selIdx >= rows.length) selIdx = rows.length - 1;
  if (selIdx < 0) selIdx = 0;
  renderPicker();
}

function renderPicker() {
  if (pickLevel === "apps") {
    pickerTitle.textContent = "Pra onde eu mando?";
    pickerBack.hidden = true;
  } else if (pickLevel === "projects") {
    pickerTitle.textContent = curApp.name;
    pickerBack.hidden = false;
  } else {
    pickerTitle.textContent = `${curApp.name} › ${curProject.name}`;
    pickerBack.hidden = false;
  }
  pickerList.innerHTML = "";
  rows.forEach((t, i) => {
    const isNew = t.kind && t.kind.startsWith("new-");
    const row = document.createElement("div");
    row.className = "dest" + (i === selIdx ? " active" : "") + (isNew ? " dest-new" : "") + (t.pinned ? " dest-pin" : "");
    row.dataset.idx = i;
    const tail = t.descend
      ? `<span class="dest-chevron"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>`
      : `<span class="dest-enter"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></span>`;
    row.innerHTML =
      `<div class="dest-ico"></div>` +
      `<div class="dest-body"><div class="dest-name"></div><div class="dest-sub"></div></div>` +
      tail;
    const ico = row.querySelector(".dest-ico");
    ico.innerHTML = avatarHTML(t.avatar || "robot", 18);
    if (t.color && !isNew) ico.style.background = t.color;
    const nameEl = row.querySelector(".dest-name");
    if (t.pinned) {
      nameEl.innerHTML =
        `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><polygon points="12 2 14.6 8.6 21.6 9 16.2 13.6 18 20.4 12 16.6 6 20.4 7.8 13.6 2.4 9 9.4 8.6"/></svg><span class="dn-txt"></span>`;
      nameEl.querySelector(".dn-txt").textContent = t.name;
    } else {
      nameEl.textContent = t.name;
    }
    const subEl = row.querySelector(".dest-sub");
    if (t.here) {
      subEl.innerHTML =
        `<svg width="8" height="8" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:5px"><circle cx="12" cy="12" r="9" fill="#22C55E"/></svg><span class="ds-txt"></span>`;
      subEl.querySelector(".ds-txt").textContent = t.sub || "";
    } else {
      subEl.textContent = t.sub || "";
    }
    row.addEventListener("click", () => { selIdx = i; activateRow(); });
    pickerList.appendChild(row);
  });
  const active = pickerList.querySelector(".dest.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function moveDest(delta) {
  if (!rows.length) return;
  selIdx = (selIdx + delta + rows.length) % rows.length;
  renderPicker();
}

// Enter/clique: desce (app/projeto), cria (config), ou envia
function activateRow() {
  const r = rows[selIdx];
  if (!r) return;
  if (r.kind === "app") return enterMidLevel(r.app);
  if (r.kind === "project") return enterAgentsLevel(r.app, r.project);
  if (r.kind === "new-agent") {
    return window.capi.openAgentEditor({
      bundleId: r.app.bundleId,
      projectKey: r.project ? r.project.key : null,
      projectName: r.project ? r.project.name : null,
      cwd: r.project ? r.project.cwd : null,
      windowMatch: r.project ? r.project.windowMatch : null,
    });
  }
  if (r.kind === "new-contact") {
    return window.capi.openAgentEditor({ bundleId: r.app ? r.app.bundleId : null });
  }
  // "Criar projeto" agora ENVIA: abre aba nova do Claude Code com o briefing
  renderPicker();
  commit();
}

// volta um nível; retorna true se voltou
function goBack() {
  if (pickLevel === "agents") { enterMidLevel(curApp); return true; }
  if (pickLevel === "projects") { enterAppsLevel(); return true; }
  return false;
}

// resolve o destino final a partir da linha selecionada
function selectedTarget() {
  const r = rows[selIdx];
  if (!r) return { id: "__last__", bundleId: "__last__", windowMatch: null };
  if (r.kind === "last") return { id: "__last__", name: "Último app", bundleId: "__last__", windowMatch: null };
  if (r.kind === "pin") return { id: r.pin.id, name: r.pin.name, bundleId: r.pin.bundleId, windowMatch: r.pin.windowMatch || null };
  if (r.kind === "conv-app") return { id: r.app.id, name: r.app.name, bundleId: r.app.bundleId, windowMatch: null };
  if (r.kind === "new-project") return { id: "__newproj__", name: "Novo projeto", bundleId: r.app.bundleId, windowMatch: null, newProject: true };
  if (r.kind === "tab") return { id: "tab:" + r.name, name: r.name, bundleId: r.app.bundleId, windowMatch: r.windowMatch || r.name };
  if (r.kind === "conv-proj") return { id: r.project.id, name: r.project.name, bundleId: r.app.bundleId, windowMatch: r.project.windowMatch || null };
  if (r.kind === "contact") return { id: r.child.id, name: r.child.name, bundleId: r.app.bundleId, windowMatch: null };
  if (r.kind === "agent") return { id: r.child.id, name: r.child.name, bundleId: r.app.bundleId, windowMatch: r.child.windowMatch || (r.project && r.project.windowMatch) || null };
  return { id: "__last__", bundleId: "__last__", windowMatch: null };
}

function renderFocusToggle() {
  if (focusMode === "stay") {
    // "ficar aqui": seta que volta pra origem (corner-up-left)
    ftIco.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`;
    ftLabel.textContent = "Mandar e ficar aqui";
  } else {
    // "ir pra tela": seta que avança (corner-down-right / share)
    ftIco.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/></svg>`;
    ftLabel.textContent = "Ir pra tela";
  }
}
focusToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  focusMode = focusMode === "stay" ? "switch" : "stay";
  renderFocusToggle();
  window.capi.setFocusMode(focusMode);
});

// voltar um nível (botão ‹)
pickerBack.addEventListener("click", (e) => {
  e.stopPropagation();
  goBack();
});

// busca dentro de um nível
pickerSearch.addEventListener("input", () => {
  searchQuery = pickerSearch.value;
  selIdx = 0;
  refilter();
});
pickerSearch.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    pickerSearch.blur();
    moveDest(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    activateRow();
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (searchQuery) { searchQuery = ""; pickerSearch.value = ""; refilter(); }
    else { pickerSearch.blur(); goBack(); }
  }
});

// ---------- seleção ----------
function setSelectionVisual(r) {
  selection.style.left = r.x + "px";
  selection.style.top = r.y + "px";
  selection.style.width = r.w + "px";
  selection.style.height = r.h + "px";
  dims.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
}
function normalize(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

let tbDrag = null;
capiFace.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const tb = toolbar.getBoundingClientRect();
  tbDrag = { dx: e.clientX - tb.left, dy: e.clientY - tb.top };
});

fsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!imgReady) return;
  rect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  veil.hidden = true;
  hint.hidden = true;
  fsBtn.hidden = true;
  selection.hidden = true;
  showToolbar();
});

window.addEventListener("mousedown", (e) => {
  if (
    toolbar.contains(e.target) ||
    fsBtn.contains(e.target) ||
    autorecPill.contains(e.target) ||
    idleCancel.contains(e.target)
  )
    return;
  if (voiceOnly) return; // janelinha pequena: sem seleção (Esc/botão cancela)
  if (!imgReady || state !== "idle") return;
  dragging = true;
  hint.hidden = true;
  fsBtn.hidden = true;
  veil.hidden = true;
  start = { x: e.clientX, y: e.clientY };
  rect = { x: start.x, y: start.y, w: 0, h: 0 };
  selection.hidden = false;
  setSelectionVisual(rect);
});

window.addEventListener("mousemove", (e) => {
  if (tbDrag) {
    const tb = toolbar.getBoundingClientRect();
    let left = Math.max(4, Math.min(e.clientX - tbDrag.dx, window.innerWidth - tb.width - 4));
    let top = Math.max(4, Math.min(e.clientY - tbDrag.dy, window.innerHeight - tb.height - 4));
    toolbar.style.left = left + "px";
    toolbar.style.top = top + "px";
    return;
  }
  if (!dragging) return;
  rect = normalize(start, { x: e.clientX, y: e.clientY });
  setSelectionVisual(rect);
});

window.addEventListener("mouseup", () => {
  if (tbDrag) {
    tbDrag = null;
    return;
  }
  if (!dragging) return;
  dragging = false;
  if (!rect || rect.w < 6 || rect.h < 6) {
    selection.hidden = true;
    veil.hidden = false;
    hint.hidden = false;
    fsBtn.hidden = false;
    rect = null;
    return;
  }
  showToolbar();
});

function positionToolbar() {
  if (voiceOnly || !rect) return; // modo voz: o CSS já posiciona na janelinha
  const margin = 12;
  const tb = toolbar.getBoundingClientRect();
  let top = (selection.hidden ? rect.y : rect.y + rect.h) + margin;
  if (top + tb.height > window.innerHeight - 8) top = rect.y - tb.height - margin;
  if (top < 8) top = 8;
  let left = rect.x + rect.w / 2 - tb.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tb.width - 8));
  toolbar.style.top = top + "px";
  toolbar.style.left = left + "px";
}

// terminou a seleção -> abre o painel. Grava sozinho OU já vai pra escolha.
function showToolbar() {
  idleCancel.hidden = true;
  autorecPill.hidden = true;
  toolbar.hidden = false;
  positionToolbar();
  if (autoRecord) {
    startRecording();
  } else {
    enterPicking(true); // sem gravar: digita ou clica no mic
  }
}

function setMicRecording(on) {
  micBtn.classList.toggle("recording", on);
}

note.addEventListener("input", () => {
  if (state === "picking") { editing = true; userEdited = true; }
});

// ---------- gravação + transcrição ao vivo (em pedaços) ----------
let mediaRecorder = null;
let micStream = null;
let chunks = [];
let timerId = null;
let seconds = 0;
let transcribing = false; // chunk em voo (live)
let finalizing = false; // transcrição FINAL rolando (pós-Enter), seletor já aberto
let pendingCommit = false; // usuário já escolheu destino, espera transcrição
let userEdited = false; // editou o texto à mão? (não sobrescrever)
let xcribeTimer = null;
let liveText = "";
let audioCtx = null;
let analyser = null;
let vuRAF = null;

async function startRecording() {
  state = "recording";
  committed = false;
  finalizing = false;
  pendingCommit = false;
  userEdited = false;
  xcribe.hidden = true;
  if (xcribeTimer) { clearInterval(xcribeTimer); xcribeTimer = null; }
  recDot.classList.remove("done");
  recDot.hidden = false;
  recLabel.textContent = "Gravando";
  setMicRecording(true);
  picker.hidden = true;
  vu.classList.remove("off");
  note.readOnly = true;
  note.classList.remove("editable");
  note.value = "";
  liveText = "";
  editing = false;
  noteListening.hidden = false;
  setStatus("");
  startTimer();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVU(micStream);
    chunks = [];
    mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        chunks.push(e.data);
        liveTranscribe();
      }
    };
    mediaRecorder.onstop = finalizeTranscription;
    mediaRecorder.start(2000);
  } catch (e) {
    recLabel.textContent = "Sem microfone";
    setMicRecording(false);
    noteListening.hidden = true;
    setStatus("Sem acesso ao microfone — pode digitar");
    enterPicking(true);
  }
}

// medidor de áudio ao vivo (VU)
function startVU(stream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      // distribui a energia nas barrinhas
      const n = vuBars.length;
      const step = Math.floor(data.length / n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j];
        const v = sum / step / 255; // 0..1
        const h = Math.max(3, Math.round(3 + v * 15));
        vuBars[i].style.height = h + "px";
        vuBars[i].style.opacity = (0.35 + v * 0.65).toFixed(2);
      }
      vuRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}
function stopVU() {
  if (vuRAF) cancelAnimationFrame(vuRAF);
  vuRAF = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  vuBars.forEach((b) => (b.style.height = "3px"));
}

// ----- efeito "máquina de escrever": revela o texto letra-a-letra -----
// anima do PREFIXO COMUM até o alvo (lida com refinamentos do STT), interrompível.
let typeTimer = null;
let typeTarget = "";
// completa a digitação na hora (pra enviar texto inteiro mesmo no meio da animação)
function flushType() {
  if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
  if (typeTarget && !userEdited && note.value !== typeTarget) {
    note.value = typeTarget;
    note.scrollTop = note.scrollHeight;
  }
}
function typeInto(target) {
  target = target || "";
  typeTarget = target;
  if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
  const cur = note.value || "";
  let i = 0;
  const max = Math.min(cur.length, target.length);
  while (i < max && cur[i] === target[i]) i++;
  note.value = target.slice(0, i); // mantém o que já casava
  let pos = i;
  if (pos >= target.length) { note.scrollTop = note.scrollHeight; return; }
  const remaining = target.length - pos;
  // revela tudo em ~600ms no máx (mín ~6ms/char); rajada maior se vier muito texto
  const perChar = Math.max(6, Math.min(28, Math.round(600 / remaining)));
  const burst = remaining > 80 ? 3 : 1;
  typeTimer = setInterval(() => {
    if (userEdited) { clearInterval(typeTimer); typeTimer = null; return; } // não atropela edição
    pos = Math.min(target.length, pos + burst);
    note.value = target.slice(0, pos);
    note.scrollTop = note.scrollHeight;
    if (pos >= target.length) { clearInterval(typeTimer); typeTimer = null; }
  }, perChar);
}

// re-transcreve o áudio acumulado e atualiza a caixa enquanto a pessoa fala
async function liveTranscribe() {
  if (state !== "recording" || transcribing || !chunks.length) return;
  transcribing = true;
  try {
    const blob = new Blob(chunks, { type: "audio/webm" });
    const wav = await blobToWavBase64(blob);
    const res = await window.capi.transcribe({ base64: wav, mime: "audio/wav" });
    if (state === "recording" && res && res.ok && res.text) {
      liveText = res.text;
      noteListening.hidden = true;
      typeInto(res.text); // streaming letra-a-letra
    }
  } catch {}
  transcribing = false;
}

function startTimer() {
  seconds = 0;
  recTimer.textContent = "0:00";
  timerId = setInterval(() => {
    seconds++;
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");
    recTimer.textContent = `${m}:${s}`;
  }, 1000);
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function stopRecording() {
  if (state !== "recording") return;
  stopTimer();
  stopVU();
  setMicRecording(false);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  // vai DIRETO pro seletor — a transcrição final roda em background
  finalizing = chunks.length > 0;
  enterPicking(false);
  if (finalizing) startXcribe();
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop(); // dispara onstop -> finalizeTranscription
  } else {
    finalizeTranscription();
  }
}

// ----- barra de transcrição dinâmica (ajusta ao tempo real) -----
function startXcribe() {
  xcribe.hidden = false;
  xcribe.classList.remove("done");
  // estimativa por duração do áudio; a barra anima até 92% e completa quando chega
  const est = Math.min(8, Math.max(1, seconds * 0.35));
  xcribeBar.style.transition = "none";
  xcribeBar.style.width = "8%";
  // força reflow e anima
  void xcribeBar.offsetWidth;
  xcribeBar.style.transition = `width ${est}s cubic-bezier(.15,.75,.25,1)`;
  xcribeBar.style.width = "92%";
  let t0 = 0;
  if (xcribeTimer) clearInterval(xcribeTimer);
  xcribeTimer = setInterval(() => {
    t0 += 0.1;
    xcribeLabel.textContent = `Transcrevendo… ${t0.toFixed(1).replace(".", ",")}s`;
  }, 100);
}
function finishXcribe() {
  if (xcribeTimer) { clearInterval(xcribeTimer); xcribeTimer = null; }
  xcribe.classList.add("done");
  xcribeBar.style.transition = "width .25s ease-out";
  xcribeBar.style.width = "100%";
  xcribeLabel.textContent = "Pronto";
  setTimeout(() => { xcribe.hidden = true; }, 700);
}

async function finalizeTranscription() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  let text = liveText || note.value;
  try {
    if (chunks.length) {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const wav = await blobToWavBase64(blob);
      const res = await window.capi.transcribe({ base64: wav, mime: "audio/wav" });
      if (res && res.ok && res.text) text = res.text;
    }
  } catch {}
  // só sobrescreve se a pessoa não editou à mão
  if (!userEdited) {
    typeInto(text); // completa o texto final letra-a-letra (a partir do que já apareceu)
  }
  finalizing = false;
  finishXcribe();
  recDot.classList.add("done");
  recLabel.textContent = "Pronto";
  // se já escolheu o destino, manda agora
  if (pendingCommit) { pendingCommit = false; commit(); }
}

// abre a TELINHA DE DESTINOS (não envia direto)
// noText=true  -> estado "pronto sem gravar ainda" (pode falar/digitar)
// noText=false -> já transcreveu, mostra "Pronto"
function enterPicking(noText) {
  state = "picking";
  stopTimer();
  stopVU();
  setMicRecording(false);
  vu.classList.add("off");
  noteListening.hidden = true;
  setStatus("");
  if (noText) {
    recDot.hidden = true;
    recLabel.textContent = "Fale ou digite";
  } else {
    recDot.hidden = false;
    recDot.classList.toggle("done", !finalizing);
    recLabel.textContent = finalizing ? "Transcrevendo" : "Pronto";
  }
  note.readOnly = false;
  note.classList.add("editable");
  renderPicker();
  picker.hidden = false;
  positionToolbar();
  if (noText) {
    note.focus();
    editing = true;
  }
}

// ---------- WAV (pro Whisper/Gemini) ----------
function toBase64(uint8) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk)
    bin += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk));
  return btoa(bin);
}
function downsample(input, inRate, outRate) {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}
function encodeWav(float32, inRate, outRate) {
  const s = downsample(float32, inRate, outRate);
  const buf = new ArrayBuffer(44 + s.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + s.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, s.length * 2, true);
  let off = 44;
  for (let i = 0; i < s.length; i++) {
    const x = Math.max(-1, Math.min(1, s[i]));
    v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    off += 2;
  }
  return buf;
}
async function blobToWavBase64(blob) {
  const arr = await blob.arrayBuffer();
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await actx.decodeAudioData(arr);
  const mono = audio.getChannelData(0);
  const wav = encodeWav(mono, audio.sampleRate, 16000);
  actx.close();
  return toBase64(new Uint8Array(wav));
}

// ---------- recorte (sem legenda: o texto é digitado no chat) ----------
function composeDataURL() {
  const scaleX = shot.naturalWidth / window.innerWidth;
  const scaleY = shot.naturalHeight / window.innerHeight;
  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);
  const sw = Math.round(rect.w * scaleX);
  const sh = Math.round(rect.h * scaleY);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

async function commit() {
  if (committed || (!rect && !voiceOnly)) return; // modo voz não tem rect
  const target = selectedTarget();
  // ainda transcrevendo? marca o destino e envia assim que terminar
  if (finalizing) {
    pendingCommit = true;
    setStatus(`Envio pro "${target.name || "destino"}" assim que terminar de transcrever…`);
    return;
  }
  committed = true;
  flushType(); // se ainda estava "digitando", completa o texto antes de enviar
  const imageDataURL = voiceOnly ? null : composeDataURL(); // sem print no modo voz
  const res = await window.capi.commit({
    imageDataURL,
    note: note.value,
    targetId: target.id,
    targetBundle: target.bundleId,
    windowMatch: target.windowMatch || null,
    focusMode,
    newProject: target.newProject || false,
  });
  // GATE de conta: o main pode pedir login ou mostrar o paywall (20 usos grátis)
  if (res && res.needLogin) {
    committed = false; // deixa reenviar depois de logar
    setStatus("Entre na Capi pra enviar — abri o login. Depois é só apertar Enter.");
    return;
  }
  if (res && res.paywall) {
    committed = false;
    showPaywall(res.payUrl);
    return;
  }
  // sucesso → o main fecha o overlay.
}

// Painel de paywall (envios grátis esgotados). Autossuficiente, sem depender do CSS.
function showPaywall(payUrl) {
  if (document.getElementById("capi-paywall")) return;
  const wrap = document.createElement("div");
  wrap.id = "capi-paywall";
  wrap.style.cssText =
    "position:fixed;inset:0;display:grid;place-items:center;z-index:99999;" +
    "background:rgba(30,27,46,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)";
  wrap.innerHTML =
    '<div style="width:340px;max-width:86vw;background:#fff;border-radius:18px;padding:24px;' +
    'text-align:center;box-shadow:0 30px 60px -20px rgba(91,63,214,.5);' +
    'font-family:-apple-system,system-ui,sans-serif;color:#1e1b2e">' +
    '<img src="../../assets/capi-mascote.png" style="width:54px;height:54px;border-radius:13px" />' +
    '<h2 style="font-size:18px;margin:12px 0 4px">Seus 20 envios grátis acabaram</h2>' +
    '<p style="color:#6b6580;font-size:13.5px;margin:0 0 18px;line-height:1.5">' +
    "Libere a Capi ilimitada por <b>R$97</b> (vitalício). Pagou, é só voltar e enviar.</p>" +
    '<button id="capi-pay" style="width:100%;padding:12px;border:0;border-radius:12px;' +
    'background:#7c5cff;color:#fff;font-weight:700;font-size:14.5px;cursor:pointer">Pagar R$97 e liberar</button>' +
    '<button id="capi-paylater" style="width:100%;margin-top:9px;padding:10px;border:0;' +
    'background:transparent;color:#6b6580;font-size:13px;cursor:pointer">Agora não</button>' +
    "</div>";
  document.body.appendChild(wrap);
  document.getElementById("capi-pay").onclick = () => window.capi.openPay(payUrl);
  document.getElementById("capi-paylater").onclick = () => window.capi.cancel();
}

// ---------- teclado ----------
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    if (state === "picking" && editing) {
      // sai do modo edição, volta pro foco da lista
      editing = false;
      note.blur();
      return;
    }
    // dentro de um nível? Esc sobe um nível (não cancela tudo)
    if (state === "picking" && pickLevel !== "apps") {
      goBack();
      return;
    }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    window.capi.cancel();
    return;
  }

  if (state === "recording") {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      stopRecording(); // Enter para de gravar -> vai pra telinha
    }
    return;
  }

  if (state === "picking") {
    // se estiver editando o texto, só a navegação por setas/Enter "rouba" o foco
    if (e.key === "ArrowDown") {
      e.preventDefault();
      editing = false;
      note.blur();
      moveDest(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      editing = false;
      note.blur();
      moveDest(-1);
    } else if (e.key === "ArrowRight" && !editing) {
      // → entra no item selecionado (app ou projeto)
      if (rows[selIdx] && rows[selIdx].descend) { e.preventDefault(); activateRow(); }
    } else if (e.key === "ArrowLeft" && !editing) {
      e.preventDefault();
      goBack();
    } else if (e.key === "Enter" && !e.shiftKey && !editing) {
      e.preventDefault();
      activateRow(); // Enter: desce no app OU envia pro destino
    } else if (e.key === "Tab") {
      e.preventDefault();
      // Tab alterna entre editar o texto e a lista
      editing = !editing;
      if (editing) {
        note.focus();
        const len = note.value.length;
        note.setSelectionRange(len, len);
      } else {
        note.blur();
      }
    }
    return;
  }
});
