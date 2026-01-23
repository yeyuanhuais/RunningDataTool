const { app, dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

function runCommand(command, args, options) {
  return new Promise(resolve => {
    const timeoutMs = (options && options.timeoutMs) || 30000; // 默认 30s
    const child = spawn(command, args, {
      windowsHide: true,
      ...(options || {}),
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try {
        child.kill();
      } catch (_) {}
    }, timeoutMs);

    child.stdout &&
      child.stdout.on("data", data => {
        stdout += data.toString();
      });
    child.stderr &&
      child.stderr.on("data", data => {
        stderr += data.toString();
      });

    child.on("error", error => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });

    child.on("close", code => {
      clearTimeout(timer);
      if (killedByTimeout) {
        resolve({ code: 124, stdout, stderr: `Command timeout after ${timeoutMs}ms` });
        return;
      }
      resolve({ code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

function getKnownHostsNull() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

async function commandExists(command) {
  if (process.platform === "win32") {
    const result = await runCommand("where", [command]);
    return result.code === 0;
  }
  // 不用 which，改用 command -v 更稳
  const result = await runCommand("sh", ["-c", `command -v ${command} >/dev/null 2>&1`]);
  return result.code === 0;
}

function sshBaseArgs() {
  // 你原本只加 StrictHostKeyChecking=no，这里加上 KnownHostsFile 避免污染/卡住
  return ["-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${getKnownHostsNull()}`];
}

function getSshDir() {
  // Electron 主进程里 os.homedir() 可用
  const os = require("os");
  return path.join(os.homedir(), ".ssh");
}

function getKeyCachePath() {
  // 缓存免密初始化成功的主机，减少重复探测
  try {
    return path.join(app.getPath("userData"), "known-key-hosts.json");
  } catch (_) {
    // app 可能尚未 ready，这里回退到用户目录
    const os = require("os");
    return path.join(os.homedir(), ".running-data-tool", "known-key-hosts.json");
  }
}

function loadKeyCache() {
  const cachePath = getKeyCachePath();
  try {
    if (!fs.existsSync(cachePath)) return { hosts: {} };
    const raw = fs.readFileSync(cachePath, "utf-8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { hosts: {} };
    return { hosts: data.hosts || {} };
  } catch (_) {
    return { hosts: {} };
  }
}

function saveKeyCache(cache) {
  const cachePath = getKeyCachePath();
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache || { hosts: {} }, null, 2), "utf-8");
  } catch (_) {
    // 忽略缓存写入失败
  }
}

function markHostKeyReady(hostKey) {
  const cache = loadKeyCache();
  cache.hosts[hostKey] = { ready: true, ts: Date.now() };
  saveKeyCache(cache);
}

function isHostKeyReady(hostKey) {
  const cache = loadKeyCache();
  return !!(cache.hosts && cache.hosts[hostKey] && cache.hosts[hostKey].ready);
}

function escapeForDoubleQuotes(s) {
  // 远端 bash -lc "..."; 这里要转义双引号与反斜杠
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim();
}

/**
 * 确保免密已初始化：
 * - 本地生成 id_rsa / id_rsa.pub（若不存在）
 * - 远端 ~/.ssh/authorized_keys 追加公钥（去重）
 * - chmod 600 authorized_keys
 *
 * password 参数存在时使用 ssh2 执行初始化，避免 ssh 交互卡住
 */
async function ensureKeyAuth({ ip, username, password }) {
  const user = username || "root";
  const host = `${user}@${ip}`;
  const baseArgs = [...sshBaseArgs(), "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];
  const hostKey = host;

  if (isHostKeyReady(hostKey)) {
    return { ok: true, message: "免密已缓存" };
  }

  // 1) 检查本机 ssh / ssh-keygen 是否存在
  const hasSsh = await commandExists(process.platform === "win32" ? "ssh" : "ssh");
  const hasKeygen = await commandExists(process.platform === "win32" ? "ssh-keygen" : "ssh-keygen");
  if (!hasSsh || !hasKeygen) {
    return { ok: false, message: "未找到 ssh/ssh-keygen，请先安装 OpenSSH 客户端" };
  }

  // 2) 确保本地 key 存在
  const sshDir = getSshDir();
  const keyPath = path.join(sshDir, "id_rsa");
  const pubPath = path.join(sshDir, "id_rsa.pub");

  try {
    if (!fs.existsSync(sshDir)) fs.mkdirSync(sshDir, { recursive: true });
  } catch (e) {
    return { ok: false, message: `创建本地 .ssh 目录失败: ${e.message || e}` };
  }

  if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
    // 生成 key：ssh-keygen -t rsa -b 2048 -N "" -f <path>
    const keygenArgs = ["-t", "rsa", "-b", "2048", "-N", "", "-f", keyPath];
    const keygenRes = await runCommand("ssh-keygen", keygenArgs);
    if (keygenRes.code !== 0) {
      return { ok: false, message: `生成 SSH key 失败: ${keygenRes.stderr || keygenRes.stdout}` };
    }
  }

  // 3) 读取公钥并推送到远端 authorized_keys（去重）
  let pub = "";
  try {
    pub = fs.readFileSync(pubPath, "utf-8").trim();
  } catch (e) {
    return { ok: false, message: `读取公钥失败: ${e.message || e}` };
  }
  if (!pub) return { ok: false, message: "本地公钥为空" };

  const pubEsc = escapeForDoubleQuotes(pub);

  async function runSsh2InitCommand(cmd, { timeoutMs = 60000 } = {}) {
    if (!password) {
      return { code: 1, stdout: "", stderr: "Missing password for ssh2 init" };
    }
    const { Client } = require("ssh2");
    return new Promise(resolve => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const conn = new Client();
      const timer = setTimeout(() => {
        try {
          conn.end();
        } catch (_) {}
        finish({ code: 124, stdout, stderr: `Command timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      conn.on("ready", () => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            finish({ code: 1, stdout, stderr: err.message });
            return;
          }
          stream.on("data", data => {
            stdout += data.toString();
          });
          stream.stderr.on("data", data => {
            stderr += data.toString();
          });
          stream.on("close", code => {
            clearTimeout(timer);
            conn.end();
            finish({ code: code == null ? 1 : code, stdout, stderr });
          });
        });
      });

      conn.on("error", err => {
        clearTimeout(timer);
        finish({ code: 1, stdout, stderr: err.message });
      });

      conn.connect({
        host: ip,
        username: user,
        password,
        readyTimeout: timeoutMs,
      });
    });
  }

  async function runSshInitCommand(cmd, { timeoutMs = 60000, retries = 2, intervalMs = 2000 } = {}) {
    let last = null;
    for (let i = 0; i < retries; i += 1) {
      const res = password
        ? await runSsh2InitCommand(cmd, { timeoutMs })
        : await runCommand("ssh", [...baseArgs, "-o", "BatchMode=yes", host, cmd], { timeoutMs });
      last = res;
      if (res.code === 0) return res;
      if (!isTransientSshError(res)) return res;
      await sleep(intervalMs);
    }
    return last || { code: 1, stdout: "", stderr: "SSH init retry failed" };
  }

  // 3.1 远端准备目录/文件
  {
    const cmd = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys";
    const res = await runSshInitCommand(cmd);
    if (res.code !== 0) {
      return { ok: false, message: `远端准备 ~/.ssh 失败: ${res.stderr || res.stdout}` };
    }
  }

  // 3.2 去重追加（bash -lc 保证 grep/echo 行为一致）
  {
    const cmd = `bash -lc "grep -qxF \\"${pubEsc}\\" ~/.ssh/authorized_keys || echo \\"${pubEsc}\\" >> ~/.ssh/authorized_keys"`;
    const res = await runSshInitCommand(cmd);
    if (res.code !== 0) {
      return { ok: false, message: `写入 authorized_keys 失败: ${res.stderr || res.stdout}` };
    }
  }

  // 3.3 chmod 600
  {
    const cmd = "chmod 600 ~/.ssh/authorized_keys";
    const res = await runSshInitCommand(cmd);
    if (res.code !== 0) {
      return { ok: false, message: `chmod authorized_keys 失败: ${res.stderr || res.stdout}` };
    }
  }

  markHostKeyReady(hostKey);
  return { ok: true, message: "免密初始化完成" };
}

/**
 * 快速探测是否已免密（避免重复执行）
 */
async function checkKeyAuth({ ip, username }) {
  const user = username || "root";
  const host = `${user}@${ip}`;
  const hostKey = host;

  if (isHostKeyReady(hostKey)) {
    return { ok: true, cached: true };
  }

  const baseArgs = [
    ...sshBaseArgs(),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
  ];
  const probeCmd = "echo __KEY_OK__";
  const res = await runCommand("ssh", [...baseArgs, host, probeCmd], { timeoutMs: 8000 });
  if (res.code === 0 && (res.stdout || "").includes("__KEY_OK__")) {
    markHostKeyReady(hostKey);
    return { ok: true };
  }
  return { ok: false };
}

/**
 * 构建 ssh/scp 参数：
 * - 不再使用 sshpass
 * - 若传了 password，则先尝试免密初始化（初始化过程会提示输入密码）
 */
async function buildSshCommand({ ip, username, password }) {
  const user = username || "root";
  const host = `${user}@${ip}`;
  const baseArgs = [...sshBaseArgs(), "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"];

  // 先尝试快速探测免密，避免重复走初始化
  const keyProbe = await checkKeyAuth({ ip, username });

  // 不传 password：直接假设用户已免密，但开启 BatchMode，避免卡在交互
  if (!password) {
    const noPromptArgs = [...baseArgs, "-o", "BatchMode=yes"];
    return { host, baseArgs: noPromptArgs, prefix: [], keyReady: keyProbe.ok };
  }

  // 传了 password：走一次免密初始化（需要用户输入密码一次）
  if (keyProbe.ok) {
    const noPromptArgs = [...baseArgs, "-o", "BatchMode=yes"];
    return { host, baseArgs: noPromptArgs, prefix: [], keyInitialized: true };
  }
  const init = await ensureKeyAuth({ ip, username, password });
  if (!init.ok) {
    return { host, baseArgs, prefix: [], keyInitFailed: true, message: init.message };
  }

  // 初始化成功后，后续就不需要 password / sshpass
  const noPromptArgs = [...baseArgs, "-o", "BatchMode=yes"];
  return { host, baseArgs: noPromptArgs, prefix: [], keyInitialized: true };
}

/**
 * 等待一段时间
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 判断 ssh 输出是否像“正常断开”（常见于 reboot 后）
 */
function isSshDisconnectLike(res) {
  const s = ((res && (res.stderr || "")) + " " + (res && (res.stdout || ""))).toLowerCase();
  return (
    s.includes("connection closed") ||
    s.includes("connection reset") ||
    s.includes("broken pipe") ||
    s.includes("connection timed out") ||
    s.includes("closed by remote host") ||
    s.includes("connection refused")
  );
}

function isTransientSshError(res) {
  const s = ((res && (res.stderr || "")) + " " + (res && (res.stdout || ""))).toLowerCase();
  return (
    s.includes("banner exchange") ||
    s.includes("connection refused") ||
    s.includes("connection reset") ||
    s.includes("connection timed out") ||
    s.includes("closed by remote host") ||
    s.includes("broken pipe")
  );
}

function resolveRootDir(rootDir) {
  if (rootDir) return rootDir;
  try {
    return app.getAppPath();
  } catch (_) {
    return path.resolve(__dirname, "..", "..");
  }
}

/**
 * 部署脚本：
 * - 可选：先 reboot
 * - 等待设备上线
 * - 检查不存在则上传
 * - CRLF 修正、chmod、nohup 单实例启动
 */
async function deployScript({ ip, username, password, rebootFirst = true, rootDir } = {}) {
  if (!ip) {
    return { ok: false, message: "请填写设备 IP" };
  }

  const localName = "shell_recordHMI-20260122.sh";
  const scriptPath = path.join(resolveRootDir(rootDir), localName);
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, message: "未找到脚本文件" };
  }

  const {
    host,
    baseArgs,
    prefix,
    keyInitFailed,
    message: keyMsg,
  } = await buildSshCommand({
    ip,
    username,
    password,
  });
  if (keyInitFailed) {
    return { ok: false, message: keyMsg || "免密初始化失败" };
  }

  const remotePath = `/root/${localName}`;
  const remoteLog = `/root/shell_recordHMI.log`;
  const pidFile = `/tmp/${localName}.pid`;

  // 单实例启动命令（pidfile + kill -0）
  const startCmd =
    `test -f ${remotePath} || { echo "__MISSING__"; exit 2; }; ` +
    `(sed -i 's/\\r$//' ${remotePath} >/dev/null 2>&1 || true); ` +
    `chmod 755 ${remotePath}; ` +
    `if [ -f ${pidFile} ]; then ` +
    `  oldpid=$(cat ${pidFile} 2>/dev/null); ` +
    `  if [ -n "$oldpid" ] && kill -0 "$oldpid" >/dev/null 2>&1; then ` +
    `    echo "__ALREADY_RUNNING__:$oldpid"; exit 0; ` +
    `  fi; ` +
    `fi; ` +
    `nohup /bin/sh ${remotePath} >${remoteLog} 2>&1 & ` +
    `newpid=$!; echo "$newpid" > ${pidFile}; ` +
    `echo "__STARTED__:$newpid";`;

  // 用于探测是否上线
  const onlineProbeCmd = `echo "__ONLINE__"`;

  // 检查文件存在命令
  const existsCmd = `test -f ${remotePath} && echo "__EXISTS__" || echo "__NO__"`;

  // reboot 命令：先 sync 再 reboot
  // 注意：reboot 会导致 ssh 断开，属于正常现象
  const rebootCmd = `sync; reboot`;

  /**
   * 执行 ssh 命令（统一封装）
   */
  async function sshExec(cmd, timeoutMs) {
    const sshArgs = [...prefix, "ssh", ...baseArgs, host, cmd];
    return runCommand(sshArgs[0], sshArgs.slice(1), { timeoutMs });
  }

  async function sshExecWithRetry(cmd, { timeoutMs = 15000, retries = 3, intervalMs = 2000 } = {}) {
    let last = null;
    for (let i = 0; i < retries; i += 1) {
      const res = await sshExec(cmd, timeoutMs);
      last = res;
      if (res.code === 0) return res;
      if (!isTransientSshError(res)) return res;
      await sleep(intervalMs);
    }
    return last || { code: 1, stdout: "", stderr: "SSH retry failed" };
  }

  /**
   * 上传脚本
   */
  async function scpUpload() {
    const scpArgs = [...prefix, "scp", ...baseArgs, scriptPath, `${host}:${remotePath}`];
    const scpRes = await runCommand(scpArgs[0], scpArgs.slice(1), { timeoutMs: 60000 });
    if (scpRes.code === 124) {
      return { ok: false, message: "上传超时：scp 可能在等待交互。请先确认免密已完成。" };
    }
    if (scpRes.code !== 0) {
      return { ok: false, message: `拷贝失败: ${scpRes.stderr || scpRes.stdout}` };
    }
    return { ok: true };
  }

  /**
   * 等待设备重启上线（轮询 ssh）
   */
  async function waitOnline({ maxWaitMs = 5 * 60 * 1000, intervalMs = 5000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const res = await sshExec(onlineProbeCmd, 8000);
      if (res.code === 0 && (res.stdout || "").includes("__ONLINE__")) {
        return { ok: true };
      }
      await sleep(intervalMs);
    }
    return { ok: false, message: "设备重启超时：无法重新连接 ssh" };
  }

  // ---------- 0) 先做一次上线探测（非必须，但能更快给出错误提示） ----------
  {
    const probeRes = await sshExecWithRetry(onlineProbeCmd, { timeoutMs: 15000, retries: 2, intervalMs: 2000 });
    if (probeRes.code === 124) {
      return { ok: false, message: "连接超时：ssh 可能在等待交互（首次连接确认/输入密码）。请先完成免密初始化。" };
    }
    if (probeRes.code !== 0) {
      return { ok: false, message: `无法连接设备: ${probeRes.stderr || probeRes.stdout}` };
    }
  }

  // ---------- 1) 检查远端脚本是否已存在，不存在则上传 ----------
  let exists = false;
  {
    const checkRes = await sshExecWithRetry(existsCmd, { timeoutMs: 20000, retries: 3, intervalMs: 2000 });
    if (checkRes.code === 124) {
      return { ok: false, message: "检查远端失败：ssh 超时（可能在等待交互）。请确认免密已完成。" };
    }
    if (checkRes.code !== 0) {
      return { ok: false, message: `检查远端失败: ${checkRes.stderr || checkRes.stdout}` };
    }
    exists = ((checkRes.stdout || "") + (checkRes.stderr || "")).includes("__EXISTS__");
  }

  if (!exists) {
    const up = await scpUpload();
    if (!up.ok) return up;
  }

  // ---------- 2) 如需要：先 reboot ----------
  if (rebootFirst) {
    const rbRes = await sshExecWithRetry(rebootCmd, { timeoutMs: 15000, retries: 2, intervalMs: 2000 });

    // reboot 后断开是正常的：可能 code != 0 或 stderr 有 connection closed
    // 这里的判定策略：只要不是明显“命令不存在/权限拒绝”，大概率认为 reboot 已触发
    const out = ((rbRes.stdout || "") + " " + (rbRes.stderr || "")).toLowerCase();
    const hardFail = out.includes("permission denied") || out.includes("not found") || (out.includes("reboot:") && out.includes("usage"));

    if (rbRes.code === 124) {
      // 超时也可能是设备卡住/命令未返回；但 reboot 正常也会导致连接中断
      // 这里不直接判失败，继续走 waitOnline
    } else if (rbRes.code !== 0 && hardFail && !isSshDisconnectLike(rbRes)) {
      return { ok: false, message: `reboot 失败: ${rbRes.stderr || rbRes.stdout}` };
    }

    // ---------- 3) 等待上线 ----------
    const w = await waitOnline({ maxWaitMs: 180000, intervalMs: 5000 });
    if (!w.ok) return w;
  }

  // ---------- 4) 上线后启动脚本（单实例） ----------
  {
    const sshRes = await sshExecWithRetry(startCmd, { timeoutMs: 20000, retries: 3, intervalMs: 2000 });

    if (sshRes.code === 124) {
      return { ok: false, message: "执行超时：远端 shell 阻塞或 ssh 不稳定。" };
    }
    if (sshRes.code !== 0) {
      return { ok: false, message: `执行失败: ${(sshRes.stderr || "") + " " + (sshRes.stdout || "")}`.trim() };
    }

    const out = (sshRes.stdout || "") + (sshRes.stderr || "");

    if (out.includes("__MISSING__")) {
      return { ok: false, message: `远端未找到脚本：${remotePath}（可能上传路径/权限有问题）` };
    }

    if (out.includes("__ALREADY_RUNNING__")) {
      // 例：__ALREADY_RUNNING__:1234
      return {
        ok: true,
        message: rebootFirst ? "已重启设备，脚本已在运行（未重复启动）" : "脚本已在运行（未重复启动）",
      };
    }

    if (out.includes("__STARTED__")) {
      // 例：__STARTED__:1234
      return {
        ok: true,
        message: rebootFirst ? "已重启设备并启动脚本" : exists ? "脚本已存在，已启动（单实例）" : "已上传并启动脚本（单实例）",
      };
    }

    // 有些设备 stdout 可能异常，仍返回成功但提示检查日志
    return { ok: true, message: `已执行启动命令（未收到确认输出）。请检查 ${remoteLog}` };
  }
}

async function downloadCsv({ ip, username, password }) {
  if (!ip) {
    return { ok: false, message: "请填写设备 IP" };
  }
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, message: "未选择本地目录" };
  }
  const destination = result.filePaths[0];
  const { host, baseArgs, prefix, keyInitFailed, message } = await buildSshCommand({
    ip,
    username,
    password,
  });
  if (keyInitFailed) {
    return { ok: false, message: message || "免密初始化失败" };
  }

  const latestCmd = "ls -t /hmi/data/*.csv 2>/dev/null | head -n 1";
  const latestRes = await runCommand("ssh", [...prefix, ...baseArgs, host, latestCmd], { timeoutMs: 30000 });
  if (latestRes.code === 124) {
    return { ok: false, message: "获取最新 CSV 超时：ssh 可能在等待交互。请确认免密初始化已完成。" };
  }
  if (latestRes.code !== 0) {
    return { ok: false, message: `获取最新 CSV 失败: ${latestRes.stderr || latestRes.stdout}` };
  }
  const latestPath = (latestRes.stdout || "").trim();
  if (!latestPath) {
    return { ok: false, message: "未找到 CSV 文件" };
  }

  const scpArgs = [...prefix, "scp", "-C", "-r", ...baseArgs, `${host}:${latestPath}`, destination];
  const scpResult = await runCommand(scpArgs[0], scpArgs.slice(1));
  if (scpResult.code !== 0) {
    return { ok: false, message: `下载失败: ${scpResult.stderr || scpResult.stdout}` };
  }
  return { ok: true, message: `CSV 已下载到 ${destination}` };
}

module.exports = {
  deployScript,
  downloadCsv,
  runCommand,
};
