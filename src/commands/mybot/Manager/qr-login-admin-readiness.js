import fs from "fs";
import path from "path";
import { readRoleRegistry } from "../../../dashboard/role-registry-service.js";

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
  if (!pid) return false;
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
  const processIsAlive = isAlive(admin.pid);
  if (!processIsAlive) {
    return { ready: false, reason: "process_stopped", message: "Admin process da dung hoac PID khong con ton tai." };
  }
  const api = options.api;
  const apiReady = typeof api?.isReady === "function" ? api.isReady() : api?.ready !== false && Boolean(api?.listener);
  if (!apiReady) {
    return { ready: false, reason: "api_not_ready", message: "API admin chua san sang de xu ly qrlogin." };
  }
  // The registry can briefly contain a stale stopped value after a child
  // process handoff. A live PID with a ready API is the authoritative state.
  return { ready: true, reason: "ready", admin };
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
