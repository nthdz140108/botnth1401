import path from "node:path";
import fs from "node:fs";
import { withRegistryLockSync } from '../commands/mybot/System/registry-lock.js';

export const RESTART_EXIT_CODE = 10;
export const QR_UID_MISMATCH_EXIT_CODE = 13;

export class RuntimeInstanceDescriptor {
  constructor({
    kind = "main",
    botKey = "admin",
    configuredUid = "admin",
    liveZaloUid = "",
    configPath = "",
    webPort = 2000,
    pid = process.pid,
    supervisor = "main-supervisor",
    projectRoot = process.cwd(),
  } = {}) {
    this.kind = kind === "child" ? "child" : "main";
    this.botKey = String(botKey || (this.kind === "main" ? "admin" : "child"));
    this.configuredUid = String(configuredUid || this.botKey);
    this.liveZaloUid = String(liveZaloUid || "");
    this.configPath = String(configPath || "");
    this.webPort = Number(webPort) || (this.kind === "main" ? 2000 : 0);
    this.pid = Number(pid) || process.pid;
    this.supervisor = supervisor || (this.kind === "main" ? "main-supervisor" : "child-terminal");
    this.projectRoot = String(projectRoot || process.cwd());
    this.createdAt = new Date().toISOString();
  }

  get isMain() {
    return this.kind === "main";
  }

  get isChild() {
    return this.kind === "child";
  }

  setLiveZaloUid(uid) {
    if (uid) {
      this.liveZaloUid = String(uid).trim();
    }
  }

  toJSON() {
    return {
      kind: this.kind,
      botKey: this.botKey,
      configuredUid: this.configuredUid,
      liveZaloUid: this.liveZaloUid,
      configPath: this.configPath,
      webPort: this.webPort,
      pid: this.pid,
      supervisor: this.supervisor,
      projectRoot: this.projectRoot,
      createdAt: this.createdAt,
    };
  }
}

let _activeDescriptor = null;

function readRegisteredAdminBotId(root) {
  try {
    const roleRegistryPath = path.join(root, "mybot", "role-registry.json");
    if (!fs.existsSync(roleRegistryPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(roleRegistryPath, "utf8").replace(/^\uFEFF/, ""));
    return parsed?.adminBotId || parsed?.primaryBotId || null;
  } catch {
    return null;
  }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
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

export function resolveLaunchDescriptor(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.projectRoot || env.PROJECT_ROOT || env.ProjectRoot || process.cwd());
  const explicitKind = String(options.kind || options.explicitKind || env.MYBOT_INSTANCE_KIND || "").trim().toLowerCase();

  let rawKey = String(
    options.botKey || options.botName || env.BOT_KEY || env.BOT_NAME || env.BOT_ID || ""
  ).trim();

  if (!rawKey && options.argv?.[2]) {
    const arg = String(options.argv[2]).trim();
    if (!arg.startsWith("-") && !arg.endsWith(".js")) {
      rawKey = arg;
    }
  }
  if (!rawKey && process.argv?.[2]) {
    const arg = String(process.argv[2]).trim();
    if (!arg.startsWith("-") && !arg.endsWith(".js")) {
      rawKey = arg;
    }
  }
  if (!rawKey) {
    rawKey = String(env.PM2_NAME || env.name || env.Cursor || "").trim();
  }

  const registeredAdminId = readRegisteredAdminBotId(root);
  const rawPort = options.webPort || env.WEB_PORT;

  let kind = "main";
  let botKey = "admin";
  let configuredUid = "admin";
  let supervisor = "main-supervisor";
  let configPath = options.configPath || env.CONFIG_PATH || "";

  if (explicitKind === "child") {
    kind = "child";
    botKey = (rawKey && rawKey.toLowerCase() !== "admin") ? rawKey : (options.botKey || "child");
    configuredUid = String(options.configuredUid || options.botUid || env.BOT_UID || botKey).trim();
    supervisor = options.supervisor || "child-terminal";
    if (!configPath) {
      configPath = path.join(root, "mybot", "bots", `${botKey}.json`);
    }
  } else if (explicitKind === "main") {
    kind = "main";
    botKey = "admin";
    configuredUid = String(options.configuredUid || options.botUid || env.BOT_UID || "admin").trim();
    supervisor = options.supervisor || "main-supervisor";
    if (!configPath) {
      configPath = path.join(root, "assets", "config.json");
    }
  } else {
    const isRegisteredAdmin = registeredAdminId && rawKey && rawKey.toLowerCase() === String(registeredAdminId).toLowerCase();
    const isMainName = !rawKey || rawKey.toLowerCase() === "admin" || isRegisteredAdmin;

    if (isMainName) {
      kind = "main";
      botKey = "admin";
      configuredUid = String(options.configuredUid || options.botUid || env.BOT_UID || "admin").trim();
      supervisor = options.supervisor || "main-supervisor";
      if (!configPath) {
        configPath = path.join(root, "assets", "config.json");
      }
    } else {
      kind = "child";
      botKey = rawKey || "child";
      configuredUid = String(options.configuredUid || options.botUid || env.BOT_UID || botKey).trim();
      supervisor = options.supervisor || "child-terminal";
      if (!configPath) {
        configPath = path.join(root, "mybot", "bots", `${botKey}.json`);
      }
    }
  }

  // Fail-closed validation for config paths
  const normalizedCfg = configPath.replace(/\\/g, "/").toLowerCase();
  const baseCfg = path.basename(configPath).toLowerCase();
  const isMainConfig = Boolean(
    normalizedCfg.endsWith("assets/config.json") ||
    normalizedCfg.endsWith("assets/data/config.json") ||
    baseCfg === "config.json" ||
    (baseCfg === "admin.json" && !normalizedCfg.includes("/instances/"))
  );
  const isChildConfig = Boolean(
    (normalizedCfg.includes("/mybot/bots/") && baseCfg !== "admin.json") ||
    normalizedCfg.includes("/instances/")
  );

  if (kind === "child" && isMainConfig) {
    const error = new Error(`[DESCRIPTOR_ERROR] Child bot '${botKey}' is pointing to main admin config: ${configPath}`);
    error.code = "INVALID_CHILD_CONFIG";
    throw error;
  }

  if (kind === "main" && isChildConfig) {
    const error = new Error(`[DESCRIPTOR_ERROR] Main bot is pointing to child bot config: ${configPath}`);
    error.code = "INVALID_MAIN_CONFIG";
    throw error;
  }

  return new RuntimeInstanceDescriptor({
    kind,
    botKey,
    configuredUid,
    liveZaloUid: options.liveZaloUid || "",
    configPath,
    webPort: rawPort || (kind === "main" ? 2000 : 0),
    pid: options.pid || process.pid,
    supervisor,
    projectRoot: root,
  });
}

export function createRuntimeInstanceDescriptor(options = {}) {
  const descriptor = resolveLaunchDescriptor(options);
  _activeDescriptor = descriptor;
  return descriptor;
}

export function getRuntimeInstanceDescriptor() {
  if (!_activeDescriptor) {
    _activeDescriptor = createRuntimeInstanceDescriptor();
  }
  return _activeDescriptor;
}

export function setRuntimeInstanceDescriptor(descriptor) {
  _activeDescriptor = descriptor;
  return _activeDescriptor;
}

export function setLiveZaloUid(uid) {
  const descriptor = getRuntimeInstanceDescriptor();
  descriptor.setLiveZaloUid(uid);
  return descriptor;
}

export function resetRuntimeInstanceDescriptor() {
  _activeDescriptor = null;
}

export function getBotId() {
  const descriptor = getRuntimeInstanceDescriptor();
  return descriptor.liveZaloUid || descriptor.configuredUid || -1;
}

export function setBotId(id) {
  const descriptor = getRuntimeInstanceDescriptor();
  descriptor.setLiveZaloUid(id);
  return id;
}

export function verifyRuntimeIdentity(descriptor, liveUid, { projectRoot = descriptor?.projectRoot } = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const normalizedLiveUid = String(liveUid || "").trim();
  const desc = descriptor || getRuntimeInstanceDescriptor();

  if (desc.isChild) {
    const expectedAccount = desc.configuredUid !== desc.botKey ? desc.configuredUid : (/^\d+$/.test(desc.botKey) ? desc.botKey : '');
    if (expectedAccount && normalizedLiveUid !== expectedAccount) {
      return { verified: false, action: 'exit', code: QR_UID_MISMATCH_EXIT_CODE, reason: `Child bot '${desc.botKey}' authenticated a different account` };
    }
    const mainState = readJsonIfExists(path.join(root, "mybot", "state", "admin.json"));
    const mainBotUid = String(mainState?.uid || "").trim();

    if (normalizedLiveUid && mainBotUid && mainBotUid.toLowerCase() !== "admin" && normalizedLiveUid === mainBotUid) {
      return {
        verified: false,
        action: "exit",
        code: QR_UID_MISMATCH_EXIT_CODE,
        reason: `Child bot '${desc.botKey}' logged into main bot UID (${normalizedLiveUid})`,
      };
    }

    if (normalizedLiveUid && normalizedLiveUid.toLowerCase() !== "admin") {
      const childStatePath = path.join(root, "mybot", "state", `${desc.botKey}.json`);
      const currentState = readJsonIfExists(childStatePath) || {};
      writeJsonAtomic(childStatePath, {
        ...currentState,
        uid: normalizedLiveUid,
        botKey: desc.botKey,
        lastVerifiedAt: new Date().toISOString(),
      });
    }

    desc.setLiveZaloUid(normalizedLiveUid);
    return {
      verified: true,
      action: "continue",
      liveUid: normalizedLiveUid,
    };
  }

  // Main process: repair admin state and registry
  if (normalizedLiveUid && normalizedLiveUid.toLowerCase() !== "admin") {
    const statePath = path.join(root, "mybot", "state", "admin.json");
    const currentState = readJsonIfExists(statePath) || {};
    const oldUid = currentState.uid || "admin";
    writeJsonAtomic(statePath, {
      ...currentState,
      uid: normalizedLiveUid,
      lastRepairedAt: new Date().toISOString(),
    });

    const registryPath = path.join(root, "mybot", "mybots.json");
    withRegistryLockSync(registryPath, () => {
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
    });

    desc.setLiveZaloUid(normalizedLiveUid);
    return {
      verified: true,
      action: "continue",
      liveUid: normalizedLiveUid,
      oldUid,
      repaired: oldUid !== normalizedLiveUid,
    };
  }

  return {
    verified: true,
    action: "continue",
    liveUid: normalizedLiveUid,
  };
}
