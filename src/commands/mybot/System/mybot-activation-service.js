import fs from "node:fs";
import path from "node:path";
import { getProfile, updateProfile } from "./mybot-profile-service.js";
import {
  reserveTrialActivation,
  getTrialLedgerPath,
} from "./mybot-trial-ledger.js";
import { getProjectRoot } from "../../../utils/env.js";
import { resolveManagedBotTarget } from "./mybot-identity.js";
import { getBotLaunchGeneration } from "./pm2-manager.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { beginBotStartOperation, isBotStartOperationCurrent, cancelledStart } from "./bot-lifecycle-operation.js";
import { withRegistryLock } from "./registry-lock.js";
import { withMyBotsTransaction } from "../Manager/qr-provisioning-registry.js";
import {
  resolveOwnedActivationCandidates,
  resolveOwnerActiveSlot,
  listOwnerActiveBots,
} from "./mybot-active-slot.js";

export { resolveOwnedActivationCandidates, resolveOwnerActiveSlot, listOwnerActiveBots };

export const DEFAULT_MAX_ACTIVE_BOTS_PER_OWNER = Infinity;

function resolveMaxActiveBotsLimit(explicitLimit) {
  const raw = explicitLimit !== undefined ? explicitLimit : process.env.MYBOT_MAX_ACTIVE_PER_OWNER;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_ACTIVE_BOTS_PER_OWNER;
  if (raw === Infinity || String(raw).trim().toLowerCase() === "infinity" || String(raw).trim().toLowerCase() === "unlimited") {
    return Infinity;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return Infinity;
  return Math.floor(numeric);
}

const inFlightActivations = new Map();

export async function activateBot({
  botId,
  actorUid,
  isSystemAdmin = false,
  root = getProjectRoot(),
  pm2Adapter = null,
  launcherAdapter = null,
  checkHealth = true,
  healthProbe = null,
  durationMs = 60 * 60 * 1000,
  maxActiveBotsPerOwner,
  operationId = null,
} = {}) {
  if (!botId) {
    return { success: false, code: "BOT_NOT_FOUND", error: "botId is required" };
  }

  const bId = String(botId).trim();
  const projectRoot = root || getProjectRoot();
  const generation = getBotLaunchGeneration(bId, projectRoot);
  let lifecycleOperationId = null;
  const assertNotCancelled = () => {
    if (getBotLaunchGeneration(bId, projectRoot) !== generation || !isBotStartOperationCurrent(bId, lifecycleOperationId, { root: projectRoot })) throw cancelledStart();
  };

  // Resolve inventory and bot record first
  const inventoryPath = path.join(projectRoot, "mybot", "mybots.json");
  let inventory = {};
  try {
    if (fs.existsSync(inventoryPath)) {
      inventory = loadMyBotsRegistry(inventoryPath);
    }
  } catch {}

  const resolvedTargets = resolveManagedBotTarget({
    selector: { type: "uid", value: bId },
    callerUid: actorUid,
    isSystemAdmin,
    projectRoot,
  });
  const targetBot = resolvedTargets && resolvedTargets.length > 0 ? resolvedTargets[0] : null;

  const botEntry = inventory[bId] || (targetBot ? targetBot.rawRecord : null);
  const profile = getProfile(bId, { root: projectRoot });

  if (!botEntry && !targetBot && !fs.existsSync(path.join(projectRoot, "mybot", "bots", `${bId}.json`))) {
    return { success: false, code: "BOT_NOT_FOUND", error: `Bot ${bId} not found` };
  }

  if (botEntry?.status === "rejected" || profile?.status === "rejected" || targetBot?.status === "rejected") {
    return { success: false, code: "BOT_REJECTED", error: "Bot is rejected by admin" };
  }

  if (botEntry?.enabled === false || profile?.enabled === false || targetBot?.enabled === false) {
    return { success: false, code: "BOT_DISABLED", error: "Bot is disabled" };
  }

  // Check credential
  const credPath = botEntry?.configFilePath
    ? (path.isAbsolute(botEntry.configFilePath) ? botEntry.configFilePath : path.join(projectRoot, botEntry.configFilePath))
    : path.join(projectRoot, "mybot", "credentials", `${bId}.json`);

  let credValid = false;
  if (fs.existsSync(credPath)) {
    try {
      const cred = JSON.parse(fs.readFileSync(credPath, "utf8").replace(/^\uFEFF/, ""));
      if (cred && (cred.cookie || cred.imei || cred.token)) {
        credValid = true;
      }
    } catch {}
  } else {
    const altCred = path.join(projectRoot, "mybot", "bots", `${bId}-credential.json`);
    if (fs.existsSync(altCred)) credValid = true;
  }

  if (!credValid) {
    return { success: false, code: "CREDENTIAL_MISSING", error: "Bot credential is missing or empty" };
  }

  const ownerUid = targetBot?.ownerUid || profile?.ownerUid || botEntry?.ownerUid || actorUid;
  if (!isSystemAdmin && actorUid && ownerUid && String(actorUid) !== String(ownerUid)) {
    return { success: false, code: "FORBIDDEN", error: "You are not authorized to activate this bot" };
  }

  const effectiveMaxActive = resolveMaxActiveBotsLimit(maxActiveBotsPerOwner);

  // Optional owner active slot cap (unlimited / Infinity by default; enforced only when finite cap is configured)
  if (ownerUid && Number.isFinite(effectiveMaxActive)) {
    const activeOthers = listOwnerActiveBots({
      ownerUid,
      excludeBotUid: bId,
      projectRoot,
      runtimeResolver: pm2Adapter ? { isBotRunning: (id) => pm2Adapter.isRunning?.(id) } : null,
    });

    if (activeOthers.length >= effectiveMaxActive) {
      const firstOccupied = activeOthers[0].bot;
      const occupiedName = firstOccupied.displayName || firstOccupied.name || firstOccupied.uid;
      return {
        success: false,
        code: "OWNER_ACTIVE_BOT_EXISTS",
        error: isSystemAdmin
          ? `Chủ bot (${ownerUid}) đang có bot "${occupiedName}" đang hoạt động hoặc còn hạn dùng (tối đa ${effectiveMaxActive} bot cùng lúc).`
          : `Bạn đang có bot "${occupiedName}" đang hoạt động hoặc còn hạn dùng (tối đa ${effectiveMaxActive} bot cùng lúc).`,
        activeBot: firstOccupied,
      };
    }
  }

  // Check in-flight lock (per-bot always; per-owner only when a finite active cap is configured)
  const botLockKey = `bot_${projectRoot}_${bId}`;
  const ownerLockKey = ownerUid && Number.isFinite(effectiveMaxActive) ? `owner_${ownerUid}` : null;
  if (inFlightActivations.has(botLockKey) || (ownerLockKey && inFlightActivations.has(ownerLockKey))) {
    return {
      success: false,
      code: "ACTIVATION_IN_PROGRESS",
      error: "Đang có một tiến trình kích hoạt bot khác đang diễn ra cho tài khoản này.",
    };
  }

  const assertActivationConfigUnchanged = () => {
    const latest = loadMyBotsRegistry(inventoryPath)[bId];
    for (const field of ["ownerUid", "enabled", "expiryAt", "activationPolicy", "activatedAt"]) {
      const semantic = record => field === "enabled" ? record?.enabled !== false : field === "ownerUid" ? (record?.ownerUid || record?.createdByUid || null) : record?.[field] ?? null;
      if (JSON.stringify(semantic(latest)) !== JSON.stringify(semantic(botEntry))) {
        throw Object.assign(new Error("Bot configuration changed during startup; retry with the current configuration"), { code: "ACTIVATION_CONFIG_CHANGED" });
      }
    }
  };

  const execution = (async () => {
    lifecycleOperationId = await beginBotStartOperation(bId, { root: projectRoot, operationId });

    const now = Date.now();
    const isPermanent = profile?.expiryAt === "-1" || profile?.expiryAt === -1;
    const isUnexpired = profile?.expiryAt && new Date(profile.expiryAt).getTime() > now;

    // Case 1: Bot already has valid expiry (permanent or unexpired trial / admin extended)
    const policy = profile.activationPolicy || botEntry?.activationPolicy;
    const pendingPolicy = !profile.activatedAt && policy &&
      (policy.type === "permanent" || (policy.type === "duration" && Number(policy.durationMs) > 0));
    if (isPermanent || isUnexpired || pendingPolicy) {
      // If process already running, return success immediately
      if (!pendingPolicy && botEntry?.status === "running" && await pm2Adapter?.isRunning?.(bId)) {
        const health = await performHealthCheck({ botId: bId, webPort: botEntry?.webPort, root: projectRoot, pm2Adapter, healthProbe });
        if (!health.healthy) return { success: false, code: "READINESS_FAILED", error: health.error || "Bot is not ready", health };
        assertNotCancelled();
        return {
          success: true,
          botId: bId,
          ownerUid,
          alreadyRunning: true,
          trialGranted: false,
          expiryAt: profile.expiryAt,
          status: "running",
        };
      }

      try {
        await startProcess({ botId: bId, root: projectRoot, operationId: lifecycleOperationId, pm2Adapter, launcherAdapter });
        let health = { healthy: true };
        if (checkHealth) {
          health = await performHealthCheck({
            botId: bId,
            webPort: botEntry?.webPort || profile?.webPort,
            root: projectRoot,
            pm2Adapter,
            healthProbe,
          });
          if (!health.healthy) {
            throw new Error(health.error || "Health check failed after start");
          }
        }

        assertNotCancelled();
        const readyAt = Number.isFinite(Date.parse(health.checkedAt)) ? Date.parse(health.checkedAt) : Date.now();
        const effectiveExpiry = pendingPolicy
          ? (policy.type === "permanent" ? "-1" : new Date(readyAt + Number(policy.durationMs)).toISOString())
          : profile.expiryAt;
        await withMyBotsTransaction({ root: projectRoot, registryPath: inventoryPath }, () => {
          assertNotCancelled();
          assertActivationConfigUnchanged();
          updateProfile(bId, {
            enabled: true, desiredStatus: "running",
            ...(pendingPolicy ? { activatedAt: new Date(readyAt).toISOString(), expiryAt: effectiveExpiry, trialStatus: "not_required" } : {}),
          }, { root: projectRoot });
          if (fs.existsSync(inventoryPath)) {
            const inv = loadMyBotsRegistry(inventoryPath);
            if (inv[bId]) {
              inv[bId].status = "running";
              inv[bId].desiredStatus = "running";
              inv[bId].enabled = true;
              inv[bId].lastUpdated = new Date().toISOString();
              saveMyBotsRegistry(inv, inventoryPath);
            }
          }
        });

        return {
          success: true,
          botId: bId,
          ownerUid,
          trialGranted: false,
          weekKey: null,
          expiryAt: effectiveExpiry,
          status: "running",
          health,
        };
      } catch (err) {
        await cleanupFailedProcess(bId, projectRoot, pm2Adapter, lifecycleOperationId);
        return { success: false, code: err?.code || "ACTIVATION_FAILED", error: err?.message || "Failed to start bot process" };
      }
    }

    // Case 2: Trial activation flow: First reserve to prevent race conditions
    const reserveRes = reserveTrialActivation(ownerUid, bId, { root: projectRoot, durationMs, now });
    if (!reserveRes.success) {
      return {
        success: false,
        code: reserveRes.code || "TRIAL_QUOTA_EXHAUSTED",
        error: reserveRes.error || "Trial quota exhausted",
        weekKey: reserveRes.weekKey,
      };
    }
    const txn = reserveRes.txn;

    try {
      await startProcess({ botId: bId, root: projectRoot, operationId: lifecycleOperationId, pm2Adapter, launcherAdapter });

      let health = { healthy: true };
      if (checkHealth) {
        health = await performHealthCheck({
          botId: bId,
          webPort: botEntry?.webPort || profile?.webPort,
          root: projectRoot,
          pm2Adapter,
          healthProbe,
        });
        if (!health.healthy) {
          throw new Error(health.error || "Health check failed after start");
        }
      }

      // ONLY after process is running and healthy: commit trial.
      // The trial clock starts at the moment the bot reached READY (health /
      // readiness probe), NOT at the moment start was issued. This is the fix
      // for "trial time counts from before the bot was ready".
      assertNotCancelled();
      const readyAt = health?.checkedAt ? Date.parse(health.checkedAt) : Date.now();
      const activatedNow = Number.isFinite(readyAt) ? readyAt : Date.now();
      let claim;
      await withMyBotsTransaction({ root: projectRoot, registryPath: inventoryPath }, (finalization) => {
        assertNotCancelled();
        assertActivationConfigUnchanged();
        finalization.trackFile(getTrialLedgerPath(projectRoot));
        claim = txn.commit({ commitNow: activatedNow, commitDurationMs: durationMs });
        if (!claim.success) {
          throw new Error(claim.error || "Failed to commit trial ledger");
        }

        // Update profile
        updateProfile(bId, {
          desiredStatus: "running",
          trialStatus: "active",
          trialStartedAt: claim.grantedAt,
          expiryAt: claim.expiryAt,
          enabled: true,
        }, { root: projectRoot });

        // Update inventory status
        if (fs.existsSync(inventoryPath)) {
          const inv = loadMyBotsRegistry(inventoryPath);
          if (inv[bId]) {
            inv[bId].status = "running";
            inv[bId].desiredStatus = "running";
            inv[bId].trialStatus = "active";
            inv[bId].trialStartedAt = claim.grantedAt;
            inv[bId].expiryAt = claim.expiryAt;
            inv[bId].enabled = true;
            inv[bId].lastUpdated = new Date(activatedNow).toISOString();
            saveMyBotsRegistry(inv, inventoryPath);
          }
        }

      });

      return {
        success: true,
        botId: bId,
        ownerUid,
        trialGranted: true,
        weekKey: claim.weekKey,
        trialStartedAt: claim.grantedAt,
        expiryAt: claim.expiryAt,
        status: "running",
        health,
      };
    } catch (startErr) {
      await cleanupFailedProcess(bId, projectRoot, pm2Adapter, lifecycleOperationId);
      txn.release();
      if (!isBotStartOperationCurrent(bId, lifecycleOperationId, { root: projectRoot })) {
        return { success: false, code: "START_CANCELLED", error: "Activation was superseded by a newer lifecycle operation" };
      }

      return {
        success: false,
        code: startErr?.code || "ACTIVATION_FAILED",
        error: startErr?.message || "Failed to start bot process",
      };
    }
  })();

  inFlightActivations.set(botLockKey, execution);
  if (ownerLockKey) inFlightActivations.set(ownerLockKey, execution);

  try {
    return await execution;
  } finally {
    if (inFlightActivations.get(botLockKey) === execution) {
      inFlightActivations.delete(botLockKey);
    }
    if (ownerLockKey && inFlightActivations.get(ownerLockKey) === execution) {
      inFlightActivations.delete(ownerLockKey);
    }
  }
}

async function startProcess({ botId, root, operationId, pm2Adapter, launcherAdapter }) {
  if (pm2Adapter && typeof pm2Adapter.start === "function") {
    const res = await pm2Adapter.start(botId, { projectRoot: root, operationId });
    if (res === false) throw new Error("PM2 start returned false");
    return;
  }
  if (launcherAdapter && typeof launcherAdapter.startBotWithLauncher === "function") {
    const res = await launcherAdapter.startBotWithLauncher(botId, { root, projectRoot: root, operationId });
    if (res && res.success === false) {
      throw new Error(res.error || res.reason || "Launcher failed to start bot");
    }
    return;
  }
  const { startBotWithLauncher } = await import("./pm2-manager.js");
  if (typeof startBotWithLauncher === "function") {
    const res = await startBotWithLauncher(botId, { root, projectRoot: root, operationId });
    if (res && res.success === false) {
      throw new Error(res.error || res.reason || "Launcher failed to start bot");
    }
    return;
  }
  throw new Error("No valid launcher available to start bot");
}

async function performHealthCheck({ botId, webPort, root, pm2Adapter, healthProbe }) {
  if (typeof healthProbe === "function") {
    const res = await healthProbe(botId);
    if (typeof res === "boolean") return { healthy: res };
    return res || { healthy: false, error: "Health probe returned falsy" };
  }
  if (pm2Adapter && typeof pm2Adapter.checkHealth === "function") {
    const res = await pm2Adapter.checkHealth(botId);
    if (typeof res === "boolean") return { healthy: res };
    return res || { healthy: false, error: "PM2 adapter health check failed" };
  }
  const { checkBotHealth } = await import("./pm2-manager.js");
  if (typeof checkBotHealth === "function") {
    return await checkBotHealth(botId, webPort || 4444, 5000, root);
  }
  return { healthy: false, error: "No readiness probe available" };
}

async function cleanupFailedProcess(botId, root, pm2Adapter, operationId) {
  return withRegistryLock(path.join(root, "mybot", "mybots.json"), async () => {
  const registry = loadMyBotsRegistry(path.join(root, "mybot", "mybots.json"));
  if (registry[botId]?.desiredStatus === "running" && registry[botId]?.operationId !== operationId) return;
  try {
    if (pm2Adapter && typeof pm2Adapter.stop === "function") {
      await pm2Adapter.stop(botId);
      return;
    }
  } catch {}
  try {
    const { killSpawnedProcess, stopPM2Process } = await import("./pm2-manager.js");
    if (typeof killSpawnedProcess === "function") await killSpawnedProcess(botId);
    if (typeof stopPM2Process === "function") await stopPM2Process(botId);
  } catch {}
  });
}
