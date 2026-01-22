const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  loadCsv: (folder, filename) => ipcRenderer.invoke('load-csv', folder, filename)
});
