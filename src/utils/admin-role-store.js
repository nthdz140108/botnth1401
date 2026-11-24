import fs from "fs";
import path from "path";
import { getProjectRoot } from "./env.js";
import { ROLE_LEVELS, resolveUserRole } from "./role-policy.js";

const HIGH_FILE_SOURCE = "FILE";
const HIGH_COMMAND_SOURCE = "COMMAND";

const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 5000;

async function defaultAcquireLock(filePath) {
  const lockDir = `${filePath}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return {
        release() {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {}
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let isStale = false;
      try {
        const stats = fs.statSync(lockDir);
        isStale = Date.now() - stats.mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (isStale) {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw Object.assign(new Error(`Lock file is already being held: ${lockDir}`), { code: "ELOCKED" });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const defaultDeps = {
  readJson: (filePath) => {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    return parsed;
  },
  writeJsonAtomic: (filePath, data) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  },
  lockFile: (filePath) => defaultAcquireLock(filePath),
  unlockFile: (lock) => Promise.resolve(lock.release()),
};

let roleCacheVersion = 0;

export function invalidateAdminRoleCache() {
  roleCacheVersion += 1;
}

export function getAdminStoragePaths({ projectRoot = getProjectRoot(), botUid = "", overrides = {} } = {}) {
  const root = projectRoot || getProjectRoot();
  const normalizedUid = String(botUid || "").trim();
  const isChild = normalizedUid && normalizedUid.toLowerCase() !== "admin";
  const defaults = {
    highFilePath: path.join(root, "assets", "data", "list_admin_high.json"),
    highCommandPath: path.join(root, "assets", "data", "list_admin_high_command.json"),
    botAdminsPath: normalizedUid
      ? path.join(root, "mybot", "instances", normalizedUid, "data", "admin-list.json")
      : null,
    childHighPath: isChild
      ? path.join(root, "mybot", "instances", normalizedUid, "data", "admin-high.json")
      : null,
  };
  return {
    ...defaults,
    ...(overrides.highFilePath ? { highFilePath: overrides.highFilePath } : {}),
    ...(overrides.highCommandPath ? { highCommandPath: overrides.highCommandPath } : {}),
    ...(overrides.botAdminsPath ? { botAdminsPath: overrides.botAdminsPath } : {}),
    ...(overrides.childHighPath ? { childHighPath: overrides.childHighPath } : {}),
  };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function readList(deps, filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return normalizeList(deps.readJson(filePath));
  } catch {
    return [];
  }
}

export function readListFromFile(filePath) {
  return readList(defaultDeps, filePath);
}

export function readHighAdminSources({ projectRoot = getProjectRoot(), deps = defaultDeps, overrides = {} } = {}) {
  const paths = getAdminStoragePaths({ projectRoot, overrides });
  return [
    { source: HIGH_FILE_SOURCE, filePath: paths.highFilePath, uids: readList(deps, paths.highFilePath) },
    { source: HIGH_COMMAND_SOURCE, filePath: paths.highCommandPath, uids: readList(deps, paths.highCommandPath) },
  ];
}

export function listEffectiveHighAdmins({ projectRoot = getProjectRoot(), deps = defaultDeps, overrides = {} } = {}) {
  const sources = readHighAdminSources({ projectRoot, deps, overrides });
  return [...new Set(sources.flatMap((entry) => entry.uids))];
}

export function resolveCallerRole({
  userId,
  threadId = "",
  botUid = "",
  groupSettings = {},
  projectRoot = getProjectRoot(),
  deps = defaultDeps,
  overrides = {},
} = {}) {
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  const fileHigh = readList(deps, paths.highFilePath);
  const commandHigh = readList(deps, paths.highCommandPath);
  const botAdmins = paths.botAdminsPath ? readList(deps, paths.botAdminsPath) : [];
  return resolveUserRole(userId, {
    threadId,
    botUid,
    mainAdmins: fileHigh,
    highCommandAdmins: commandHigh,
    botAdmins,
    groupSettings,
  });
}

async function appendAudit(auditPath, record) {
  if (!auditPath) return;
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("[admin-role-store] audit log failed:", error.message);
  }
}

function buildAuditRecord({ action, tier, actorId, targetUid, botUid, threadId, source, result, detail = "" }) {
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    action,
    tier,
    actorId: String(actorId || ""),
    targetUid: String(targetUid || ""),
    botUid: String(botUid || ""),
    threadId: String(threadId || ""),
    source: source || "",
    result,
    detail,
    cacheVersionBefore: undefined,
    cacheVersionAfter: roleCacheVersion,
  };
}

export async function mutateListFileTransaction({
  filePath,
  uid,
  mode,
  actorId,
  botUid,
  threadId = "",
  tier,
  source,
  auditPath,
  deps = defaultDeps,
  verify,
}) {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) throw Object.assign(new Error("Target UID is required"), { code: "INVALID_TARGET" });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    deps.writeJsonAtomic(filePath, []);
  }

  let lock = null;
  let snapshot = [];
  try {
    lock = await deps.lockFile(filePath);
    snapshot = readList(deps, filePath);
    const exists = snapshot.includes(normalizedUid);
    if (mode === "add" && exists) {
      await appendAudit(auditPath, buildAuditRecord({ action: mode, tier, actorId, targetUid: normalizedUid, botUid, threadId, source, result: "noop", detail: "already-present" }));
      return { changed: false, list: snapshot };
    }
    if (mode === "remove" && !exists) {
      await appendAudit(auditPath, buildAuditRecord({ action: mode, tier, actorId, targetUid: normalizedUid, botUid, threadId, source, result: "noop", detail: "not-present" }));
      return { changed: false, list: snapshot };
    }

    const next = mode === "add"
      ? [...snapshot, normalizedUid]
      : snapshot.filter((item) => item !== normalizedUid);

    deps.writeJsonAtomic(filePath, next);
    invalidateAdminRoleCache();

    let reread = [];
    try {
      reread = readList(deps, filePath);
    } catch (error) {
      throw Object.assign(new Error(`Re-read failed after ${mode}: ${error.message}`), { code: "VERIFY_FAILED" });
    }
    const verified = mode === "add"
      ? reread.includes(normalizedUid)
      : !reread.includes(normalizedUid);
    const extraOk = typeof verify === "function" ? await verify(reread) : true;
    if (!verified || !extraOk) {
      throw Object.assign(new Error(`Verify failed after ${mode} for ${normalizedUid}`), { code: "VERIFY_FAILED" });
    }

    await appendAudit(auditPath, buildAuditRecord({ action: mode, tier, actorId, targetUid: normalizedUid, botUid, threadId, source, result: "ok" }));
    return { changed: true, list: reread };
  } catch (error) {
    if (fs.existsSync(filePath)) {
      try {
        let current = null;
        try {
          current = readList(defaultDeps, filePath);
        } catch {
          current = null;
        }
        const baseline = Array.isArray(snapshot) ? snapshot : [];
        if (JSON.stringify(current) !== JSON.stringify(baseline)) {
          defaultDeps.writeJsonAtomic(filePath, baseline);
        }
        invalidateAdminRoleCache();
      } catch (rollbackError) {
        console.error("[admin-role-store] rollback failed:", rollbackError.message);
      }
    }
    await appendAudit(auditPath, buildAuditRecord({
      action: mode,
      tier,
      actorId,
      targetUid: normalizedUid,
      botUid,
      threadId,
      source,
      result: "failed",
      detail: error.code || error.message,
    }));
    throw error;
  } finally {
    if (lock) {
      try {
        await deps.unlockFile(lock);
      } catch {}
    }
  }
}

export function buildFullRoleContext({
  threadId = "",
  botUid = "",
  groupSettings = {},
  projectRoot = getProjectRoot(),
  deps = defaultDeps,
  overrides = {},
} = {}) {
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  return {
    threadId,
    botUid,
    mainAdmins: readList(deps, paths.highFilePath),
    highCommandAdmins: readList(deps, paths.highCommandPath),
    botAdmins: paths.botAdminsPath ? readList(deps, paths.botAdminsPath) : [],
    groupSettings,
  };
}

export function assertManageableTarget({ targetUid, callerRole, botUid, roleContext }) {
  const normalizedUid = String(targetUid || "").trim();
  if (normalizedUid && botUid && normalizedUid === String(botUid).trim()) {
    throw Object.assign(new Error("Không thể thao tác trên UID của bot"), { code: "BOT_PROTECTED" });
  }
  const targetRole = resolveUserRole(normalizedUid, roleContext);
  if (ROLE_LEVELS[callerRole] <= ROLE_LEVELS[targetRole]) {
    throw Object.assign(new Error("Không thể thao tác trên mục tiêu cùng cấp hoặc cao hơn"), { code: "TARGET_PROTECTED" });
  }
  return targetRole;
}

export async function addHighAdminViaCommand({
  uid,
  actorId,
  botUid,
  threadId = "",
  projectRoot = getProjectRoot(),
  auditPath,
  deps = defaultDeps,
  overrides = {},
} = {}) {
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  return mutateListFileTransaction({
    filePath: paths.highCommandPath,
    uid,
    mode: "add",
    actorId,
    botUid,
    threadId,
    tier: "high",
    source: HIGH_COMMAND_SOURCE,
    auditPath,
    deps,
  });
}

export async function removeHighAdminViaCommand({
  uid,
  actorId,
  botUid,
  threadId = "",
  projectRoot = getProjectRoot(),
  auditPath,
  deps = defaultDeps,
  overrides = {},
} = {}) {
  const normalizedUid = String(uid || "").trim();
  const sources = readHighAdminSources({ projectRoot, deps, overrides });
  const fileSource = sources.find((entry) => entry.source === HIGH_FILE_SOURCE);
  if (fileSource.uids.includes(normalizedUid)) {
    const error = Object.assign(
      new Error("UID này thuộc danh sách tối cao nguồn FILE, chỉ có thể sửa trực tiếp trong file."),
      { code: "FILE_SOURCE_PROTECTED" },
    );
    await appendAudit(auditPath, buildAuditRecord({
      action: "remove", tier: "high", actorId, targetUid: normalizedUid, botUid, threadId,
      source: HIGH_COMMAND_SOURCE, result: "failed", detail: error.code,
    }));
    throw error;
  }
  const remainingAfter = listEffectiveHighAdmins({ projectRoot, deps, overrides }).filter((item) => item !== normalizedUid);
  if (remainingAfter.length === 0) {
    const error = Object.assign(
      new Error("Phải còn ít nhất một quản trị tối cao hiệu lực sau thao tác."),
      { code: "LAST_ADMIN_PROTECTED" },
    );
    await appendAudit(auditPath, buildAuditRecord({
      action: "remove", tier: "high", actorId, targetUid: normalizedUid, botUid, threadId,
      source: HIGH_COMMAND_SOURCE, result: "failed", detail: error.code,
    }));
    throw error;
  }
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  return mutateListFileTransaction({
    filePath: paths.highCommandPath,
    uid: normalizedUid,
    mode: "remove",
    actorId,
    botUid,
    threadId,
    tier: "high",
    source: HIGH_COMMAND_SOURCE,
    auditPath,
    deps,
  });
}

export async function mutateBotAdmin({ uid, mode, actorId, botUid, threadId = "", projectRoot = getProjectRoot(), auditPath, deps = defaultDeps, overrides = {} }) {
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  if (!paths.botAdminsPath) {
    throw Object.assign(new Error("botUid is required for instance admin management"), { code: "MISSING_BOT_UID" });
  }
  const result = await mutateListFileTransaction({
    filePath: paths.botAdminsPath,
    uid,
    mode,
    actorId,
    botUid,
    threadId,
    tier: "bot",
    source: "INSTANCE",
    auditPath,
    deps,
  });
  if (botUid && String(botUid).trim() !== "admin") {
    try {
      const root = projectRoot || getProjectRoot();
      const legacyPath = path.join(root, "mybot", "configs", `list_admin-${String(botUid).trim()}.json`);
      if (fs.existsSync(legacyPath)) {
        deps.writeJsonAtomic(legacyPath, result.list);
      }
    } catch {}
  }
  return result;
}

export async function mutateChildHighAdmin({
  uid,
  mode,
  actorId,
  botUid,
  threadId = "",
  projectRoot = getProjectRoot(),
  auditPath,
  deps = defaultDeps,
  overrides = {},
} = {}) {
  const paths = getAdminStoragePaths({ projectRoot, botUid, overrides });
  if (!paths.childHighPath) {
    throw Object.assign(new Error("botUid is required for child supreme admin management"), { code: "MISSING_BOT_UID" });
  }
  return mutateListFileTransaction({
    filePath: paths.childHighPath,
    uid,
    mode,
    actorId,
    botUid,
    threadId,
    tier: "high",
    source: "CHILD_HIGH",
    auditPath,
    deps,
  });
}

export async function mutateBoxAdmin({
  uid,
  mode,
  actorId,
  botUid,
  threadId,
  groupSettings,
  auditPath,
  deps = defaultDeps,
  persist = { readGroupSettings: null, writeGroupSettings: null },
}) {
  const normalizedUid = String(uid || "").trim();
  if (!threadId) throw Object.assign(new Error("threadId is required for box admin management"), { code: "MISSING_THREAD" });
  if (!groupSettings?.[threadId]) groupSettings[threadId] = {};
  if (!groupSettings[threadId].adminList || typeof groupSettings[threadId].adminList !== "object") {
    groupSettings[threadId].adminList = {};
  }
  const adminList = groupSettings[threadId].adminList;
  const snapshotEntries = { ...adminList };

  try {
    if (mode === "add") {
      if (Object.prototype.hasOwnProperty.call(adminList, normalizedUid)) {
        await appendAudit(auditPath, buildAuditRecord({ action: mode, tier: "box", actorId, targetUid: normalizedUid, botUid, threadId, source: "GROUP_SETTINGS", result: "noop", detail: "already-present" }));
        return { changed: false };
      }
      adminList[normalizedUid] = String(uid);
    } else {
      if (!Object.prototype.hasOwnProperty.call(adminList, normalizedUid)) {
        await appendAudit(auditPath, buildAuditRecord({ action: mode, tier: "box", actorId, targetUid: normalizedUid, botUid, threadId, source: "GROUP_SETTINGS", result: "noop", detail: "not-present" }));
        return { changed: false };
      }
      delete adminList[normalizedUid];
    }

    if (typeof persist.writeGroupSettings === "function") {
      persist.writeGroupSettings(groupSettings);
    }
    invalidateAdminRoleCache();

    if (typeof persist.readGroupSettings === "function" || typeof persist.writeGroupSettings === "function") {
      let persisted = groupSettings;
      try {
        if (typeof persist.readGroupSettings === "function") {
          persisted = persist.readGroupSettings();
        }
      } catch (error) {
        throw Object.assign(new Error(`Re-read failed after ${mode}: ${error.message}`), { code: "VERIFY_FAILED" });
      }
      const storedList = persisted?.[threadId]?.adminList || {};
      const verified = mode === "add"
        ? Object.prototype.hasOwnProperty.call(storedList, normalizedUid)
        : !Object.prototype.hasOwnProperty.call(storedList, normalizedUid);
      if (!verified) {
        throw Object.assign(new Error(`Verify failed after ${mode} for ${normalizedUid}`), { code: "VERIFY_FAILED" });
      }
    }

    await appendAudit(auditPath, buildAuditRecord({ action: mode, tier: "box", actorId, targetUid: normalizedUid, botUid, threadId, source: "GROUP_SETTINGS", result: "ok" }));
    return { changed: true };
  } catch (error) {
    groupSettings[threadId].adminList = { ...snapshotEntries };
    try {
      if (typeof persist.writeGroupSettings === "function") {
        persist.writeGroupSettings(groupSettings);
      }
      invalidateAdminRoleCache();
    } catch (rollbackError) {
      console.error("[admin-role-store] box rollback failed:", rollbackError.message);
    }
    await appendAudit(auditPath, buildAuditRecord({
      action: mode, tier: "box", actorId, targetUid: normalizedUid, botUid, threadId,
      source: "GROUP_SETTINGS", result: "failed", detail: error.code || error.message,
    }));
    throw error;
  }
}

export function buildBoxRoleContext({ threadId, botUid, groupSettings }) {
  return {
    threadId,
    botUid,
    groupSettings,
  };
}

export const ADMIN_ROLE_STORE_DEFAULT_DEPS = defaultDeps;
