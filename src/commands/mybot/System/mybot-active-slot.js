import path from "node:path";
import { getProjectRoot } from "../../../utils/env.js";
import { loadMyBotsRegistry } from "./mybots-registry.js";
import { getProfile } from "./mybot-profile-service.js";
import { isBotOwnedByCaller } from "./mybot-identity.js";

export function resolveOwnedActivationCandidates({ ownerUid, registry = null, projectRoot = getProjectRoot() } = {}) {
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner) return [];
  const root = projectRoot || getProjectRoot();
  const reg = registry || loadMyBotsRegistry(path.join(root, "mybot", "mybots.json"));
  const candidates = [];
  for (const [key, bot] of Object.entries(reg)) {
    if (!bot || typeof bot !== "object") continue;
    if (bot.isMain === true || key === "admin" || String(bot.name || "").toLowerCase() === "admin") continue;
    if (!isBotOwnedByCaller(bot, normOwner) || bot.status === "deleting") continue;
    const bOwner = String(bot.ownerUid || bot.createdByUid || (/^\d{10,}$/.test(String(bot.createdBy || "")) ? bot.createdBy : "")).trim() || normOwner;
    const profile = getProfile(bot.uid || key, { root }) || {};
    candidates.push({ key, uid: bot.uid || key, name: bot.name || key, displayName: bot.displayName || profile.nameServer || bot.name || key, ownerUid: bOwner, ownerName: bot.ownerName || profile.ownerName || "", status: bot.status || profile.status || "stopped", trialStatus: profile.trialStatus || bot.trialStatus || "pending", expiryAt: profile.expiryAt ?? bot.expiryAt ?? null, avatar: bot.avatar || profile.avatar || "", enabled: bot.enabled !== false && profile.enabled !== false, webPort: bot.webPort || profile.webPort, createdAt: bot.createdAt || profile.createdAt || 0, rawRecord: bot, profile });
  }
  candidates.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime() || String(a.key).localeCompare(String(b.key)));
  return candidates;
}

export function listOwnerActiveBots({ ownerUid, excludeBotUid = null, candidates = null, registry = null, projectRoot = getProjectRoot(), runtimeResolver = null } = {}) {
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner) return [];
  const normExclude = excludeBotUid ? String(excludeBotUid).trim() : null;
  const list = candidates || resolveOwnedActivationCandidates({ ownerUid: normOwner, registry, projectRoot });
  const now = Date.now();
  const active = [];
  for (const bot of list) {
    if (normExclude && (bot.uid === normExclude || bot.key === normExclude)) continue;
    if (bot.status === "rejected" || bot.enabled === false) continue;
    let isRunning = bot.status === "running" || bot.status === "starting";
    if (runtimeResolver?.isBotRunning) isRunning = isRunning || runtimeResolver.isBotRunning(bot.uid || bot.key);
    if (isRunning) {
      active.push({ bot, reason: "BOT_RUNNING" });
      continue;
    }
    const isPermanent = bot.expiryAt === "-1" || bot.expiryAt === -1;
    const isUnexpired = bot.expiryAt && new Date(bot.expiryAt).getTime() > now;
    if (isPermanent || isUnexpired) {
      active.push({
        bot,
        reason: isPermanent ? "PERMANENT_ACTIVE" : (bot.trialStatus === "active" ? "TRIAL_ACTIVE" : "UNEXPIRED_PLAN"),
      });
    }
  }
  return active;
}

export function resolveOwnerActiveSlot({ ownerUid, candidates = null, registry = null, projectRoot = getProjectRoot(), runtimeResolver = null } = {}) {
  const active = listOwnerActiveBots({ ownerUid, candidates, registry, projectRoot, runtimeResolver });
  if (active.length > 0) {
    return { occupied: true, activeBot: active[0].bot, reason: active[0].reason, activeCount: active.length };
  }
  return { occupied: false, activeBot: null, reason: null, activeCount: 0 };
}
