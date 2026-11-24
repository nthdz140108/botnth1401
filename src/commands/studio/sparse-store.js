import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const STUDIO_GLOBAL_DIR = path.join("assets", "json-data", "command-studio");
export const STUDIO_GLOBAL_FILE = path.join(STUDIO_GLOBAL_DIR, "global.json");
export const STUDIO_DRAFTS_FILE = path.join(STUDIO_GLOBAL_DIR, "drafts.json");
export const STUDIO_HISTORY_FILE = path.join(STUDIO_GLOBAL_DIR, "history.json");
export const BOT_STUDIO_DATA_FILE = path.join("data", "command-studio.json");
export const GROUP_OVERRIDES_DIR = path.join("data", "command-group-overrides");

export function isValidBotId(botId) {
  return /^[a-zA-Z0-9_-]+$/.test(String(botId || ""));
}

export function isValidThreadId(threadId) {
  return /^[a-zA-Z0-9_-]+$/.test(String(threadId || ""));
}

export function globalStudioPath(root) {
  return path.join(root, STUDIO_GLOBAL_FILE);
}

export function draftsPath(root) {
  return path.join(root, STUDIO_DRAFTS_FILE);
}

export function historyPath(root) {
  return path.join(root, STUDIO_HISTORY_FILE);
}

export function botStudioPath(root, botId) {
  if (!isValidBotId(botId)) throw storeError(400, "INVALID_BOT_ID", "botId must match [a-zA-Z0-9_-]");
  return path.join(root, "mybot", "instances", botId, BOT_STUDIO_DATA_FILE);
}

export function groupOverridePath(root, botId, threadId) {
  if (!isValidBotId(botId)) throw storeError(400, "INVALID_BOT_ID", "botId must match [a-zA-Z0-9_-]");
  if (!isValidThreadId(threadId)) throw storeError(400, "INVALID_THREAD_ID", "threadId must match [a-zA-Z0-9_-]");
  return path.join(root, "mybot", "instances", botId, GROUP_OVERRIDES_DIR, `${threadId}.json`);
}

function storeError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export async function readLayerDoc(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw storeError(500, "STUDIO_LAYER_MALFORMED", `Studio layer is malformed: ${filePath}`);
    }
    return normalizeLayer(parsed);
  } catch (error) {
    if (error.code === "ENOENT") return { meta: freshMeta(), commands: {} };
    throw error;
  }
}

function normalizeLayer(parsed) {
  const { _meta, ...rest } = parsed;
  const inlineMeta = rest.meta && typeof rest.meta === "object" ? rest.meta : null;
  delete rest.meta;
  return {
    meta: { ...freshMeta(), ...(_meta || {}), ...(inlineMeta || {}) },
    commands: rest.commands && typeof rest.commands === "object" ? rest.commands : rest,
  };
}

function freshMeta() {
  return { revision: 0, updatedAt: null };
}

export async function atomicWriteJson(filePath, value, { backupDir } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let backup = null;
  try {
    const previous = await fsp.readFile(filePath, "utf8");
    backup = await writeBackup(filePath, previous, backupDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = await fsp.mkdtemp(path.join(path.dirname(filePath), ".tmp-"));
  const tempFile = path.join(temp, path.basename(filePath));
  await fsp.writeFile(tempFile, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tempFile, filePath);
  await fsp.rm(temp, { recursive: true, force: true });
  return backup;
}

async function writeBackup(filePath, content, backupDir) {
  const target = backupDir || path.join(process.cwd(), "logs", "dashboard-backups");
  await fsp.mkdir(target, { recursive: true });
  const base = path.basename(filePath).replace(/\.json$/, "");
  const backupFile = path.join(target, `${base}.${Date.now()}.bak`);
  await fsp.writeFile(backupFile, content, "utf8");
  return backupFile;
}

export function bumpRevision(doc) {
  doc.meta = { ...(doc.meta || freshMeta()), revision: Number(doc.meta?.revision || 0) + 1, updatedAt: new Date().toISOString() };
  return doc.meta;
}

export function layerRevision(doc) {
  return Number(doc.meta?.revision || 0);
}

export async function appendHistory(root, entry) {
  const file = historyPath(root);
  let entries = [];
  try {
    entries = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch {}
  entries.push({ at: new Date().toISOString(), ...entry });
  while (entries.length > 300) entries.shift();
  await atomicWriteJson(file, entries);
  return entries;
}

export async function readHistory(root, limit = 50) {
  try {
    const entries = JSON.parse(await fsp.readFile(historyPath(root), "utf8"));
    return Array.isArray(entries) ? entries.slice(-limit).reverse() : [];
  } catch {
    return [];
  }
}

const mtimeCache = new Map();

export function readJsonCached(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    mtimeCache.delete(filePath);
    return undefined;
  }
  const cached = mtimeCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    mtimeCache.set(filePath, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return undefined;
  }
}

export function invalidateStudioCache(filePath) {
  if (filePath) mtimeCache.delete(filePath);
  else mtimeCache.clear();
}
