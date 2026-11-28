import fs from "fs";
import path from "path";
import { getBotInfo, getProjectRoot, getBotName } from "./env.js";

var mutableKeys = [
  "configFilePath",
  "groupSettingsPath",
  "adminFilePath",
  "adminLevelHighFilePath",
  "commandFilePath",
  "MANAGER_FILE_PATH",
  "PROPHYLACTIC_CONFIG_PATH",
  "WEB_CONFIG_PATH",
  "dataTrainingPath",
  "rankInfoPath",
  "locmemDbPath",
  "logDir",
  "resourceDir",
  "tempDir",
  "dataGifPath",
  "stateDir",
  "workspaceDir",
  "generatedDir",
];

function resolveWorkspaceRoot(projectRoot, uid) {
  return path.join(projectRoot, "mybot", "instances", uid);
}

function resolveRuntimePath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim()) return value;
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(projectRoot, value);
}

function resolveSeedPath(projectRoot, relativeCandidates) {
  for (const relativeCandidate of relativeCandidates) {
    if (!relativeCandidate || typeof relativeCandidate !== "string") continue;
    const candidatePath = path.isAbsolute(relativeCandidate)
      ? relativeCandidate
      : path.join(projectRoot, relativeCandidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

export function resolveCanonicalBotUid(identity) {
  const raw = typeof identity === "object" && identity !== null
    ? (identity.botKey || identity.key || identity.name || identity.uid || identity.configuredUid || "")
    : String(identity || "").trim();
  const rawStr = String(raw || "").trim();

  try {
    const { getRuntimeInstanceDescriptor } = require ? {} : {};
  } catch {}

  // If running with an active descriptor, honor instance boundary
  return rawStr || "admin";
}

export function createBotRuntimeContext(uidOrConfig, { root } = {}) {
  const projectRoot = root || getProjectRoot();
  let descriptor = null;
  try {
    const { getRuntimeInstanceDescriptor } = { getRuntimeInstanceDescriptor: null };
  } catch {}

  let rawUid = typeof uidOrConfig === "string"
    ? uidOrConfig.trim()
    : (uidOrConfig?.botKey || uidOrConfig?.key || uidOrConfig?.name || uidOrConfig?.uid || uidOrConfig?.configuredUid || "");

  let uid = rawUid;
  if (!uid) {
    const currentName = getBotName();
    uid = (currentName && currentName !== "admin") ? currentName : "admin";
  }

  // Canonical normalization: never use raw live UID or display botName interchangeably with canonical admin
  const lowerUid = String(uid).toLowerCase();
  if (lowerUid === "admin") {
    uid = "admin";
  }

  const workspaceRoot = resolveWorkspaceRoot(projectRoot, uid);
  const instanceRoot = workspaceRoot;
  const dataDir = path.join(instanceRoot, "data");
  const logsDir = path.join(instanceRoot, "logs");
  const tempDir = path.join(instanceRoot, "temp");
  const resourcesDir = path.join(instanceRoot, "resources");
  const generatedDir = path.join(instanceRoot, "generated");
  const stateDir = path.join(instanceRoot, "state");

  const base = typeof uidOrConfig === "object" && uidOrConfig ? uidOrConfig : {};
  const resolved = {
    uid,
    projectRoot,
    workspaceRoot,
    instanceRoot,
    dataDir,
    logsDir,
    tempDir,
    resourcesDir,
    generatedDir,
    stateDir,
    credentialPath: path.join(projectRoot, "mybot", "credentials", `${uid}.json`),
    botConfigPath: path.join(projectRoot, "mybot", "bots", `${uid}.json`),
    commandConfigPath: path.join(dataDir, "command.json"),
    groupSettingsPath: path.join(dataDir, "group-settings.json"),
    adminListPath: path.join(dataDir, "admin-list.json"),
    adminLevelHighFilePath: path.join(projectRoot, "assets", "data", "list_admin_high.json"),
    managerPath: path.join(dataDir, "manager.json"),
    prophylacticPath: path.join(dataDir, "prophylactic.json"),
    webConfigPath: path.join(dataDir, "web-config.json"),
    trainingPath: path.join(dataDir, "data-training.json"),
    rankInfoPath: path.join(dataDir, "rank-info.json"),
    locmemDbPath: path.join(dataDir, "locmem-activity"),
    remindersPath: path.join(dataDir, "reminders.json"),
    antiConfigPath: path.join(dataDir, "anti-config.json"),
    scheduledAssetsDir: path.join(dataDir, "scheduled-assets"),
    messageLogPath: path.join(logsDir, "message.txt"),
    messageJsonPath: path.join(logsDir, "message.json"),
    botManagerLogPath: path.join(logsDir, "bot-manager.log"),
    ...base,
  };
  resolved.uid = uid;

  for (const key of mutableKeys) {
    if (!resolved[key]) continue;
    resolved[key] = resolveRuntimePath(projectRoot, resolved[key]);
  }

  return resolved;
}

export function getRuntimeContext(uid) {
  const currentKey = uid || getBotName() || "admin";
  const botInfo = fs.existsSync(path.join(getProjectRoot(), "mybot", "bots", `${currentKey}.json`))
    ? (getBotInfo() || {})
    : {};
  return createBotRuntimeContext({ ...botInfo, uid: uid || botInfo.uid || currentKey });
}

export function ensureRuntimeDirectories(context) {
  if (!context) return;
  const dirs = [
    context.workspaceRoot,
    context.dataDir,
    context.logsDir,
    context.tempDir,
    context.resourcesDir,
    context.generatedDir,
    context.stateDir,
  ];
  for (const dir of dirs) {
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
  }
}

function addCandidateUid(targetSet, rawValue) {
  if (rawValue === undefined || rawValue === null) return;
  if (typeof rawValue === "object") {
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        addCandidateUid(targetSet, item);
      }
      return;
    }
    addCandidateUid(targetSet, rawValue.uid || rawValue.botUid || rawValue.id || rawValue.adminUid || rawValue.admin?.uid || rawValue.admin?.botUid);
    return;
  }
  const uid = String(rawValue).trim();
  if (uid && uid.toLowerCase() !== "admin") {
    targetSet.add(uid);
  }
}

function resolveMainBotUid({ projectRoot } = {}) {
  const root = projectRoot || getProjectRoot();
  try {
    const adminStatePath = path.join(root, "mybot", "state", "admin.json");
    if (fs.existsSync(adminStatePath)) {
      const parsed = JSON.parse(fs.readFileSync(adminStatePath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed?.uid && String(parsed.uid).toLowerCase() !== "admin") return String(parsed.uid).trim();
    }
    const mybotsPath = path.join(root, "mybot", "mybots.json");
    if (fs.existsSync(mybotsPath)) {
      const parsed = JSON.parse(fs.readFileSync(mybotsPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed?.admin?.uid && String(parsed.admin.uid).toLowerCase() !== "admin") return String(parsed.admin.uid).trim();
    }
  } catch {}
  return "";
}

export function getInitialAdminList(botUid, projectRoot = getProjectRoot()) {
  const root = projectRoot || getProjectRoot();
  const adminSet = new Set();
  const sBotUid = String(botUid || "").trim();
  const isChild = Boolean(sBotUid && sBotUid.toLowerCase() !== "admin");

  // For child bots, ONLY read the resolved local instance admin-list.json or legacy list_admin-<uid>.json
  if (isChild) {
    try {
      const localAdminPath = path.join(root, "mybot", "instances", sBotUid, "data", "admin-list.json");
      if (fs.existsSync(localAdminPath)) {
        const localAdmins = JSON.parse(fs.readFileSync(localAdminPath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(localAdmins) && localAdmins.length > 0) {
          for (const item of localAdmins) addCandidateUid(adminSet, item);
          return Array.from(adminSet).filter(Boolean);
        }
      }
    } catch {}

    try {
      const botSpecificAdminPath = path.join(root, "mybot", "configs", `list_admin-${sBotUid}.json`);
      if (fs.existsSync(botSpecificAdminPath)) {
        const botSpecificAdmins = JSON.parse(fs.readFileSync(botSpecificAdminPath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(botSpecificAdmins) && botSpecificAdmins.length > 0) {
          for (const item of botSpecificAdmins) addCandidateUid(adminSet, item);
          return Array.from(adminSet).filter(Boolean);
        }
      }
    } catch {}

    // Do NOT merge main bot UID or global admin lists into child bot!
    return [];
  }

  // 1. Add bot UID itself
  addCandidateUid(adminSet, sBotUid || "admin");

  // 2. Add Main Bot UID
  const mainBotUid = resolveMainBotUid({ projectRoot: root });
  addCandidateUid(adminSet, mainBotUid);

  // 3. Check state admin.json directly if mainBotUid not yet found
  try {
    const stateAdminPath = path.join(root, "mybot", "state", "admin.json");
    if (fs.existsSync(stateAdminPath)) {
      const parsed = JSON.parse(fs.readFileSync(stateAdminPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed?.uid) addCandidateUid(adminSet, parsed.uid);
    }
  } catch {}

  // 4. Check mybots.json for main bot / admin entries
  try {
    const myBotsPath = path.join(root, "mybot", "mybots.json");
    if (fs.existsSync(myBotsPath)) {
      const parsed = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
      for (const rec of Object.values(parsed)) {
        if (rec?.isMain || rec?.uid === "admin" || (rec?.status === "running" && rec?.uid)) {
          if (rec.uid) addCandidateUid(adminSet, rec.uid);
        }
      }
    }
  } catch {}

  // 5. Check role-registry.json
  try {
    const roleRegPath = path.join(root, "mybot", "role-registry.json");
    if (fs.existsSync(roleRegPath)) {
      const parsed = JSON.parse(fs.readFileSync(roleRegPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed?.adminBotId) addCandidateUid(adminSet, parsed.adminBotId);
      if (parsed?.primaryBotId) addCandidateUid(adminSet, parsed.primaryBotId);
    }
  } catch {}

  // 6. Check global admin list files
  const candidateGlobalPaths = [
    path.join(root, "assets", "data", "list_admin_high.json"),
    path.join(root, "assets", "data", "list_admin.json"),
    path.join(root, "assets", "json-data", "list_admin.json"),
  ];

  for (const gPath of candidateGlobalPaths) {
    try {
      if (fs.existsSync(gPath)) {
        const parsed = JSON.parse(fs.readFileSync(gPath, "utf8").replace(/^\uFEFF/, ""));
        addCandidateUid(adminSet, parsed);
      }
    } catch {}
  }

  return Array.from(adminSet).filter(Boolean);
}

export function seedRuntimeFiles(context, { force = false } = {}) {
  ensureRuntimeDirectories(context);
  const seeds = [
    {
      target: context.groupSettingsPath,
      sources: [
        "assets/data/group_settings.json",
        "groupSettings.json",
        `mybot/settings/groupSettings-${context.uid}.json`,
        "mybot/instances/admin/data/group-settings.json",
      ],
      fallback: {},
      isObjectMap: true,
    },
    {
      target: context.commandConfigPath,
      sources: [
        `mybot/json-data/command-${context.uid}.json`,
        "assets/json-data/command.json",
        "mybot/defaultCommand.json",
      ],
      fallback: { prefix: "!", commands: [] },
    },
    {
      target: context.adminListPath,
      sources: [
        context.adminFilePath,
        `mybot/configs/list_admin-${context.uid}.json`,
      ],
      fallback: getInitialAdminList(context.uid, context.projectRoot),
      isAdminList: true,
    },
  ];

  for (const seed of seeds) {
    if (!seed.target) {
      continue;
    }
    let targetHasData = false;
    if (!force && fs.existsSync(seed.target)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(seed.target, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existingData)) {
          targetHasData = existingData.length > 0;
        } else if (existingData && typeof existingData === "object") {
          targetHasData = Object.keys(existingData).length > 0;
        }
      } catch {
        targetHasData = false;
      }
      if (targetHasData) {
        continue;
      }
    }
    const sourcePath = resolveSeedPath(context.projectRoot, seed.sources);
    let data = seed.fallback;
    if (sourcePath) {
      try {
        data = JSON.parse(fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, ""));
        if (seed.isAdminList && Array.isArray(data)) {
          const isChild = context.uid && context.uid.toLowerCase() !== "admin";
          if (!isChild) {
            const mergedAdminSet = new Set();
            for (const item of data) {
              addCandidateUid(mergedAdminSet, item);
            }
            for (const item of getInitialAdminList(context.uid, context.projectRoot)) {
              addCandidateUid(mergedAdminSet, item);
            }
            data = Array.from(mergedAdminSet).filter(Boolean);
          }
        }
      } catch {
        data = seed.fallback;
      }
    }
    fs.mkdirSync(path.dirname(seed.target), { recursive: true });
    fs.writeFileSync(seed.target, JSON.stringify(data, null, 2), "utf8");
  }
}

export function updateCommandPrefixFile(commandPath, newPrefix) {
  const config = fs.existsSync(commandPath)
    ? JSON.parse(fs.readFileSync(commandPath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  config.prefix = newPrefix;
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.writeFileSync(commandPath, JSON.stringify(config, null, 2), "utf8");
  return config;
}
