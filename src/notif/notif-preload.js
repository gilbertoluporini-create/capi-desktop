// Ponte segura entre a telinha de notificação (renderer) e o main.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("notif", {
  onShow: (cb) => ipcRenderer.on("notif:show", (_e, data) => cb(data)),
  reply: () => ipcRenderer.send("notif:reply"),
  dismiss: () => ipcRenderer.send("notif:dismiss"),
  // pausa/retoma a contagem regressiva (quando o mouse entra/sai do card)
  hold: (on) => ipcRenderer.send("notif:hold", !!on),
});
