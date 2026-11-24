import fs from "fs";
import path from "path";
import { getProjectRoot, getBotName } from "./env.js";
import { ROLE_LEVELS } from "./role-policy.js";
import {
  getAdminStoragePaths,
  readHighAdminSources,
  readListFromFile,
} from "./admin-role-store.js";

export const AUTH_SOURCES = Object.freeze({
  INSTANCE_SELF: "instanceSelf",
  MAIN_BOT: "mainBot",
  MAIN_BOT_ADMIN_LIST: "mainBotAdminList",
  GLOBAL_HIGH_FILE: "globalHighFile",
  GLOBAL_HIGH_COMMAND: "globalHighCommand",
  INSTANCE_ADMIN_LIST: "instanceAdminList",
  BOX_ADMIN_LIST: "boxAdminList",
  MEMBER: "member",
});

function normalizeUid(value) {
  return String(value ?? "").trim();
}

/**
 * Whether a child instance's identity resolution is pending (fail-closed state).
 * When identity is pending, the child session has NOT verified its owner/main
 * usernames, so UIDs observed from shared Main state must not grant admin.
 *
 * "No evidence" is treated as pending: a child that has never resolved its admin
 * identities (no profile, no audit, no verified admin list) must not inherit
 * foreign UIDs from shared Main state.
 */
function childIdentityIsPending(instanceUid, root) {
  try {
    let hasVerificationEvidence = false;

    const profilePath = path.join(root, "mybot", "instances", instanceUid, "data", "profile.json");
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
      hasVerificationEvidence = true;
      if (profile.identityPending === true) return true;
      if (profile.adminIdentitySeeds) {
        const seeds = profile.adminIdentitySeeds;
        const hasAllSeeds = Boolean(seeds.botAdminUsername && seeds.ownerUsername && seeds.selfUsername);
        if (!hasAllSeeds) return true;
      }
    }

    const auditPath = path.join(root, "mybot", "instances", instanceUid, "data", "admin-identity-audit.json");
    if (fs.existsSync(auditPath)) {
      const audit = JSON.parse(fs.readFileSync(auditPath, "utf8").replace(/^\uFEFF/, ""));
      hasVerificationEvidence = true;
      if (audit.identityPending === true) return true;
      if (audit.status === "identityPending") return true;
    }

    // No verification evidence at all -> treat as pending (fail-closed).
    if (!hasVerificationEvidence) return true;
  } catch {}
  return false;
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export function resolveMainBotUid({ projectRoot = getProjectRoot() } = {}) {
  const root = projectRoot || getProjectRoot();
  const candidates = [];

  const adminState = readJsonIfExists(path.join(root, "mybot", "state", "admin.json"));
  if (adminState && typeof adminState === "object") {
    candidates.push(adminState.uid);
  }

  const registry = readJsonIfExists(path.join(root, "mybot", "mybots.json"));
  if (registry && typeof registry === "object" && registry.admin && typeof registry.admin === "object") {
    candidates.push(registry.admin.uid);
  }

  for (const candidate of candidates) {
    const uid = normalizeUid(candidate);
    if (uid && uid.toLowerCase() !== "admin") return uid;
  }
  return "";
}

// Resolution order for child instances:
//   1. Real main-bot UID or this bot's own UID -> adminLevelHigh
//   2. UID in child's own admin-list.json -> adminBot
//   3. UID in box adminList of current thread -> adminBox
//   4. Remaining -> member
export function readMainInstanceAdminUids({ projectRoot = getProjectRoot(), mainBotUid } = {}) {
  const root = projectRoot || getProjectRoot();
  const uids = new Set();

  const candidates = ["admin"];
  const resolvedMainUid = normalizeUid(mainBotUid) || resolveMainBotUid({ projectRoot: root });
  if (resolvedMainUid) candidates.push(resolvedMainUid);

  for (const key of candidates) {
    const list = readJsonIfExists(path.join(root, "mybot", "instances", key, "data", "admin-list.json"));
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const uid = normalizeUid(item);
      if (uid && uid.toLowerCase() !== "admin") uids.add(uid);
    }
  }

  return [...uids];
}

function readRegisteredAdminBotId(projectRoot) {
  const root = projectRoot || getProjectRoot();
  const registry = readJsonIfExists(path.join(root, "mybot", "role-registry.json"));
  return normalizeUid(registry?.adminBotId || registry?.primaryBotId || "");
}

function writeJsonAtomic(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } catch {}
  }
}

export function persistVerifiedInstanceIdentity({
  instanceKind = "main",
  liveUid = "",
  botName = "",
  configPath = "",
  projectRoot = getProjectRoot(),
} = {}) {
  const root = projectRoot || getProjectRoot();
  const normalizedKind = String(instanceKind || "").toLowerCase() === "child" ? "child" : "main";
  const normalizedLiveUid = normalizeUid(liveUid);

  if (normalizedKind === "main") {
    if (!normalizedLiveUid || normalizedLiveUid.toLowerCase() === "admin") {
      return { success: false, reason: "invalid_live_uid" };
    }

    const statePath = path.join(root, "mybot", "state", "admin.json");
    const currentState = readJsonIfExists(statePath) || {};
    const oldUid = currentState.uid || "admin";
    const updatedState = {
      ...currentState,
      uid: normalizedLiveUid,
      lastRepairedAt: new Date().toISOString(),
    };
    writeJsonAtomic(statePath, updatedState);

    const registryPath = path.join(root, "mybot", "mybots.json");
    const reg = readJsonIfExists(registryPath);
    if (reg && typeof reg === "object") {
      const existingAdmin = reg.admin || {};
      reg.admin = {
        ...existingAdmin,
        uid: normalizedLiveUid,
        isMain: true,
        lastUpdated: new Date().toISOString(),
      };
      writeJsonAtomic(registryPath, reg);
    }

    console.log(`identity source=live-login processKind=main processUid=${normalizedLiveUid} persistedUid=${oldUid} action=repaired`);
    return { success: true, repaired: true, liveUid: normalizedLiveUid, oldUid };
  }

  // Child process: only touch child state, NEVER modify admin.json or mybots.json.admin
  if (normalizedLiveUid && normalizedLiveUid.toLowerCase() !== "admin") {
    const childStatePath = path.join(root, "mybot", "state", `${normalizedLiveUid}.json`);
    const currentState = readJsonIfExists(childStatePath) || {};
    const updatedState = {
      ...currentState,
      uid: normalizedLiveUid,
      lastUpdated: new Date().toISOString(),
    };
    writeJsonAtomic(childStatePath, updatedState);
  }

  return { success: true, repaired: false, liveUid: normalizedLiveUid };
}

export function resolveCurrentInstanceIdentity({
  api = null,
  appContext = null,
  botName = null,
  configPath = null,
  instanceKind = null,
  projectRoot = getProjectRoot(),
} = {}) {
  const root = projectRoot || getProjectRoot();

  // 1. Process identity inputs:
  //    - MYBOT_INSTANCE_KIND from arg or env
  //    - Exact config path comparison
  //    - BOT_NAME from arg or env
  //    - Registry lookup (mybots.json)
  //    - Live UID from api session / appContext

  const rawKindArg = normalizeUid(instanceKind || process.env.MYBOT_INSTANCE_KIND).toLowerCase();
  const isExplicitMainKind = rawKindArg === "main";
  const isExplicitChildKind = rawKindArg === "child";

  const rawBotNameArg = normalizeUid(botName);
  const rawEnvBotName = normalizeUid(process.env.BOT_NAME || process.env.BOT_ID);
  const explicitBotName = rawBotNameArg || rawEnvBotName;

  const effectiveConfigPath = configPath || process.env.CONFIG_PATH || process.env.CONFIGFILE_PATH || "";
  const normalizedCfg = effectiveConfigPath.replace(/\\/g, "/").toLowerCase();
  const baseCfg = path.basename(effectiveConfigPath).toLowerCase();

  const isMainConfig = Boolean(
    effectiveConfigPath &&
    (
      (baseCfg === "admin.json" && !normalizedCfg.includes("/instances/")) ||
      (baseCfg === "config.json" && !normalizedCfg.includes("/instances/")) ||
      normalizedCfg.endsWith("assets/config.json") ||
      normalizedCfg.endsWith("/config.json") ||
      normalizedCfg === "config.json" ||
      normalizedCfg.endsWith("mybot/bots/admin.json")
    )
  );

  const isChildConfig = Boolean(
    effectiveConfigPath &&
    (
      normalizedCfg.includes("/instances/") ||
      (normalizedCfg.includes("/mybot/bots/") && baseCfg !== "admin.json")
    )
  );

  // 2. Resolve Live UID
  let liveUid = "";
  try {
    if (typeof api?.getOwnId === "function") {
      liveUid = normalizeUid(api.getOwnId());
    } else if (api?.currentUserId || api?.botUid) {
      liveUid = normalizeUid(api.currentUserId || api.botUid);
    }
  } catch {}
  if (!liveUid && appContext?.uid) {
    liveUid = normalizeUid(appContext.uid);
  }
  if (!liveUid && process.env.BOT_UID) {
    liveUid = normalizeUid(process.env.BOT_UID);
  }
  if (liveUid.toLowerCase() === "admin") {
    liveUid = "";
  }

  const persistedMainUid = resolveMainBotUid({ projectRoot: root });
  const registry = readJsonIfExists(path.join(root, "mybot", "mybots.json"));

  const isMainName = Boolean(
    explicitBotName &&
    (
      explicitBotName.toLowerCase() === "admin" ||
      (persistedMainUid && explicitBotName === persistedMainUid) ||
      (registry?.admin?.uid && explicitBotName === registry.admin.uid) ||
      (registry?.[explicitBotName]?.isMain === true)
    )
  );

  const isChildName = Boolean(
    explicitBotName &&
    !isMainName &&
    (
      registry?.[explicitBotName]?.isMain === false ||
      isChildConfig
    )
  );

  // 3. Candidate determination
  let candidateKind = "child";
  let identitySource = "default-child";

  if (isExplicitMainKind) {
    candidateKind = "main";
    identitySource = "launcher-main-env";
  } else if (isExplicitChildKind) {
    candidateKind = "child";
    identitySource = "launcher-child-env";
  } else if (isMainConfig) {
    candidateKind = "main";
    identitySource = "launcher-main-config";
  } else if (isChildConfig) {
    candidateKind = "child";
    identitySource = "launcher-child-config";
  } else if (isMainName) {
    candidateKind = "main";
    identitySource = explicitBotName.toLowerCase() === "admin" ? "launcher-main-name" : "launcher-main-name-uid";
  } else if (isChildName) {
    candidateKind = "child";
    identitySource = "launcher-child-name";
  } else if (liveUid) {
    if (registry?.[liveUid]?.isMain === false) {
      candidateKind = "child";
      identitySource = "registry-child-uid";
    } else if (persistedMainUid && liveUid === persistedMainUid) {
      candidateKind = "main";
      identitySource = "persisted-main-uid";
    } else if (registry?.[liveUid]?.isMain === true || registry?.admin?.uid === liveUid) {
      candidateKind = "main";
      identitySource = "registry-main-uid";
    } else {
      const runtimeName = normalizeUid(getBotName());
      if (runtimeName && runtimeName.toLowerCase() === "admin") {
        candidateKind = "main";
        identitySource = "live-login";
      } else {
        candidateKind = "child";
        identitySource = "unverified-live-uid";
      }
    }
  } else {
    const runtimeName = normalizeUid(getBotName());
    if (runtimeName && runtimeName.toLowerCase() === "admin") {
      candidateKind = "main";
      identitySource = "runtime-metadata";
    } else {
      candidateKind = "child";
      identitySource = "runtime-metadata-child";
    }
  }

  // 4. Fail-closed Conflict Verification Matrix
  if (candidateKind === "main" && isChildConfig) {
    return {
      instanceKind: "main",
      processBotUid: liveUid || (explicitBotName && explicitBotName.toLowerCase() !== "admin" ? explicitBotName : persistedMainUid) || "",
      mainBotUid: persistedMainUid || "",
      identitySource: "conflict-main-with-child-config",
      persistedMismatch: true,
      verified: false,
    };
  }

  if (candidateKind === "child" && isMainConfig) {
    return {
      instanceKind: "child",
      processBotUid: liveUid || explicitBotName || "",
      mainBotUid: persistedMainUid || "",
      identitySource: "conflict-child-with-main-config",
      persistedMismatch: true,
      verified: false,
    };
  }

  if (candidateKind === "child") {
    if (liveUid && persistedMainUid && persistedMainUid.toLowerCase() !== "admin" && liveUid === persistedMainUid) {
      return {
        instanceKind: "child",
        processBotUid: liveUid,
        mainBotUid: persistedMainUid,
        identitySource: "child-live-uid-conflict",
        persistedMismatch: true,
        verified: false,
      };
    }
    return {
      instanceKind: "child",
      processBotUid: liveUid || (explicitBotName && explicitBotName.toLowerCase() !== "admin" ? explicitBotName : ""),
      mainBotUid: persistedMainUid || "",
      identitySource: identitySource || "child-process",
      persistedMismatch: false,
      verified: identitySource !== "unverified-live-uid",
    };
  }

  // Main process validation
  if (liveUid) {
    const mismatch = Boolean(
      !persistedMainUid ||
      persistedMainUid.toLowerCase() === "admin" ||
      persistedMainUid !== liveUid
    );
    return {
      instanceKind: "main",
      processBotUid: liveUid,
      mainBotUid: persistedMainUid || "",
      identitySource: mismatch ? "live-login" : "persisted-match",
      persistedMismatch: mismatch,
      verified: true,
    };
  }

  return {
    instanceKind: "main",
    processBotUid: persistedMainUid || (explicitBotName && explicitBotName.toLowerCase() !== "admin" ? explicitBotName : "admin"),
    mainBotUid: persistedMainUid || "",
    identitySource: identitySource || "persisted-main",
    persistedMismatch: false,
    verified: Boolean(persistedMainUid && persistedMainUid.toLowerCase() !== "admin"),
  };
}

export function inferInstanceKind(instanceUid, { projectRoot = getProjectRoot(), mainBotUid } = {}) {
  const uid = normalizeUid(instanceUid);
  if (!uid) return "main";
  if (uid.toLowerCase() === "admin") return "main";

  const registeredAdminId = readRegisteredAdminBotId(projectRoot);
  if (registeredAdminId && uid.toLowerCase() === registeredAdminId.toLowerCase()) return "main";

  const resolvedMainUid = normalizeUid(mainBotUid) || resolveMainBotUid({ projectRoot });
  if (resolvedMainUid) return uid === resolvedMainUid ? "main" : "child";

  return "main";
}

function includesUid(list, uid) {
  return Array.isArray(list) && list.includes(uid);
}

function boxAdminIds(threadId, groupSettings) {
  const settings = groupSettings?.[normalizeUid(threadId)]?.adminList;
  if (!settings || typeof settings !== "object") return [];
  return Object.keys(settings).map(normalizeUid).filter(Boolean);
}

function buildSnapshot({
  senderId,
  threadId,
  instanceKind,
  instanceUid,
  mainBotUid,
  role,
  source,
  mainOperator = false,
}) {
  const level = ROLE_LEVELS[role] ?? 0;
  const sender = normalizeUid(senderId);
  const resolvedMainUid = normalizeUid(mainBotUid);
  return {
    senderId: sender,
    threadId: normalizeUid(threadId),
    instanceKind: instanceKind === "main" ? "main" : "child",
    instanceUid: normalizeUid(instanceUid),
    mainBotUid: resolvedMainUid,
    role,
    source,
    isAdminLevelHigh: role === "adminLevelHigh",
    isBotAdmin: level >= ROLE_LEVELS.adminBot,
    isGroupAdmin: level >= ROLE_LEVELS.adminBox,
    isMainBotAdmin:
      mainOperator ||
      Boolean(resolvedMainUid && sender && sender === resolvedMainUid) ||
      (instanceKind === "main" && role === "adminLevelHigh"),
  };
}

export function resolveInstanceAuthorization({
  senderId,
  threadId = "",
  instanceUid = "",
  instanceKind = "",
  mainBotUid,
  groupSettings = {},
  projectRoot = getProjectRoot(),
  overrides = {},
} = {}) {
  const root = projectRoot || getProjectRoot();
  const sender = normalizeUid(senderId);
  const selfUid = normalizeUid(instanceUid);
  const kind = String(instanceKind || "").trim()
    || inferInstanceKind(selfUid, { projectRoot: root });
  const resolvedMainUid = mainBotUid === undefined || mainBotUid === null
    ? resolveMainBotUid({ projectRoot: root })
    : normalizeUid(mainBotUid);

  if (!sender) {
    return buildSnapshot({
      senderId: "",
      threadId,
      instanceKind: kind,
      instanceUid: selfUid,
      mainBotUid: resolvedMainUid,
      role: "member",
      source: AUTH_SOURCES.MEMBER,
    });
  }

  const paths = getAdminStoragePaths({ projectRoot: root, botUid: selfUid, overrides });
  const boxUids = boxAdminIds(threadId, groupSettings);

  // Precedence on a child instance:
  // 1. This child bot's own UID -> adminLevelHigh
  // 2. Registered Main-bot UID -> adminLevelHigh ONLY when the child identity
  //    is not pending (i.e., the child session resolved its own identity). This
  //    preserves the legitimate Main operator flow for a verified child while
  //    staying fail-closed: when identity is pending (unresolved usernames),
  //    a UID observed from shared Main state must NOT grant admin.
  // 3. Child's own verified admin-list.json / admin-high (resolved via child
  //    session by canonical username) -> adminLevelHigh / adminBot by tier
  // 4. Dynamic resolved Supreme Admins (owner, bot admin) from child session
  // 5. Current thread's box adminList -> adminBox
  // 6. Member
  if (kind === "child") {
    // Registered Main-bot UID: only granted Supreme Admin when the child's
    // identity resolution is NOT pending (verified in child session).
    // Checked before INSTANCE_SELF so MAIN_BOT takes precedence when identities overlap.
    if (resolvedMainUid && sender === resolvedMainUid) {
      const childIdentityPending = childIdentityIsPending(selfUid, root);
      if (!childIdentityPending) {
        return buildSnapshot({
          senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
          mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.MAIN_BOT,
          mainOperator: true,
        });
      }
    }

    if (selfUid && sender === selfUid) {
      return buildSnapshot({
        senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
        mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.INSTANCE_SELF,
      });
    }

    // Dynamic resolved Supreme Admins (Owner, Bot Admin) for this child instance.
    // Only UIDs written into the child's own admin-identity-audit.json after
    // verification in the child session are accepted.
    if (selfUid) {
      const auditPath = path.join(root, "mybot", "instances", selfUid, "data", "admin-identity-audit.json");
      const audit = readJsonIfExists(auditPath);
      if (audit && audit.resolvedUids) {
        const oUid = normalizeUid(audit.resolvedUids.ownerUid);
        const bUid = normalizeUid(audit.resolvedUids.botAdminUid);
        if ((oUid && sender === oUid) || (bUid && sender === bUid)) {
          return buildSnapshot({
            senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
            mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.GLOBAL_HIGH_COMMAND,
          });
        }
      }

      const profilePath = path.join(root, "mybot", "instances", selfUid, "data", "profile.json");
      const profile = readJsonIfExists(profilePath);
      // Profile ownerUid is only trusted when it was verified in the child
      // session (identityPending === false) — otherwise it is a stale/foreign
      // UID from the Main session and must NOT grant admin (fail-closed).
      if (profile && profile.identityPending !== true && profile.ownerUid && sender === normalizeUid(profile.ownerUid)) {
        return buildSnapshot({
          senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
          mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.GLOBAL_HIGH_COMMAND,
        });
      }
    }

    if (paths.childHighPath && includesUid(readListFromFile(paths.childHighPath), sender)) {
      return buildSnapshot({
        senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
        mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.GLOBAL_HIGH_COMMAND,
      });
    }

    if (paths.botAdminsPath && includesUid(readListFromFile(paths.botAdminsPath), sender)) {
      return buildSnapshot({
        senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
        mainBotUid: resolvedMainUid, role: "adminBot", source: AUTH_SOURCES.INSTANCE_ADMIN_LIST,
      });
    }

    if (boxUids.includes(sender)) {
      return buildSnapshot({
        senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
        mainBotUid: resolvedMainUid, role: "adminBox", source: AUTH_SOURCES.BOX_ADMIN_LIST,
      });
    }

    return buildSnapshot({
      senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
      mainBotUid: resolvedMainUid, role: "member", source: AUTH_SOURCES.MEMBER,
    });
  }

  // Precedence on the main instance:
  // 1. Self UID -> adminLevelHigh
  // 2. Global high sources (FILE / COMMAND) -> adminLevelHigh
  // 3. Main instance admin-list.json -> adminBot
  // 4. Box adminList -> adminBox
  // 5. Member
  if (selfUid && sender === selfUid) {
    return buildSnapshot({
      senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
      mainBotUid: resolvedMainUid, role: "adminLevelHigh", source: AUTH_SOURCES.INSTANCE_SELF,
    });
  }

  const sources = readHighAdminSources({ projectRoot: root, overrides });
  for (const entry of sources) {
    if (includesUid(entry.uids, sender)) {
      return buildSnapshot({
        senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
        mainBotUid: resolvedMainUid, role: "adminLevelHigh",
        source: entry.source === "FILE" ? AUTH_SOURCES.GLOBAL_HIGH_FILE : AUTH_SOURCES.GLOBAL_HIGH_COMMAND,
      });
    }
  }

  if (paths.botAdminsPath && includesUid(readListFromFile(paths.botAdminsPath), sender)) {
    return buildSnapshot({
      senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
      mainBotUid: resolvedMainUid, role: "adminBot", source: AUTH_SOURCES.INSTANCE_ADMIN_LIST,
    });
  }

  if (boxUids.includes(sender)) {
    return buildSnapshot({
      senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
      mainBotUid: resolvedMainUid, role: "adminBox", source: AUTH_SOURCES.BOX_ADMIN_LIST,
    });
  }

  return buildSnapshot({
    senderId: sender, threadId, instanceKind: kind, instanceUid: selfUid,
    mainBotUid: resolvedMainUid, role: "member", source: AUTH_SOURCES.MEMBER,
  });
}

export function listInstanceSupremeAdmins({
  instanceUid = "",
  instanceKind = "",
  mainBotUid,
  projectRoot = getProjectRoot(),
  overrides = {},
} = {}) {
  const root = projectRoot || getProjectRoot();
  const selfUid = normalizeUid(instanceUid);
  const kind = String(instanceKind || "").trim()
    || inferInstanceKind(selfUid, { projectRoot: root });
  const resolvedMainUid = mainBotUid === undefined || mainBotUid === null
    ? resolveMainBotUid({ projectRoot: root })
    : normalizeUid(mainBotUid);

  if (kind === "child") {
    const entries = [];
    const seen = new Set();
    const paths = getAdminStoragePaths({ projectRoot: root, botUid: selfUid, overrides });

    // The registered Main-bot UID is listed as a Supreme Admin only when the
    // child's identity resolution is NOT pending (verified in child session).
    // When identity is pending, UIDs observed from shared Main state must not be
    // presented as admins (fail-closed).
    if (resolvedMainUid && !childIdentityIsPending(selfUid, root) && !seen.has(resolvedMainUid)) {
      seen.add(resolvedMainUid);
      entries.push({ uid: resolvedMainUid, source: "MAIN-BOT" });
    }

    if (selfUid) {
      const auditPath = path.join(root, "mybot", "instances", selfUid, "data", "admin-identity-audit.json");
      const audit = readJsonIfExists(auditPath);
      if (audit && audit.resolvedUids) {
        const oUid = normalizeUid(audit.resolvedUids.ownerUid);
        const bUid = normalizeUid(audit.resolvedUids.botAdminUid);
        if (oUid && !seen.has(oUid)) {
          seen.add(oUid);
          entries.push({ uid: oUid, source: "CREATOR" });
        }
        if (bUid && !seen.has(bUid)) {
          seen.add(bUid);
          entries.push({ uid: bUid, source: "CREATOR" });
        }
      }

      const profilePath = path.join(root, "mybot", "instances", selfUid, "data", "profile.json");
      const profile = readJsonIfExists(profilePath);
      // Profile ownerUid is only presented when identity is NOT pending
      // (verified in the child session) — otherwise fail-closed.
      if (profile && profile.identityPending !== true && profile.ownerUid) {
        const pOwnerUid = normalizeUid(profile.ownerUid);
        if (pOwnerUid && !seen.has(pOwnerUid)) {
          seen.add(pOwnerUid);
          entries.push({ uid: pOwnerUid, source: "CREATOR" });
        }
      }
    }
    if (selfUid && !seen.has(selfUid)) {
      seen.add(selfUid);
      entries.push({ uid: selfUid, source: "SELF" });
    }
    if (paths.childHighPath) {
      const childHighList = readListFromFile(paths.childHighPath);
      for (const uid of childHighList) {
        if (uid && !seen.has(uid)) {
          seen.add(uid);
          entries.push({ uid: uid, source: "COMMAND" });
        }
      }
    }
    return entries;
  }

  const sources = readHighAdminSources({ projectRoot: root, overrides });
  const merged = new Set(sources.flatMap((entry) => entry.uids));
  const labels = new Map(
    sources.flatMap((entry) => entry.uids.map((uid) => [uid, entry.source])),
  );
  return [...merged].filter(Boolean).map((uid) => ({ uid, source: labels.get(uid) || "SELF" }));
}
