// Ponte segura entre a janela de onboarding (renderer) e o processo principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capiOnboarding", {
  // escolheu um destino: devolve { installed, name }
  pick: (bundleId) => ipcRenderer.invoke("onboarding:pick", bundleId),
  // confirma o destino como padrão + marca onboarded: { ok, name }
  setDefault: (bundleId) => ipcRenderer.invoke("onboarding:setDefault", bundleId),
  // abre um link externo (baixar app / extensão)
  openExternal: (url) => ipcRenderer.send("onboarding:open-external", url),
  // "Outro app" -> abre a config nativa
  openSettings: () => ipcRenderer.send("onboarding:openSettings"),
  // "Tudo pronto" / "Pular por agora" -> fecha marcando onboarded
  done: () => ipcRenderer.send("onboarding:done"),
});
