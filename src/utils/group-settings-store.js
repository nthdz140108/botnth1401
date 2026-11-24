import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { getProjectRoot, getBotInfoSync } from "./env.js";
import {
  createBotRuntimeContext,
  ensureRuntimeDirectories,
} from "./bot-runtime-context.js";

const groupSettingsCache = new Map();
const groupSettingsMeta = new Map();
const pendingDiskFlushes = new Map();
const SOURCE_REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEBOUNCE_WRITE_MS = Number(process.env.GROUP_SETTINGS_DEBOUNCE_MS || 1000);
const EXTERNAL_CHECK_TTL_MS = 5000;

function getActiveContext() {
  const currentInfo = getBotInfoSync() || {};
  return createBotRuntimeContext(currentInfo);
}

/**
 * Chỉ bật khi tiến trình đang chạy test (node --test / SKIP_ENV_VALIDATION).
 * Bot production không bao giờ mang các biến này nên guard vô hình lúc chạy thật.
 */
function isTestProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT
    || process.env.SKIP_ENV_VALIDATION === "1"
    || process.env.NODE_ENV === "test"
  );
}

/**
 * Guard dữ liệu runtime: dưới node --test, mọi ghi vào group-settings NẰM TRONG
 * workspace phải fail ngay lập tức để test không bao giờ phá cấu hình nhóm thật.
 * Các store trong thư mục tạm (fixture) vẫn được ghi bình thường.
 */
export function assertSafeGroupSettingsWritePath(filePath) {
  if (!isTestProcess() || !filePath) return;
  const target = path.resolve(String(filePath));
  const tmpDir = path.resolve(os.tmpdir());
  if (target.startsWith(tmpDir)) {
    return;
  }
  const rel = path.relative(SOURCE_REPO_ROOT, target);
  const insideProject = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (insideProject) {
    throw new Error(
      `[group-settings-guard] test process attempted to write real group settings inside the workspace: ${target}`
    );
  }
}

export function getCanonicalGroupSettingsPath(customContext = null) {
  const ctx = customContext || getActiveContext();
  const rawPath = ctx.groupSettingsPath || path.join(ctx.dataDir || "", "group-settings.json");
  const projectRoot = getProjectRoot();
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(projectRoot, rawPath);
}

function readDiskSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function atomicWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = path.join(
    dir,
    `.tmp-group-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, content, "utf8");

  let retries = 5;
  while (retries > 0) {
    try {
      fs.renameSync(tempPath, filePath);
      break;
    } catch {
      retries--;
      if (retries === 0) {
        try { fs.unlinkSync(tempPath); } catch {}
        try {
          fs.writeFileSync(filePath, content, "utf8");
        } catch (fallbackErr) {
          console.error(`[group-settings-store] Fallback write error for ${filePath}:`, fallbackErr.message);
        }
        break;
      }
    }
  }
  groupSettingsMeta.set(filePath, {
    sig: readDiskSignature(filePath),
    checkedAt: Date.now(),
  });
}

async function atomicWriteJsonAsync(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.tmp-group-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  const content = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(tempPath, content, "utf8");
  try {
    await fs.promises.rename(tempPath, filePath);
  } catch {
    try { await fs.promises.unlink(tempPath); } catch {}
    await fs.promises.writeFile(filePath, content, "utf8");
  }
  groupSettingsMeta.set(filePath, {
    sig: readDiskSignature(filePath),
    checkedAt: Date.now(),
  });
}

export function flushAllGroupSettingsSync() {
  for (const [canonicalPath, pending] of pendingDiskFlushes.entries()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    try {
      atomicWriteJsonSync(canonicalPath, pending.settings);
    } catch (err) {
      console.error(`[group-settings-store] Flush sync error for ${canonicalPath}:`, err.message);
    }
    pendingDiskFlushes.delete(canonicalPath);
  }
}

export function flushGroupSettingsSync(customContext = null) {
  if (!customContext) {
    flushAllGroupSettingsSync();
    return;
  }
  const canonicalPath = getCanonicalGroupSettingsPath(customContext);
  const pending = pendingDiskFlushes.get(canonicalPath);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingDiskFlushes.delete(canonicalPath);
    atomicWriteJsonSync(canonicalPath, pending.settings);
  } else if (groupSettingsCache.has(canonicalPath)) {
    assertSafeGroupSettingsWritePath(canonicalPath);
    atomicWriteJsonSync(canonicalPath, groupSettingsCache.get(canonicalPath));
  }
}

process.once("beforeExit", flushAllGroupSettingsSync);
process.once("exit", flushAllGroupSettingsSync);

export function loadCanonicalGroupSettings(customContext = null) {
  const ctx = customContext || getActiveContext();
  ensureRuntimeDirectories(ctx);

  const canonicalPath = getCanonicalGroupSettingsPath(ctx);
  let settings = {};
  let loaded = false;

  if (fs.existsSync(canonicalPath)) {
    try {
      const raw = fs.readFileSync(canonicalPath, "utf8").replace(/^\uFEFF/, "");
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          settings = parsed;
          loaded = true;
        }
      } else {
        settings = {};
        loaded = true;
      }
    } catch (parseErr) {
      console.warn(`[WARN] Lỗi parse canonical groupSettings từ ${canonicalPath}:`, parseErr.message);
    }
  }

  // If canonical file did not exist on disk, check candidate sources for initial seed
  if (!loaded && !fs.existsSync(canonicalPath)) {
    const projectRoot = getProjectRoot();
    const candidates = [
      path.join(projectRoot, "assets", "data", "group_settings.json"),
      path.join(projectRoot, "groupSettings.json"),
      path.join(projectRoot, "mybot", "instances", "admin", "data", "group-settings.json"),
      path.join(projectRoot, "mybot", "settings", `groupSettings-${ctx.uid}.json`),
    ];

    for (const candidate of candidates) {
      if (path.resolve(candidate) !== canonicalPath && fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, "utf8").replace(/^\uFEFF/, "");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
            settings = { ...parsed, ...settings };
            break;
          }
        } catch {}
      }
    }

    try {
      assertSafeGroupSettingsWritePath(canonicalPath);
      atomicWriteJsonSync(canonicalPath, settings);
    } catch (writeErr) {
      console.error(`[group-settings-store] Lỗi ghi khởi tạo canonical settings ${canonicalPath}:`, writeErr.message);
    }
  } else {
    groupSettingsMeta.set(canonicalPath, {
      sig: readDiskSignature(canonicalPath),
      checkedAt: Date.now(),
    });
  }

  groupSettingsCache.set(canonicalPath, settings);
  return settings;
}

export function getGroupSettings(customContext = null) {
  const canonicalPath = getCanonicalGroupSettingsPath(customContext);
  if (groupSettingsCache.has(canonicalPath)) {
    // If no pending write in this process, refresh if external process (Dashboard) modified file
    if (!pendingDiskFlushes.has(canonicalPath)) {
      const meta = groupSettingsMeta.get(canonicalPath);
      const now = Date.now();
      if (!meta || now - meta.checkedAt > EXTERNAL_CHECK_TTL_MS) {
        const currentSig = readDiskSignature(canonicalPath);
        if (meta && currentSig && currentSig !== meta.sig) {
          return loadCanonicalGroupSettings(customContext);
        }
        groupSettingsMeta.set(canonicalPath, { sig: currentSig, checkedAt: now });
      }
    }
    return groupSettingsCache.get(canonicalPath);
  }
  return loadCanonicalGroupSettings(customContext);
}

export function readGroupSettings(customContext = null) {
  return getGroupSettings(customContext);
}

export function writeGroupSettings(settings, customContext = null, { immediate = false } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return;
  }
  const ctx = customContext || getActiveContext();
  const canonicalPath = getCanonicalGroupSettingsPath(ctx);

  // Hard-fail khi node --test cố ghi vào store thật của workspace
  assertSafeGroupSettingsWritePath(canonicalPath);

  groupSettingsCache.set(canonicalPath, settings);

  // Trong môi trường test hoặc yêu cầu immediate: ghi đồng bộ ngay để kiểm tra file tức thì
  if (immediate || isTestProcess() || DEBOUNCE_WRITE_MS <= 0) {
    const existingPending = pendingDiskFlushes.get(canonicalPath);
    if (existingPending?.timer) {
      clearTimeout(existingPending.timer);
    }
    pendingDiskFlushes.delete(canonicalPath);
    try {
      atomicWriteJsonSync(canonicalPath, settings);
    } catch (error) {
      console.error("Lỗi khi ghi file group-settings:", error);
    }
    return;
  }

  // Production: cập nhật RAM 0ms + gom ghi nền bất đồng bộ (debounce 1s)
  const existing = pendingDiskFlushes.get(canonicalPath);
  if (existing) {
    existing.settings = settings;
    return;
  }

  const entry = {
    settings,
    timer: null,
  };
  entry.timer = setTimeout(() => {
    const latest = pendingDiskFlushes.get(canonicalPath);
    pendingDiskFlushes.delete(canonicalPath);
    const toWrite = latest ? latest.settings : settings;
    atomicWriteJsonAsync(canonicalPath, toWrite).catch((err) => {
      console.error("Lỗi khi ghi nền file group-settings:", err?.message || err);
    });
  }, DEBOUNCE_WRITE_MS);
  entry.timer.unref?.();
  pendingDiskFlushes.set(canonicalPath, entry);
}

export function updateGroupSettings(updaterFn, customContext = null) {
  const current = getGroupSettings(customContext);
  const result = typeof updaterFn === "function" ? updaterFn(current) : current;
  const nextSettings = (result && typeof result === "object" && !Array.isArray(result)) ? result : current;
  writeGroupSettings(nextSettings, customContext);
  return nextSettings;
}

export function clearGroupSettingsCache(customContext = null) {
  if (customContext) {
    const canonicalPath = getCanonicalGroupSettingsPath(customContext);
    const pending = pendingDiskFlushes.get(canonicalPath);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingDiskFlushes.delete(canonicalPath);
    groupSettingsCache.delete(canonicalPath);
    groupSettingsMeta.delete(canonicalPath);
  } else {
    for (const pending of pendingDiskFlushes.values()) {
      if (pending?.timer) clearTimeout(pending.timer);
    }
    pendingDiskFlushes.clear();
    groupSettingsCache.clear();
    groupSettingsMeta.clear();
  }
}
