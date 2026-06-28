// Ponte segura entre a janela de login (renderer) e o processo principal.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capiLogin", {
  submit: (email, password) => ipcRenderer.invoke("login:submit", { email, password }),
  signup: () => ipcRenderer.send("login:signup"),
  cancel: () => ipcRenderer.send("login:cancel"),
});
