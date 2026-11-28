import { loadMyBotsRegistry, saveMyBotsRegistry } from './mybots-registry.js';
import { withRegistryLockSync } from './registry-lock.js';
import fs from "fs";
import path from "path";
import { writeJsonAtomic } from "./json-state.js";
import { resolveUserRole } from "../../../utils/role-policy.js";
import { buildFullRoleContext } from "../../../utils/admin-role-store.js";
import { resolveCurrentInstanceIdentity, persistVerifiedInstanceIdentity } from "../../../utils/instance-authorization.js";
import { getProfile } from "./mybot-profile-service.js";

import { normalizeUsername, extractUsernameFromUserInfo, extractUsername } from "./child-admin-resolver.js";

export { resolveCurrentInstanceIdentity, persistVerifiedInstanceIdentity };
export { normalizeUsername, extractUsernameFromUserInfo, extractUsername };

function readJsonIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    }
  } catch {}
  return null;
}

export async function hydrateCurrentBotIdentity({
  api,
  botId,
  projectRoot = process.cwd(),
  store = null,
  mode = null,
} = {}) {
  let effectiveMode = mode;
  if (!effectiveMode) {
    try {
      const { getIdentityMode } = await import("../../../identity/index.js");
      effectiveMode = getIdentityMode();
    } catch {
      effectiveMode = process.env.MULTI_BOT_IDENTITY_MODE || "off";
    }
  }

  if (effectiveMode === "off") {
    return { mode: "off", ready: false, hydrated: false };
  }

  let idStore = store;
  if (!idStore) {
    try {
      const { getIdentityPool, createIdentityStore, isIdentityDbAvailable } = await import("../../../identity/index.js");
      const pool = getIdentityPool();
      if (await isIdentityDbAvailable(pool)) {
        idStore = createIdentityStore({ pool });
      }
    } catch (dbErr) {
      if (effectiveMode === "enforce") {
        console.error(`[mybot-identity] MySQL Identity DB connection failed in enforce mode: ${dbErr.message}`);
        throw dbErr;
      } else {
        console.warn(`[mybot-identity] MySQL Identity DB unavailable in shadow mode: ${dbErr.message}`);
        return { mode: "shadow", ready: false, dbAvailable: false, error: dbErr.message };
      }
    }
  }

  if (!idStore) {
    if (effectiveMode === "enforce") {
      const err = new Error("IDENTITY_DB_UNAVAILABLE: Cơ sở dữ liệu định danh MySQL trung tâm không khả dụng");
      err.code = "IDENTITY_DB_UNAVAILABLE";
      console.error(`[mybot-identity] ${err.message}`);
      throw err;
    }
    return { mode: "shadow", ready: false, dbAvailable: false };
  }

  // Resolve real Zalo UID — never use literal "admin"
  let effectiveBotId = "";
  const apiOwnId = typeof api?.getOwnId === "function" ? api.getOwnId() : (api?.currentUserId || api?.botUid);
  if (apiOwnId && String(apiOwnId).trim() && String(apiOwnId).trim().toLowerCase() !== "admin") {
    effectiveBotId = String(apiOwnId).trim();
  }
  if (!effectiveBotId && typeof api?.getBotId === "function") {
    const apiBotId = api.getBotId();
    if (apiBotId && String(apiBotId).trim() && String(apiBotId).trim().toLowerCase() !== "admin") {
      effectiveBotId = String(apiBotId).trim();
    }
  }
  if (!effectiveBotId && botId && String(botId).trim().toLowerCase() !== "admin") {
    effectiveBotId = String(botId).trim();
  }
  if (!effectiveBotId) {
    console.warn("[mybot-identity] Cannot determine real Zalo UID for hydration, skipping");
    return { mode: effectiveMode, ready: false, hydrated: false, error: "no_real_uid" };
  }

  try {
    const { hydrateBotIdentity } = await import("../../../identity/index.js");
    const hydrated = await hydrateBotIdentity({
      store: idStore,
      api,
      botId: effectiveBotId,
      localUid: effectiveBotId,
    });

    // Persist hydration results. CRITICAL ISOLATION RULE: a child bot must only
    // ever write its own instance state / profile — it must NEVER touch
    // mybot/state/admin.json or mybots.json.admin (those belong to the Main bot).
    // Writing the child UID into admin.json made the next boot believe the child
    // is the Main Bot and exit with BOOT:IDENTITY:FATAL on restart.
    const root = path.resolve(projectRoot || process.cwd());
    const { getRuntimeInstanceDescriptor } = await import("../../../core/runtime-instance.js");
    const desc = getRuntimeInstanceDescriptor();
    const isChildContext = desc?.isChild === true || process.env.MYBOT_INSTANCE_KIND === "child";

    if (isChildContext) {
      // Child: only hydrate the child's own instance data dir + profile.
      const instanceDataDir = path.join(root, "mybot", "instances", effectiveBotId, "data");
      if (!fs.existsSync(instanceDataDir)) fs.mkdirSync(instanceDataDir, { recursive: true });
      const childHydrationPath = path.join(instanceDataDir, "hydration.json");
      const current = readJsonIfExists(childHydrationPath) || {};
      writeJsonAtomic(childHydrationPath, {
        ...current,
        botId: effectiveBotId,
        uid: effectiveBotId,
        globalUid: hydrated.globalUid || current.globalUid || null,
        canonicalUsername: hydrated.canonicalUsername || current.canonicalUsername || null,
        zaloUsername: hydrated.displayUsername || current.zaloUsername || null,
        lastHydratedAt: new Date().toISOString(),
      });

      // Update child profile only (never profile of another bot).
      try {
        const { getProfile, updateProfile } = await import("./mybot-profile-service.js");
        const profile = getProfile(effectiveBotId, { root }) || {};
        updateProfile(effectiveBotId, {
          ...profile,
          globalUid: hydrated.globalUid || profile.globalUid || null,
          canonicalUsername: hydrated.canonicalUsername || profile.canonicalUsername || null,
          zaloUsername: hydrated.displayUsername || profile.zaloUsername || null,
          lastHydratedAt: new Date().toISOString(),
        }, { root });
      } catch (profileErr) {
        console.warn(`[mybot-identity] Could not persist hydration to child profile: ${profileErr.message}`);
      }
    } else {
      const stateDir = path.join(root, "mybot", "state");
      if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
      const adminStatePath = path.join(stateDir, "admin.json");
      const adminState = readJsonIfExists(adminStatePath) || {};
      const updated = {
        ...adminState,
        uid: effectiveBotId,
        globalUid: hydrated.globalUid || adminState.globalUid || null,
        canonicalUsername: hydrated.canonicalUsername || adminState.canonicalUsername || null,
        zaloUsername: hydrated.displayUsername || adminState.zaloUsername || null,
        lastHydratedAt: new Date().toISOString(),
      };
      writeJsonAtomic(adminStatePath, updated);

      // Also update mybots.json record for the Main bot
      try {
        const registryPath = path.join(root, "mybot", "mybots.json");
        if (fs.existsSync(registryPath)) {
          const registry = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
          const botKey = registry[effectiveBotId] ? effectiveBotId : (registry["admin"] ? "admin" : null);
          if (botKey && registry[botKey]) {
            registry[botKey].globalUid = hydrated.globalUid || registry[botKey].globalUid || null;
            registry[botKey].zaloUsername = hydrated.displayUsername || registry[botKey].zaloUsername || null;
            registry[botKey].canonicalUsername = hydrated.canonicalUsername || registry[botKey].canonicalUsername || null;
            registry[botKey].lastHydratedAt = new Date().toISOString();
            writeJsonAtomic(registryPath, registry);
          }
        }
      } catch (regErr) {
        console.warn(`[mybot-identity] Could not persist hydration to mybots.json: ${regErr.message}`);
      }
    }

    return {
      mode: effectiveMode,
      ready: true,
      hydrated: true,
      botId: effectiveBotId,
      localUid: hydrated.localUid,
      globalUid: hydrated.globalUid,
      canonicalUsername: hydrated.canonicalUsername,
      displayUsername: hydrated.displayUsername,
      displayName: hydrated.displayName,
      avatar: hydrated.avatar,
      instanceKind: isChildContext ? "child" : "main",
    };
  } catch (hydErr) {
    if (effectiveMode === "enforce") {
      console.error(`[mybot-identity] Bot identity hydration failed in enforce mode: ${hydErr.message}`);
      throw hydErr;
    }
    console.warn(`[mybot-identity] Bot identity hydration warning in shadow mode: ${hydErr.message}`);
    return { mode: "shadow", ready: false, hydrated: false, error: hydErr.message };
  }
}

export function resolveAdminIdentity({ projectRoot = process.cwd(), api, config, stateDir } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const resolvedStateDir = stateDir ? path.resolve(stateDir) : path.join(root, "mybot", "state");
  const adminStatePath = path.join(resolvedStateDir, "admin.json");

  let adminUid = null;
  let canonicalUsername = null;
  let displayUsername = null;
  let globalUid = null;

  // 1. API session / own ID
  try {
    const apiOwnId = typeof api?.getOwnId === "function" ? api.getOwnId() : api?.currentUserId || api?.botUid;
    if (apiOwnId && String(apiOwnId).trim() && String(apiOwnId).trim().toLowerCase() !== "admin") {
      adminUid = String(apiOwnId).trim();
    }
  } catch {}

  // 2. process.env.BOT_UID
  if (!adminUid && process.env.BOT_UID && process.env.BOT_UID.trim() && process.env.BOT_UID.trim().toLowerCase() !== "admin") {
    adminUid = process.env.BOT_UID.trim();
  }

  // 3. state admin.json
  try {
    if (fs.existsSync(adminStatePath)) {
      const raw = fs.readFileSync(adminStatePath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      if (!adminUid && parsed?.uid && String(parsed.uid).trim() && String(parsed.uid).trim().toLowerCase() !== "admin") {
        adminUid = String(parsed.uid).trim();
      }
      if (parsed?.canonicalUsername || parsed?.zaloUsername || parsed?.username) {
        displayUsername = parsed.zaloUsername || parsed.username || parsed.displayUsername || null;
        canonicalUsername = parsed.canonicalUsername || (displayUsername ? String(displayUsername).trim().replace(/^@+/, "").normalize("NFKC").toLowerCase() : null);
      }
      if (parsed?.globalUid) {
        globalUid = parsed.globalUid;
      }
    }
  } catch {}

  // 4. Candidate creds / config (read verified username only, never display name)
  if (!canonicalUsername) {
    const candidateCredPaths = [
      adminUid && adminUid !== "admin" ? path.join(root, "mybot", "credentials", `${adminUid}.json`) : null,
      path.join(root, "mybot", "credentials", "admin.json"),
      path.join(root, "assets", "config.json"),
      path.join(root, "config.json"),
    ].filter(Boolean);

    for (const cPath of candidateCredPaths) {
      try {
        if (fs.existsSync(cPath)) {
          const parsed = JSON.parse(fs.readFileSync(cPath, "utf8").replace(/^\uFEFF/, ""));
          const uName = extractUsernameFromUserInfo(parsed?.userInfo || parsed);
          if (uName && !canonicalUsername) {
            displayUsername = String(uName).trim().replace(/^@+/, "");
            canonicalUsername = normalizeUsername(displayUsername);
          }
          if (parsed?.globalUid && !globalUid) {
            globalUid = parsed.globalUid;
          }
        }
      } catch {}
    }
  }

  // Fallback
  if (!adminUid) {
    adminUid = "admin";
  }

  return {
    adminUid,
    isMain: true,
    canonicalUsername,
    displayUsername,
    botAdminUsername: canonicalUsername || (displayUsername ? displayUsername.normalize("NFKC").toLowerCase() : null),
    globalUid,
    identityReady: Boolean(adminUid && adminUid !== "admin" && (canonicalUsername || globalUid)),
  };
}

export function syncMainBotRegistry(options = {}) {
  const root = path.resolve(options.projectRoot || process.cwd());
  return withRegistryLockSync(path.join(root, 'mybot', 'mybots.json'), () => syncMainBotRegistryLocked(options));
}
function syncMainBotRegistryLocked({ projectRoot = process.cwd(), adminUid, webPort, pid, forceSave = true, identityInfo = null } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const myBotDir = path.join(root, "mybot");
  const registryPath = path.join(myBotDir, "mybots.json");

  if (!fs.existsSync(myBotDir)) {
    fs.mkdirSync(myBotDir, { recursive: true });
  }

  const myBots = loadMyBotsRegistry(registryPath);

  const resolvedUid = adminUid && adminUid.toLowerCase() !== "admin" ? String(adminUid).trim() : null;

  // Prune any duplicate record whose key is the real admin UID
  if (resolvedUid && myBots[resolvedUid]) {
    delete myBots[resolvedUid];
  }

  const existingAdmin = myBots["admin"] || {};
  const currentPid = pid !== undefined ? String(pid) : existingAdmin.pid !== undefined ? String(existingAdmin.pid) : String(process.pid || "");
  const currentPort = webPort !== undefined ? String(webPort) : existingAdmin.webPort || "2000";

  let credAvatar = existingAdmin.avatar || null;
  let credDisplayName = existingAdmin.displayName || "Admin Bot";
  let credUsername = existingAdmin.zaloUsername || identityInfo?.zaloUsername || identityInfo?.canonicalUsername || null;
  let credGlobalUid = existingAdmin.globalUid || identityInfo?.globalUid || null;

  const candidateCredPaths = [
    resolvedUid ? path.join(myBotDir, "credentials", `${resolvedUid}.json`) : null,
    path.join(myBotDir, "credentials", "admin.json"),
    path.join(root, "config.json"),
  ].filter(Boolean);

  for (const cPath of candidateCredPaths) {
    try {
      if (fs.existsSync(cPath)) {
        const parsed = JSON.parse(fs.readFileSync(cPath, "utf8").replace(/^\uFEFF/, ""));
        const foundAvatar = parsed?.userInfo?.avatar || parsed?.avatar || parsed?.photo || null;
        const foundName = parsed?.userInfo?.name || parsed?.userInfo?.zaloName || parsed?.displayName || parsed?.name || null;
        const foundUsername = parsed?.userInfo?.username || parsed?.username || parsed?.zaloUsername || null;
        const foundGlobalUid = parsed?.globalUid || null;

        if (foundAvatar && !credAvatar) credAvatar = foundAvatar;
        if (foundName && (!credDisplayName || credDisplayName === "Admin Bot")) credDisplayName = foundName;
        if (foundUsername && !credUsername) credUsername = foundUsername;
        if (foundGlobalUid && !credGlobalUid) credGlobalUid = foundGlobalUid;
      }
    } catch {}
  }

  myBots["admin"] = {
    name: "admin",
    createdBy: "admin",
    createdAt: existingAdmin.createdAt || new Date().toISOString(),
    expiryAt: existingAdmin.expiryAt || "-1",
    webPort: currentPort,
    status: existingAdmin.status || "running",
    database: "nthdz",
    ...existingAdmin,
    database: "nthdz",
    displayName: credDisplayName,
    avatar: credAvatar,
    zaloUsername: credUsername || existingAdmin.zaloUsername || null,
    canonicalUsername: credUsername ? credUsername.normalize("NFKC").toLowerCase() : (existingAdmin.canonicalUsername || null),
    globalUid: credGlobalUid || existingAdmin.globalUid || null,
    uid: resolvedUid || existingAdmin.uid || "admin",
    isMain: true,
    pid: currentPid,
    lastUpdated: new Date().toISOString(),
  };

  // Migrate all other records
  for (const [key, record] of Object.entries(myBots)) {
    if (!record || typeof record !== "object") continue;
    if (key === "admin" || record.name === "admin" || record.isMain === true) {
      record.isMain = true;
      if (resolvedUid && (record.uid === "admin" || !record.uid)) {
        record.uid = resolvedUid;
      }
    } else {
      if (!record.uid) {
        record.uid = key;
      }
      if (record.isMain === undefined) {
        record.isMain = false;
      }
    }
  }

  if (forceSave) {
    saveMyBotsRegistry(myBots, registryPath);
  }

  return { myBots, changed: true };
}

export function resolveMyBotCallerRole({
  uidFrom,
  adminBotUid,
  isAdminLevelHighest = false,
  api = null,
  roleContext = null,
  projectRoot = process.cwd(),
} = {}) {
  const callerUid = String(uidFrom || "").trim();
  const realAdminUid = String(adminBotUid || "").trim();

  let isSystemAdmin = false;

  // 1. Check if caller matches real Main Bot UID
  if (callerUid && realAdminUid && callerUid === realAdminUid && realAdminUid.toLowerCase() !== "admin") {
    isSystemAdmin = true;
  }

  // 2. Check if caller is marked as isAdminLevelHighest
  if (!isSystemAdmin && isAdminLevelHighest === true) {
    isSystemAdmin = true;
  }

  // 3. Check 4-tier role resolution (adminLevelHigh)
  if (!isSystemAdmin && callerUid) {
    try {
      const fullContext = roleContext || buildFullRoleContext({ projectRoot });
      const callerRole = resolveUserRole(callerUid, fullContext);
      if (callerRole === "adminLevelHigh") {
        isSystemAdmin = true;
      }
    } catch {}
  }

  return {
    callerUid,
    isSystemAdmin: Boolean(isSystemAdmin),
    canManageAll: Boolean(isSystemAdmin),
    canManageBot(targetBotRecord) {
      if (isSystemAdmin) return true;
      if (!targetBotRecord || typeof targetBotRecord !== "object") return false;
      return isBotOwnedByCaller(targetBotRecord, callerUid);
    },
  };
}

export function isMainBot(botRecord, botKey = "") {
  if (!botRecord && !botKey) return false;
  if (botRecord?.isMain === true) return true;
  if (String(botKey).trim().toLowerCase() === "admin") return true;
  if (String(botRecord?.name || "").trim().toLowerCase() === "admin") return true;
  const dbName = String(botRecord?.database || "").trim().toLowerCase();
  if (dbName === "nthdz" || dbName === "admin") return true;
  return false;
}

export function assertCanDeleteBot(botRecord, botKey = "") {
  if (isMainBot(botRecord, botKey)) {
    const err = new Error("Không thể xóa hoặc vô hiệu hóa Main Bot!");
    err.code = "MAIN_BOT_PROTECTED";
    throw err;
  }
}

export function resolveBotPaths(targetOrUid, projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  const myBotDir = path.join(root, "mybot");

  let canonicalKey = "";
  let canonicalUid = "";
  let isMain = false;

  if (targetOrUid && typeof targetOrUid === "object") {
    canonicalKey = String(targetOrUid.key || targetOrUid.name || targetOrUid.uid || "").trim();
    canonicalUid = String(targetOrUid.uid || targetOrUid.botId || targetOrUid.key || targetOrUid.name || "").trim();
    isMain = Boolean(targetOrUid.isMain || canonicalKey.toLowerCase() === "admin" || canonicalUid.toLowerCase() === "admin");
  } else {
    canonicalKey = String(targetOrUid || "").trim();
    canonicalUid = String(targetOrUid || "").trim();
    isMain = canonicalKey.toLowerCase() === "admin" || canonicalUid.toLowerCase() === "admin";
    if (!isMain && (canonicalKey || canonicalUid)) {
      try {
        const adminStatePath = path.join(myBotDir, "state", "admin.json");
        if (fs.existsSync(adminStatePath)) {
          const parsed = JSON.parse(fs.readFileSync(adminStatePath, "utf8").replace(/^\uFEFF/, ""));
          if (parsed?.uid && (parsed.uid === canonicalKey || parsed.uid === canonicalUid)) {
            isMain = true;
          }
        }
      } catch {}
      if (!isMain) {
        try {
          const regPath = path.join(myBotDir, "mybots.json");
          if (fs.existsSync(regPath)) {
            const reg = JSON.parse(fs.readFileSync(regPath, "utf8").replace(/^\uFEFF/, ""));
            const adminRec = reg["admin"];
            if (adminRec?.uid && (adminRec.uid === canonicalKey || adminRec.uid === canonicalUid)) {
              isMain = true;
            }
          }
        } catch {}
      }
    }
  }

  if (!canonicalKey) canonicalKey = "admin";
  if (!canonicalUid) canonicalUid = canonicalKey;

  const storageKey = isMain ? 'admin' : canonicalKey;
  const instanceDir = path.join(myBotDir, 'instances', storageKey);
  const dataDir = path.join(instanceDir, "data");
  const logsDir = path.join(root, 'logs', storageKey);

  // Canonical paths for child bot (write target)
  const canonicalCredPath = isMain
    ? path.join(root, "assets", "config.json")
    : path.join(myBotDir, "credentials", `${storageKey}.json`);
  const legacyCredPath = isMain
    ? path.join(myBotDir, "credentials", "admin.json")
    : path.join(myBotDir, "credentials", `${canonicalKey}.json`);

  const canonicalConfigPath = path.join(myBotDir, "bots", `${storageKey}.json`);
  const legacyConfigPath = path.join(myBotDir, "bots", `${canonicalKey}.json`);

  const canonicalStatePath = path.join(myBotDir, "state", `${storageKey}.json`);
  const legacyStatePath = path.join(myBotDir, "state", `${canonicalKey}.json`);

  const adminListPath = path.join(dataDir, "admin-list.json");
  const legacyAdminListPath = path.join(myBotDir, "configs", `list_admin-${storageKey}.json`);

  const groupSettingsPath = path.join(dataDir, "group-settings.json");
  const legacyGroupSettingsPath = path.join(myBotDir, "settings", `groupSettings-${storageKey}.json`);

  const commandConfigPath = path.join(dataDir, "command.json");
  const legacyCommandConfigPath = path.join(myBotDir, "json-data", `command-${storageKey}.json`);

  // Helper to pick existing file path when reading
  function getReadPath(canonical, fallback) {
    if (fs.existsSync(canonical)) return canonical;
    if (fallback && fs.existsSync(fallback)) return fallback;
    return canonical;
  }

  return {
    projectRoot: root,
    canonicalKey,
    canonicalUid,
    isMain,
    instanceDir,
    dataDir,
    logsDir,
    logDir: logsDir,
    startupLogPath: path.join(logsDir, "startup.log"),
    // Credential paths
    credentialPath: canonicalCredPath,
    readCredentialPath: isMain ? canonicalCredPath : getReadPath(canonicalCredPath, legacyCredPath),
    legacyCredentialPath: legacyCredPath,
    // Bot config paths
    configPath: canonicalConfigPath,
    readConfigPath: getReadPath(canonicalConfigPath, legacyConfigPath),
    legacyConfigPath: legacyConfigPath,
    // State paths
    statePath: canonicalStatePath,
    readStatePath: getReadPath(canonicalStatePath, legacyStatePath),
    legacyStatePath: legacyStatePath,
    // Admin list paths
    adminListPath,
    legacyAdminListPath,
    readAdminListPath: getReadPath(adminListPath, legacyAdminListPath),
    // Group settings paths
    groupSettingsPath,
    legacyGroupSettingsPath,
    readGroupSettingsPath: getReadPath(groupSettingsPath, legacyGroupSettingsPath),
    // Command config paths
    commandConfigPath,
    legacyCommandConfigPath,
    readCommandConfigPath: getReadPath(commandConfigPath, legacyCommandConfigPath),
  };
}

/**
 * Resolve the set of valid ownership principal UIDs for a bot record.
 * Valid principals include:
 * 1. Creator UID from ownerUid or createdByUid.
 * 2. Zalo UID of the bot itself from uid, botId, or numeric key.
 * 3. Valid legacy UID from profile or createdBy.
 */
export function resolveBotOwnershipPrincipals(botRecord) {
  if (!botRecord || typeof botRecord !== "object") return new Set();

  const principals = new Set();
  const raw = botRecord.rawRecord || (botRecord.uid || botRecord.key ? botRecord : {});
  const prof = botRecord.profile || {};

  const isMain = isMainBot(botRecord, botRecord.key);
  if (isMain) {
    principals.add("admin");
    const mainUid = String(botRecord.uid || raw.uid || "").trim();
    if (mainUid && mainUid.toLowerCase() !== "admin") {
      principals.add(mainUid);
    }
    return principals;
  }

  // 1. Creator UID from ownerUid or createdByUid
  const ownerSources = [
    botRecord.ownerUid,
    raw.ownerUid,
    prof.ownerUid,
    botRecord.createdByUid,
    raw.createdByUid,
    prof.createdByUid,
  ];
  for (const src of ownerSources) {
    if (src != null) {
      const s = String(src).trim();
      if (s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") {
        principals.add(s);
      }
    }
  }

  // 2. Zalo UID of the child bot itself from uid / botId / key
  const botUidSources = [
    botRecord.uid,
    raw.uid,
    prof.botId,
    prof.uid,
    botRecord.botId,
    raw.botId,
  ];
  for (const src of botUidSources) {
    if (src != null) {
      const s = String(src).trim();
      if (s && s.toLowerCase() !== "null" && s.toLowerCase() !== "undefined") {
        principals.add(s);
      }
    }
  }
  if (botRecord.key && /^\d{10,}$/.test(String(botRecord.key).trim())) {
    principals.add(String(botRecord.key).trim());
  }

  // 3. Valid legacy UID saved in profile or createdBy
  const legacySources = [
    botRecord.createdBy,
    raw.createdBy,
    prof.createdBy,
  ];
  for (const src of legacySources) {
    if (src != null) {
      const s = String(src).trim();
      if (/^\d{10,}$/.test(s)) {
        principals.add(s);
      }
    }
  }

  return principals;
}

/**
 * Check whether a bot is owned by a caller UID.
 */
export function isBotOwnedByCaller(botRecord, callerUid) {
  if (!botRecord || !callerUid) return false;
  const normCaller = String(callerUid).trim();
  if (!normCaller) return false;
  const principals = resolveBotOwnershipPrincipals(botRecord);
  return principals.has(normCaller);
}

export function resolveManagedBotList({
  projectRoot = process.cwd(),
  registry = null,
  ownerUid = null,
  includeMain = true,
  includeRejected = true,
  includeDisabled = true,
  includePending = true,
} = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const registryPath = path.join(root, "mybot", "mybots.json");

  const myBots = registry && typeof registry === 'object' ? registry : loadMyBotsRegistry(registryPath);

  const list = [];
  for (const [key, rawRecord] of Object.entries(myBots)) {
    if (!rawRecord || typeof rawRecord !== "object") continue;

    const isMain = isMainBot(rawRecord, key);
    const targetUid = String(rawRecord.uid || rawRecord.botId || key).trim();
    const profile = getProfile(key, { root });

    let resolvedOwnerUid = null;
    let ownerResolution = "missing";

    if (rawRecord.ownerUid && String(rawRecord.ownerUid).trim()) {
      resolvedOwnerUid = String(rawRecord.ownerUid).trim();
      ownerResolution = resolvedOwnerUid === targetUid ? "self" : "verified";
    } else if (rawRecord.createdByUid && String(rawRecord.createdByUid).trim()) {
      resolvedOwnerUid = String(rawRecord.createdByUid).trim();
      ownerResolution = resolvedOwnerUid === targetUid ? "self" : "verified";
    } else if (profile?.ownerUid && String(profile.ownerUid).trim() && String(profile.ownerUid).trim().toLowerCase() !== "admin") {
      resolvedOwnerUid = String(profile.ownerUid).trim();
      ownerResolution = resolvedOwnerUid === targetUid ? "self" : "verified";
    } else if (isMain) {
      resolvedOwnerUid = targetUid !== "admin" ? targetUid : "admin";
      ownerResolution = "verified";
    } else if (rawRecord.createdBy && /^\d{10,}$/.test(String(rawRecord.createdBy).trim())) {
      resolvedOwnerUid = String(rawRecord.createdBy).trim();
      ownerResolution = "legacy";
    } else if (!isMain && targetUid && /^\d{10,}$/.test(targetUid)) {
      resolvedOwnerUid = targetUid;
      ownerResolution = "self";
    } else {
      resolvedOwnerUid = null;
      ownerResolution = "missing";
    }

    const adminIdentitySeeds = rawRecord.adminIdentitySeeds || profile?.adminIdentitySeeds || null;
    const identityPending = Boolean(rawRecord.identityPending === true || (!isMain && !adminIdentitySeeds));
    const identityPendingReason = rawRecord.identityPendingReason || (identityPending ? "Chưa cấu hình đủ 3 admin identity seeds" : null);

    const ownerName = rawRecord.ownerName || profile?.ownerName || rawRecord.createdBy || (ownerResolution === "missing" ? "Chưa xác định" : "User");
    const nameServer = profile?.nameServer || rawRecord.nameServer || rawRecord.displayName || rawRecord.name || key;
    const displayName = rawRecord.displayName || profile?.nameServer || rawRecord.name || key;
    const status = rawRecord.status || "stopped";
    const webPort = rawRecord.webPort || profile?.webPort || "4444";
    const database = rawRecord.database || (isMain ? "nthdz" : targetUid);
    const expiryAt = profile?.expiryAt !== undefined ? profile.expiryAt : (rawRecord.expiryAt || null);
    const trialStatus = profile?.trialStatus || rawRecord.trialStatus || (expiryAt ? "active" : "pending");
    const enabled = profile?.enabled !== undefined
      ? profile.enabled
      : (rawRecord.enabled !== false && status !== "disabled" && status !== "rejected");

    const paths = resolveBotPaths({ key, uid: targetUid, isMain }, root);

    const target = {
      key,
      uid: targetUid,
      ownerUid: resolvedOwnerUid,
      ownerResolution,
      ownerName,
      nameServer,
      displayName,
      avatar: rawRecord.avatar || profile?.avatar || "",
      profile,
      status,
      webPort: String(webPort),
      database: String(database),
      isMain,
      createdAt: rawRecord.createdAt || profile?.updatedAt || null,
      expiryAt,
      trialStatus,
      enabled,
      identityPending,
      identityPendingReason,
      adminIdentitySeeds,
      pid: rawRecord.pid || null,
      consolePid: rawRecord.consolePid || null,
      paths,
      rawRecord,
    };

    if (!includeMain && target.isMain) continue;
    if (!includeRejected && (status === "rejected" || profile?.status === "rejected")) continue;
    if (!includeDisabled && target.enabled === false) continue;
    if (!includePending && target.identityPending) continue;

    if (ownerUid) {
      const normOwner = String(ownerUid).trim();
      if (!isBotOwnedByCaller(target, normOwner)) {
        continue;
      }
    }

    list.push(target);
  }

  // Sort: Main Bot first, then createdAt ascending, then uid
  list.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;

    const timeA = a.createdAt ? Date.parse(a.createdAt) : 0;
    const timeB = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }

    return String(a.uid || a.key || "").localeCompare(String(b.uid || b.key || ""));
  });

  return list;
}

export function resolveManagedBotTargetRecord(targetOrKey, { projectRoot = process.cwd(), registry = null } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  if (targetOrKey && typeof targetOrKey === "object" && targetOrKey.paths && targetOrKey.ownerResolution) {
    return targetOrKey;
  }

  const allList = resolveManagedBotList({ projectRoot: root, registry, includeMain: true, includeRejected: true });
  const lookupKey = typeof targetOrKey === "object" && targetOrKey ? String(targetOrKey.key || targetOrKey.uid || "") : String(targetOrKey || "");
  const trimmed = lookupKey.trim();

  if (trimmed) {
    const found = allList.find((b) =>
      String(b.key || "").trim() === trimmed ||
      String(b.uid || "").trim() === trimmed ||
      String(b.profile?.botId || "").trim() === trimmed
    );
    if (found) return found;
  }

  // If not found in registry, create synthetic record
  let isMain = trimmed.toLowerCase() === "admin";
  if (!isMain && trimmed) {
    try {
      const adminStatePath = path.join(root, "mybot", "state", "admin.json");
      if (fs.existsSync(adminStatePath)) {
        const parsed = JSON.parse(fs.readFileSync(adminStatePath, "utf8").replace(/^\uFEFF/, ""));
        if (parsed?.uid && parsed.uid === trimmed) {
          isMain = true;
        }
      }
    } catch {}
  }
  const paths = resolveBotPaths({ key: trimmed || "unknown", uid: trimmed || "unknown", isMain }, root);
  return {
    key: trimmed || "unknown",
    uid: trimmed || "unknown",
    ownerUid: isMain ? (trimmed !== "admin" ? trimmed : "admin") : null,
    ownerResolution: isMain ? "verified" : "missing",
    ownerName: isMain ? "Admin" : "Chưa xác định",
    nameServer: trimmed || "unknown",
    displayName: trimmed || "unknown",
    avatar: "",
    profile: null,
    status: "stopped",
    webPort: "4444",
    database: isMain ? "nthdz" : (trimmed || "unknown"),
    isMain,
    createdAt: null,
    expiryAt: null,
    trialStatus: "pending",
    enabled: true,
    identityPending: false,
    identityPendingReason: null,
    adminIdentitySeeds: null,
    pid: null,
    consolePid: null,
    paths,
    rawRecord: null,
  };
}

export function resolveVisibleBots({
  projectRoot = process.cwd(),
  registry = null,
  callerUid = "",
  isSystemAdmin = false,
  includeRejected = true,
  includeDisabled = true,
  includePending = true,
} = {}) {
  const normCaller = String(callerUid || "").trim();
  let adminBypass = Boolean(isSystemAdmin || !normCaller || normCaller.toLowerCase() === "admin");
  if (!adminBypass && normCaller) {
    try {
      const { adminUid } = resolveAdminIdentity({ projectRoot });
      if (adminUid && adminUid.toLowerCase() !== "admin" && normCaller === adminUid) {
        adminBypass = true;
      }
    } catch {}
  }

  if (adminBypass) {
    return resolveManagedBotList({
      projectRoot,
      registry,
      includeMain: true,
      includeRejected,
      includeDisabled,
      includePending: true,
    });
  }

  return resolveManagedBotList({
    projectRoot,
    registry,
    ownerUid: normCaller,
    includeMain: false,
    includeRejected,
    includeDisabled,
    includePending,
  });
}

export function resolveManagedBotTarget({
  selector = { type: "self" },
  registry = null,
  callerUid = "",
  isSystemAdmin = false,
  action = "",
  projectRoot = process.cwd(),
  visibleBots = null,
} = {}) {
  const normCaller = String(callerUid || "").trim();
  const isCallerScoping = Boolean(normCaller && !isSystemAdmin);

  const allList = resolveManagedBotList({
    projectRoot,
    registry,
    includeMain: true,
    includeRejected: true,
  });

  if (allList.length === 0) return [];

  const targetList = isCallerScoping
    ? (visibleBots || resolveVisibleBots({ projectRoot, registry, callerUid: normCaller, isSystemAdmin: false }))
    : allList;

  let matched = [];

  switch (selector?.type) {
    case "all": {
      matched = isCallerScoping ? [...targetList] : [...allList];
      matched = matched.filter((b) => !b.isMain);
      break;
    }

    case "index": {
      const idx = typeof selector.value === "number" ? selector.value : parseInt(selector.value, 10);
      if (isNaN(idx) || idx < 1 || idx > targetList.length) return [];
      const item = targetList[idx - 1];
      matched = item ? [item] : [];
      break;
    }

    case "uid": {
      const targetVal = String(selector.value || "").trim();
      if (!targetVal) return [];
      // Strictly match bot UID, bot key, or profile.botId (never owner UID)
      const item = allList.find((b) =>
        String(b.uid || "").trim() === targetVal ||
        String(b.key || "").trim() === targetVal ||
        String(b.profile?.botId || "").trim() === targetVal
      );
      if (item) {
        if (!isCallerScoping || isBotOwnedByCaller(item, normCaller)) {
          matched = [item];
        }
      }
      break;
    }

    case "multiple": {
      const items = Array.isArray(selector.items) ? selector.items : [];
      const resultMap = new Map();
      for (const item of items) {
        const trimmed = String(item || "").trim();
        if (!trimmed) continue;
        if (/^\d+$/.test(trimmed) && trimmed.length < 10) {
          const idx = parseInt(trimmed, 10);
          if (idx >= 1 && idx <= targetList.length) {
            const b = targetList[idx - 1];
            if (b) resultMap.set(b.key, b);
          }
        } else {
          const b = allList.find((bot) =>
            String(bot.uid || "").trim() === trimmed ||
            String(bot.key || "").trim() === trimmed ||
            String(bot.profile?.botId || "").trim() === trimmed
          );
          if (b) {
            if (!isCallerScoping || isBotOwnedByCaller(b, normCaller)) {
              resultMap.set(b.key, b);
            }
          }
        }
      }
      matched = Array.from(resultMap.values());
      matched = matched.filter((b) => !b.isMain);
      break;
    }

    case "self":
    default: {
      if (normCaller) {
        matched = targetList.filter(b => !b.isMain && isBotOwnedByCaller(b, normCaller));
      }
      break;
    }
  }

  return matched;
}

