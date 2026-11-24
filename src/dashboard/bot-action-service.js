import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getInternalSecret } from "../commands/mybot/System/mybot-command-relay.js";
import { AuditStore } from "./audit-store.js";
import {
  checkPM2Status,
  checkSpawnedProcessStatus,
  deletePM2Process,
  killSpawnedProcess,
  restartPM2Process,
  restartBotRuntime,
  startBotWithLauncher,
  stopPM2Process,
  createBotConfig as defaultCreateBotConfig,
} from "../commands/mybot/System/pm2-manager.js";
import { requestRestartForBot } from "../utils/util.js";
import { claimOwnerTrial, getOwnerTrialStatus } from "../commands/mybot/System/mybot-trial-ledger.js";
import { getProfile, updateProfile } from "../commands/mybot/System/mybot-profile-service.js";
import { activateBot } from "../commands/mybot/System/mybot-activation-service.js";
import { PM2Adapter, PM2ErrorCode } from "../runtime/pm2-adapter.js";
import { createLaunchDescriptor } from "../runtime/launch-descriptor.js";
import { withBotLock } from "../runtime/bot-lock.js";

const DELETE_CONFIRMATION = "DELETE_SELECTED_BOTS";

/**
 * Normalize a PM2 op result to the structured shape:
 * - legacy boolean `false` / `true` → { success:false|true }
 * - structured object passes through
 * Any result whose `success` is falsy (including `{ success:false }` objects)
 * is an action failure — callers must never treat object results as success
 * just because `result !== false`.
 */
function normalizeActionSuccess(result) {
  if (result === false) return { success: false, reason: PM2ErrorCode.PM2_COMMAND_FAILED || "pm2_command_failed" };
  if (result === true || result === undefined || result === null) return { success: true, reason: "ok" };
  return result;
}

/**
 * Map a failed PM2 op to the approved API error mapping:
 * - daemon unavailable → 503 PM2_UNAVAILABLE
 * - timeout → 504 PM2_TIMEOUT
 * - other PM2 command failures → 409 ACTION_FAILED (safe reason attached)
 */
function actionFailureFromPM2(result, fallbackMessage) {
  const code = String(result?.code || "").toLowerCase();
  const reason = String(result?.reason || "").toLowerCase();
  // Already-mapped API errors pass through untouched.
  if (result?.status && result?.code === "PM2_UNAVAILABLE") return result;
  if (result?.status && result?.code === "PM2_TIMEOUT") return result;
  if (result?.code === PM2ErrorCode.DAEMON_UNAVAILABLE || code.includes("daemon_unavailable") || code.includes("pm2_unavailable")
    || reason.includes("daemon_unavailable") || reason.includes("daemon unavailable") || reason.includes("daemon down")) {
    return actionError(503, "PM2_UNAVAILABLE", "PM2 daemon is unavailable", { details: { reason: safeReason(result) } });
  }
  if (result?.code === PM2ErrorCode.TIMEOUT || code.includes("timeout") || reason.includes("timeout")) {
    return actionError(504, "PM2_TIMEOUT", "PM2 command timed out", { details: { reason: safeReason(result) } });
  }
  return actionError(409, "ACTION_FAILED", fallbackMessage, { details: { reason: safeReason(result) } });
}

/**
 * Filter a PM2 failure reason for safe display: strip absolute paths,
 * credentials-looking fragments and cap length.
 */
function safeReason(result) {
  const raw = String(result?.detail || result?.reason || result?.message || "");
  return raw
    .replace(/[A-Za-z]:\\[^\s'"]+/g, "<path>")
    .replace(/\/[\w.-]+\/[\w./-]+/g, "<path>")
    .replace(/(cookie|token|password|secret)=\S+/gi, "$1=<redacted>")
    .slice(0, 200) || "unknown_reason";
}

/**
 * Default PM2-backed bot start. Uses the PM2 adapter (single source of truth)
 * instead of the legacy `startBotWithLauncher()` which spawned PowerShell +
 * CMD windows. Keeps the same return shape so callers don't have to branch.
 */
async function defaultPM2Start(botId, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const adapter = options.pm2Adapter || new PM2Adapter({ projectRoot });
  const isMain = botId === "admin";
  const descriptor = createLaunchDescriptor({
    kind: isMain ? "main" : "child",
    botKey: isMain ? "admin" : botId,
    uid: botId,
    projectRoot,
  });
  const result = await adapter.startBot(descriptor);
  if (!result?.success) {
    return { success: false, pid: null, reason: result?.reason || result?.detail || "pm2_start_failed", detail: result?.detail || null };
  }
  // Best-effort PID lookup; success path doesn't strictly require pid
  const procs = await adapter.listMyBotProcesses().catch(() => []);
  const proc = procs.find((p) => p.name === descriptor.pm2Name);
  return { success: true, pid: proc?.pid || null, reason: result.reason };
}

async function defaultInternalBridgeCaller({ port, pathname, body = {}, root = process.cwd() }) {
  const secret = getInternalSecret({ projectRoot: root });
  const url = `http://127.0.0.1:${port}${pathname}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(data?.error || `Bridge error ${response.status}`);
    err.code = data?.code || "INTERNAL_BRIDGE_ERROR";
    err.fallback = data?.fallback || null;
    err.status = response.status;
    throw err;
  }
  return data;
}

export function createBotActionService({
  root = process.cwd(),
  registry,
  configStore,
  auditStore = new AuditStore({ root }),
  pm2Adapter = {},
  processAdapter = {},
  restartLauncher = defaultRestartLauncher,
  createBotConfig = defaultCreateBotConfig,
  internalBridgeCaller = defaultInternalBridgeCaller,
} = {}) {
  if (!registry) throw new Error("registry is required");
  if (!configStore) throw new Error("configStore is required");
  const projectRoot = path.resolve(root);
  const pm2 = {
    status: pm2Adapter.status || checkPM2Status,
    // Default to PM2-backed start, NOT the legacy launcher. Tests can still
    // inject pm2Adapter.start to override.
    start: pm2Adapter.start || defaultPM2Start,
    stop: pm2Adapter.stop || stopPM2Process,
    restart: pm2Adapter.restart || restartPM2Process,
    delete: pm2Adapter.delete || deletePM2Process,
  };
  const process = {
    status: processAdapter.status || checkSpawnedProcessStatus,
    kill: processAdapter.kill || killSpawnedProcess,
  };
  const activeOperations = new Map();
  const operationHistory = new Map();
  const useSharedRuntimeRestart = pm2Adapter.restartBotRuntime !== undefined
    ? Boolean(pm2Adapter.restartBotRuntime)
    : true;

  function trackOperation(botId, action, executor) {
    const existing = activeOperations.get(botId);
    if (existing && (existing.operation.phase === "accepted" || existing.operation.phase === "connecting" || existing.operation.phase === "stopping")) {
      return existing.promise;
    }

    const operationId = `op_${action}_${botId}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const startedAt = new Date().toISOString();
    const operation = {
      operationId,
      botId,
      action,
      phase: "accepted",
      status: action === "stop" || action === "standby" ? "stopping" : "connecting",
      startedAt,
      updatedAt: startedAt,
      error: null,
      pm2: null,
      memory: null,
    };

    operationHistory.set(operationId, operation);

    const promise = (async () => {
      try {
        const result = await executor(operation);
        const resolvedPhase = result?.phase || (action === "standby" ? "standby" : action === "stop" ? (result?.status === "standby" ? "standby" : "stopped") : (result?.status === "running" ? "ws_ready" : "connecting"));
        const resolvedStatus = result?.status || resolvedPhase;
        operation.phase = resolvedPhase;
        operation.status = resolvedStatus;
        operation.updatedAt = new Date().toISOString();
        if (result?.pm2) operation.pm2 = result.pm2;
        if (result?.memory) operation.memory = result.memory;
        return {
          ...result,
          operationId: operation.operationId,
          phase: operation.phase,
          status: operation.status,
          startedAt: operation.startedAt,
          updatedAt: operation.updatedAt,
        };
      } catch (err) {
        operation.phase = "error";
        operation.status = "error";
        operation.updatedAt = new Date().toISOString();
        operation.error = {
          code: err.code || "ACTION_FAILED",
          message: err.message,
          details: err.details || null,
          fallback: err.fallback || null,
        };
        throw err;
      }
    })();

    const tracked = promise.finally(() => {
      if (activeOperations.get(botId)?.promise === tracked) {
        activeOperations.delete(botId);
      }
    });

    activeOperations.set(botId, { operation, promise: tracked });
    return tracked;
  }

  async function requireBot(botId) {
    const bot = await registry.describe(botId);
    if (!bot) throw actionError(404, "BOT_NOT_FOUND", "Bot not found");
    return bot;
  }

  function start(botId, options = {}) {
    return trackOperation(botId, "start", async (operation) => {
      return await withBotLock(botId, async () => {
        const bot = await requireBot(botId);
        assertEnabled(bot);

        // Hot standby resume if bot is in standby or hot_standby
        if (bot.status === "standby" || bot.status === "hot_standby") {
          try {
            return await executeResume(botId, bot, options);
          } catch (resumeErr) {
            // If standby resume fails (process dead, port unreachable, or cookie expired),
            // gracefully fall through to cold PM2 start so bot can boot or enter QR recovery mode.
          }
        }

        operation.phase = "connecting";
        let started;
        try {
          started = await pm2.start(botId);
        } catch (error) {
          throw actionFailureFromPM2(error, "Bot start failed");
        }
        const normalized = normalizeActionSuccess(started);
        if (!normalized?.success) {
          throw actionFailureFromPM2(normalized, "Bot start failed");
        }

        return {
          botId,
          action: "start",
          status: "starting",
          phase: "connecting",
          pm2: { pid: normalized.pid ?? null, reason: normalized.reason || null },
        };
      }, { root: projectRoot });
    });
  }

  function stop(botId, options = {}) {
    return trackOperation(botId, "stop", async (operation) => {
      return await withBotLock(botId, async () => {
        const bot = await requireBot(botId);

        if (options.mode === "standby" || options.hotStandby === true) {
          operation.phase = "stopping";
          return await executeStandby(botId, bot, options);
        }

        operation.phase = "stopping";
        await stopRuntime(botId);
        // Verify the process is really no longer online before claiming "stopped".
        try {
          const status = await pm2.status(botId);
          const stillOnline = status?.running === true || status?.status === "online";
          if (stillOnline) throw actionError(409, "STOP_FAILED", "Bot still online after stop", { details: ["PM2_STILL_ONLINE"] });
        } catch (error) {
          if (error?.status) throw error;
          throw actionError(503, "PM2_UNAVAILABLE", "Cannot verify stop: PM2 status unavailable");
        }
        return { botId, action: "stop", status: "stopped", phase: "stopped" };
      }, { root: projectRoot });
    });
  }

  function standby(botId, options = {}) {
    return trackOperation(botId, "standby", async (operation) => {
      return await withBotLock(botId, async () => {
        const bot = await requireBot(botId);
        operation.phase = "stopping";
        return await executeStandby(botId, bot, options);
      }, { root: projectRoot });
    });
  }

  function resume(botId, options = {}) {
    return trackOperation(botId, "resume", async (operation) => {
      return await withBotLock(botId, async () => {
        const bot = await requireBot(botId);
        assertEnabled(bot);
        operation.phase = "connecting";
        return await executeResume(botId, bot, options);
      }, { root: projectRoot });
    });
  }

  async function executeStandby(botId, bot, options = {}) {
    const isMain = botId === "admin" || bot?.isMain;
    const defaultPort = isMain ? 2000 : 3000;
    const port = Number(bot?.port || bot?.webPort || defaultPort);
    const pm2Status = await Promise.resolve(pm2.status(botId)).catch(() => null);
    const pm2Online = Boolean(pm2Status?.running || pm2Status?.status === "online");

    if (!pm2Online && !port) {
      return {
        botId,
        action: "standby",
        status: "stopped",
        phase: "standby",
        message: "Bot was not running",
      };
    }

    try {
      const res = await internalBridgeCaller({
        port: port || defaultPort,
        pathname: "/internal/runtime/standby",
        body: { botId, options },
        root: projectRoot,
      });
      return {
        botId,
        action: "standby",
        status: "standby",
        phase: "standby",
        memory: res?.memory || null,
      };
    } catch (err) {
      if (err.code === "ECONNREFUSED" || err.message?.includes("fetch failed") || !port) {
        await stopRuntime(botId);
        return { botId, action: "standby", status: "stopped", phase: "standby", message: "Process stopped as fallback" };
      }
      throw err;
    }
  }

  async function executeResume(botId, bot, options = {}) {
    const isMain = botId === "admin" || bot?.isMain;
    const defaultPort = isMain ? 2000 : 3000;
    const port = Number(bot?.port || bot?.webPort || defaultPort);
    const pm2Status = await Promise.resolve(pm2.status(botId)).catch(() => null);
    const pm2Online = Boolean(pm2Status?.running || pm2Status?.status === "online");

    if (!pm2Online) {
      const err = actionError(409, "NODE_PROCESS_DEAD", `Tiến trình Node của bot '${botId}' không hoạt động, yêu cầu khởi động nguội (cold start).`, {
        details: { fallback: "COLD_START_REQUIRED", botId },
      });
      err.fallback = "COLD_START_REQUIRED";
      throw err;
    }

    if (bot.cookieDead === true || (bot.credential && bot.credential.state === "missing")) {
      const err = actionError(401, "COOKIE_EXPIRED", `Phiên đăng nhập Zalo (cookie) của bot '${botId}' đã hết hạn, yêu cầu quét mã QR để đăng nhập lại.`, {
        details: { fallback: "QR_LOGIN_REQUIRED", botId },
      });
      err.fallback = "QR_LOGIN_REQUIRED";
      throw err;
    }

    try {
      const res = await internalBridgeCaller({
        port: port || defaultPort,
        pathname: "/internal/runtime/resume",
        body: { botId, options },
        root: projectRoot,
      });
      return {
        botId,
        action: "resume",
        status: "ws_ready",
        phase: "ws_ready",
        memory: res?.memory || null,
        generation: res?.generation ?? null,
        keyExchanged: res?.keyExchanged ?? true,
      };
    } catch (err) {
      if (err.code === "COOKIE_EXPIRED" || err.code === "NODE_PROCESS_DEAD") {
        throw err;
      }
      if (err.code === "ECONNREFUSED" || err.message?.includes("fetch failed")) {
        const deadErr = actionError(409, "NODE_PROCESS_DEAD", `Tiến trình Node của bot '${botId}' không phản hồi cổng HTTP, yêu cầu khởi động nguội.`, {
          details: { fallback: "COLD_START_REQUIRED", botId },
        });
        deadErr.fallback = "COLD_START_REQUIRED";
        throw deadErr;
      }
      throw actionError(err.status || 500, err.code || "RESUME_FAILED", err.message || "Failed to resume bot from standby");
    }
  }

  function restart(botId) {
    return trackOperation(botId, "restart", async (operation) => {
      return await withBotLock(botId, async () => {
        operation.phase = "connecting";
        const bot = await requireBot(botId);
        assertEnabled(bot);
        if (botId === "admin") {
          try {
            if (await restartLauncher({ botId, root: projectRoot, pm2, bot }) === false) {
              throw actionError(409, "ACTION_FAILED", "Bot restart failed");
            }
          } catch (error) {
            if (error?.code === "ACTION_FAILED") throw error;
            throw actionError(409, "ACTION_FAILED", "Bot restart failed", { details: [error?.message || String(error)] });
          }
          return { botId, action: "restart", status: "restarting", phase: "connecting" };
        }
        const [pm2Status, processStatus] = await Promise.all([
          Promise.resolve(pm2.status(botId)).catch(() => null),
          Promise.resolve(process.status(botId)).catch(() => null),
        ]);
        const pm2Running = Boolean(pm2Status?.running || pm2Status?.status === "online");
        const processRunning = Boolean(processStatus?.running);

        try {
          if (pm2Running) {
            const ok = normalizeActionSuccess(await pm2.restart(botId));
            if (!ok?.success) throw actionFailureFromPM2(ok, "Bot restart failed");
          } else {
            if (processRunning) {
              const stopped = normalizeActionSuccess(await process.kill(botId));
              if (!stopped?.success) throw actionFailureFromPM2(stopped, "Bot process stop failed");
            }
            const started = normalizeActionSuccess(await pm2.start(botId));
            if (!started?.success) throw actionFailureFromPM2(started, "Bot restart failed");
          }
        } catch (error) {
          if (error?.status) throw error;
          if (error?.code === "ACTION_FAILED") throw error;
          throw actionError(409, "ACTION_FAILED", "Bot restart failed", { details: [error?.message || String(error)] });
        }
        return { botId, action: "restart", status: "restarting", phase: "connecting" };
      }, { root: projectRoot });
    });
  }

  async function enable(botId) {
    await requireBot(botId);
    const inventory = await readInventory();
    inventory[botId] = { ...(inventory[botId] || {}), enabled: true, disabledAt: null, disabledReason: null };
    await configStore.writeJson(registry.inventoryPath, inventory);
    try { updateProfile(botId, { enabled: true }, { root: projectRoot }); } catch {}
    const bot = await registry.describe(botId);
    await auditStore.append({ action: "bots.enable", botId });
    return { botId, action: "enable", enabled: true, status: bot?.status || "stopped" };
  }

  async function disable(botId, { reason = "" } = {}) {
    const bot = await requireBot(botId);
    if (bot.isMain || botId === "admin") throw actionError(403, "ADMIN_PROTECTED", "Admin bot is protected");
    await stopRuntime(botId, bot);
    const inventory = await readInventory();
    const disabledAt = new Date().toISOString();
    inventory[botId] = { ...(inventory[botId] || {}), enabled: false, disabledAt, disabledReason: String(reason || "") };
    await configStore.writeJson(registry.inventoryPath, inventory);
    try { updateProfile(botId, { enabled: false }, { root: projectRoot }); } catch {}
    await auditStore.append({ action: "bots.disable", botId, reason: String(reason || "") });
    return { botId, action: "disable", enabled: false, disabledAt, disabledReason: String(reason || ""), status: "disabled" };
  }

  async function deleteBot(botId, { confirm, confirmId, confirmName } = {}) {
    return await withBotLock(botId, async () => {
      const bot = await requireBot(botId);
      if (bot.isMain || botId === "admin") throw actionError(403, "ADMIN_PROTECTED", "Admin bot is protected");
      const isTokenConfirmed = confirm === DELETE_CONFIRMATION;
      const isLegacyConfirmed = confirmId === botId && (!bot.displayName || confirmName === bot.displayName);
      if (!isTokenConfirmed && !isLegacyConfirmed) {
        throw actionError(400, "DELETE_CONFIRMATION_REQUIRED", "Delete confirmation is required");
      }

      const inventoryPath = path.resolve(registry.inventoryPath);
      const candidates = await buildManifest(botId, bot);
      const backup = await writeDeleteManifest(botId, candidates);

      await stopRuntime(botId, bot).catch(() => null);
      const deletedPaths = [];
      const skippedPaths = [];
      let partial = false;

      let delRes;
      try {
        delRes = await pm2.delete(botId);
      } catch (error) {
        throw actionError(500, "PM2_DELETE_FAILED", `PM2 delete failed: ${error.message}`);
      }

      const isDelOk = Boolean(
        delRes &&
        typeof delRes === "object" &&
        delRes.success === true &&
        delRes.verifiedAbsent === true &&
        delRes.ownershipVerified === true
      );

      if (!isDelOk) {
        throw actionError(
          500,
          delRes?.reason || "PM2_DELETE_FAILED",
          `PM2 delete failed: ${delRes?.detail || delRes?.reason || "Process not verified absent"}`
        );
      }
      deletedPaths.push(`pm2:${botId}`);

      const inventory = await readInventory();
      delete inventory[botId];
      try {
        await configStore.writeJson(inventoryPath, inventory);
        deletedPaths.push(inventoryPath);
      } catch (error) {
        partial = true;
        skippedPaths.push({ path: inventoryPath, reason: error.message });
      }

      for (const target of candidates) {
        if (target === inventoryPath) continue;
        try {
          const stat = await fs.stat(target);
          await fs.rm(target, { recursive: stat.isDirectory(), force: true });
          deletedPaths.push(target);
        } catch (error) {
          if (error.code === "ENOENT") skippedPaths.push({ path: target, reason: "NOT_FOUND" });
          else {
            partial = true;
            skippedPaths.push({ path: target, reason: error.message });
          }
        }
      }

      await auditStore.append({ action: "bots.delete", botId, backup: backup.file, deletedPaths, skippedPaths, partial });
      return { botId, deletedPaths, skippedPaths, backup, partial };
    }, { root: projectRoot });
  }

  async function bulk(action, botIds = [], payload = {}) {
    const ids = [...new Set(Array.isArray(botIds) ? botIds : [])];
    const results = [];
    for (const botId of ids) {
      if (action === "delete" && payload.confirm !== DELETE_CONFIRMATION) {
        results.push({ botId, success: false, error: { code: "DELETE_CONFIRMATION_REQUIRED", message: "Bulk delete confirmation is required" } });
        continue;
      }
      try {
        const deletePayload = action === "delete"
          ? { ...payload, confirmId: payload.confirmId || botId, confirmName: payload.confirmName || (await registry.describe(botId))?.displayName }
          : payload;
        const result = await (action === "delete"
          ? deleteBot(botId, deletePayload)
          : action === "disable"
            ? disable(botId, payload)
            : action === "enable"
              ? enable(botId)
              : action === "start"
                ? start(botId, payload)
                : action === "stop" || action === "shutdown"
                  ? stop(botId, payload)
                  : action === "standby"
                    ? standby(botId, payload)
                    : action === "resume"
                      ? resume(botId, payload)
                      : action === "restart"
                        ? restart(botId)
                        : action === "active"
                          ? enable(botId)
                          : Promise.reject(actionError(400, "ACTION_UNAVAILABLE", `Unsupported action: ${action}`)));
        results.push({ botId, success: true, data: result });
      } catch (error) {
        results.push({ botId, success: false, error: { code: error.code || "ACTION_FAILED", message: error.message } });
      }
    }
    return { action, results, partial: results.some((item) => !item.success) };
  }

  return {
    start,
    stop,
    shutdown: stop,
    restart,
    standby,
    resume,
    active: enable,
    enable,
    disable,
    delete: deleteBot,
    bulk,
    getOperation: (operationId) => operationHistory.get(operationId) || null,
    getActiveOperation: (botId) => activeOperations.get(botId)?.operation || null,
    getStandbyBots: async () => {
      const bots = await registry.list();
      return bots.filter((b) => b.status === "standby");
    },
  };

  async function stopRuntime(botId, bot = null) {
    const current = bot || await requireBot(botId);
    const [pm2Status, processStatus] = await Promise.all([
      Promise.resolve(pm2.status(botId)).catch(() => null),
      Promise.resolve(process.status(botId)).catch(() => null),
    ]);
    const pm2Running = Boolean(pm2Status?.running || pm2Status?.status === "online");
    const processRunning = Boolean(processStatus?.running);
    const errors = [];
    if (pm2Running) {
      let stopResult = null;
      try {
        stopResult = normalizeActionSuccess(await pm2.stop(botId));
      } catch (error) {
        stopResult = { success: false, reason: error?.code || error?.message || "pm2_stop_failed" };
      }
      if (!stopResult?.success) {
        const mapped = actionFailureFromPM2(stopResult, "Bot could not be stopped");
        errors.push(mapped.code === "ACTION_FAILED" ? "PM2_STOP_FAILED" : mapped.code);
        if (mapped.code === "PM2_UNAVAILABLE") throw mapped;
      }
    }
    if (processRunning) {
      let killResult = null;
      try {
        killResult = normalizeActionSuccess(await process.kill(botId));
      } catch (error) {
        killResult = { success: false, reason: error?.message || "spawned_process_kill_failed" };
      }
      if (!killResult?.success) errors.push("SPAWNED_PROCESS_KILL_FAILED");
    }
    if (errors.length) throw actionError(409, "STOP_FAILED", "Bot could not be stopped", { details: errors });
  }

  async function readInventory() {
    try { return JSON.parse(await fs.readFile(registry.inventoryPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }

  async function buildManifest(botId, bot) {
    const admin = await registry.describe("admin");
    const adminPaths = new Set(collectPaths(admin).filter(Boolean).map((item) => path.resolve(projectRoot, item)));
    const protectedPaths = new Set([
      path.resolve(registry.inventoryPath),
      path.join(projectRoot, "mybot"),
      path.join(projectRoot, "assets"),
      path.join(projectRoot, "logs"),
      path.join(projectRoot, "mybot", "bots"),
      path.join(projectRoot, "mybot", "state"),
      path.join(projectRoot, "mybot", "credentials"),
      path.join(projectRoot, "mybot", "configs"),
      path.join(projectRoot, "mybot", "settings"),
      path.join(projectRoot, "mybot", "json-data"),
      path.join(projectRoot, "mybot", "command-overrides"),
      path.join(projectRoot, "mybot", "instances"),
      path.join(projectRoot, "logs", "backups"),
    ].map((item) => path.resolve(item)));
    const values = new Set([
      bot.botFile,
      bot.stateFile,
      ...collectPaths(bot),
      path.join(projectRoot, "mybot", "bots", `${botId}.json`),
      path.join(projectRoot, "mybot", "state", `${botId}.json`),
      path.join(projectRoot, "mybot", "credentials", botId),
      path.join(projectRoot, "mybot", "overrides", botId),
      path.join(projectRoot, "mybot", "config", botId),
      path.join(projectRoot, "mybot", "data", botId),
      path.join(projectRoot, "mybot", "instances", botId),
      path.join(projectRoot, "mybot", "configs", `${botId}.json`),
      path.join(projectRoot, "mybot", "credentials", `${botId}.json`),
      path.join(projectRoot, "mybot", "json-data", `${botId}.json`),
      path.join(projectRoot, "mybot", "settings", `${botId}.json`),
      path.join(projectRoot, "logs", `${botId}.log`),
      path.join(projectRoot, "logs", `${botId}.error.log`),
    ]);
    if (typeof createBotConfig === "function") collectGeneratedPaths(createBotConfig(botId, bot.webPort || bot.port || 0), values);
    const output = [];
    for (const value of values) {
      if (!value) continue;
      const target = path.resolve(projectRoot, value);
      if (!isWithinRoot(target) || isProtectedPath(target, protectedPaths, adminPaths)) throw actionError(400, "DELETE_PATH_UNSAFE", `Unsafe delete path: ${target}`);
      if (!output.some((existing) => target === existing || target.startsWith(`${existing}${path.sep}`))) output.push(target);
    }
    return output;
  }

  async function writeDeleteManifest(botId, candidates) {
    const inventory = await fs.readFile(registry.inventoryPath, "utf8").catch(() => "{}");
    const files = [{ path: path.relative(projectRoot, registry.inventoryPath), value: inventory }];
    for (const target of candidates) await collectBackupFiles(target, files);
    const dir = path.join(projectRoot, "logs", "backups");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `bot-delete-${botId}-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify({ botId, createdAt: new Date().toISOString(), files }, null, 2), "utf8");
    return { file, count: files.length };
  }

  async function collectBackupFiles(target, files) {
    try {
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        files.push({ path: path.relative(projectRoot, target), value: await fs.readFile(target, "utf8") });
        return;
      }
      if (!stat.isDirectory()) return;
      for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        await collectBackupFiles(path.join(target, entry.name), files);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function collectPaths(bot) { return Object.values(bot?.paths || {}).filter((value) => typeof value === "string"); }
  function collectGeneratedPaths(value, output) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && /(path|file|dir|folder)/i.test(key)) output.add(item);
      else if (item && typeof item === "object") collectGeneratedPaths(item, output);
    }
  }
  function isWithinRoot(target) { return target === projectRoot || target.startsWith(`${projectRoot}${path.sep}`); }
  function isProtectedPath(target, protectedPaths, adminPaths) {
    if ([...protectedPaths].some((protectedPath) => target === protectedPath || protectedPath.startsWith(`${target}${path.sep}`))) return true;
    return [...adminPaths].some((protectedPath) => target === protectedPath || target.startsWith(`${protectedPath}${path.sep}`) || protectedPath.startsWith(`${target}${path.sep}`));
  }
  function assertEnabled(bot) { if (bot.enabled === false || bot.status === "disabled") throw actionError(409, "BOT_DISABLED", bot.disabledReason || "Bot is disabled"); }
}

async function resolveAdminReloadUrl(resolvedRoot, bot) {
  const directPort = Number(bot?.webPort || bot?.port || 0);
  if (Number.isFinite(directPort) && directPort > 0) {
    return `http://127.0.0.1:${directPort}/internal/runtime/reload`;
  }
  const candidateFiles = [
    path.join(resolvedRoot, "mybot", "bots", "admin.json"),
    path.join(resolvedRoot, "mybot", "state", "admin.json"),
    path.join(resolvedRoot, "mybot", "mybots.json"),
    path.join(resolvedRoot, "assets", "config.json"),
  ];
  for (const file of candidateFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      const entry = path.basename(file) === "mybots.json" ? parsed?.admin : parsed;
      const candidatePort = Number(entry?.webPort || entry?.port || entry?.runtime?.port || 0);
      if (Number.isFinite(candidatePort) && candidatePort > 0) {
        return `http://127.0.0.1:${candidatePort}/internal/runtime/reload`;
      }
    } catch {}
  }
  if (process.env.BOT_WEB_URL) {
    try {
      return new URL("/internal/runtime/reload", process.env.BOT_WEB_URL).toString();
    } catch {}
  }
  return "http://127.0.0.1:2000/internal/runtime/reload";
}

async function defaultRestartLauncher({
  botId = "admin",
  root = process.cwd(),
  pm2 = null,
  bot = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolvedRoot = path.resolve(root);
  await fs.mkdir(resolvedRoot, { recursive: true }).catch(() => {});
  requestRestartForBot(botId, { reason: "dashboard" }, { root: resolvedRoot });

  const effectivePm2 = pm2 || { status: checkPM2Status, restart: restartPM2Process };
  if (typeof effectivePm2.restart === "function") {
    let shouldTryPm2 = typeof effectivePm2.status !== "function";
    if (!shouldTryPm2) {
      const status = await Promise.resolve(effectivePm2.status(botId)).catch(() => null);
      const statusText = String(status?.status || "").toLowerCase();
      shouldTryPm2 = Boolean(
        status?.running === true ||
        ["online", "stopped", "stopping", "launching", "errored"].includes(statusText)
      );
    }
    if (shouldTryPm2) {
      const restarted = normalizeActionSuccess(await Promise.resolve(effectivePm2.restart(botId)).catch(() => false));
      if (restarted?.success) return true;
    }
  }

  if (typeof fetchImpl === "function") {
    const reloadUrl = await resolveAdminReloadUrl(resolvedRoot, bot);
    await fetchImpl(reloadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restart", reason: "dashboard" }),
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(1500) : undefined,
    }).catch(() => null);
  }

  return true;
}

function actionError(status, code, message, details = {}) {
  const error = new Error(message);
  Object.assign(error, { status, code, ...details });
  return error;
}

export { DELETE_CONFIRMATION, defaultRestartLauncher };
