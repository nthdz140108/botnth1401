import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-state.js";
import { loadTrialLedger, getBangkokCalendarWeek } from "./mybot-trial-ledger.js";

/**
 * Shared Bot-Expiry Classifier.
 *
 * Bot QR trial lifecycle is prone to two production bugs:
 *   1. A fresh QR bot is stored with `expiryAt: null`. The periodic timer
 *      called `new Date(null)` → the Unix epoch (1970), compared it to now,
 *      and wrongly flipped the record to `expired` and stopped PM2.
 *   2. A pending trial whose start failed/never ran was auto-"expired".
 *
 * This module centralizes classification so the periodic sweep, activation,
 * display and dashboard all agree. A record is ONLY ever `expired` when it has
 * a real, parseable expiry date in the past. `expiryAt: null` with
 * `trialStatus: "pending"` is `pending`, never `expired`.
 *
 * Classifier states: `pending | active | permanent | expired | malformed`.
 */

/** Trial duration for a fresh QR bot (1 hour). */
export const DEFAULT_TRIAL_DURATION_MS = 3600000;

function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  const str = String(value).trim();
  if (str === "-1" || str.toLowerCase() === "permanent") return "permanent";
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/**
 * Classify a bot record's expiry lifecycle.
 *
 * @param {object} bot - bot record with `expiryAt`, `trialStatus`
 * @param {number} [now=Date.now()] - current epoch ms
 * @returns {"pending"|"active"|"permanent"|"expired"|"malformed"}
 */
export function classifyBotExpiry(bot = {}, now = Date.now()) {
  const expiryAt = bot?.expiryAt;
  const trialStatus = String(bot?.trialStatus || "").trim().toLowerCase() || "pending";
  // Allow `now` to be supplied either as the second argument or nested on the
  // bot record (both callers and consumers may pass it either way).
  const nowMs = Number(bot?.now) || Number(now) || Date.now();

  // `-1` means permanent/vĩnh viễn regardless of trialStatus.
  if (expiryAt === "-1" || expiryAt === -1 || String(expiryAt).trim() === "-1") {
    return "permanent";
  }

  // No expiry at all.
  if (expiryAt === null || expiryAt === undefined || expiryAt === "") {
    return trialStatus === "active" ? "malformed" : "pending";
  }

  const asDate = parseDate(expiryAt);
  if (asDate === "permanent") return "permanent";
  if (!asDate) {
    // A non-parseable string is malformed — never treat as expired.
    return "malformed";
  }

  const expiryMs = asDate.getTime();
  if (expiryMs <= nowMs) return "expired";

  return "active";
}

/**
 * Resolve the periodic-sweep action for one bot record.
 *
 * Returns:
 *  - `{ action: "skip", shouldStopPM2: false }`            for pending / permanent / malformed
 *  - `{ action: "expire", shouldStopPM2: true }`           for a genuinely expired record
 *  - `{ action: "active", shouldStopPM2: false }`          for a live, in-window record
 *
 * `shouldStopPM2` tells the sweep whether to stop/kill the process. Only a
 * genuine `expired` state ever stops the process.
 *
 * @param {object} params
 * @param {object} params.botInfo - the bot record
 * @param {number} [params.now=Date.now()]
 * @returns {{action:string, shouldStopPM2:boolean, state:string}}
 */
export function resolvePeriodicAction({ botInfo = {}, now = Date.now() } = {}) {
  const state = classifyBotExpiry(botInfo, now);
  if (state === "pending") {
    // A pending trial has NOT started yet — no deadline, never expire/stop.
    return { action: "skip", shouldStopPM2: false, state };
  }
  if (state === "permanent") {
    return { action: "active", shouldStopPM2: false, state };
  }
  if (state === "malformed") {
    // Data is inconsistent; never auto-expire or stop. Report for diagnosis.
    return { action: "skip", shouldStopPM2: false, state, reason: "malformed-expiry" };
  }
  if (state === "expired") {
    return { action: "expire", shouldStopPM2: true, state };
  }
  // active
  return { action: "active", shouldStopPM2: false, state };
}

/**
 * Decide whether a corrupted `expired` record should be repaired back to
 * `stopped`. A record is eligible ONLY when all of:
 *   - `status === "expired"` (or "trialExpired"),
 *   - `trialStatus === "pending"`,
 *   - no `expiryAt`,
 *   - no `trialStartedAt`,
 *   - the owner's trial ledger has NOT already recorded the trial as used.
 *
 * Anything with a real expiry, a started trial, or a used ledger entry is left
 * alone (its expiry was real).
 *
 * @param {object} bot - bot record
 * @param {{ledgerUsed:boolean}} [context]
 * @returns {boolean}
 */
export function shouldRecoverCorruptedExpiredRecord(bot = {}, context = {}) {
  const status = String(bot?.status || "").trim().toLowerCase();
  const trialStatus = String(bot?.trialStatus || "").trim().toLowerCase();
  const hasExpiry = bot?.expiryAt !== null && bot?.expiryAt !== undefined && bot?.expiryAt !== "";
  const hasTrialStarted = Boolean(
    bot?.trialStartedAt !== null && bot?.trialStartedAt !== undefined && bot?.trialStartedAt !== ""
  );

  if (status !== "expired" && status !== "trialExpired") return false;
  if (trialStatus !== "pending") return false;
  if (hasExpiry) return false;
  if (hasTrialStarted) return false;
  if (context?.ledgerUsed === true) return false;

  return true;
}

/**
 * Determine whether the owner has already consumed this week's trial.
 *
 * @param {string} ownerUid
 * @param {{root:string, legacyLedgerPath?:string, now?:number}} opts
 * @returns {boolean}
 */
export function hasOwnerUsedTrialThisWeek(ownerUid, { root = process.cwd(), legacyLedgerPath = null, now = Date.now() } = {}) {
  if (!ownerUid) return false;
  const data = loadTrialLedger({ root, ledgerPath: legacyLedgerPath || undefined });
  const uid = String(ownerUid).trim();
  const records = data?.ledger?.[uid] || {};
  const currentWeek = getBangkokCalendarWeek(now);
  return Boolean(records[currentWeek]);
}

/**
 * Scan all registry records and return the periodic-sweep actions.
 * For each record whose action is "skip"/"expire"/"active", the callbacks are
 * invoked when relevant. This keeps the side-effectful PM2 stop/kill/status
 * writes out of the classifier so it stays unit-testable.
 *
 * @param {object} params
 * @param {string} params.root - project root
 * @param {number} [params.now=Date.now()]
 * @param {Function} [params.onStop] async (uid) => {}
 * @param {Function} [params.onKill] async (uid) => {}
 * @param {Function} [params.onStatus] async (uid, status) => {}
 * @param {Function} [params.readRegistry] async () => object  (test override)
 * @returns {Promise<Array<{uid:string,action:string,state:string}>>}
 */
export async function scanPendingTrialRecords({
  root = process.cwd(),
  now = Date.now(),
  onStop = async () => {},
  onKill = async () => {},
  onStatus = async () => {},
  readRegistry = null,
} = {}) {
  const registryPath = path.join(root, "mybot", "mybots.json");
  let registry = {};
  if (readRegistry) {
    registry = await readRegistry();
  } else if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {}
  }

  const results = [];
  for (const [uid, botInfo] of Object.entries(registry)) {
    if (!botInfo || typeof botInfo !== "object") continue;
    if (uid === "admin") continue;

    const decision = resolvePeriodicAction({ botInfo, now });
    if (decision.action === "expire") {
      await onStop(uid);
      await onKill(uid);
      await onStatus(uid, "expired");
    } else if (decision.action === "active") {
      // Registry-level sync only; leave process management to whoever reads
      // the live status. We do NOT flip pending -> running here.
    }
    results.push({ uid, action: decision.action, state: decision.state });
  }

  return results;
}

/**
 * Repair records wrongly written as `expired` but that are actually still a
 * pending trial (corrupted by the `new Date(null)` bug). Only repairs when
 * `shouldRecoverCorruptedExpiredRecord` is true for the record AND its owner
 * has not consumed this week's trial.
 *
 * @param {object} params
 * @param {string} params.root - project root
 * @param {number} [params.now=Date.now()]
 * @param {string} [params.registryPath] - override registry path (test)
 * @param {Function} [params.readRegistry] async () => object (test override)
 * @returns {Promise<Array<{uid:string,recovered:boolean,state:string}>>}
 */
export async function recoverPendingTrialRecords({
  root = process.cwd(),
  now = Date.now(),
  registryPath = null,
  readRegistry = null,
} = {}) {
  const resolvedRegistry = registryPath || path.join(root, "mybot", "mybots.json");
  let registry = {};
  if (readRegistry) {
    registry = await readRegistry();
  } else if (fs.existsSync(resolvedRegistry)) {
    try {
      registry = JSON.parse(fs.readFileSync(resolvedRegistry, "utf8").replace(/^\uFEFF/, ""));
    } catch {}
  }

  const recovered = [];
  let changed = false;

  for (const [uid, botInfo] of Object.entries(registry)) {
    if (!botInfo || typeof botInfo !== "object") continue;
    if (uid === "admin") continue;

    const ownerUid = botInfo.ownerUid || botInfo.createdByUid || uid;
    const ledgerUsed = hasOwnerUsedTrialThisWeek(ownerUid, { root, now });
    if (!shouldRecoverCorruptedExpiredRecord(botInfo, { ledgerUsed })) continue;

    botInfo.status = "stopped";
    botInfo.trialStatus = "pending";
    botInfo.trialStartedAt = null;
    botInfo.expiryAt = null;
    botInfo.lastUpdated = new Date(Number(now) || Date.now()).toISOString();
    changed = true;
    recovered.push({ uid, recovered: true, state: "pending" });
  }

  if (changed) {
    writeJsonAtomic(resolvedRegistry, registry);
  }

  return recovered;
}
