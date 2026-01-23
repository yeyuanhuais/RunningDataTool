const { dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { buildSeries, parseCsvStream } = require("./csv-utils");

async function selectFolder() {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { folder: null, files: [] };
  }
  const folder = result.filePaths[0];
  const entries = fs.readdirSync(folder);
  const csvFiles = entries.filter(entry => entry.toLowerCase().endsWith(".csv"));
  return { folder, files: csvFiles };
}

async function refreshFolder(folder) {
  const entries = fs.readdirSync(folder);
  const csvFiles = entries.filter(entry => entry.toLowerCase().endsWith(".csv"));
  return { folder, files: csvFiles };
}

async function loadCsvFile(folder, filename) {
  const fullPath = path.join(folder, filename);
  const parsed = await parseCsvStream(fullPath);
  return buildSeries(parsed);
}

module.exports = {
  loadCsvFile,
  refreshFolder,
  selectFolder,
};
