const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  refreshFolder: (folder) => ipcRenderer.invoke('refresh-folder',folder),
  loadCsv: (folder, filename) => ipcRenderer.invoke('load-csv', folder, filename),
  deployScript: (payload) => ipcRenderer.invoke('deploy-script', payload),
  downloadCsv: (payload) => ipcRenderer.invoke('download-csv', payload)
});
