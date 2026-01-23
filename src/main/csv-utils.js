const fs = require("fs");

function normalizeNumeric(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const cleaned = String(value).replace(/kB|%/gi, "").trim();
  const parsed = Number(cleaned);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseCsvLine(headers, delimiter, line) {
  const parts = line.split(delimiter);
  const row = {};
  headers.forEach((header, index) => {
    row[header] = parts[index] ? parts[index].trim() : "";
  });
  return row;
}

async function parseCsvStream(filePath, { maxRows = 5000, avgLineBytes = 80 } = {}) {
  const fsStat = fs.statSync(filePath);
  const estimatedLines = Math.max(1, Math.ceil(fsStat.size / avgLineBytes));
  const stride = Math.max(1, Math.ceil(estimatedLines / maxRows));

  const readline = require("readline");
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = [];
  let delimiter = ",";
  let lineIndex = 0;
  const rows = [];

  for await (const line of rl) {
    if (!line) continue;
    if (lineIndex === 0) {
      delimiter = line.includes("\t") ? "\t" : ",";
      headers = line.split(delimiter).map(header => header.trim());
      lineIndex += 1;
      continue;
    }
    if (lineIndex % stride === 0) {
      rows.push(parseCsvLine(headers, delimiter, line));
    }
    lineIndex += 1;
  }

  if (headers.length === 0) {
    return { headers: [], rows: [] };
  }
  return { headers, rows };
}

function formatTimestamp(value) {
  if (value === undefined || value === null) {
    return "";
  }

  const raw = String(value).trim();
  if (!raw) {
    return "";
  }

  // ✅ 新增：yyyyMMdd-HHmmss
  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const [, y, m, d, hh, mm, ss] = compactMatch;
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }

  // 原有：yyyy-MM-dd HH:mm:ss / yyyy/MM/dd HH:mm:ss
  const dateMatch = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:[ T](\d{2})(?::(\d{2}))(?::(\d{2}))?)?$/);
  if (dateMatch) {
    const [, year, month, day, hour = "00", minute = "00", second = "00"] = dateMatch;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  // 原有：epoch 秒 / 毫秒
  if (/^\d{10,13}$/.test(raw)) {
    const epoch = Number(raw.length === 10 ? `${raw}000` : raw);
    const date = new Date(epoch);
    if (!Number.isNaN(date.getTime())) {
      const pad = n => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
  }

  return raw.replace(/\//g, "-");
}

function buildSeries(data) {
  const { headers, rows } = data;
  const timeAxis = rows.map(row => formatTimestamp(row.timestamp));
  const metrics = headers.filter(field => field !== "timestamp" && !field.toLowerCase().endsWith("_pid"));
  const useSampling = rows.length > 2000;
  const series = metrics.map(field => ({
    name: field,
    type: "line",
    showSymbol: false,
    sampling: useSampling ? "lttb" : undefined,
    progressive: useSampling ? 1000 : undefined,
    data: rows.map(row => normalizeNumeric(row[field])),
  }));

  const pidFields = headers.filter(field => field.toLowerCase().endsWith("_pid"));
  const restarts = pidFields.map(field => {
    let lastPid = null;
    let restartsCount = 0;
    rows.forEach(row => {
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
    restarts,
  };
}

module.exports = {
  buildSeries,
  formatTimestamp,
  normalizeNumeric,
  parseCsvLine,
  parseCsvStream,
};
