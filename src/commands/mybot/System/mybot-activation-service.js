import { assertNotPortalManaged } from "../../../dashboard/portal-policy.js";
import fs from "node:fs";
import path from "node:path";
import { getProfile, updateProfile } from "./mybot-profile-service.js";
import {
  claimOwnerTrial,
  releaseOwnerTrial,
  getBangkokCalendarWeek,
  reserveTrialActivation,
} from "./mybot-trial-ledger.js";
import { getProjectRoot } from "../../../utils/env.js";
import { resolveManagedBotTarget } from "./mybot-identity.js";
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
} = {}) {
  if (!botId) {
    return { success: false, code: "BOT_NOT_FOUND", error: "botId is required" };
  }

  const bId = String(botId).trim();
  const projectRoot = root || getProjectRoot();
  try { assertNotPortalManaged(projectRoot, bId); } catch (error) { return {success:false,code:error.code,error:"Suất MYBOT Cloud phải được quản lý tại cổng thuê."}; }

  // Resolve inventory and bot record first
  const inventoryPath = path.join(projectRoot, "mybot", "mybots.json");
  let inventory = {};
  try {
    if (fs.existsSync(inventoryPath)) {
      inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8").replace(/^\uFEFF/, ""));
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
  const profile = getProfile(targetBot?.uid || bId, { root: projectRoot });

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
  const botLockKey = `bot_${bId}`;
  const ownerLockKey = ownerUid && Number.isFinite(effectiveMaxActive) ? `owner_${ownerUid}` : null;
  if (inFlightActivations.has(botLockKey) || (ownerLockKey && inFlightActivations.has(ownerLockKey))) {
    return {
      success: false,
      code: "ACTIVATION_IN_PROGRESS",
      error: "Đang có một tiến trình kích hoạt bot khác đang diễn ra cho tài khoản này.",
    };
  }

  const execution = (async () => {
    // Snapshots for rollback
    const profileSnapshot = JSON.parse(JSON.stringify(profile || {}));
    const registrySnapshot = botEntry ? JSON.parse(JSON.stringify(botEntry)) : null;

    const now = Date.now();
    const isPermanent = profile?.expiryAt === "-1" || profile?.expiryAt === -1;
    const isUnexpired = profile?.expiryAt && new Date(profile.expiryAt).getTime() > now;

    // Case 1: Bot already has valid expiry (permanent or unexpired trial / admin extended)
    if (isPermanent || isUnexpired) {
      // If process already running, return success immediately
      if (botEntry?.status === "running" && pm2Adapter?.isRunning?.(bId)) {
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
        await startProcess({ botId: bId, root: projectRoot, pm2Adapter, launcherAdapter });
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

        // Update profile & registry
        updateProfile(bId, { enabled: true }, { root: projectRoot });
        if (fs.existsSync(inventoryPath)) {
          const inv = JSON.parse(fs.readFileSync(inventoryPath, "utf8").replace(/^\uFEFF/, ""));
          if (inv[bId]) {
            inv[bId].status = "running";
            inv[bId].enabled = true;
            inv[bId].lastUpdated = new Date().toISOString();
            fs.writeFileSync(inventoryPath, JSON.stringify(inv, null, 2), "utf8");
          }
        }

        return {
          success: true,
          botId: bId,
          ownerUid,
          trialGranted: false,
          weekKey: null,
          expiryAt: profile.expiryAt,
          status: "running",
          health,
        };
      } catch (err) {
        await cleanupFailedProcess(bId, projectRoot, pm2Adapter);
        return { success: false, code: "ACTIVATION_FAILED", error: err?.message || "Failed to start bot process" };
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

    let claimRecord = null;
    try {
      await startProcess({ botId: bId, root: projectRoot, pm2Adapter, launcherAdapter });

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
      const readyAt = health?.checkedAt ? Date.parse(health.checkedAt) : Date.now();
      const activatedNow = Number.isFinite(readyAt) ? readyAt : Date.now();
      const claim = txn.commit({ commitNow: activatedNow, commitDurationMs: durationMs });
      if (!claim.success) {
        throw new Error(claim.error || "Failed to commit trial ledger");
      }
      claimRecord = claim;

      // Update profile
      updateProfile(bId, {
        trialStatus: "active",
        trialStartedAt: claim.grantedAt,
        expiryAt: claim.expiryAt,
        enabled: true,
      }, { root: projectRoot });

      // Update inventory status
      if (fs.existsSync(inventoryPath)) {
        const inv = JSON.parse(fs.readFileSync(inventoryPath, "utf8").replace(/^\uFEFF/, ""));
        if (inv[bId]) {
          inv[bId].status = "running";
          inv[bId].trialStatus = "active";
          inv[bId].trialStartedAt = claim.grantedAt;
          inv[bId].expiryAt = claim.expiryAt;
          inv[bId].enabled = true;
          inv[bId].lastUpdated = new Date(activatedNow).toISOString();
          fs.writeFileSync(inventoryPath, JSON.stringify(inv, null, 2), "utf8");
        }
      }

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
      // Rollback on failure: stop process, release trial claim, revert profile & inventory snapshots
      await cleanupFailedProcess(bId, projectRoot, pm2Adapter);
      if (claimRecord?.weekKey) {
        try {
          releaseOwnerTrial(ownerUid, claimRecord.weekKey, { root: projectRoot });
        } catch {}
      } else {
        try {
          txn.release();
        } catch {}
      }

      try {
        updateProfile(bId, {
          trialStatus: profileSnapshot.trialStatus || "pending",
          trialStartedAt: profileSnapshot.trialStartedAt || null,
          expiryAt: profileSnapshot.expiryAt || null,
          enabled: profileSnapshot.enabled !== false,
        }, { root: projectRoot });
      } catch {}

      if (fs.existsSync(inventoryPath)) {
        try {
          const inv = JSON.parse(fs.readFileSync(inventoryPath, "utf8").replace(/^\uFEFF/, ""));
          if (inv[bId]) {
            if (registrySnapshot) {
              // Restore the pre-activation snapshot but ALWAYS normalize the
              // trial fields back to pending so a failed activation never
              // leaves a half-committed trial (no expiry, no startedAt).
              inv[bId] = {
                ...registrySnapshot,
                status: registrySnapshot.status === "running" ? "stopped" : registrySnapshot.status,
                trialStatus: "pending",
                trialStartedAt: null,
                expiryAt: null,
              };
            } else {
              inv[bId].status = "stopped";
              inv[bId].trialStatus = "pending";
              inv[bId].trialStartedAt = null;
              inv[bId].expiryAt = null;
            }
            inv[bId].lastUpdated = new Date().toISOString();
            fs.writeFileSync(inventoryPath, JSON.stringify(inv, null, 2), "utf8");
          }
        } catch {}
      }

      return {
        success: false,
        code: "ACTIVATION_FAILED",
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

async function startProcess({ botId, root, pm2Adapter, launcherAdapter }) {
  if (pm2Adapter && typeof pm2Adapter.start === "function") {
    const res = await pm2Adapter.start(botId);
    if (res === false) throw new Error("PM2 start returned false");
    return;
  }
  if (launcherAdapter && typeof launcherAdapter.startBotWithLauncher === "function") {
    const res = await launcherAdapter.startBotWithLauncher(botId, { root });
    if (res && res.success === false) {
      throw new Error(res.error || res.reason || "Launcher failed to start bot");
    }
    return;
  }
  const { startBotWithLauncher } = await import("./pm2-manager.js");
  if (typeof startBotWithLauncher === "function") {
    const res = await startBotWithLauncher(botId, { root });
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
    return await checkBotHealth(botId, webPort || 4444, 5000);
  }
  return { healthy: true };
}

async function cleanupFailedProcess(botId, root, pm2Adapter) {
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
}
