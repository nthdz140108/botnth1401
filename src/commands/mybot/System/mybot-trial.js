import fs from "fs";
import path from "path";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { claimOwnerTrial, getOwnerTrialStatus } from "./mybot-trial-ledger.js";
import { getProfile, updateProfile } from "./mybot-profile-service.js";

const DEFAULT_REGISTRY_PATH = path.join(process.cwd(), "mybot", "mybots.json");

export async function activatePendingTrial(botUid, {
  registryPath = DEFAULT_REGISTRY_PATH,
  now = Date.now(),
  ownerUid = null,
  enforceQuota = false,
  root = process.cwd(),
} = {}) {
  if (!botUid) throw new Error("botUid is required");
  const myBots = fs.existsSync(registryPath) ? loadMyBotsRegistry(registryPath) : {};
  const bot = myBots[botUid];
  if (!bot) throw new Error(`Bot ${botUid} không tồn tại trong registry`);

  const effectiveOwner = ownerUid || bot.ownerUid || bot.createdByUid || botUid;
  const hasExplicitExpiry = Boolean(
    bot.expiryAt !== null &&
    bot.expiryAt !== undefined &&
    bot.expiryAt !== "" &&
    (String(bot.expiryAt).trim() === "-1" || !Number.isNaN(Date.parse(String(bot.expiryAt))))
  );
  const isPending = !hasExplicitExpiry && (bot.trialStatus === "pending" || bot.trialStatus !== "active");
  const currentTime = Number(now) || Date.now();
  const trialDurationMs = Number(bot.trialDurationMs) || 3600000;

  if (enforceQuota && isPending) {
    const claimRes = claimOwnerTrial(effectiveOwner, botUid, {
      durationMs: trialDurationMs,
      now: currentTime,
      root,
    });
    if (!claimRes.success) {
      const err = new Error(claimRes.error || "Trial quota exhausted");
      err.code = claimRes.code || "TRIAL_QUOTA_EXHAUSTED";
      throw err;
    }
    bot.trialStatus = "active";
    bot.trialStartedAt = claimRes.grantedAt;
    bot.expiryAt = claimRes.expiryAt;
    bot.trialDurationMs = trialDurationMs;
  } else if (isPending && (!bot.expiryAt || bot.trialStatus === "pending")) {
    bot.trialStatus = "active";
    bot.trialStartedAt = new Date(currentTime).toISOString();
    bot.expiryAt = new Date(currentTime + trialDurationMs).toISOString();
    bot.trialDurationMs = trialDurationMs;
  }

  bot.status = "running";
  bot.lastUpdated = new Date(currentTime).toISOString();

  saveMyBotsRegistry(myBots, registryPath);

  // Sync with profile.json
  try {
    updateProfile(botUid, {
      trialStatus: bot.trialStatus,
      expiryAt: bot.expiryAt,
      enabled: true,
    }, { root });
  } catch {}

  return bot;
}

export async function revertFailedTrialReactivation(botUid, {
  registryPath = DEFAULT_REGISTRY_PATH,
  now = Date.now(),
  root = process.cwd(),
} = {}) {
  if (!botUid) throw new Error("botUid is required");
  const myBots = fs.existsSync(registryPath) ? loadMyBotsRegistry(registryPath) : {};
  const bot = myBots[botUid];
  if (!bot) return null;

  if (bot.trialStatus === "activating" || bot.trialStatus === "pending" || !bot.trialStartedAt) {
    bot.trialStatus = "pending";
    bot.trialStartedAt = null;
    bot.expiryAt = null;
  }

  bot.status = "stopped";
  bot.pid = null;
  bot.consolePid = null;
  bot.lastUpdated = new Date(Number(now) || Date.now()).toISOString();

  saveMyBotsRegistry(myBots, registryPath);

  // Sync with profile.json
  try {
    updateProfile(botUid, {
      trialStatus: bot.trialStatus,
      trialStartedAt: bot.trialStartedAt,
      expiryAt: bot.expiryAt,
    }, { root });
  } catch {}

  return bot;
}
