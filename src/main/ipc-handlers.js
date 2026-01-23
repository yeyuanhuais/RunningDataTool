function registerIpcHandlers({
  ipcMain,
  selectFolder,
  refreshFolder,
  loadCsvFile,
  deployScript,
  downloadCsv,
  rootDir,
}) {
  ipcMain.handle("select-folder", async () => selectFolder());
  ipcMain.handle("refresh-folder", async (event, folder) => {
    if (!folder) {
      return null;
    }
    return refreshFolder(folder);
  });
  ipcMain.handle("load-csv", async (event, folder, filename) => {
    if (!folder || !filename) {
      return null;
    }
    return loadCsvFile(folder, filename);
  });
  ipcMain.handle("deploy-script", async (event, payload) => deployScript({ ...payload, rootDir }));
  ipcMain.handle("download-csv", async (event, payload) => downloadCsv(payload));
}

module.exports = { registerIpcHandlers };
