import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export class WindowsSupervisor {
  constructor(options = {}) {
    this.botName = options.botName || process.env.BOT_NAME || "admin";
    this.projectRoot = options.projectRoot || projectRoot;
    this.maxRestarts = options.maxRestarts || 5;
    this.restartWindowMs = options.restartWindowMs || 60000;
    this.stateFilePath = path.join(this.projectRoot, "mybot", "supervisor-state.json");
    this.lockFilePath = path.join(this.projectRoot, `.bot-${this.botName}.lock`);
    this.botProcess = null;
    this.dashboardProcess = null;
    this.restartTimestamps = [];
    this.shuttingDown = false;
    this.interactive = Boolean(options.interactive ?? (process.stdout.isTTY && !process.env.DAEMON_MODE));
  }

  acquireLock() {
    try {
      fs.mkdirSync(path.dirname(this.lockFilePath), { recursive: true });
      if (fs.existsSync(this.lockFilePath)) {
        try {
          const raw = fs.readFileSync(this.lockFilePath, "utf8").trim();
          const existingPid = parseInt(raw, 10);
          if (existingPid && this.isProcessAlive(existingPid)) {
            throw new Error(`Another supervisor instance for bot '${this.botName}' is already running with PID ${existingPid}`);
          }
          // Stale lock removal if process is dead
          fs.unlinkSync(this.lockFilePath);
        } catch (e) {
          if (e.message.includes("already running")) throw e;
        }
      }
      fs.writeFileSync(this.lockFilePath, String(process.pid), { flag: "wx", encoding: "utf8" });
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        throw new Error(`Another supervisor instance for bot '${this.botName}' is already running with PID ${process.pid}`);
      }
      console.error(`[windows-supervisor] Failed to acquire lock: ${err.message}`);
      throw err;
    }
  }

  releaseLock() {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        const existingPid = parseInt(fs.readFileSync(this.lockFilePath, "utf8").trim(), 10);
        if (existingPid === process.pid) {
          fs.unlinkSync(this.lockFilePath);
        }
      }
    } catch {}
  }

  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  saveState(extra = {}) {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      const state = {
        supervisorPid: process.pid,
        botName: this.botName,
        botPid: this.botProcess?.pid || null,
        dashboardPid: this.dashboardProcess?.pid || null,
        restarts: this.restartTimestamps.length,
        lastStateUpdate: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform,
        ...extra,
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), "utf8");
    } catch {}
  }

  startBot() {
    if (this.shuttingDown) return;
    const nodeExecutable = process.execPath;
    const botScript = path.join(this.projectRoot, "bot.js");

    console.log(`[windows-supervisor] Starting Bot process (${botScript})...`);
    this.botProcess = spawn(nodeExecutable, [botScript], {
      cwd: this.projectRoot,
      stdio: "inherit",
      windowsHide: !this.interactive,
      env: { ...process.env, SUPERVISOR_MANAGED: "1" },
    });

    this.saveState({ status: "running" });

    this.botProcess.on("exit", (code, signal) => {
      console.warn(`[windows-supervisor] Bot process exited with code ${code}, signal ${signal}`);
      this.botProcess = null;
      if (!this.shuttingDown) {
        this.handleBotCrash();
      }
    });
  }

  startDashboard() {
    if (this.shuttingDown) return;
    if (process.env.MYBOT_NODE_HYBRID === "true" || process.env.DISABLE_NODE_DASHBOARD === "true") {
      console.log("[windows-supervisor] Hybrid mode active: Node dashboard disabled (port 4173 dedicated to Rust V4)");
      return;
    }
    const nodeExecutable = process.execPath;
    const dashboardScript = path.join(this.projectRoot, "dashboard", "server.js");

    if (!fs.existsSync(dashboardScript)) return;

    console.log(`[windows-supervisor] Starting Dashboard process (${dashboardScript})...`);
    this.dashboardProcess = spawn(nodeExecutable, [dashboardScript], {
      cwd: this.projectRoot,
      stdio: "inherit",
      windowsHide: !this.interactive,
      env: { ...process.env, SUPERVISOR_MANAGED: "1" },
    });

    this.dashboardProcess.on("exit", (code) => {
      console.warn(`[windows-supervisor] Dashboard process exited with code ${code}`);
      this.dashboardProcess = null;
      if (!this.shuttingDown) {
        setTimeout(() => this.startDashboard(), 3000);
      }
    });
  }

  handleBotCrash() {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => ts > now - this.restartWindowMs);
    this.restartTimestamps.push(now);

    if (this.restartTimestamps.length > this.maxRestarts) {
      console.error(`[windows-supervisor] FATAL: Bot exceeded maximum crash limit (${this.maxRestarts} crashes in ${this.restartWindowMs / 1000}s). Halting supervisor.`);
      this.saveState({ status: "crash_loop_exhausted" });
      this.stop();
      process.exit(1);
    }

    const backoffMs = Math.min(30000, 2000 * Math.pow(2, this.restartTimestamps.length - 1));
    console.log(`[windows-supervisor] Restarting Bot in ${backoffMs}ms (crash count: ${this.restartTimestamps.length})...`);
    this.saveState({ status: "backing_off", nextRestartInMs: backoffMs });
    setTimeout(() => this.startBot(), backoffMs);
  }

  start() {
    this.acquireLock();
    this.startBot();
    this.startDashboard();

    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    process.on("exit", () => this.releaseLock());
  }

  stop() {
    this.shuttingDown = true;
    console.log("[windows-supervisor] Shutting down supervisor and child processes...");
    if (this.botProcess) {
      try { this.botProcess.kill(); } catch {}
    }
    if (this.dashboardProcess) {
      try { this.dashboardProcess.kill(); } catch {}
    }
    this.releaseLock();
    this.saveState({ status: "stopped" });
  }
}

// Support direct run
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const supervisor = new WindowsSupervisor();
  supervisor.start();
}
