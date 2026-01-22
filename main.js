const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const WINDOW_CONFIG = {
  width: 1200,
  height: 800,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false
  }
};

function normalizeNumeric(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const cleaned = String(value).replace(/kB|%/gi, '').trim();
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { headers: [], rows: [] };
  }
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delimiter).map((header) => header.trim());
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = parts[index] ? parts[index].trim() : '';
    });
    return row;
  });
  return { headers, rows };
}

function buildSeries(data) {
  const { headers, rows } = data;
  const timeAxis = rows.map((row) => row.timestamp || '');
  const metrics = headers.filter((field) =>
    field !== 'timestamp' && !field.toLowerCase().endsWith('_pid')
  );
  const useSampling = rows.length > 2000;
  const series = metrics.map((field) => ({
    name: field,
    type: 'line',
    showSymbol: false,
    sampling: useSampling ? 'lttb' : undefined,
    progressive: useSampling ? 1000 : undefined,
    data: rows.map((row) => normalizeNumeric(row[field]))
  }));

  const pidFields = headers.filter((field) => field.toLowerCase().endsWith('_pid'));
  const restarts = pidFields.map((field) => {
    let lastPid = null;
    let restartsCount = 0;
    rows.forEach((row) => {
      const pidValue = row[field];
      if (!pidValue) {
        return;
      }
      if (lastPid === null) {
        lastPid = pidValue;
        return;
      }
      if (pidValue !== lastPid) {
        restartsCount += 1;
        lastPid = pidValue;
      }
    });
    return { field, restarts: restartsCount };
  });

  return {
    timeAxis,
    series,
    metrics,
    restarts
  };
}

async function selectFolder() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { folder: null, files: [] };
  }
  const folder = result.filePaths[0];
  const entries = fs.readdirSync(folder);
  const csvFiles = entries.filter((entry) => entry.toLowerCase().endsWith('.csv'));
  return { folder, files: csvFiles };
}

function loadCsvFile(folder, filename) {
  const fullPath = path.join(folder, filename);
  const content = fs.readFileSync(fullPath, 'utf-8');
  return buildSeries(parseCsv(content));
}

function createWindow() {
  const win = new BrowserWindow(WINDOW_CONFIG);
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('select-folder', async () => selectFolder());
  ipcMain.handle('load-csv', async (event, folder, filename) => {
    if (!folder || !filename) {
      return null;
    }
    return loadCsvFile(folder, filename);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
