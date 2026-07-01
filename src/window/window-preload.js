const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capiWin", {
  getState: () => ipcRenderer.invoke("win:getState"),
  setOption: (key, value) => ipcRenderer.send("win:setOption", { key, value }),
  capture: () => ipcRenderer.send("win:capture"),
  openPanel: () => ipcRenderer.send("win:openPanel"),
  openScreenPrefs: () => ipcRenderer.send("win:openScreenPrefs"),
  openAxPrefs: () => ipcRenderer.send("win:openAxPrefs"),
  openNotifPrefs: () => ipcRenderer.send("win:openNotifPrefs"),
  pickTarget: () => ipcRenderer.send("win:pickTarget"),
  removeTarget: (bundleId) => ipcRenderer.send("win:removeTarget", bundleId),
  setDefault: (bundleId) => ipcRenderer.send("win:setDefault", bundleId),
  // agentes
  listRunningApps: () => ipcRenderer.invoke("win:listRunningApps"),
  listClaudeProjects: () => ipcRenderer.invoke("win:listClaudeProjects"),
  listAppWindows: (bundleId) => ipcRenderer.invoke("win:listAppWindows", bundleId),
  grabActiveWindow: (bundleId) => ipcRenderer.invoke("win:grabActiveWindow", bundleId),
  setShortcut: (which, accel) => ipcRenderer.invoke("win:setShortcut", { which, accel }),
  saveAgent: (agent) => ipcRenderer.send("win:saveAgent", agent),
  removeAgent: (id) => ipcRenderer.send("win:removeAgent", id),
  setAgentDefault: (id) => ipcRenderer.send("win:setAgentDefault", id),
  // projetos (nível 2 dos apps de IA)
  listProjects: (bundleId) => ipcRenderer.invoke("win:listProjects", bundleId),
  archiveProject: (key) => ipcRenderer.send("win:archiveProject", key),
  unarchiveProject: (key) => ipcRenderer.send("win:unarchiveProject", key),
  saveProject: (proj) => ipcRenderer.send("win:saveProject", proj),
  // frentes (abrir janela + Claude Code + briefing) + fixar
  launchFrente: (id) => ipcRenderer.invoke("win:launchFrente", id),
  seedCapiFrentes: () => ipcRenderer.invoke("win:seedCapiFrentes"),
  togglePinAgent: (id) => ipcRenderer.send("win:togglePinAgent", id),
  // apps (nível 1) + contatos
  saveApp: (app) => ipcRenderer.send("win:saveApp", app),
  removeApp: (bundleId) => ipcRenderer.send("win:removeApp", bundleId),
  saveContact: (contact) => ipcRenderer.send("win:saveContact", contact),
  removeContact: (id) => ipcRenderer.send("win:removeContact", id),
  onState: (cb) => ipcRenderer.on("win:state", (_e, s) => cb(s)),
  onFocusApp: (cb) => ipcRenderer.on("win:focusApp", (_e, bundleId) => cb(bundleId)),
});
