const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { registerIpcHandlers } = require("./src/main/ipc-handlers");
const { selectFolder, refreshFolder, loadCsvFile } = require("./src/main/file-manager");
const { deployScript, downloadCsv } = require("./src/main/ssh-utils");
const { createWindow } = require("./src/main/window");

const rootDir = __dirname;

app.whenReady().then(() => {
  registerIpcHandlers({
    ipcMain,
    selectFolder,
    refreshFolder,
    loadCsvFile,
    deployScript,
    downloadCsv,
    rootDir,
  });

  createWindow(rootDir);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(rootDir);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
