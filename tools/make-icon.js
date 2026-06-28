// Rasteriza o contorno da Capi (SVG) em PNGs de template pra barra de menu.
// Uma janela só (evita corrida), captura em @2x e deriva o @1x por resize.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(ROOT, "assets", "capi-glyph.svg"), "utf8");

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  // janela de 18pt -> em Retina captura 36px (nosso @2x)
  const win = new BrowserWindow({
    width: 18,
    height: 18,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  });
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;}
    svg{display:block;width:18px;height:18px;}
  </style></head><body>${svg}</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 250));
  const img2x = await win.webContents.capturePage();
  win.destroy();

  const out = path.join(ROOT, "assets");
  fs.writeFileSync(path.join(out, "capiTemplate@2x.png"), img2x.toPNG());
  const img1x = img2x.resize({ width: 18, height: 18, quality: "best" });
  fs.writeFileSync(path.join(out, "capiTemplate.png"), img1x.toPNG());
  console.log("@2x", img2x.getSize(), "@1x", img1x.getSize());
  app.quit();
});
