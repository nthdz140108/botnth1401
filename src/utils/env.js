import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveDataDir, resolveProjectRoot } from "../platform/index.js";
import { readCachedJson, invalidateCachedJson } from "./cached-json.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let _botName = null;
let _cfgPath = null;
let _projectRoot = null;

function hasProjectStructure(rootPath) {
  if (!rootPath || typeof rootPath !== "string") return false;
  return (
    fs.existsSync(path.join(rootPath, "mybot")) ||
    fs.existsSync(path.join(rootPath, "assets")) ||
    fs.existsSync(path.join(rootPath, "src")) ||
    fs.existsSync(path.join(rootPath, "package.json"))
  );
}

function resolveProjectRootCandidate(candidate) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  return hasProjectStructure(resolved) ? resolved : null;
}

function debugEnv() {
  console.log("=== ENVIRONMENT DEBUG ===");
  console.log("process.argv:", process.argv);
  console.log("process.env.Cursor:", process.env.Cursor);
  console.log("process.env.CONFIG_PATH:", process.env.CONFIG_PATH);
  console.log("process.env.ProjectRoot:", process.env.ProjectRoot);
  console.log("process.cwd():", process.cwd());
  console.log("=========================");
}

import { getRuntimeInstanceDescriptor, resetRuntimeInstanceDescriptor, getBotId, setBotId } from "../core/runtime-instance.js";
export { getBotId, setBotId };

function normalizeIdentity(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readArgvIdentity() {
  return normalizeIdentity(process.argv?.[2]);
}

export function getBotName() {
  const descriptor = getRuntimeInstanceDescriptor();
  return descriptor.botKey;
}

export function resolveInstanceKind(botName, { adminBotId } = {}) {
  const candidate = String(botName ?? "").trim().toLowerCase();
  if (!candidate) return "child";
  if (candidate === "admin") return "main";
  const registeredAdminId = String(adminBotId ?? "").trim().toLowerCase();
  if (registeredAdminId && candidate === registeredAdminId) return "main";
  return "child";
}

function readRegisteredAdminBotId() {
  try {
    const roleRegistryPath = path.join(getProjectRoot(), "mybot", "role-registry.json");
    if (!fs.existsSync(roleRegistryPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(roleRegistryPath, "utf8").replace(/^\uFEFF/, ""));
    return parsed?.adminBotId || parsed?.primaryBotId || null;
  } catch {
    return null;
  }
}

export function getInstanceKind() {
  const descriptor = getRuntimeInstanceDescriptor();
  return descriptor.kind;
}

export function isMainInstance() {
  return getInstanceKind() === "main";
}

export function getProjectRoot() {
  const envCandidates = [process.env.PROJECT_ROOT, process.env.ProjectRoot];
  for (const candidate of envCandidates) {
    if (candidate) {
      const resolved = resolveProjectRootCandidate(candidate);
      if (resolved) {
        return resolved;
      }
    }
  }
  if (_projectRoot === null) {
    _projectRoot = resolveProjectRoot(path.resolve(__dirname, "..", ".."));
  }
  return _projectRoot;
}

export function getDataDir() {
  return resolveDataDir(process.env.MYBOT_DATA_DIR || path.join(getProjectRoot(), "mybot"));
}

export function getCfgPath() {
  const descriptor = getRuntimeInstanceDescriptor();
  return descriptor.configPath;
}

export function getConfig() {
  return {
    botName: getBotName(),
    cfgPath: getCfgPath(),
    projectRoot: getProjectRoot(),
  };
}

export function validateConfigFile() {
  const cfgPath = getCfgPath();
  if (!fs.existsSync(cfgPath)) {
    console.error(`Config file không tồn tại: ${cfgPath}`);
    return false;
  }
  try {
    const configContent = fs.readFileSync(cfgPath, "utf8");
    JSON.parse(configContent);
    return true;
  } catch (error) {
    console.error(`Config file không hợp lệ: ${cfgPath}`, error.message);
    return false;
  }
}

export function validateEnv(showDebug = false) {
  if (showDebug) debugEnv();
  try {
    getConfig();
    return validateConfigFile();
  } catch (error) {
    console.error("Environment validation failed:", error.message);
    if (showDebug) debugEnv();
    return false;
  }
}

export function loadConfig() {
  const cfgPath = getCfgPath();
  try {
    const configContent = fs.readFileSync(cfgPath, "utf8");
    const config = JSON.parse(configContent);
    config._meta = {
      botName: getBotName(),
      configPath: cfgPath,
      projectRoot: getProjectRoot(),
      loadedAt: new Date().toISOString(),
    };
    return config;
  } catch (error) {
    console.error(`Lỗi load config từ ${cfgPath}:`, error.message);
    throw error;
  }
}

export function resetCache() {
  _botName = null;
  _cfgPath = null;
  _projectRoot = null;
  resetRuntimeInstanceDescriptor();
  invalidateCachedJson();
}

export function setEnvVars(envVars) {
  if (envVars.name) process.env.name = envVars.name;
  if (envVars.BOT_NAME) process.env.BOT_NAME = envVars.BOT_NAME;
  if (envVars.BOT_ID) process.env.BOT_ID = envVars.BOT_ID;
  if (envVars.PM2_NAME) process.env.PM2_NAME = envVars.PM2_NAME;
  if (envVars.Cursor) process.env.Cursor = envVars.Cursor;
  if (envVars.CONFIG_PATH) process.env.CONFIG_PATH = envVars.CONFIG_PATH;
  if (envVars.ProjectRoot) process.env.ProjectRoot = envVars.ProjectRoot;
  if (envVars.PROJECT_ROOT) process.env.PROJECT_ROOT = envVars.PROJECT_ROOT;
  if (envVars.MYBOT_DATA_DIR) process.env.MYBOT_DATA_DIR = envVars.MYBOT_DATA_DIR;
  resetCache();
}

export function getBotInfoSync() {
  // Hot path (called per message via settings lookups): serve through the
  // mtime/TTL cache so repeated reads do not hit disk every time.
  return readCachedJson(getCfgPath(), null);
}

export async function getBotInfo() {
  const cfgPath = getCfgPath();
  if (!fs.existsSync(cfgPath)) {
    console.trace(`Không tìm thấy file cấu hình bot: ${cfgPath}`);
    return null;
  }
  try {
    const cfgData = await fs.promises.readFile(cfgPath, "utf8");
    return JSON.parse(cfgData);
  } catch (error) {
    console.error(error);
    return null;
  }
}

if (!process.env.SKIP_ENV_VALIDATION) {
  process.nextTick(() => {
    try {
      validateEnv(false);
    } catch (error) {
      console.warn("Auto-validation failed, but continuing...", error.message);
    }
  });
}

