const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function buildSshCommand({ ip, username, password }) {
  const user = username || 'root';
  const host = `${user}@${ip}`;
  const baseArgs = ['-o', 'StrictHostKeyChecking=no'];
  const prefix = password ? ['sshpass', '-p', password] : [];
  return { host, baseArgs, prefix };
}

async function deployScript({ ip, username, password }) {
  if (!ip) {
    return { ok: false, message: '请填写设备 IP' };
  }
  const scriptPath = path.join(__dirname, 'shell_recordHMI-20260122.sh');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, message: '未找到脚本文件' };
  }
  const { host, baseArgs, prefix } = buildSshCommand({ ip, username, password });

  const scpArgs = [
    ...prefix,
    'scp',
    ...baseArgs,
    scriptPath,
    `${host}:/root/shell_recordHMI-20260122.sh`
  ];
  const scpResult = await runCommand(scpArgs[0], scpArgs.slice(1));
  if (scpResult.code !== 0) {
    return { ok: false, message: `拷贝失败: ${scpResult.stderr || scpResult.stdout}` };
  }

  const remoteCommand = 'chmod 755 /root/shell_recordHMI-20260122.sh && nohup /root/shell_recordHMI-20260122.sh >/root/shell_recordHMI.log 2>&1 &';
  const sshArgs = [
    ...prefix,
    'ssh',
    ...baseArgs,
    host,
    remoteCommand
  ];
  const sshResult = await runCommand(sshArgs[0], sshArgs.slice(1));
  if (sshResult.code !== 0) {
    return { ok: false, message: `执行失败: ${sshResult.stderr || sshResult.stdout}` };
  }
  return { ok: true, message: '部署完成，长跑已启动' };
}

async function downloadCsv({ ip, username, password }) {
  if (!ip) {
    return { ok: false, message: '请填写设备 IP' };
  }
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, message: '未选择本地目录' };
  }
  const destination = result.filePaths[0];
  const { host, baseArgs, prefix } = buildSshCommand({ ip, username, password });
  const scpArgs = [
    ...prefix,
    'scp',
    '-r',
    ...baseArgs,
    `${host}:/hmi/data/*.csv`,
    destination
  ];
  const scpResult = await runCommand(scpArgs[0], scpArgs.slice(1));
  if (scpResult.code !== 0) {
    return { ok: false, message: `下载失败: ${scpResult.stderr || scpResult.stdout}` };
  }
  return { ok: true, message: `CSV 已下载到 ${destination}` };
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
  ipcMain.handle('deploy-script', async (event, payload) => deployScript(payload));
  ipcMain.handle('download-csv', async (event, payload) => downloadCsv(payload));

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
