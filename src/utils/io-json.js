import fs from "fs";
import path from "path";
import { mkdir } from "fs/promises";
import { getBotInfo, getBotInfoSync, getProjectRoot } from "./env.js";
import { readCachedJson, invalidateCachedJson } from "./cached-json.js";
import { getTimeToString, getTimeNow } from "./format-util.js";
import { createBotRuntimeContext, ensureRuntimeDirectories, seedRuntimeFiles, getInitialAdminList } from "./bot-runtime-context.js";
import { composeRuntimeCommandConfig, createCommandSeedStub, toStateOnlyCommandConfig } from "./command-runtime-state.js";

const projectRoot = getProjectRoot();
const botInfo = getBotInfoSync() || await getBotInfo() || {};
const runtimeContext = createBotRuntimeContext(botInfo);
const configFilePath = path.join(projectRoot, botInfo.configFilePath || "assets/config.json");
const commandFilePath = runtimeContext.commandConfigPath;
const commandSeedCandidates = [
  path.join(projectRoot, "assets", "json-data", "command.json"),
  path.join(projectRoot, "mybot", "defaultCommand.json"),
];

function isTestEnv() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT ||
    process.env.SKIP_ENV_VALIDATION === "1" ||
    process.env.NODE_ENV === "test"
  );
}

function atomicWriteSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.tmp-json-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, content, "utf8");
  }
  invalidateCachedJson(filePath);
}

export function getActiveRuntimeContext() {
  const currentInfo = getBotInfoSync() || {};
  return createBotRuntimeContext(currentInfo);
}

function loadDefaultCommandConfig() {
  for (const seedPath of commandSeedCandidates) {
    const parsed = readCachedJson(seedPath, null);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }
  return { prefix: "!", commands: [] };
}

export function readConfig() {
  const parsed = readCachedJson(configFilePath, null);
  return parsed && typeof parsed === "object" ? parsed : {};
}

const _adminMemCache = new Map();
const ADMIN_HOT_CACHE_TTL_MS = 2000;

function withHotCache(cacheKey, computeFn) {
  if (isTestEnv()) {
    return computeFn();
  }
  const now = Date.now();
  const hit = _adminMemCache.get(cacheKey);
  if (hit && now - hit.at <= ADMIN_HOT_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = computeFn();
  _adminMemCache.set(cacheKey, { at: now, value });
  return value;
}

export function invalidateAdminCaches() {
  _adminMemCache.clear();
  invalidateCachedJson();
}

export function readAdmins() {
  const currentCtx = getActiveRuntimeContext();
  const cacheKey = `admins:${currentCtx.uid}:${currentCtx.adminListPath}`;
  return withHotCache(cacheKey, () => {
    const currentAdminFilePath = currentCtx.adminListPath;
    const currentInfo = getBotInfoSync() || {};

    const candidatePaths = [
      currentAdminFilePath,
      currentInfo.adminFilePath ? path.resolve(projectRoot, currentInfo.adminFilePath) : null,
      path.join(projectRoot, "mybot", "configs", `list_admin-${currentCtx.uid}.json`),
      path.join(projectRoot, "assets", "data", "list_admin.json"),
      path.join(projectRoot, "assets", "json-data", "list_admin.json"),
    ].filter(Boolean);

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const parsed = readCachedJson(p, null);
          if (Array.isArray(parsed)) {
            const highLevelSet = new Set(readMainBotAdmins(projectRoot));
            return parsed.map((id) => String(id).trim()).filter((id) => id && !highLevelSet.has(id));
          }
        } catch (error) {
          console.error(`Lỗi đọc tệp admin từ ${p}:`, error);
        }
      }
    }

    return getInitialAdminList(currentCtx.uid, projectRoot);
  });
}

export function readMainBotAdmins(root = getProjectRoot()) {
  const resolvedRoot = root || getProjectRoot();
  const readStrictJson = (filePath) => {
    try {
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return withHotCache(`mainAdmins:${resolvedRoot}`, () => {
    const highLevelPath = path.join(resolvedRoot, "assets", "data", "list_admin_high.json");
    if (fs.existsSync(highLevelPath)) {
      const parsed = readStrictJson(highLevelPath);
      return Array.isArray(parsed) ? parsed.map((id) => String(id).trim()).filter(Boolean) : [];
    }
    const mainBotConfigPath = path.join(resolvedRoot, "mybot", "bots", "admin.json");
    let targetAdminPath = null;

    if (fs.existsSync(mainBotConfigPath)) {
      const config = readStrictJson(mainBotConfigPath);
      if (!config || typeof config !== "object") {
        return [];
      }
      if (typeof config.adminFilePath === "string" && config.adminFilePath.trim()) {
        targetAdminPath = path.resolve(resolvedRoot, config.adminFilePath.trim());
      }
    }

    if (!targetAdminPath) {
      targetAdminPath = path.join(resolvedRoot, "assets", "data", "list_admin.json");
    }

    if (!fs.existsSync(targetAdminPath)) {
      return [];
    }

    const parsed = readStrictJson(targetAdminPath);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((id) => String(id).trim()).filter(Boolean);
  });
}

export function readHighCommandAdmins(root = getProjectRoot()) {
  const resolvedRoot = root || getProjectRoot();
  return withHotCache(`highCmdAdmins:${resolvedRoot}`, () => {
    const highCommandPath = path.join(resolvedRoot, "assets", "data", "list_admin_high_command.json");
    if (!fs.existsSync(highCommandPath)) return [];
    const parsed = readCachedJson(highCommandPath, null);
    return Array.isArray(parsed) ? parsed.map((id) => String(id).trim()).filter(Boolean) : [];
  });
}

export function isMainBotAdmin(userId, root = getProjectRoot()) {
  if (!userId) return false;
  const normalizedId = String(userId).trim();
  if (!normalizedId) return false;
  const mainAdmins = readMainBotAdmins(root);
  return mainAdmins.includes(normalizedId);
}

const logDir = runtimeContext.logsDir;
export const resourceDir = runtimeContext.resourcesDir;
export const tempDir = runtimeContext.tempDir;
export const dataGifPath = path.join(runtimeContext.resourcesDir, "gif");

const logManagerBotFilePath = runtimeContext.botManagerLogPath;
const loggingMessageFilePath = runtimeContext.messageLogPath;
const loggingMessageJsonPath = runtimeContext.messageJsonPath;

export const resourceDirMain = path.join(projectRoot, "assets", "resources");
export const BACKGROUND_RESOURCE_PATH_TEMP = path.join(resourceDirMain, "background");

export async function ensureLogFiles() {
  try {
    ensureRuntimeDirectories(runtimeContext);
    await mkdir(logDir, { recursive: true });
    await mkdir(resourceDir, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    await mkdir(dataGifPath, { recursive: true });
    if (!fs.existsSync(logManagerBotFilePath)) {
      fs.writeFileSync(logManagerBotFilePath, "");
    }
    if (process.env.LOG_CHAT_MESSAGES === "true" && !fs.existsSync(loggingMessageFilePath)) {
      fs.writeFileSync(loggingMessageFilePath, "");
    }
    if (!fs.existsSync(loggingMessageJsonPath)) {
      fs.writeFileSync(loggingMessageJsonPath, "{}");
    }
  } catch (err) {
    console.error("Lỗi khi tạo thư mục hoặc file log:", err);
  }
}

export function mkdirRecursive(dirPath) {
  if (fs.existsSync(dirPath)) return;

  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

const MAX_ROUTINE_LOG_BYTES = 10 * 1024 * 1024;
const _logBuffers = new Map();
let _logFlushTimer = null;

function rotateOversizedLogSync(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size >= MAX_ROUTINE_LOG_BYTES) {
      const backupPath = `${filePath}.1`;
      try {
        fs.copyFileSync(filePath, backupPath);
      } catch {}
      fs.truncateSync(filePath, 0);
    }
  } catch {}
}

async function rotateOversizedLogAsync(filePath) {
  try {
    const st = await fs.promises.stat(filePath);
    if (st.size >= MAX_ROUTINE_LOG_BYTES) {
      const backupPath = `${filePath}.1`;
      try {
        await fs.promises.copyFile(filePath, backupPath);
      } catch {}
      await fs.promises.truncate(filePath, 0);
    }
  } catch {}
}

function flushLogBuffersSync() {
  if (_logFlushTimer) {
    clearTimeout(_logFlushTimer);
    _logFlushTimer = null;
  }
  for (const [filePath, chunks] of _logBuffers.entries()) {
    if (!chunks || chunks.length === 0) continue;
    const payload = chunks.join("");
    chunks.length = 0;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotateOversizedLogSync(filePath);
      fs.appendFileSync(filePath, payload, "utf8");
    } catch {}
  }
}

async function flushLogBuffersAsync() {
  _logFlushTimer = null;
  for (const [filePath, chunks] of _logBuffers.entries()) {
    if (!chunks || chunks.length === 0) continue;
    const payload = chunks.join("");
    chunks.length = 0;
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await rotateOversizedLogAsync(filePath);
      await fs.promises.appendFile(filePath, payload, "utf8");
    } catch {}
  }
}

function enqueueLogWrite(filePath, text) {
  if (!filePath || !text) return;
  let chunks = _logBuffers.get(filePath);
  if (!chunks) {
    chunks = [];
    _logBuffers.set(filePath, chunks);
  }
  chunks.push(text);
  if (chunks.length >= 100) {
    flushLogBuffersAsync().catch(() => {});
  } else if (!_logFlushTimer) {
    _logFlushTimer = setTimeout(() => {
      flushLogBuffersAsync().catch(() => {});
    }, 2000);
    _logFlushTimer.unref?.();
  }
}

process.once("beforeExit", flushLogBuffersSync);
process.once("exit", flushLogBuffersSync);

export function logManagerBot(message) {
  const timestamp = getTimeToString(getTimeNow());
  const logEntry = `${timestamp} - ${message}\n`;
  enqueueLogWrite(logManagerBotFilePath, logEntry);
}

export function logMessageToFile(data, type = "message") {
  // Tắt ghi nội dung chat thường ra đĩa để chống mòn SSD và phình log; chỉ bật khi LOG_CHAT_MESSAGES=true
  if (process.env.LOG_CHAT_MESSAGES !== "true") return;
  const logData = `${data}\n\n`;
  enqueueLogWrite(loggingMessageFilePath, logData);
}

export {
  getCanonicalGroupSettingsPath,
  loadCanonicalGroupSettings,
  getGroupSettings,
  readGroupSettings,
  writeGroupSettings,
  updateGroupSettings,
  clearGroupSettingsCache,
  flushGroupSettingsSync,
  flushAllGroupSettingsSync,
} from "./group-settings-store.js";

export function readCommandConfig() {
  try {
    ensureRuntimeDirectories(runtimeContext);
    seedRuntimeFiles(runtimeContext);
    if (!fs.existsSync(commandFilePath)) {
      atomicWriteSync(commandFilePath, JSON.stringify(createCommandSeedStub(), null, 2));
    }
    const data = fs.readFileSync(commandFilePath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(data);
    const runtimeFile = Array.isArray(parsed)
      ? { prefix: "!", commands: parsed }
      : parsed && typeof parsed === "object"
        ? parsed
        : createCommandSeedStub();
    const catalog = loadDefaultCommandConfig();
    return composeRuntimeCommandConfig({ catalog, runtimeFile });
  } catch (error) {
    console.error("Lỗi khi đọc file command.json:", error?.code || error?.message || error);
    return loadDefaultCommandConfig();
  }
}

let _cachedCommandConfig = null;

export function getCommandConfig() {
  if (!_cachedCommandConfig) {
    _cachedCommandConfig = readCommandConfig();
  }
  return _cachedCommandConfig;
}

export function reloadCommandConfig() {
  _cachedCommandConfig = readCommandConfig();
  return _cachedCommandConfig;
}

export function writeCommandConfig(config) {
  try {
    _cachedCommandConfig = config;
    const stateOnly = toStateOnlyCommandConfig(config, { catalog: loadDefaultCommandConfig() });
    atomicWriteSync(commandFilePath, JSON.stringify(stateOnly, null, 2));
  } catch (error) {
    console.error("Lỗi khi ghi file command.json:", error);
  }
}

const WEB_CONFIG_PATH = path.join(projectRoot, botInfo.WEB_CONFIG_PATH || "assets/web-config/web-config.json");
export function readWebConfig() {
  try {
    return readCachedJson(WEB_CONFIG_PATH, {});
  } catch (error) {
    console.error("Lỗi khi đọc file web-config.json:", error);
    return {};
  }
}

export function writeWebConfig(config) {
  atomicWriteSync(WEB_CONFIG_PATH, JSON.stringify(config, null, 2));
}

const MANAGER_FILE_PATH = path.join(projectRoot, botInfo.MANAGER_FILE_PATH || "assets/json-data/manager-bot.json");

export function readManagerFile() {
  const parsed = readCachedJson(MANAGER_FILE_PATH, null);
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function writeManagerFile(data) {
  atomicWriteSync(MANAGER_FILE_PATH, JSON.stringify(data, null, 2));
}

export function pushMessageToWebLog(io, nameType, senderName, content, avtGroup) {
  if (io) {
    const messageData = { nameType, senderName, content, avtGroup };
    io.emit("newMessage", messageData);
  }
}

const PROPHYLACTIC_CONFIG_PATH = path.join(projectRoot, botInfo.PROPHYLACTIC_CONFIG_PATH || "assets/json-data/prophylactic.json");
const DEFAULT_PROPHYLACTIC = () => ({
  prophylacticUploadAttachment: {
    enable: false,
    lastBlocked: "",
    numRequestZalo: 0,
  },
});

export function readProphylacticConfig() {
  const parsed = readCachedJson(PROPHYLACTIC_CONFIG_PATH, null);
  return parsed && typeof parsed === "object" ? parsed : DEFAULT_PROPHYLACTIC();
}

export function writeProphylacticConfig(data) {
  try {
    atomicWriteSync(PROPHYLACTIC_CONFIG_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Lỗi khi ghi file prophylactic.json:", error);
  }
}
