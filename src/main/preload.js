// Ponte segura entre o overlay (renderer) e o processo principal
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capi", {
  onInit: (cb) => ipcRenderer.on("overlay:init", (_e, data) => cb(data)),
  cancel: () => ipcRenderer.send("overlay:cancel"),
  commit: (payload) => ipcRenderer.invoke("overlay:commit", payload),
  transcribe: (payload) => ipcRenderer.invoke("overlay:transcribe", payload),
  setFocusMode: (mode) => ipcRenderer.send("overlay:setFocusMode", mode),
  setAutoRecord: (on) => ipcRenderer.send("overlay:setAutoRecord", on),
  openAgentEditor: (bundleId) => ipcRenderer.send("overlay:openAgentEditor", bundleId),
  // gate de conta: abrir login / abrir pagamento (paywall)
  openLogin: () => ipcRenderer.send("overlay:openLogin"),
  openPay: (payUrl) => ipcRenderer.send("overlay:openPay", payUrl),
  // diagnóstico: falha do microfone vai pro log do main (debug Windows)
  micError: (name) => ipcRenderer.send("overlay:micError", name),
});
