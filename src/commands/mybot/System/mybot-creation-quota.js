import fs from "fs";
import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
import { writeJsonAtomic } from "./json-state.js";
import { loadMyBotsRegistry } from "./mybots-registry.js";

export const DEFAULT_MAX_BOTS_PER_OWNER = Infinity;

function getReservationsPath(root) {
  return path.join(root, "mybot", "state", "quota-reservations.json");
}

function loadReservations(root) {
  const resPath = getReservationsPath(root);
  try {
    if (fs.existsSync(resPath)) {
      const raw = fs.readFileSync(resPath, "utf8").replace(/^\uFEFF/, "");
      return JSON.parse(raw) || {};
    }
  } catch {}
  return {};
}

function saveReservations(root, reservations) {
  const resPath = getReservationsPath(root);
  fs.mkdirSync(path.dirname(resPath), { recursive: true });
  writeJsonAtomic(resPath, reservations);
}

function cleanExpiredReservations(reservations, now = Date.now()) {
  const cleaned = {};
  let changed = false;
  for (const [reqId, res] of Object.entries(reservations)) {
    if (res && res.expiresAt && res.expiresAt > now) {
      cleaned[reqId] = res;
    } else {
      changed = true;
    }
  }
  return { cleaned, changed };
}

export function getOwnerActiveBotCount(ownerUid, { projectRoot = getProjectRoot(), registry = null, includeReservations = false } = {}) {
  const root = projectRoot || getProjectRoot();
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner || normOwner.toLowerCase() === "admin") return 0;

  const reg = registry || loadMyBotsRegistry(path.join(root, "mybot", "mybots.json"));
  let count = 0;

  for (const [key, bot] of Object.entries(reg)) {
    if (!bot || typeof bot !== "object") continue;
    if (bot.isMain === true || key === "admin" || String(bot.name || "").toLowerCase() === "admin") continue;

    const bOwner = String(bot.ownerUid || bot.createdByUid || (/^\d{10,}$/.test(String(bot.createdBy || "")) ? bot.createdBy : "")).trim();
    if (bOwner === normOwner && bot.status !== "rejected" && bot.status !== "deleting") {
      count++;
    }
  }

  if (includeReservations) {
    const rawRes = loadReservations(root);
    const { cleaned } = cleanExpiredReservations(rawRes);
    for (const res of Object.values(cleaned)) {
      if (res && res.ownerUid === normOwner) {
        count++;
      }
    }
  }

  return count;
}

export function checkOwnerCreationQuota(ownerUid, {
  projectRoot = getProjectRoot(),
  maxBots = Infinity,
  registry = null,
  includeReservations = true,
} = {}) {
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner) {
    return {
      allowed: false,
      reason: "MISSING_OWNER_UID",
      currentCount: 0,
      maxBots: Infinity,
      remaining: 0,
      hasInFlightReservation: false,
    };
  }

  const root = projectRoot || getProjectRoot();
  const rawRes = loadReservations(root);
  const { cleaned } = cleanExpiredReservations(rawRes);
  let hasInFlightReservation = false;

  for (const res of Object.values(cleaned)) {
    if (res && res.ownerUid === normOwner) {
      hasInFlightReservation = true;
      break;
    }
  }

  const currentCount = getOwnerActiveBotCount(normOwner, { projectRoot: root, registry, includeReservations });
  const isAdminOwner = normOwner.toLowerCase() === "admin";
  const effectiveMax = isAdminOwner ? Infinity : maxBots;
  const allowed = currentCount < effectiveMax;
  const remaining = Number.isFinite(effectiveMax) ? Math.max(0, effectiveMax - currentCount) : Infinity;

  return {
    allowed,
    currentCount,
    maxBots: effectiveMax,
    remaining,
    hasInFlightReservation,
    reason: allowed ? "OK" : "QUOTA_EXCEEDED",
  };
}

export function reserveCreationQuota(ownerUid, requestId, {
  projectRoot = getProjectRoot(),
  ttlMs = 300000,
} = {}) {
  const root = projectRoot || getProjectRoot();
  const normOwner = String(ownerUid || "").trim();
  const reqId = String(requestId || `${normOwner}-${Date.now()}`).trim();

  if (!normOwner) {
    return { allowed: false, reason: "MISSING_OWNER_UID" };
  }

  if (normOwner.toLowerCase() === "admin") {
    return { allowed: true, requestId: reqId, maxBots: Infinity, currentCount: 0 };
  }

  const rawRes = loadReservations(root);
  const { cleaned } = cleanExpiredReservations(rawRes);

  let activeReservationCount = 0;
  for (const [id, res] of Object.entries(cleaned)) {
    if (res && res.ownerUid === normOwner && id !== reqId) {
      activeReservationCount++;
    }
  }

  // Prevent concurrent QR sessions for the same owner
  if (activeReservationCount > 0) {
    return {
      allowed: false,
      reason: "CONCURRENT_QR_SESSION_EXISTS",
      currentCount: activeReservationCount,
      maxBots: Infinity,
      remaining: 0,
    };
  }

  cleaned[reqId] = {
    ownerUid: normOwner,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };

  saveReservations(root, cleaned);

  return {
    allowed: true,
    requestId: reqId,
    currentCount: 1,
    maxBots: Infinity,
    remaining: Infinity,
  };
}

export function commitCreationQuota(ownerUid, botUid, { projectRoot = getProjectRoot(), requestId = null } = {}) {
  const root = projectRoot || getProjectRoot();
  const normOwner = String(ownerUid || "").trim();
  const normBot = String(botUid || "").trim();

  if (requestId) {
    try {
      const rawRes = loadReservations(root);
      if (rawRes[requestId]) {
        delete rawRes[requestId];
        saveReservations(root, rawRes);
      }
    } catch {}
  }

  const auditPath = path.join(root, "mybot", "state", "creation-quota-audit.jsonl");
  const record = {
    ts: new Date().toISOString(),
    action: "create_commit",
    ownerUid: normOwner,
    botUid: normBot,
    requestId: requestId || undefined,
  };

  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}

  return record;
}

export function releaseCreationQuota(ownerUid, botUidOrRequestId, { projectRoot = getProjectRoot() } = {}) {
  const root = projectRoot || getProjectRoot();
  const normOwner = String(ownerUid || "").trim();
  const targetId = String(botUidOrRequestId || "").trim();

  try {
    const rawRes = loadReservations(root);
    if (rawRes[targetId]) {
      delete rawRes[targetId];
      saveReservations(root, rawRes);
    }
  } catch {}

  const auditPath = path.join(root, "mybot", "state", "creation-quota-audit.jsonl");
  const record = {
    ts: new Date().toISOString(),
    action: "release_quota",
    ownerUid: normOwner,
    botUid: targetId,
  };

  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}

  return record;
}

export function acquireQrCreationLease(ownerUid, requestId, options = {}) {
  const normOwner = String(ownerUid || "").trim();
  const reqId = String(requestId || `${normOwner}-${Date.now()}`).trim();
  const root = options.projectRoot || getProjectRoot();

  const reservation = reserveCreationQuota(normOwner, reqId, { ...options, projectRoot: root });
  let status = reservation.allowed ? "reserved" : "rejected";

  const lease = {
    allowed: reservation.allowed,
    requestId: reqId,
    ownerUid: normOwner,
    reservation,
    get status() {
      return status;
    },
    commit(botUid) {
      if (status === "committed") {
        return { success: true, alreadyCommitted: true };
      }
      if (status !== "reserved") {
        return { success: false, status, error: `Cannot commit lease in status ${status}` };
      }
      status = "committed";
      const record = commitCreationQuota(normOwner, botUid, { projectRoot: root, requestId: reqId });
      return { success: true, record };
    },
    release() {
      if (status === "released" || status === "committed") {
        return { success: true, status };
      }
      status = "released";
      const record = releaseCreationQuota(normOwner, reqId, { projectRoot: root });
      return { success: true, record };
    },
  };

  return lease;
}

export const acquireCreationQuotaLease = acquireQrCreationLease;
