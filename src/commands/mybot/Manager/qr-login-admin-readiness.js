import fs from "fs";
import path from "path";
import { readRoleRegistry } from "../../../dashboard/role-registry-service.js";
import { createBotReadinessService } from '../../../runtime/runtime-readiness.js';

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function assertAdminReady(options = {}) {
  const root = options.projectRoot || process.cwd();
  const registryPath = path.join(root, "mybot", "mybots.json");
  const statePath = path.join(root, "mybot", "state", "admin.json");
  const registry = options.registry || readJsonSafe(registryPath, {});
  const roleRegistry = options.roleRegistry || await readRoleRegistry(path.join(root, "mybot", "role-registry.json"));
  const adminBotId = options.adminBotId || roleRegistry.adminBotId || roleRegistry.primaryBotId || "admin";
  const admin = registry[adminBotId] || (adminBotId !== "admin" ? registry.admin : null);
  const state = options.state || readJsonSafe(statePath, {});
  const isAlive = options.isProcessAlive || processAlive;

  if (!admin) {
    return { ready: false, reason: "missing_admin", message: "Chua co bot admin trong registry." };
  }
  if (state.cookieDead === true || admin.cookieDead === true) {
    return { ready: false, reason: "cookie_dead", message: "Cookie admin da het han. Runtime dang cho QR recovery admin." };
  }
  const status = String(admin.status || "").toLowerCase();
  if (status === "recovering") {
    return { ready: false, reason: "recovering", message: "Admin dang QR recovery. Vui long thu lai sau khi admin online." };
  }
  // Registry PID is diagnostic data: it can be absent or stale after a restart.
  // Resolve the supervisor's current PID and verify the runtime identity/listener.
  const adminKey = registry[adminBotId] ? adminBotId : 'admin';
  const readiness = options.readiness || createBotReadinessService({ root });
  let runtimeProcess;
  let health;
  try {
    runtimeProcess = await readiness.getProcess(adminKey);
    const processIsAlive = runtimeProcess?.status === 'online' && isAlive(runtimeProcess.pid);
    if (processIsAlive) {
      health = await readiness.probe({
        descriptor: {
          kind: adminKey === 'admin' || admin.isMain ? 'main' : 'child',
          botKey: adminKey, pm2Name: adminKey,
          webPort: Number(admin.webPort || (adminKey === 'admin' ? 2000 : 0)),
          accountUid: admin.accountUid || (admin.uid && admin.uid !== adminKey ? admin.uid : undefined),
        },
        process: runtimeProcess, expectedPid: runtimeProcess.pid,
      });
    }
  } catch {
    return { ready: false, reason: 'api_not_ready', stage: 'qr_admin_readiness', message: 'Chưa xác minh được trạng thái Main từ PM2 và runtime. Vui lòng thử lại.' };
  }
  const processIsAlive = runtimeProcess?.status === 'online' && isAlive(runtimeProcess.pid);
  if (!processIsAlive) {
    return { ready: false, reason: "process_stopped", message: "Admin process da dung hoac PID khong con ton tai." };
  }
  const api = options.api;
  const apiReady = typeof api?.isReady === "function" ? await api.isReady() : api?.ready !== false && api?.listener?.ws?.readyState === 1;
  if (!apiReady || !health?.ready || !health.identity?.liveZaloUid) {
    return { ready: false, reason: "api_not_ready", message: "API admin chua san sang de xu ly qrlogin." };
  }
  return { ready: true, reason: "ready", admin, livePid: Number(runtimeProcess.pid) };
}

export async function waitForAdminReady(options = {}) {
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs : 10000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 500;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const loadRegistry = options.loadRegistry || (() => readJsonSafe(
    path.join(options.projectRoot || process.cwd(), "mybot", "mybots.json"),
    {},
  ));
  const roleRegistry = options.roleRegistry || await readRoleRegistry(path.join(options.projectRoot || process.cwd(), "mybot", "role-registry.json"));
  const startedAt = Date.now();
  let result = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    result = await assertAdminReady({
      ...options,
      registry: loadRegistry(),
      roleRegistry,
    });
    if (result.ready || !["stopped", "process_stopped", "api_not_ready"].includes(result.reason)) {
      return result;
    }
    if (Date.now() - startedAt >= maxWaitMs) break;
    await sleep(Math.min(pollMs, maxWaitMs - (Date.now() - startedAt)));
  }

  return result || {
    ready: false,
    reason: "process_stopped",
    message: "Admin process da dung hoac PID khong con ton tai.",
  };
}
