// Telinha de notificação: mostra quem respondeu + barra de tempo até sumir.
// A contagem regressiva real (auto-dismiss) é tocada pelo main; aqui só animamos
// a barra e damos os botões. Pausa quando o mouse está em cima.
const card = document.getElementById("card");
const avatar = document.getElementById("avatar");
const fromEl = document.getElementById("from");
const tagEl = document.getElementById("tag");
const bodyEl = document.getElementById("body");
const bar = document.getElementById("bar");

let durationMs = 10000;
let startedAt = 0;
let rafId = null;
let paused = false;
let pausedRemaining = durationMs;

function animateBar() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    if (paused) return;
    const elapsed = performance.now() - startedAt;
    const frac = Math.max(0, 1 - elapsed / durationMs);
    bar.style.transform = `scaleX(${frac})`;
    if (frac > 0) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

window.notif.onShow((data) => {
  fromEl.textContent = data.from || "Agente";
  tagEl.textContent = data.tag || "respondeu você";
  bodyEl.textContent = data.text || "";
  bodyEl.style.display = data.text ? "" : "none";
  if (data.avatar) {
    avatar.src = data.avatar;
    avatar.style.display = "";
  } else {
    avatar.style.display = "none";
  }
  durationMs = data.duration || 10000;

  // entrada animada + começa a barra
  card.classList.remove("out");
  requestAnimationFrame(() => {
    card.classList.add("in");
    startedAt = performance.now();
    paused = false;
    animateBar();
  });
});

// pausa a barra enquanto o mouse está sobre o card (e avisa o main p/ segurar o timer)
card.addEventListener("mouseenter", () => {
  paused = true;
  pausedRemaining = durationMs - (performance.now() - startedAt);
  window.notif.hold(true);
});
card.addEventListener("mouseleave", () => {
  paused = false;
  // retoma de onde parou
  startedAt = performance.now() - (durationMs - pausedRemaining);
  animateBar();
  window.notif.hold(false);
});

document.getElementById("reply").addEventListener("click", () => {
  card.classList.add("out");
  setTimeout(() => window.notif.reply(), 180);
});
function doDismiss() {
  card.classList.add("out");
  setTimeout(() => window.notif.dismiss(), 200);
}
document.getElementById("dismiss").addEventListener("click", doDismiss);
document.getElementById("close").addEventListener("click", doDismiss);
