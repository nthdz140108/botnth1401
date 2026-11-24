import fs from "node:fs";
import path from "node:path";
import { LRUCache } from "lru-cache";
import { getProjectRoot, getBotName } from "../../utils/env.js";
import { getRuntimeInstanceDescriptor } from "../../core/runtime-instance.js";
import { getConsecutiveCalendarDays, getVietnamDateKey } from "./time-util.js";

const storeInstances = new Map();
const DATE_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})\.json$/;

export const COVERAGE_STATUS = Object.freeze({
  COMPLETE: "complete",
  MID_DAY_STARTUP: "mid_day_startup",
  DOWNTIME: "downtime",
  LISTENER_DISCONNECTED: "listener_disconnected",
  SNAPSHOT_DELAYED: "snapshot_delayed",
  SNAPSHOT_FAILED: "snapshot_failed",
  SQLITE_ERROR: "sqlite_error",
  API_ERROR: "api_error",
  INCOMPLETE: "incomplete",
  MISSING_RECORD: "missing_record",
});

export function normalizeCoverageStatusCode(code) {
  if (!code) return COVERAGE_STATUS.INCOMPLETE;
  const val = String(code).trim().toLowerCase();
  for (const known of Object.values(COVERAGE_STATUS)) {
    if (val === known) return known;
  }
  if (val.includes("disconnect")) return COVERAGE_STATUS.LISTENER_DISCONNECTED;
  if (val.includes("sqlite") || val.includes("storage")) return COVERAGE_STATUS.SQLITE_ERROR;
  if (val.includes("getallgroups") || val.includes("api")) return COVERAGE_STATUS.API_ERROR;
  if (val.includes("delayed")) return COVERAGE_STATUS.SNAPSHOT_DELAYED;
  if (val.includes("snapshot")) return COVERAGE_STATUS.SNAPSHOT_FAILED;
  if (val.includes("startup") || val.includes("mid_day")) return COVERAGE_STATUS.MID_DAY_STARTUP;
  if (val.includes("down")) return COVERAGE_STATUS.DOWNTIME;
  if (val.includes("missing")) return COVERAGE_STATUS.MISSING_RECORD;
  if (val.includes("complete")) return COVERAGE_STATUS.COMPLETE;
  return COVERAGE_STATUS.INCOMPLETE;
}

export function resolveLocmemDbPath(botIdentityOrContext = "admin", root = getProjectRoot()) {
  if (botIdentityOrContext && typeof botIdentityOrContext === "object") {
    if (botIdentityOrContext.locmemDbPath) {
      return path.resolve(botIdentityOrContext.locmemDbPath);
    }
    if (botIdentityOrContext.dataDir) {
      return path.resolve(path.join(botIdentityOrContext.dataDir, "locmem-activity"));
    }
    const extractedUid = botIdentityOrContext.uid || botIdentityOrContext.botKey || botIdentityOrContext.configuredUid;
    if (extractedUid) {
      return resolveLocmemDbPath(extractedUid, root);
    }
  }

  const rawStr = String(botIdentityOrContext || "").trim();

  let desc = null;
  try {
    desc = getRuntimeInstanceDescriptor();
  } catch {}

  if (desc) {
    if (desc.isMain) {
      if (!rawStr || rawStr === "admin" || rawStr === desc.liveZaloUid || rawStr === desc.botKey || rawStr === getBotName()) {
        return path.join(root, "mybot", "instances", "admin", "data", "locmem-activity");
      }
    } else if (desc.isChild) {
      if (!rawStr || rawStr === "admin" || rawStr === "main" || rawStr === "default" || rawStr === desc.botKey || rawStr === desc.liveZaloUid || rawStr === getBotName()) {
        return path.join(root, "mybot", "instances", desc.botKey, "data", "locmem-activity");
      }
    }
  }

  const safeUid = rawStr || "admin";
  return path.join(root, "mybot", "instances", safeUid, "data", "locmem-activity");
}

function atomicWriteJsonFileSync(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
  }
}

function createEmptyDayPartition(dateKey) {
  return {
    dateKey: String(dateKey),
    activities: {},
    snapshots: {},
    coverage: {},
    dirty: false,
  };
}

/**
 * Pure-JS Daily-Partitioned Locmem Store (100% Node 20 Windows Server 2012 R2 compatible).
 * Stores ONLY integer counters, member UID snapshots, and coverage codes per YYYY-MM-DD.json.
 * Zero SQLite/C++ addons, zero PII, zero message content, O(1) retention pruning.
 */
export class LocmemStore {
  constructor(options = {}) {
    const { dbPath, botUid = "admin" } = options;
    if (!dbPath) {
      throw new Error("dbPath is required for LocmemStore");
    }
    this.botUid = String(botUid || "admin");
    this.dbPath = path.resolve(dbPath);
    const ext = path.extname(this.dbPath);
    const baseName = path.basename(this.dbPath, ext);
    this.storeDir = path.join(path.dirname(this.dbPath), `${baseName}-days`);
    this.metaPath = path.join(this.storeDir, "meta.json");

    fs.mkdirSync(this.storeDir, { recursive: true });

    // Compatibility handle for callers checking store.db.open
    this.db = { open: true };
    this.pendingActivities = new Map();
    this.dirtyDates = new Set();
    this._flushTimer = null;

    this.dayPartitions = new LRUCache({
      max: 45,
      dispose: (partition, dateKey) => {
        if (partition?.dirty) {
          this.#writePartitionSync(dateKey, partition);
        }
      },
    });

    this.meta = this.#loadMetaSync();
    if (this.meta.schema_version !== "2" || !fs.existsSync(this.metaPath)) {
      this.meta.schema_version = "2";
      this.#saveMetaSync();
    }

    storeInstances.set(this.dbPath, this);
  }

  #assertOpen() {
    if (!this.db || !this.db.open) {
      throw new Error("Database is not open");
    }
  }

  #dayFilePath(dateKey) {
    const safeKey = String(dateKey).replace(/[^0-9-]/g, "");
    return path.join(this.storeDir, `${safeKey}.json`);
  }

  #loadMetaSync() {
    try {
      if (fs.existsSync(this.metaPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf8").replace(/^\uFEFF/, ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {}
    return { schema_version: "2" };
  }

  #saveMetaSync() {
    try {
      atomicWriteJsonFileSync(this.metaPath, this.meta);
    } catch {}
  }

  #getPartition(dateKey, { createIfMissing = false } = {}) {
    const dKey = String(dateKey);
    if (this.dayPartitions.has(dKey)) {
      return this.dayPartitions.get(dKey);
    }
    const filePath = this.#dayFilePath(dKey);
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
        const part = {
          dateKey: dKey,
          activities: parsed?.activities && typeof parsed.activities === "object" ? parsed.activities : {},
          snapshots: parsed?.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {},
          coverage: parsed?.coverage && typeof parsed.coverage === "object" ? parsed.coverage : {},
          dirty: false,
        };
        this.dayPartitions.set(dKey, part);
        return part;
      } catch {}
    }
    if (!createIfMissing) return null;
    const fresh = createEmptyDayPartition(dKey);
    this.dayPartitions.set(dKey, fresh);
    return fresh;
  }

  #markDirty(dateKey, partition) {
    partition.dirty = true;
    this.dirtyDates.add(String(dateKey));
  }

  #writePartitionSync(dateKey, partition) {
    if (!partition) return;
    const dKey = String(dateKey);
    try {
      atomicWriteJsonFileSync(this.#dayFilePath(dKey), {
        dateKey: dKey,
        activities: partition.activities,
        snapshots: partition.snapshots,
        coverage: partition.coverage,
      });
      partition.dirty = false;
      this.dirtyDates.delete(dKey);
    } catch {}
  }

  flushDirtyPartitionsSync() {
    for (const dKey of Array.from(this.dirtyDates)) {
      const part = this.dayPartitions.get(dKey);
      if (part?.dirty) {
        this.#writePartitionSync(dKey, part);
      } else {
        this.dirtyDates.delete(dKey);
      }
    }
  }

  listStoredDateKeys(groupId = null) {
    this.flushPendingActivities();
    if (!fs.existsSync(this.storeDir)) return [];
    const keys = [];
    for (const entry of fs.readdirSync(this.storeDir)) {
      const m = DATE_FILE_REGEX.exec(entry);
      if (!m) continue;
      const dKey = m[1];
      if (!groupId) {
        keys.push(dKey);
      } else {
        const part = this.#getPartition(dKey, { createIfMissing: false });
        const gId = String(groupId);
        if (part && (part.coverage[gId] || part.snapshots[gId] || part.activities[gId])) {
          keys.push(dKey);
        }
      }
    }
    return keys.sort();
  }

  flushPendingActivities() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this.db || !this.db.open) {
      this.pendingActivities.clear();
      return;
    }
    if (this.pendingActivities && this.pendingActivities.size > 0) {
      for (const item of this.pendingActivities.values()) {
        const part = this.#getPartition(item.dateKey, { createIfMissing: true });
        if (!part.activities[item.groupId]) {
          part.activities[item.groupId] = {};
        }
        const cur = part.activities[item.groupId][item.memberId] || [0, 0, 0];
        cur[0] = (Number(cur[0]) || 0) + (Number(item.messageCount) || 0);
        cur[1] = (Number(cur[1]) || 0) + (Number(item.reactionCount) || 0);
        cur[2] = (Number(cur[2]) || 0) + (Number(item.groupActionCount) || 0);
        part.activities[item.groupId][item.memberId] = cur;
        this.#markDirty(item.dateKey, part);
      }
      this.pendingActivities.clear();
    }
    this.flushDirtyPartitionsSync();
  }

  recordActivity({ groupId, memberId, dateKey, messageCount = 0, reactionCount = 0, groupActionCount = 0 }) {
    if (!groupId || !memberId || !dateKey) return;
    this.#assertOpen();
    const gId = String(groupId);
    const mId = String(memberId);
    const dKey = String(dateKey);
    const key = `${gId}\u0000${mId}\u0000${dKey}`;
    const existing = this.pendingActivities.get(key);
    if (existing) {
      existing.messageCount += Number(messageCount) || 0;
      existing.reactionCount += Number(reactionCount) || 0;
      existing.groupActionCount += Number(groupActionCount) || 0;
    } else {
      this.pendingActivities.set(key, {
        groupId: gId,
        memberId: mId,
        dateKey: dKey,
        messageCount: Number(messageCount) || 0,
        reactionCount: Number(reactionCount) || 0,
        groupActionCount: Number(groupActionCount) || 0,
      });
    }

    if (this.pendingActivities.size >= 50) {
      this.flushPendingActivities();
    } else if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        try {
          this.flushPendingActivities();
        } catch {}
      }, 10_000);
      this._flushTimer.unref?.();
    }
  }

  resetMemberOnJoin(groupId, memberId) {
    if (!groupId || !memberId) return;
    this.flushPendingActivities();
    const gId = String(groupId);
    const mId = String(memberId);

    for (const dKey of this.listStoredDateKeys()) {
      const part = this.#getPartition(dKey, { createIfMissing: false });
      if (!part) continue;
      let changed = false;
      if (Array.isArray(part.snapshots[gId])) {
        const beforeLen = part.snapshots[gId].length;
        part.snapshots[gId] = part.snapshots[gId].filter((id) => id !== mId);
        if (part.snapshots[gId].length !== beforeLen) changed = true;
      }
      if (part.activities[gId] && Object.prototype.hasOwnProperty.call(part.activities[gId], mId)) {
        delete part.activities[gId][mId];
        changed = true;
      }
      if (changed) {
        this.#markDirty(dKey, part);
      }
    }
    this.flushDirtyPartitionsSync();
  }

  getMemberActivity(groupId, memberId, dateKey) {
    if (!groupId || !memberId || !dateKey) return null;
    this.flushPendingActivities();
    const part = this.#getPartition(String(dateKey), { createIfMissing: false });
    const tuple = part?.activities?.[String(groupId)]?.[String(memberId)];
    if (!Array.isArray(tuple)) return null;
    return {
      messageCount: Number(tuple[0]) || 0,
      reactionCount: Number(tuple[1]) || 0,
      groupActionCount: Number(tuple[2]) || 0,
    };
  }

  saveMemberSnapshot(groupId, memberIds = [], dateKey) {
    return this.recordSnapshot(groupId, memberIds, dateKey);
  }

  recordSnapshot(groupId, memberIds = [], dateKey) {
    if (!groupId || !dateKey || !Array.isArray(memberIds)) return;
    this.flushPendingActivities();
    const gId = String(groupId);
    const dKey = String(dateKey);
    const part = this.#getPartition(dKey, { createIfMissing: true });

    const snapSet = new Set(Array.isArray(part.snapshots[gId]) ? part.snapshots[gId] : []);
    if (!part.activities[gId]) {
      part.activities[gId] = {};
    }

    for (const rawId of memberIds) {
      if (!rawId) continue;
      const mId = String(rawId);
      snapSet.add(mId);
      if (!Array.isArray(part.activities[gId][mId])) {
        part.activities[gId][mId] = [0, 0, 0];
      }
    }

    part.snapshots[gId] = Array.from(snapSet);
    this.#markDirty(dKey, part);
    this.flushDirtyPartitionsSync();
  }

  #upsertCoverage(groupId, dateKey, { isComplete, snapshotTaken, downtimeDetected, statusCode }) {
    const gId = String(groupId);
    const dKey = String(dateKey);
    const part = this.#getPartition(dKey, { createIfMissing: true });
    const prev = part.coverage[gId];
    part.coverage[gId] = {
      is_complete: isComplete ? 1 : 0,
      snapshot_taken: Math.max(prev?.snapshot_taken || 0, snapshotTaken ? 1 : 0),
      downtime_detected: Math.max(prev?.downtime_detected || 0, downtimeDetected ? 1 : 0),
      status_code: statusCode,
    };
    this.#markDirty(dKey, part);
    this.flushDirtyPartitionsSync();
  }

  markCoverage(groupId, dateKey, { isComplete = true, coverageStatus = "complete", downtimeReason = null, snapshotSuccess = true } = {}) {
    if (downtimeReason) {
      this.recordDailyCoverageSnapshot(groupId, dateKey, snapshotSuccess);
      this.recordDowntime(groupId, dateKey, downtimeReason);
    } else {
      const code = isComplete ? COVERAGE_STATUS.COMPLETE : normalizeCoverageStatusCode(coverageStatus);
      this.#upsertCoverage(groupId, dateKey, {
        isComplete,
        snapshotTaken: snapshotSuccess,
        downtimeDetected: false,
        statusCode: code,
      });
    }
  }

  recordDailyCoverageSnapshot(groupId, dateKey, success = true) {
    if (!groupId || !dateKey) return;
    const gId = String(groupId);
    const dKey = String(dateKey);
    const code = success ? COVERAGE_STATUS.INCOMPLETE : COVERAGE_STATUS.SNAPSHOT_FAILED;
    const part = this.#getPartition(dKey, { createIfMissing: true });
    const prev = part.coverage[gId];
    part.coverage[gId] = {
      is_complete: prev?.is_complete || 0,
      snapshot_taken: success ? 1 : 0,
      downtime_detected: prev?.downtime_detected || 0,
      status_code: code,
    };
    this.#markDirty(dKey, part);
    this.flushDirtyPartitionsSync();
  }

  recordDowntime(groupId, dateKey, reason = "downtime") {
    if (!dateKey) return;
    const dKey = String(dateKey);
    const statusCode = normalizeCoverageStatusCode(reason);
    const part = this.#getPartition(dKey, { createIfMissing: true });

    if (groupId) {
      const gId = String(groupId);
      const prev = part.coverage[gId];
      part.coverage[gId] = {
        is_complete: 0,
        snapshot_taken: prev?.snapshot_taken || 0,
        downtime_detected: 1,
        status_code: statusCode,
      };
    } else {
      for (const gId of Object.keys(part.coverage)) {
        part.coverage[gId].is_complete = 0;
        part.coverage[gId].downtime_detected = 1;
        part.coverage[gId].status_code = statusCode;
      }
    }
    this.#markDirty(dKey, part);
    this.flushDirtyPartitionsSync();
  }

  markDayComplete(groupId, dateKey) {
    if (!groupId || !dateKey) return false;
    const gId = String(groupId);
    const dKey = String(dateKey);
    const cov = this.getDailyCoverage(gId, dKey);
    if (!cov) {
      this.#upsertCoverage(gId, dKey, {
        isComplete: false,
        snapshotTaken: false,
        downtimeDetected: true,
        statusCode: COVERAGE_STATUS.MISSING_RECORD,
      });
      return false;
    }

    if (cov.snapshot_taken === 1 && cov.downtime_detected === 0) {
      this.#upsertCoverage(gId, dKey, {
        isComplete: true,
        snapshotTaken: true,
        downtimeDetected: false,
        statusCode: COVERAGE_STATUS.COMPLETE,
      });
      return true;
    }

    const code = normalizeCoverageStatusCode(cov.status_code || COVERAGE_STATUS.INCOMPLETE);
    this.#upsertCoverage(gId, dKey, {
      isComplete: false,
      snapshotTaken: cov.snapshot_taken === 1,
      downtimeDetected: cov.downtime_detected === 1,
      statusCode: code,
    });
    return false;
  }

  getDailyCoverage(groupId, dateKey) {
    if (!groupId || !dateKey) return null;
    const gId = String(groupId);
    const dKey = String(dateKey);
    const part = this.#getPartition(dKey, { createIfMissing: false });
    const cov = part?.coverage?.[gId];
    if (!cov) return null;
    return {
      group_id: gId,
      date_key: dKey,
      is_complete: Number(cov.is_complete) || 0,
      snapshot_taken: Number(cov.snapshot_taken) || 0,
      downtime_detected: Number(cov.downtime_detected) || 0,
      status_code: cov.status_code || COVERAGE_STATUS.INCOMPLETE,
    };
  }

  getQualified7DayWindow(groupId, todayDateKey = getVietnamDateKey()) {
    if (!groupId) {
      return { qualified: false, days: [], completeDays: [], missingDays: [] };
    }
    const required7Days = getConsecutiveCalendarDays(todayDateKey, 7);
    const gId = String(groupId);
    const completeSet = new Set();

    for (const dKey of required7Days) {
      const cov = this.getDailyCoverage(gId, dKey);
      if (cov && cov.is_complete === 1) {
        completeSet.add(dKey);
      }
    }

    const missingDays = required7Days.filter((d) => !completeSet.has(d));
    const qualified = completeSet.size === 7 && missingDays.length === 0;

    return {
      qualified,
      isQualified: qualified,
      days: required7Days,
      calendarDays: required7Days,
      completeDays: required7Days.filter((d) => completeSet.has(d)),
      missingDays,
      reason: qualified ? null : "missing_or_incomplete_calendar_days",
    };
  }

  getCompleteDays(groupId, beforeDateKey, limit = 7) {
    if (!groupId || !beforeDateKey) return [];
    const window = this.getQualified7DayWindow(groupId, beforeDateKey);
    return window.completeDays.slice(0, Number(limit) || 7);
  }

  getInactiveCandidates({ groupId, completeDays, todayDateKey, excludeMemberIds = [] }) {
    if (!groupId || !Array.isArray(completeDays) || completeDays.length < 7 || !todayDateKey) {
      return [];
    }
    this.flushPendingActivities();

    const gId = String(groupId);
    const uniqueDays = Array.from(new Set(completeDays.map(String)));
    if (uniqueDays.length < 7) return [];

    const excludeSet = new Set(excludeMemberIds.map(String));
    const snapshotCounts = new Map();

    for (const dKey of uniqueDays) {
      const part = this.#getPartition(dKey, { createIfMissing: false });
      const snapList = part?.snapshots?.[gId];
      if (!Array.isArray(snapList) || snapList.length === 0) {
        return [];
      }
      for (const mId of new Set(snapList.map(String))) {
        if (excludeSet.has(mId)) continue;
        snapshotCounts.set(mId, (snapshotCounts.get(mId) || 0) + 1);
      }
    }

    const snapshotCandidateIds = [];
    for (const [mId, count] of snapshotCounts.entries()) {
      if (count === uniqueDays.length) {
        snapshotCandidateIds.push(mId);
      }
    }
    if (snapshotCandidateIds.length === 0) return [];

    const activeSet = new Set();
    for (const dKey of [...uniqueDays, String(todayDateKey)]) {
      const part = this.#getPartition(dKey, { createIfMissing: false });
      const groupAct = part?.activities?.[gId];
      if (!groupAct) continue;
      for (const mId of snapshotCandidateIds) {
        if (activeSet.has(mId)) continue;
        const tuple = groupAct[mId];
        if (Array.isArray(tuple)) {
          const sum = (Number(tuple[0]) || 0) + (Number(tuple[1]) || 0) + (Number(tuple[2]) || 0);
          if (sum > 0) activeSet.add(mId);
        }
      }
    }

    return snapshotCandidateIds.filter((mId) => !activeSet.has(mId));
  }

  cleanupMonthly({ keepDateKeys = [], monthKey = "" }) {
    const keepSet = new Set(keepDateKeys.filter(Boolean).map(String));
    if (keepSet.size === 0) return 0;
    this.flushPendingActivities();

    let removedCount = 0;
    for (const dKey of this.listStoredDateKeys()) {
      if (!keepSet.has(dKey)) {
        this.dayPartitions.delete(dKey);
        this.dirtyDates.delete(dKey);
        try {
          fs.unlinkSync(this.#dayFilePath(dKey));
          removedCount += 1;
        } catch {}
      }
    }

    if (monthKey) {
      this.setMeta("last_monthly_cleanup", String(monthKey));
    }
    return removedCount;
  }

  pruneOlderThanDays(retentionDays = 35, todayDateKey = getVietnamDateKey()) {
    const safeDays = Math.max(7, Number(retentionDays) || 35);
    const keepDays = getConsecutiveCalendarDays(todayDateKey, safeDays);
    return this.cleanupMonthly({ keepDateKeys: [todayDateKey, ...keepDays] });
  }

  getMeta(key) {
    if (!key) return null;
    const val = this.meta[String(key)];
    return val === undefined ? null : String(val);
  }

  setMeta(key, value) {
    if (!key) return;
    this.meta[String(key)] = String(value ?? "");
    this.#saveMetaSync();
  }

  checkpoint() {
    try {
      this.flushPendingActivities();
      this.#saveMetaSync();
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.flushPendingActivities();
      this.#saveMetaSync();
    } catch {}
    if (this.db) {
      this.db.open = false;
    }
    this.dayPartitions.clear();
    this.dirtyDates.clear();
    storeInstances.delete(this.dbPath);
  }
}

export function createLocmemStore(options = {}) {
  const root = options.projectRoot || getProjectRoot();
  const botUid = options.botUid || "admin";
  const dbPath = options.dbPath || resolveLocmemDbPath(botUid, root);
  return new LocmemStore({ dbPath, botUid });
}

export function getLocmemStore(botIdentityOrContext = "admin", options = {}) {
  if (options.storeOverride) return options.storeOverride;
  if (botIdentityOrContext && typeof botIdentityOrContext === "object" && botIdentityOrContext.db && typeof botIdentityOrContext.recordActivity === "function") {
    return botIdentityOrContext;
  }

  const root = options.projectRoot || getProjectRoot();
  const dbPath = options.dbPath || resolveLocmemDbPath(botIdentityOrContext, root);
  const resolvedPath = path.resolve(dbPath);

  if (storeInstances.has(resolvedPath)) {
    const existing = storeInstances.get(resolvedPath);
    if (existing.db?.open) {
      return existing;
    }
    storeInstances.delete(resolvedPath);
  }

  const botUid = typeof botIdentityOrContext === "string"
    ? botIdentityOrContext
    : (botIdentityOrContext?.uid || botIdentityOrContext?.botKey || "admin");
  const store = new LocmemStore({ dbPath: resolvedPath, botUid });
  storeInstances.set(resolvedPath, store);
  return store;
}

export function closeAllLocmemStores() {
  for (const store of storeInstances.values()) {
    try {
      store.close();
    } catch {}
  }
  storeInstances.clear();
}
