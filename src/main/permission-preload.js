const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("capiPerm", {
  report: (r) => ipcRenderer.send("perm:result", r),
});
