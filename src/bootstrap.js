import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import dotenv from "dotenv";
import { resolveProjectRoot, resolveDataDir } from "./platform/index.js";

const moduleFile = fileURLToPath(import.meta.url);
const rootFromModule = path.resolve(path.dirname(moduleFile), "..");

export function loadProviderEnvironment({ root = process.env.PROJECT_ROOT || rootFromModule } = {}) {
  const resolvedRoot = resolveProjectRoot(root);
  const resolvedDataDir = resolveDataDir(process.env.MYBOT_DATA_DIR);
  for (const file of [".env.local", ".env"]) {
    dotenv.config({ path: path.join(resolvedRoot, file), override: false, quiet: true });
    dotenv.config({ path: path.join(resolvedDataDir, file), override: false, quiet: true });
  }
  process.env.PROJECT_ROOT = resolvedRoot;
  process.env.MYBOT_DATA_DIR = resolvedDataDir;
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") {
    const sandboxedTemp = path.join(resolvedRoot, ".runtime", "temp");
    try { fs.mkdirSync(sandboxedTemp, { recursive: true }); } catch {}
    process.env.TEMP = sandboxedTemp;
    process.env.TMP = sandboxedTemp;
    if (!process.env.MYBOT_RESOURCE_PROFILE) {
      process.env.MYBOT_RESOURCE_PROFILE = "lean";
    }
  }
  return process.env;
}

export async function configureNativeMemoryLimits() {
  try {
    const sharpMod = await import("sharp");
    const sharpLib = sharpMod.default || sharpMod;
    if (typeof sharpLib?.cache === "function") sharpLib.cache(false);
    if (typeof sharpLib?.concurrency === "function") sharpLib.concurrency(1);
  } catch {}
}

export const RUNTIME_VERSION = "fix-cooldown-qr-recall-v2.5.2";

export function getGitCommitHash(root = process.env.PROJECT_ROOT || rootFromModule) {
  try {
    const hash = execSync("git rev-parse --short HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return hash || "unknown";
  } catch {
    return "unknown";
  }
}

import { createRuntimeInstanceDescriptor, getRuntimeInstanceDescriptor, resolveLaunchDescriptor } from "./core/runtime-instance.js";

export function resolveInstanceKind(options = {}) {
  const descriptor = resolveLaunchDescriptor({
    kind: options.explicitKind || options.kind,
    botName: options.botName ?? options.botUid,
    botUid: options.botUid,
    configuredUid: options.configuredUid ?? options.botUid,
    configPath: options.configPath,
    projectRoot: options.projectRoot,
    env: options.env || {},
  });
  return descriptor.kind;
}

export function printRuntimeFingerprint({
  entrypoint = moduleFile,
  commit,
  descriptor = null,
  botName,
  botKey,
  botUid,
  instanceKind,
  configPath,
  supervisor,
  webPort,
  pid,
  projectRoot,
} = {}) {
  const active = descriptor || (
    botName || botKey || botUid || instanceKind || configPath
      ? {
          projectRoot: projectRoot || process.env.PROJECT_ROOT || rootFromModule,
          botKey: botKey || botName || botUid || "admin",
          configuredUid: botUid || botKey || botName || "admin",
          kind: instanceKind || (String(botKey || botName || botUid || "admin").toLowerCase() === "admin" ? "main" : "child"),
          supervisor: supervisor || "main-supervisor",
          configPath: configPath || "",
          webPort: webPort ?? 2000,
          pid: pid ?? process.pid,
        }
      : getRuntimeInstanceDescriptor()
  );
  const root = active.projectRoot;
  const resolvedCommit = commit || getGitCommitHash(root);
  const banner = `[RUNTIME FINGERPRINT] root="${root}" | entry="${entrypoint}" | bot="${active.botKey}" | key="${active.botKey}" | uid="${active.configuredUid}" | kind="${active.kind}" | supervisor="${active.supervisor}" | config="${active.configPath}" | port="${active.webPort}" | pid=${active.pid} | version="${RUNTIME_VERSION}" | commit="${resolvedCommit}"`;
  console.log(banner);
  return banner;
}

/**
 * Decide whether this module is the runtime entrypoint.
 *
 * Runs the bot only when the module is being executed as the process entry:
 *  1. Direct execution: `node src/bootstrap.js` → argv[1] resolves to this file.
 *  2. PM2 ESM bootstrap: PM2 7 imports this file via
 *     ProcessContainerFork.js using `import(pathToFileURL(pm_exec_path))`, so
 *     argv[1] points at PM2's own fork container. In that case pm_exec_path is
 *     set by PM2 and resolves to this file — treat that as the entrypoint too.
 *
 * Any other import (unit tests, wrappers like index.js/bot.js importing the
 * fingerprint helpers, or third-party code) must NOT start the bot.
 *
 * @param {object} params
 * @param {string} params.moduleFile resolved path of this module
 * @param {string|null} [params.argv1] process.argv[1]
 * @param {string|null} [params.pmExecPath] process.env.pm_exec_path
 * @returns {boolean}
 */
export function isRuntimeEntrypoint({
  moduleFile,
  argv1 = process.argv[1],
  pmExecPath = process.env.pm_exec_path,
} = {}) {
  const norm = (p) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const target = norm(moduleFile);
  if (argv1 && norm(argv1) === target) return true;
  const isPm2Container = Boolean(argv1 && /processcontainer/i.test(path.basename(argv1)));
  if (isPm2Container && pmExecPath && norm(pmExecPath) === target) return true;
  return false;
}

export function upsertEnvLocalEntries(envFilePath, entries = {}) {
  let content = "";
  try {
    if (fs.existsSync(envFilePath)) {
      content = fs.readFileSync(envFilePath, "utf8");
    }
  } catch {}
  const lines = content ? content.split(/\r?\n/) : [];
  for (const [key, val] of Object.entries(entries)) {
    const safeVal = JSON.stringify(String(val));
    const idx = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (idx >= 0) {
      lines[idx] = `${key}=${safeVal}`;
    } else {
      lines.push(`${key}=${safeVal}`);
    }
  }
  const normalized = `${lines.filter((l, i, arr) => !(i === arr.length - 1 && l === "")).join("\n")}\n`;
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  fs.writeFileSync(envFilePath, normalized, "utf8");
}

export function ensureDashboardBootstrapCredentials({ root = process.env.PROJECT_ROOT || rootFromModule } = {}) {
  let username = String(process.env.DASHBOARD_ADMIN_USERNAME || "").trim();
  let password = String(process.env.DASHBOARD_ADMIN_PASSWORD || "").trim();
  let generated = false;
  if (!username) {
    username = "admin";
    process.env.DASHBOARD_ADMIN_USERNAME = username;
    generated = true;
  }
  if (!password) {
    password = "140108";
    process.env.DASHBOARD_ADMIN_PASSWORD = password;
    generated = true;
  }
  if (generated) {
    try {
      upsertEnvLocalEntries(path.join(root, ".env.local"), {
        DASHBOARD_ADMIN_USERNAME: username,
        DASHBOARD_ADMIN_PASSWORD: password,
      });
    } catch {}
    const port = Number(process.env.DASHBOARD_PORT || 4173);
    console.log("\n╔══════════════════════════════════════════════════════════════════╗");
    console.log("║  🌐 MYBOT CONTROL CENTER V4 — THÔNG TIN ĐĂNG NHẬP KHỞI TẠO       ║");
    console.log(`║  • Địa chỉ Web Admin : http://localhost:${String(port).padEnd(24, " ")}║`);
    console.log(`║  • Tài khoản         : ${username.padEnd(42, " ")}║`);
    console.log(`║  • Mật khẩu khởi tạo : ${password.padEnd(42, " ")}║`);
    console.log("║  (Đã lưu vào .env.local — Bạn có thể đổi mật khẩu ngay trên Web) ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝\n");
  }
  return { username, generated };
}

function isLocalPortOpen(port, host = "127.0.0.1", timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(Number(port), host, () => finish(true));
  });
}

let _dashboardChild = null;
let _dashboardStopping = false;

export async function startAlwaysOnDashboardSupervisor({ root = process.env.PROJECT_ROOT || rootFromModule } = {}) {
  const isTest = Boolean(
    process.env.NODE_TEST_CONTEXT ||
    process.env.NODE_ENV === "test" ||
    process.env.DASHBOARD_TEST_MODE === "1" ||
    process.env.SKIP_ENV_VALIDATION ||
    process.env.QR_BOOTSTRAP_ONLY === "1" ||
    process.env.MYBOT_DISABLE_AUTO_DASHBOARD === "1"
  );
  if (isTest) return { started: false, reason: "test-or-disabled" };

  const descriptor = getRuntimeInstanceDescriptor();
  if (!descriptor?.isMain) return { started: false, reason: "not-main-instance" };

  ensureDashboardBootstrapCredentials({ root });
  process.env.MYBOT_DASHBOARD_MANAGED = "1";

  const port = Number(process.env.DASHBOARD_PORT || 4173);
  const serverScript = path.join(root, "dashboard", "server.js");
  if (!fs.existsSync(serverScript)) {
    return { started: false, reason: "server-script-missing" };
  }

  if (await isLocalPortOpen(port, "127.0.0.1")) {
    console.log(`[LIFERAFT] Web Admin Dashboard đang trực tuyến tại http://localhost:${port}`);
    return { started: true, reused: true, port };
  }

  const spawnDashboard = () => {
    if (_dashboardStopping) return;
    const childEnv = {
      ...process.env,
      DASHBOARD_HOST: process.env.DASHBOARD_HOST || "0.0.0.0",
      DASHBOARD_PORT: String(port),
      DASHBOARD_PROJECT_ROOT: root,
    };
    delete childEnv.pm_exec_path;
    delete childEnv.pm_id;
    delete childEnv.NODE_APP_INSTANCE;

    const child = spawn(process.execPath, [serverScript], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: childEnv,
    });
    _dashboardChild = child;

    child.once("exit", (code, signal) => {
      if (_dashboardChild === child) _dashboardChild = null;
      if (_dashboardStopping) return;
      console.warn(`[LIFERAFT] Web Dashboard dừng bất ngờ (code=${code ?? "null"}, signal=${signal ?? "null"}). Tự khởi động lại sau 2s...`);
      const timer = setTimeout(async () => {
        if (_dashboardStopping) return;
        if (!(await isLocalPortOpen(port, "127.0.0.1"))) {
          spawnDashboard();
        }
      }, 2000);
      timer.unref?.();
    });
  };

  const stopDashboard = () => {
    _dashboardStopping = true;
    try {
      _dashboardChild?.kill?.();
    } catch {}
  };
  process.once("exit", stopDashboard);
  process.once("SIGINT", stopDashboard);
  process.once("SIGTERM", stopDashboard);

  console.log(`[LIFERAFT] Khởi chạy tức thời Web Admin Control Center trên 0.0.0.0:${port} (Always-On Liferaft)...`);
  spawnDashboard();
  return { started: true, reused: false, port };
}

const isMain = isRuntimeEntrypoint({ moduleFile });
if (isMain) {
  try {
    loadProviderEnvironment();
    await configureNativeMemoryLimits();
    createRuntimeInstanceDescriptor();
    printRuntimeFingerprint({ entrypoint: "src/bootstrap.js" });
    await startAlwaysOnDashboardSupervisor();
    await import("./index.js");
  } catch (bootErr) {
    console.error(`[BOOTSTRAP:FATAL] ${bootErr?.stack || bootErr?.message || bootErr}`);
    process.exit(1);
  }
}



