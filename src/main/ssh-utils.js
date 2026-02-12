const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { dialog, app } = require("electron");

/**
 * 统一的错误包装（可选）
 */
function makeErr(message, extra) {
  const err = new Error(message);
  if (extra) err.extra = extra;
  return err;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveRootDir(rootDir) {
  if (rootDir) return rootDir;
  try {
    return app.getAppPath();
  } catch (_) {
    return path.resolve(__dirname);
  }
}

function defaultKeyPath() {
  const p = path.join(os.homedir(), ".ssh", "id_rsa");
  return fs.existsSync(p) ? p : "";
}

/**
 * ========== 1) SSH 基础封装：连接 / exec / sftp ==========
 *
 * 设计点：
 * - 每次操作使用短连接（简单可靠，方便超时控制）
 * - 如果你想做连接复用，也可以把 connect/disconnect 提出来复用一条连接
 */
class SshClient {
  /**
   * @param {{
   *  host: string,
   *  port?: number,
   *  username: string,
   *  password?: string,
   *  privateKeyPath?: string,
   *  readyTimeoutMs?: number,
   *  keepaliveInterval?: number
   * }} options
   */
  constructor(options) {
    this.options = options || {};
  }

  _buildConfig() {
    const o = this.options;
    if (!o.host) throw makeErr("Missing host");
    if (!o.username) throw makeErr("Missing username");

    const cfg = {
      host: o.host,
      port: o.port || 22,
      username: o.username,
      readyTimeout: o.readyTimeoutMs || 15000,
      keepaliveInterval: o.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
    };

    if (o.password) {
      cfg.password = o.password;
      cfg.tryKeyboard = true;
    } else {
      const kp = o.privateKeyPath || defaultKeyPath();
      if (!kp) throw makeErr("Missing privateKeyPath and default ~/.ssh/id_rsa not found");
      cfg.privateKey = fs.readFileSync(kp, "utf8");
    }

    return cfg;
  }

  /**
   * 执行命令（带超时）
   * @param {string} command
   * @param {{timeoutMs?: number}} opts
   * @returns {Promise<{code:number, stdout:string, stderr:string}>}
   */
  exec(command, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 30000;
    const config = this._buildConfig();

    return new Promise((resolve) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };

      const timer = setTimeout(() => {
        try {
          conn.end();
        } catch (_) {}
        finish({ code: 124, stdout, stderr: `Command timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      if (config.password) {
        conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finishPrompts) => {
          finishPrompts((prompts || []).map(() => config.password));
        });
      }

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            finish({ code: 1, stdout, stderr: err.message });
            return;
          }
          stream.on("data", (d) => (stdout += d.toString()));
          stream.stderr.on("data", (d) => (stderr += d.toString()));
          stream.on("close", (code) => {
            clearTimeout(timer);
            conn.end();
            finish({ code: code == null ? 1 : code, stdout, stderr });
          });
        });
      });

      conn.on("error", (e) => {
        clearTimeout(timer);
        finish({ code: 1, stdout, stderr: e.message });
      });

      conn.connect(config);
    });
  }

  /**
   * SFTP 上传（fastPut）
   */
  upload(localPath, remotePath, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 60000;
    const config = this._buildConfig();

    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };

      const timer = setTimeout(() => {
        try {
          conn.end();
        } catch (_) {}
        finish({ code: 124, stdout: "", stderr: `SFTP upload timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      if (config.password) {
        conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finishPrompts) => {
          finishPrompts((prompts || []).map(() => config.password));
        });
      }

      conn.on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            finish({ code: 1, stdout: "", stderr: err.message });
            return;
          }
          sftp.fastPut(localPath, remotePath, (e) => {
            clearTimeout(timer);
            conn.end();
            if (e) {
              finish({ code: 1, stdout: "", stderr: e.message });
              return;
            }
            finish({ code: 0, stdout: "", stderr: "" });
          });
        });
      });

      conn.on("error", (e) => {
        clearTimeout(timer);
        finish({ code: 1, stdout: "", stderr: e.message });
      });

      conn.connect(config);
    });
  }

  /**
   * SFTP 下载（fastGet）
   */
  download(remotePath, localPath, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 60000;
    const config = this._buildConfig();

    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };

      const timer = setTimeout(() => {
        try {
          conn.end();
        } catch (_) {}
        finish({ code: 124, stdout: "", stderr: `SFTP download timeout after ${timeoutMs}ms` });
      }, timeoutMs);

      if (config.password) {
        conn.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finishPrompts) => {
          finishPrompts((prompts || []).map(() => config.password));
        });
      }

      conn.on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            finish({ code: 1, stdout: "", stderr: err.message });
            return;
          }
          sftp.fastGet(remotePath, localPath, (e) => {
            clearTimeout(timer);
            conn.end();
            if (e) {
              finish({ code: 1, stdout: "", stderr: e.message });
              return;
            }
            finish({ code: 0, stdout: "", stderr: "" });
          });
        });
      });

      conn.on("error", (e) => {
        clearTimeout(timer);
        finish({ code: 1, stdout: "", stderr: e.message });
      });

      conn.connect(config);
    });
  }
}

/**
 * ========== 2) 部署服务 ==========
 */
class DeployService {
  /**
   * @param {SshClient} ssh
   */
  constructor(ssh) {
    this.ssh = ssh;
  }

  async probeOnline() {
    const r = await this.ssh.exec('echo "__ONLINE__"', { timeoutMs: 8000 });
    return r.code === 0 && (r.stdout || "").includes("__ONLINE__");
  }

  async waitOnline({ maxWaitMs = 180000, intervalMs = 5000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (await this.probeOnline()) return { ok: true };
      await sleep(intervalMs);
    }
    return { ok: false, message: "设备重启超时：无法重新连接 ssh2" };
  }

  async remoteFileExists(remotePath) {
    const r = await this.ssh.exec(`test -f ${remotePath} && echo "__YES__" || echo "__NO__"`, { timeoutMs: 15000 });
    if (r.code !== 0) throw makeErr(`检查远端文件失败: ${r.stderr || r.stdout}`);
    return (r.stdout || "").includes("__YES__");
  }

  /**
   * 单实例启动：pidfile + kill -0
   */
  async startSingleInstance({ remotePath, remoteLog, pidFile }) {
    // 说明：尽量使用 /bin/sh 语法，避免设备缺 bash
    const cmd =
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

    const r = await this.ssh.exec(cmd, { timeoutMs: 20000 });
    if (r.code !== 0) throw makeErr(`启动失败: ${r.stderr || r.stdout}`);

    const out = (r.stdout || "") + (r.stderr || "");
    if (out.includes("__MISSING__")) return { ok: false, message: "远端脚本缺失" };
    if (out.includes("__ALREADY_RUNNING__")) return { ok: true, alreadyRunning: true, raw: out };
    if (out.includes("__STARTED__")) return { ok: true, started: true, raw: out };
    return { ok: true, unknown: true, raw: out };
  }

  /**
   * 部署主流程
   */
  async deployScript({
    localScriptPath,
    remotePath,
    remoteLog,
    rebootFirst = true,
    pidFile,
  }) {
    if (!fs.existsSync(localScriptPath)) {
      return { ok: false, message: `未找到脚本文件: ${localScriptPath}` };
    }

    // 0) 探测在线（更快给错误）
    {
      const online = await this.probeOnline();
      if (!online) {
        // 这里不直接失败，可能是短暂抖动，再试一次
        const online2 = await this.probeOnline();
        if (!online2) return { ok: false, message: "无法连接设备（ssh2 探测失败）" };
      }
    }

    // 1) 不存在则上传
    const exists = await this.remoteFileExists(remotePath);
    if (!exists) {
      const up = await this.ssh.upload(localScriptPath, remotePath, { timeoutMs: 60000 });
      if (up.code !== 0) return { ok: false, message: `上传失败: ${up.stderr}` };
    }

    // 2) 可选 reboot
    if (rebootFirst) {
      // reboot 会断连：ssh2 可能返回 error 或非 0，这里不强行判失败
      await this.ssh.exec("sync; reboot", { timeoutMs: 15000 }).catch(() => {});
      const w = await this.waitOnline({ maxWaitMs: 180000, intervalMs: 5000 });
      if (!w.ok) return w;
    }

    // 3) 启动
    const st = await this.startSingleInstance({ remotePath, remoteLog, pidFile });
    if (!st.ok) return st;

    if (st.alreadyRunning) {
      return { ok: true, message: rebootFirst ? "已重启设备，脚本已在运行（未重复启动）" : "脚本已在运行（未重复启动）" };
    }
    if (st.started) {
      return { ok: true, message: rebootFirst ? "已重启设备并启动脚本" : "已启动脚本（单实例）" };
    }
    return { ok: true, message: `已执行启动命令，但未识别输出。请检查日志：${remoteLog}`, raw: st.raw };
  }
}

/**
 * ========== 3) CSV 下载服务 ==========
 */
class CsvService {
  /**
   * @param {SshClient} ssh
   */
  constructor(ssh) {
    this.ssh = ssh;
  }

  async getLatestCsvPath() {
    const cmd = "ls -t /hmi/data/*.csv 2>/dev/null | head -n 1";
    const r = await this.ssh.exec(cmd, { timeoutMs: 30000 });
    if (r.code !== 0) throw makeErr(`获取最新 CSV 失败: ${r.stderr || r.stdout}`);
    return (r.stdout || "").trim();
  }

  async downloadLatestCsvToDirectory(localDir) {
    const remote = await this.getLatestCsvPath();
    if (!remote) return { ok: false, message: "未找到 CSV 文件" };
    const localPath = path.join(localDir, path.basename(remote));
    const r = await this.ssh.download(remote, localPath, { timeoutMs: 60000 });
    if (r.code !== 0) return { ok: false, message: `下载失败: ${r.stderr}` };
    return { ok: true, message: `CSV 已下载到 ${localPath}`, localPath, remotePath: remote };
  }
}

/**
 * ========== 4) 对外导出：与你当前模块接口对齐 ==========
 * deployScript / downloadCsv
 */

async function deployScript({
  ip,
  port,
  username,
  password,
  keyPath,
  rebootFirst = true,
  rootDir,
} = {}) {
  if (!ip) return { ok: false, message: "请填写设备 IP" };

  const ssh = new SshClient({
    host: ip,
    port,
    username: username || "root",
    password: password || "",
    privateKeyPath: keyPath || "",
    readyTimeoutMs: 15000,
  });

  const svc = new DeployService(ssh);

  const localName = "shell_recordHMI-20260122.sh";
  const localScriptPath = path.join(resolveRootDir(rootDir), localName);

  const remotePath = `/root/${localName}`;
  const remoteLog = `/root/shell_recordHMI.log`;
  const pidFile = `/tmp/${localName}.pid`;

  try {
    return await svc.deployScript({
      localScriptPath,
      remotePath,
      remoteLog,
      rebootFirst,
      pidFile,
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

async function downloadCsv({ ip, port, username, password, keyPath } = {}) {
  if (!ip) return { ok: false, message: "请填写设备 IP" };

  const pick = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  if (pick.canceled || !pick.filePaths || pick.filePaths.length === 0) {
    return { ok: false, message: "未选择本地目录" };
  }
  const destination = pick.filePaths[0];

  const ssh = new SshClient({
    host: ip,
    port,
    username: username || "root",
    password: password || "",
    privateKeyPath: keyPath || "",
    readyTimeoutMs: 15000,
  });

  const csv = new CsvService(ssh);

  try {
    return await csv.downloadLatestCsvToDirectory(destination);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  SshClient,
  DeployService,
  CsvService,
  deployScript,
  downloadCsv,
};
