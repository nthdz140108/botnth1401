import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readRoleRegistry } from "./role-registry-service.js";
import { createRuntimeStatusResolver } from "./runtime-status-resolver.js";
import { classifyBotExpiry } from "../commands/mybot/System/expiry-classifier.js";

const SENSITIVE = /cookie|token|password|secret|imei|useragent|credential/i;

export class BotRegistry {
  constructor({ root = process.cwd(), pm2 = null, portProbe = isPortOpen } = {}) {
    this.root = path.resolve(root);
    this.pm2 = pm2;
    this.portProbe = portProbe;
    this.inventoryPath = path.join(this.root, "mybot", "mybots.json");
    this.roleRegistryPath = path.join(this.root, "mybot", "role-registry.json");
    // Shared two-layer status resolver (PM2 supervisor + bot readiness).
    // Keeps /api/bots, overview and terminal snapshot on the same status engine.
    this.resolver = createRuntimeStatusResolver({
      root: this.root,
      pm2: pm2 || null,
      portProbe: portProbe || isPortOpen,
    });
  }

  async list() {
    const inventory = await readJson(this.inventoryPath, {});
    const roleRegistry = await readJson(this.roleRegistryPath, {});
    const botIds = new Set(["admin", ...Object.keys(inventory), ...(await readIds(path.join(this.root, "mybot", "bots"))), ...(await readIds(path.join(this.root, "mybot", "state")))]);
    const bots = [];
    for (const id of botIds) bots.push(await this.describe(id, inventory[id] || {}, roleRegistry));
    return bots.sort((a, b) => (a.id === "admin" ? -1 : b.id === "admin" ? 1 : a.id.localeCompare(b.id)));
  }

  async describe(id, inventoryEntry = null, roleRegistryEntry = null) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid bot id");
    const botFile = path.join(this.root, "mybot", "bots", `${id}.json`);
    const stateFile = path.join(this.root, "mybot", "state", `${id}.json`);
    const hasBotFile = await exists(botFile);
    const hasStateFile = await exists(stateFile);
    const config = hasBotFile ? await readJson(botFile, {}) : {};
    const state = hasStateFile ? await readJson(stateFile, {}) : {};
    const inventoryFile = await readJson(this.inventoryPath, {});
    const inventory = inventoryEntry || inventoryFile[id] || {};
    if (id !== "admin" && !hasBotFile && !hasStateFile && !inventoryEntry && !inventoryFile[id]) return null;
    const roleRegistry = roleRegistryEntry || await readJson(this.roleRegistryPath, {});
    const adminBotId = typeof roleRegistry.adminBotId === "string"
      ? roleRegistry.adminBotId
      : typeof roleRegistry.primaryBotId === "string"
        ? roleRegistry.primaryBotId
        : "admin";
    const primaryBotId = typeof roleRegistry.primaryBotId === "string" ? roleRegistry.primaryBotId : adminBotId;
    const merged = { ...config, ...state, ...inventory };
    if (id === "admin") {
      merged.webPort = merged.webPort || 2000;
      merged.port = merged.port || 2000;
      if (!merged.configFilePath) merged.configFilePath = "assets/config.json";
    }
    const configPath = resolveProjectPath(this.root, merged.configFilePath || config.configFilePath || inventory.configFilePath);
    const paths = collectPaths(this.root, merged, configPath);
    const enabled = merged.enabled !== false;
    const runtime = await this.runtime(id, { inventory, config, state, merged, configPath });
    return {
      id,
      uid: id,
      displayName: merged.displayName || merged.name || id,
      name: merged.name || id,
      status: enabled ? runtime.status : "disabled",
      // Status schema v2: every bot status carries its schema version, the
      // two-layer provenance (supervisor + readiness) and a machine-readable
      // reason. Frontends must reject objects missing statusSchemaVersion
      // instead of rendering a bare "N/A".
      statusSchemaVersion: 2,
      statusReason: enabled ? (runtime.reason || runtime.readiness?.reason || null) : "bot-disabled",
      configuredStatus: enabled ? normalizeStatus(inventory.status || config.status || state.status || "unknown", merged.expiryAt, merged.trialStatus) : "disabled",
      enabled,
      disabledAt: enabled ? null : merged.disabledAt || null,
      disabledReason: enabled ? null : merged.disabledReason || "",
      expiryAt: merged.expiryAt || null,
      primaryBotId,
      isPrimary: primaryBotId === id,
      primaryRole: primaryBotId === id ? "primary" : adminBotId === id ? "admin" : "child",
      port: runtime.port,
      webPort: runtime.port,
      pid: runtime.pid,
      botFile,
      stateFile,
      configPath,
      paths,
      config: redact(config),
      credential: await credentialState(this.root, configPath || config.configFilePath),
      processAlive: runtime.processAlive,
      portOpen: runtime.portOpen,
      pm2Status: runtime.pm2Status,
      supervisor: runtime.supervisor,
      readiness: runtime.readiness,
      connected: runtime.connected,
      lastSeenAt: state.updatedAt || state.timestamp || null,
      cookieDead: state.cookieDead === true,
      standbyRam: runtime.readiness?.memory || null,
    };
  }

  async runtime(id, snapshot = null) {
    const data = snapshot || { inventory: {}, config: {}, state: {}, merged: {} };
    const port = Number(data.merged?.webPort || data.inventory?.webPort || data.config?.webPort || data.state?.webPort) || null;
    const pid = data.state?.pid || data.inventory?.pid || data.config?.pid || null;
    // Diagnostics only: a stored PID never proves the bot is running
    // (stale or Windows-reused PIDs must not fake liveness).
    const processAlive = isProcessAlive(pid);
    // Shared resolver decides status from PM2 supervisor + readiness probes.
    // It ignores processAlive for the running decision.
    let resolved;
    try {
      resolved = await this.resolver.resolveBot({
        id,
        enabled: data.merged?.enabled !== false,
        expiryAt: data.merged?.expiryAt || null,
        trialStatus: data.merged?.trialStatus,
        port,
        webHost: data.merged?.webHost || data.config?.webHost || "127.0.0.1",
        configuredStatus: normalizeStatus(data.inventory?.status || data.config?.status || data.state?.status || "unknown", data.merged?.expiryAt, data.merged?.trialStatus),
      });
    } catch {
      // Resolver failure must degrade to unknown, never fake running.
      resolved = {
        status: "unknown",
        configuredStatus: "unknown",
        connected: false,
        supervisor: { available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 },
        readiness: { status: "not-ready", portOpen: false, identityVerified: false, reason: "resolver-unavailable", checkedAt: new Date().toISOString() },
        reason: "resolver-unavailable",
      };
    }
    const pm2Status = resolved.supervisor?.available
      ? { running: resolved.supervisor.status === "online", status: resolved.supervisor.status, pid: resolved.supervisor.pid, pm2Id: resolved.supervisor.pm2Id, uptime: resolved.supervisor.uptime, restartCount: resolved.supervisor.restartCount }
      : null;
    return {
      status: resolved.status,
      port,
      pid,
      processAlive,
      portOpen: resolved.readiness?.portOpen || false,
      pm2Status,
      connected: resolved.connected,
      supervisor: resolved.supervisor,
      readiness: resolved.readiness,
    };
  }
}

async function credentialState(root, relativePath) {
  if (!relativePath) return { configured: false, state: "missing" };
  try {
    const value = await readJson(resolveProjectPath(root, relativePath), {});
    const configured = Boolean(value?.cookie && typeof value.cookie === "object" && Object.keys(value.cookie).length);
    return { configured, state: configured ? "configured" : "missing" };
  } catch {
    return { configured: false, state: "invalid" };
  }
}

function collectPaths(root, merged, configPath) {
  const output = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string" && /(path|file)/i.test(key)) output[key] = resolveProjectPath(root, value);
  }
  if (configPath) output.credentialPath = configPath;
  return output;
}

function resolveProjectPath(root, value) {
  return value ? path.resolve(root, value) : null;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Invalid JSON: ${file}`);
  }
}

async function readIds(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !/credential/i.test(entry.name))
      .map((entry) => entry.name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function redact(value) {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)));
}

function normalizeStatus(status, expiryAt, trialStatus) {
  // Shared expiry classifier: only "expired" when there is a real past date.
  // "-1" stays permanent, malformed stays unknown, missing expiry without
  // an `active` trial stays pending. Never call `Date.parse(expiryAt)`
  // directly here — it misclassifies `"-1"` and other sentinels.
  const expiryState = classifyBotExpiry({ expiryAt, trialStatus });
  if (expiryState === "expired") return "expired";
  return ["running", "stopped", "starting", "stopping", "restarting", "pending", "error", "credential_dead", "unknown", "expired", "disabled"].includes(status) ? status : "unknown";
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isPortOpen(portNumber, host = "127.0.0.1", timeout = 400) {
  const numericPort = Number(portNumber);
  if (!Number.isFinite(numericPort) || numericPort <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(numericPort, host, () => done(true));
  });
}
