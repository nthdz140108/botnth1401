import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "./json-state.js";
import { getProjectRoot } from '../../../utils/env.js';
import { withRegistryLockSync, registryTransactions } from './registry-lock.js';

const projectRoot = getProjectRoot();
const defaultMyBotsPath = path.join(projectRoot, "mybot", "mybots.json");

const snapshots = new WeakMap();
function readRegistry(filePath = defaultMyBotsPath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(data.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Registry must be an object');
    snapshots.set(parsed, structuredClone(parsed));
    return parsed;
  } catch (error) {
    throw Object.assign(new Error('Cannot read registry; restore a valid backup before retrying', { cause: error }), { code: 'REGISTRY_CORRUPT', stage: 'registry-read' });
  }
}

function writeRegistry(myBots, filePath = defaultMyBotsPath) {
  return withRegistryLockSync(filePath, () => {
    const base = snapshots.get(myBots);
    const current = readRegistry(filePath);
    const next = base ? mergeDelta(base, myBots, current) : myBots;
    const transaction = registryTransactions.getStore();
    if (transaction && path.resolve(transaction._registryPath) === path.resolve(filePath)) {
      for (const key of Object.keys(transaction._registry)) delete transaction._registry[key];
      Object.assign(transaction._registry, next);
      transaction._flush();
    } else writeJsonAtomic(filePath, next);
    snapshots.set(myBots, structuredClone(myBots));
  });
}

function mergeDelta(base, edited, current) {
  const next = structuredClone(current);
  for (const key of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(edited[key])) continue;
    if (!(key in edited)) { delete next[key]; continue; }
    if (base[key] && edited[key] && typeof base[key] === 'object' && typeof edited[key] === 'object' && !Array.isArray(edited[key])) {
      next[key] = mergeDelta(base[key], edited[key], current[key] || {});
    } else next[key] = structuredClone(edited[key]);
  }
  return next;
}

function cloneRecord(record = {}) {
  return JSON.parse(JSON.stringify(record || {}));
}

function isTruthy(value) {
  return value !== undefined && value !== null && value !== "";
}

function scoreRecord(uid, record = {}, adminPid, adminWebPort) {
  const status = String(record.status || "").toLowerCase();
  let score = 0;
  if (uid === "admin") score += 1000;
  if (String(record.name || "").toLowerCase() === "admin") score += 300;
  const dbName = String(record.database || "").toLowerCase();
  if (dbName === "nthdz" || dbName === "admin") score += 300;
  if (status === "running") score += 100;
  if (status === "starting") score += 50;
  if (String(record.pid || "") === String(adminPid || "")) score += 200;
  if (String(record.webPort || "") === String(adminWebPort || "")) score += 150;
  if (isTruthy(record.createdAt)) {
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isNaN(createdAt)) score += Math.min(createdAt / 1000, 10);
  }
  return score;
}

function removeAliasArtifacts(aliasUid) {
  if (!aliasUid || aliasUid === "admin") return;
  const candidates = [
    path.join(projectRoot, "mybot", "bots", `${aliasUid}.json`),
    path.join(projectRoot, "mybot", "configs", `list_admin-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "settings", `groupSettings-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `command-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `manager-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `game_data-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `prophylactic-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `web_config-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `database_config-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `data_training-${aliasUid}.json`),
    path.join(projectRoot, "mybot", "json-data", `rank_info-${aliasUid}.json`),
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.warn(`Không thể xóa file alias ${filePath}: ${error.message}`);
    }
  }
}

export function loadMyBotsRegistry(filePath) {
  return readRegistry(filePath);
}

export function saveMyBotsRegistry(myBots, filePath) {
  writeRegistry(myBots, filePath);
}

export function dedupeMyBotsRegistry(options = {}) {
  return withRegistryLockSync(options.filePath || defaultMyBotsPath, () => dedupeMyBotsRegistryLocked(options));
}
function dedupeMyBotsRegistryLocked({ adminUid, adminPid, adminWebPort, removeAliasFiles = false, filePath } = {}) {
  const myBots = readRegistry(filePath);
  const entries = Object.entries(myBots);
  if (entries.length === 0) return { myBots, changed: false, removed: [] };

  const grouped = new Map();
  for (const [uid, record] of entries) {
    const key = [
      uid === "admin" ? "admin" : "",
      String(record.pid || "") && String(record.pid) === String(adminPid || "") ? "pid" : "",
      String(record.webPort || "") && String(record.webPort) === String(adminWebPort || "") ? "port" : "",
      (String(record.database || "") === "nthdz" || String(record.database || "") === "admin") ? "db-admin" : "",
      String(record.name || "").toLowerCase() === "admin" ? "name-admin" : "",
      adminUid && uid === adminUid ? "actual-admin-uid" : "",
    ].filter(Boolean).join("|") || uid;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push([uid, record]);
  }

  const next = {};
  const removed = [];
  let changed = false;

  for (const [groupKey, groupEntries] of grouped.entries()) {
    if (groupEntries.length === 1) {
      const [uid, record] = groupEntries[0];
      next[uid] = cloneRecord(record);
      continue;
    }

    const sorted = [...groupEntries].sort((a, b) => {
      const scoreA = scoreRecord(a[0], a[1], adminPid, adminWebPort);
      const scoreB = scoreRecord(b[0], b[1], adminPid, adminWebPort);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return String(b[1].createdAt || "").localeCompare(String(a[1].createdAt || ""));
    });
    const [winnerUid, winnerRecord] = sorted[0];
    next[winnerUid] = cloneRecord(winnerRecord);
    for (const [uid] of sorted.slice(1)) {
      removed.push(uid);
      changed = true;
      if (removeAliasFiles) removeAliasArtifacts(uid);
    }
    if (groupEntries.some(([uid]) => uid !== winnerUid)) {
      changed = true;
    }
    if (groupKey.includes("actual-admin-uid") && winnerUid !== "admin" && myBots["admin"]) {
      next["admin"] = cloneRecord(next[winnerUid]);
      next["admin"].name = "admin";
      next["admin"].database = "nthdz";
      next["admin"].displayName = next["admin"].displayName || "Admin Bot";
      removed.push(winnerUid);
      delete next[winnerUid];
      next["admin"].pid = String(adminPid || next["admin"].pid || "");
      next["admin"].webPort = String(adminWebPort || next["admin"].webPort || "");
      changed = true;
      if (removeAliasFiles) removeAliasArtifacts(winnerUid);
    }
  }

  if (myBots["admin"] || next["admin"]) {
    const adminRecord = next["admin"] || myBots["admin"] || {};
    next["admin"] = {
      ...cloneRecord(myBots["admin"] || {}),
      ...adminRecord,
      name: "admin",
      database: "nthdz",
      isMain: true,
      uid: (adminUid && adminUid !== "admin") ? String(adminUid).trim() : adminRecord.uid || "admin",
      pid: String(adminPid || next["admin"]?.pid || myBots["admin"]?.pid || ""),
      webPort: String(adminWebPort || next["admin"]?.webPort || myBots["admin"]?.webPort || ""),
    };
  }

  if (adminUid && adminUid !== "admin" && next[adminUid]) {
    removed.push(adminUid);
    delete next[adminUid];
    changed = true;
    if (removeAliasFiles) removeAliasArtifacts(adminUid);
  }

  for (const [key, record] of Object.entries(next)) {
    if (!record || typeof record !== "object") continue;
    if (key === "admin" || record.name === "admin" || record.isMain === true) {
      record.isMain = true;
      if (!record.database || String(record.database).trim() === "" || String(record.database).trim().toLowerCase() === "admin") {
        record.database = "nthdz";
        changed = true;
      }
      if (!record.webPort || String(record.webPort).trim() === "") {
        record.webPort = String(adminWebPort || record.webPort || "2000");
        changed = true;
      }
      if (adminUid && adminUid !== "admin" && (record.uid === "admin" || !record.uid)) {
        record.uid = String(adminUid).trim();
      }
    } else {
      if (!record.uid) {
        record.uid = key;
      }
      if (record.isMain === undefined) {
        record.isMain = false;
      }
      if (!record.database || String(record.database).trim() === "") {
        record.database = key;
        changed = true;
      }
      if (!record.webPort || String(record.webPort).trim() === "") {
        record.webPort = "4444";
        changed = true;
      }
    }
  }

  if (changed) {
    writeRegistry(next, filePath);
  }

  return { myBots: next, changed, removed };
}
