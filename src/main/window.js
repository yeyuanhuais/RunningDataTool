const path = require("path");
const { BrowserWindow } = require("electron");

function createWindow(rootDir) {
  const windowConfig = {
    width: 1200,
    height: 800,
    icon: path.join(rootDir, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(rootDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  const win = new BrowserWindow(windowConfig);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(rootDir, "index.html"));
  return win;
}

module.exports = { createWindow };
