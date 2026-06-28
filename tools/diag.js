// Diagnóstico de permissão de tela
const { app, desktopCapturer, systemPreferences, screen } = require("electron");

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  console.log("== plataforma:", process.platform);
  console.log(
    "== status getMediaAccessStatus('screen'):",
    systemPreferences.getMediaAccessStatus("screen")
  );
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 200, height: 200 },
    });
    console.log("== getSources OK, n =", sources.length);
    sources.forEach((s, i) =>
      console.log(
        `   [${i}] name=${s.name} display_id=${s.display_id} thumbEmpty=${s.thumbnail.isEmpty()} size=${JSON.stringify(
          s.thumbnail.getSize()
        )}`
      )
    );
  } catch (e) {
    console.log("== getSources ERRO:", e && e.stack ? e.stack : e);
  }
  console.log(
    "== status APÓS tentativa:",
    systemPreferences.getMediaAccessStatus("screen")
  );
  setTimeout(() => app.quit(), 800);
});
