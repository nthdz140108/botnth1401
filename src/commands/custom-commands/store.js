import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { commandRegistry } from "../command-registry.js";
import { mediaExtFor, mediaKindToMime } from "./media-constants.js";

const require = createRequire(import.meta.url);

let properLockfile = null;
try {
  properLockfile = require("proper-lockfile");
} catch {
  // fallback: no-op lock (used in tests without proper-lockfile)
}

export const CUSTOM_COMMAND_PAGE_SIZE = 16;
export const COMMANDS_DIR_NAME = "custom-commands";
export const MANIFEST_FILE_NAME = "commands.json";
export const MEDIA_DIR_NAME = "media";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export const RESERVED_SUBCOMMANDS = Object.freeze(["list", "remove"]);
export const CUSTOM_COMMAND_COUNTDOWN = 30;

export function customCommandsRoot(root = process.env.PROJECT_ROOT || process.cwd()) {
  return path.resolve(root, "mybot", COMMANDS_DIR_NAME);
}

export function customCommandsManifestPath(root) {
  return path.join(customCommandsRoot(root), MANIFEST_FILE_NAME);
}

export function customCommandsMediaDir(root) {
  return path.join(customCommandsRoot(root), MEDIA_DIR_NAME);
}

export function customMediaPath(root, id, ext) {
  return path.join(customCommandsMediaDir(root), `${id}.${String(ext).replace(/^\./, "").toLowerCase()}`);
}

export function normalizeCommandName(input) {
  const normalized = String(input ?? "").normalize("NFKC").trim().toLowerCase();
  return normalized.replace(/\s+/g, " ");
}

export function normalizeName(value) {
  return normalizeCommandName(value).split(" ")[0];
}

export function isValidCustomName(name) {
  if (typeof name !== "string") return false;
  const trimmed = normalizeCommandName(name);
  if (!trimmed || trimmed.includes(" ")) return false;
  if (!/^\p{L}/u.test(trimmed)) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(trimmed);
}

export function isReservedCustomName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return true;
  if (RESERVED_SUBCOMMANDS.includes(normalized)) return true;
  const nameSet = buildSystemCommandNameSet();
  return nameSet.has(normalized);
}

let cachedSystemNameSet = null;
export function buildSystemCommandNameSet(registry = commandRegistry) {
  if (registry !== commandRegistry && cachedSystemNameSet) cachedSystemNameSet = null;
  if (cachedSystemNameSet) return cachedSystemNameSet;
  const names = new Set();
  for (const definition of registry?.definitions ?? []) {
    names.add(normalizeName(definition.name));
    for (const alias of definition.aliases ?? []) {
      names.add(normalizeName(alias));
    }
  }
  cachedSystemNameSet = names;
  return names;
}

export function readManifest(root) {
  const manifestPath = customCommandsManifestPath(root);
  try {
    if (!fs.existsSync(manifestPath)) return { commands: [], nextId: 0 };
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object") return { commands: [], nextId: 0 };
    const commands = Array.isArray(parsed.commands) ? parsed.commands.filter(Boolean) : [];
    const nextId = Number.isFinite(parsed.nextId)
      ? parsed.nextId
      : commands.reduce((max, command) => Math.max(max, Number(command.id) || 0), 0) + 1;
    return { commands, nextId };
  } catch {
    return { commands: [], nextId: 0 };
  }
}

export function writeManifest(root, manifest) {
  const manifestPath = customCommandsManifestPath(root);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, manifestPath);
}

export async function withManifestLock(root, callback) {
  const manifestPath = customCommandsManifestPath(root);
  const lockTarget = path.dirname(manifestPath);
  let releaseLock = null;
  if (properLockfile && fs.existsSync(lockTarget)) {
    try {
      releaseLock = await properLockfile.lock(manifestPath, {
        retries: 10,
        minTimeout: 50,
        maxTimeout: 200,
      });
    } catch {
      // proceed without lock (best-effort)
    }
  }
  try {
    const manifest = readManifest(root);
    const result = await callback(manifest);
    return result;
  } finally {
    if (releaseLock && typeof releaseLock === "function") {
      try {
        await releaseLock();
      } catch {
        // ignore release errors
      }
    }
  }
}

export function cleanupOrphanMedia(root, manifest = readManifest(root)) {
  const mediaDir = customCommandsMediaDir(root);
  if (!fs.existsSync(mediaDir)) return [];
  const kept = new Set(
    (manifest.commands || [])
      .map((command) => (command.media?.path ? path.basename(command.media.path) : null))
      .filter(Boolean),
  );
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(mediaDir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (kept.has(entry)) continue;
    const fullPath = path.join(mediaDir, entry);
    try {
      fs.unlinkSync(fullPath);
      removed.push(entry);
    } catch {
      // Windows may hold the file; clean on next mutation.
    }
  }
  return removed;
}

export function listCustomCommands({ page = 1, pageSize = CUSTOM_COMMAND_PAGE_SIZE, root }) {
  const manifest = readManifest(root);
  const systemNames = buildSystemCommandNameSet();
  const all = (manifest.commands || [])
    .slice()
    .sort((left, right) => (Number(left.id) || 0) - (Number(right.id) || 0))
    .map((command) => ({ ...command, conflict: systemNames.has(normalizeName(command.name)) }));

  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const commands = all.slice(startIndex, startIndex + pageSize);

  return {
    commands,
    page: safePage,
    totalPages,
    total,
    pageSize,
    hasNext: safePage < totalPages,
    hasPrev: safePage > 1,
  };
}

export function findCustomCommand(name, root) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const manifest = readManifest(root);
  const systemNames = buildSystemCommandNameSet();
  const command = (manifest.commands || []).find(
    (entry) => normalizeName(entry.name) === normalized,
  );
  if (!command) return null;
  return { ...command, conflict: systemNames.has(normalized) };
}

export function createCustomCommand({ name, text, media = null, createdBy, root }) {
  if (!isValidCustomName(name)) {
    const error = new Error(`Tên lệnh không hợp lệ: ${String(name)}`);
    error.code = "INVALID_NAME";
    throw error;
  }
  if (isReservedCustomName(name)) {
    const error = new Error(`Tên lệnh "${normalizeName(name)}" trùng với lệnh hệ thống hoặc tên dành riêng.`);
    error.code = "RESERVED_NAME";
    throw error;
  }

  return withManifestLock(root, (manifest) => {
    const normalized = normalizeName(name);
    const duplicate = (manifest.commands || []).some(
      (entry) => normalizeName(entry.name) === normalized,
    );
    if (duplicate) {
      const error = new Error(`Lệnh "${normalized}" đã tồn tại.`);
      error.code = "DUPLICATE_COMMAND";
      throw error;
    }

    const id = Number(manifest.nextId) || 1;
    let resolvedMedia = null;
    let movedTempPath = null;

    if (media?.tempPath && media?.kind) {
      const stored = moveMediaFile(root, id, media.tempPath, media.kind);
      resolvedMedia = stored.media;
      movedTempPath = stored.originalTempPath;
    } else if (media && typeof media === "object") {
      resolvedMedia = media;
    }

    const command = {
      id,
      name: normalizeCommandName(name),
      normalizedName: normalized,
      text: String(text ?? ""),
      media: resolvedMedia,
      createdBy: String(createdBy ?? ""),
      createdAt: new Date().toISOString(),
    };

    const nextManifest = {
      commands: [...(manifest.commands || []), command],
      nextId: id + 1,
    };
    writeManifest(root, nextManifest);
    return { ...command, conflict: false, movedTempPath };
  });
}

export function moveMediaFile(root, id, tempFilePath, kind) {
  const mediaDir = customCommandsMediaDir(root);
  fs.mkdirSync(mediaDir, { recursive: true });
  const ext = mediaExtFor(kind);
  const finalPath = customMediaPath(root, id, ext);
  fs.renameSync(tempFilePath, finalPath);
  const stat = fs.statSync(finalPath);
  return {
    originalTempPath: tempFilePath,
    media: {
      path: finalPath,
      type: mediaKindToMime(kind),
      ext,
      size: stat.size,
      kind,
    },
  };
}

export async function removeCustomCommand(nameOrId, root) {
  const key = normalizeName(nameOrId);
  const removed = await withManifestLock(root, (manifest) => {
    const index = (manifest.commands || []).findIndex((entry) => {
      if (key && key === normalizeName(entry.name)) return true;
      return Number(nameOrId) > 0 && Number(entry.id) === Number(nameOrId);
    });
    if (index === -1) return null;

    const nextCommands = (manifest.commands || []).slice();
    const [removedCommand] = nextCommands.splice(index, 1);
    const nextManifest = {
      commands: nextCommands,
      nextId: Number(manifest.nextId) || removedCommand.id + 1,
    };
    writeManifest(root, nextManifest);
    return removedCommand;
  });

  if (removed) {
    // Remove media after the manifest commit; orphan cleanup handles Windows locks.
    tryRemoveMediaFromRecord(removed, root);
    cleanupOrphanMedia(root);
  }
  return removed;
}

function tryRemoveMediaFromRecord(command, root) {
  const media = command?.media;
  if (!media?.path) return;
  try {
    if (fs.existsSync(media.path)) fs.unlinkSync(media.path);
  } catch {
    // Opportunistic; will be cleaned by cleanupOrphanMedia on next mutation.
  }
}

export function markConflictInList(commands) {
  const systemNames = buildSystemCommandNameSet();
  return (commands || []).map((command) => ({
    ...command,
    conflict: systemNames.has(normalizeName(command.name)),
  }));
}

export function isCustomNameAllowedBySystem(name) {
  return !isReservedCustomName(name) && isValidCustomName(name);
}
