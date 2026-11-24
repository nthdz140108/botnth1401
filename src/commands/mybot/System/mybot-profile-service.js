import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./json-state.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { DEFAULT_STYLE, normalizeStyle, validateStyle } from "./mybot-style.js";

export function getProfileDir(botId, root = process.cwd()) {
  return path.join(root, "mybot", "instances", String(botId), "data");
}

export function getProfilePath(botId, root = process.cwd()) {
  return path.join(getProfileDir(botId, root), "profile.json");
}

export function createDefaultProfile(botId, overrides = {}) {
  const bId = String(botId).trim();
  const ownerUid = overrides.ownerUid !== undefined && overrides.ownerUid !== null ? String(overrides.ownerUid).trim() : null;
  const ownerUsername = overrides.ownerUsername !== undefined && overrides.ownerUsername !== null ? String(overrides.ownerUsername).trim() : null;
  const ownerName = overrides.ownerName || overrides.createdBy || "User";
  const nameServer = overrides.nameServer || overrides.displayName || "Thanh Hung";
  const description = overrides.description || "";
  const botInfo = overrides.botInfo || "";
  const typePlatform = overrides.typePlatform || "zalo";

  const style = normalizeStyle(overrides.style || DEFAULT_STYLE);
  const trialStatus = overrides.trialStatus || "pending";
  const expiryAt = overrides.expiryAt || null;
  const enabled = overrides.enabled !== false;

  const adminIdentitySeeds = overrides.adminIdentitySeeds && typeof overrides.adminIdentitySeeds === "object"
    ? {
        botAdminUsername: overrides.adminIdentitySeeds.botAdminUsername || null,
        ownerUsername: overrides.adminIdentitySeeds.ownerUsername || null,
        selfUsername: overrides.adminIdentitySeeds.selfUsername || null,
      }
    : null;

  const identityPending = overrides.identityPending !== undefined ? Boolean(overrides.identityPending) : false;
  const identityPendingReason = overrides.identityPendingReason || null;
  const resolvedChildAdminUids = Array.isArray(overrides.resolvedChildAdminUids) ? overrides.resolvedChildAdminUids : null;
  const adminIdentityResolvedAt = overrides.adminIdentityResolvedAt || null;

  return {
    botId: bId,
    ownerUid,
    ownerUsername,
    ownerName,
    nameServer,
    description,
    botInfo,
    typePlatform,
    style,
    trialStatus,
    expiryAt,
    enabled,
    adminIdentitySeeds,
    identityPending,
    identityPendingReason,
    resolvedChildAdminUids,
    adminIdentityResolvedAt,
    revision: Number(overrides.revision) || 1,
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  };
}

export function validateProfile(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    errors.push("Profile data must be an object");
    return { ok: false, errors };
  }

  if (!data.botId || typeof data.botId !== "string") {
    errors.push("botId is required and must be a string");
  }

  if (data.ownerUid !== undefined && data.ownerUid !== null && typeof data.ownerUid !== "string") {
    errors.push("ownerUid must be a string or null");
  }

  if (data.ownerUsername !== undefined && data.ownerUsername !== null && typeof data.ownerUsername !== "string") {
    errors.push("ownerUsername must be a string or null");
  }

  if (data.adminIdentitySeeds !== undefined && data.adminIdentitySeeds !== null && typeof data.adminIdentitySeeds !== "object") {
    errors.push("adminIdentitySeeds must be an object or null");
  }

  if (data.identityPending !== undefined && typeof data.identityPending !== "boolean") {
    errors.push("identityPending must be a boolean");
  }

  if (data.identityPendingReason !== undefined && data.identityPendingReason !== null && typeof data.identityPendingReason !== "string") {
    errors.push("identityPendingReason must be a string or null");
  }

  if (data.resolvedChildAdminUids !== undefined && data.resolvedChildAdminUids !== null && !Array.isArray(data.resolvedChildAdminUids)) {
    errors.push("resolvedChildAdminUids must be an array or null");
  }

  if (data.ownerName !== undefined) {
    if (typeof data.ownerName !== "string" || data.ownerName.length > 80) {
      errors.push("ownerName must be a string <= 80 characters");
    }
  }

  if (data.nameServer !== undefined) {
    if (typeof data.nameServer !== "string" || !data.nameServer.trim() || data.nameServer.length > 80) {
      errors.push("nameServer must be a non-empty string <= 80 characters");
    }
  }

  if (data.description !== undefined) {
    if (typeof data.description !== "string" || data.description.length > 500) {
      errors.push("description must be a string <= 500 characters");
    }
  }

  if (data.botInfo !== undefined) {
    if (typeof data.botInfo !== "string" || data.botInfo.length > 500) {
      errors.push("botInfo must be a string <= 500 characters");
    }
  }

  if (data.typePlatform !== undefined) {
    if (typeof data.typePlatform !== "string" || data.typePlatform.length > 40) {
      errors.push("typePlatform must be a string <= 40 characters");
    }
  }

  if (data.style !== undefined) {
    const styleVal = validateStyle(data.style);
    if (!styleVal.ok) {
      errors.push(...styleVal.errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function getProfile(botId, { root = process.cwd() } = {}) {
  const bId = String(botId).trim();
  const filePath = getProfilePath(bId, root);

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const profile = JSON.parse(raw);
      return createDefaultProfile(bId, profile);
    }
  } catch {}

  // Fallback: migrate from registry or legacy config files (pure read without disk mutation)
  const registryPath = path.join(root, "mybot", "mybots.json");
  const registry = fs.existsSync(registryPath) ? loadMyBotsRegistry(registryPath) : {};
  const regEntry = registry[bId] || {};

  let legacyNameServer = regEntry.displayName || regEntry.nameServer;
  let legacyDesc = regEntry.description;

  // Try reading database.json for nameServer
  try {
    const dbJsonPath = path.join(getProfileDir(bId, root), "database.json");
    if (fs.existsSync(dbJsonPath)) {
      const dbConfig = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
      if (dbConfig.nameServer) legacyNameServer = legacyNameServer || dbConfig.nameServer;
    }
  } catch {}

  return createDefaultProfile(bId, {
    ownerUid: regEntry.ownerUid || regEntry.createdByUid || null,
    ownerUsername: regEntry.ownerUsername || null,
    ownerName: regEntry.ownerName || regEntry.createdBy || regEntry.displayName || "User",
    nameServer: legacyNameServer || "Thanh Hung",
    description: legacyDesc || "",
    trialStatus: regEntry.trialStatus || (regEntry.expiryAt ? "active" : "pending"),
    expiryAt: regEntry.expiryAt || null,
    enabled: regEntry.enabled !== false && regEntry.status !== "disabled" && regEntry.status !== "rejected",
    adminIdentitySeeds: regEntry.adminIdentitySeeds || null,
    identityPending: regEntry.identityPending !== undefined ? regEntry.identityPending : false,
    identityPendingReason: regEntry.identityPendingReason || null,
    resolvedChildAdminUids: regEntry.resolvedChildAdminUids || null,
    adminIdentityResolvedAt: regEntry.adminIdentityResolvedAt || null,
  });
}

export function saveProfile(botId, profileData, {
  root = process.cwd(),
  expectedRevision = null,
  actor = "system",
  auditStore = null,
} = {}) {
  const bId = String(botId).trim();
  const current = getProfile(bId, { root });

  if (expectedRevision !== null && expectedRevision !== undefined) {
    if (Number(current.revision) !== Number(expectedRevision)) {
      const err = new Error(`Revision conflict for bot ${bId}: expected ${expectedRevision}, got ${current.revision}`);
      err.code = "REVISION_CONFLICT";
      err.status = 409;
      throw err;
    }
  }

  const validation = validateProfile(profileData);
  if (!validation.ok) {
    const err = new Error(`Invalid profile data: ${validation.errors.join("; ")}`);
    err.code = "INVALID_PROFILE";
    err.status = 400;
    err.details = validation.errors;
    throw err;
  }

  const dir = getProfileDir(bId, root);
  fs.mkdirSync(dir, { recursive: true });

  const backupDir = path.join(root, "logs", "profile-backups", bId);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-rev${current.revision}.json`);

  try {
    fs.writeFileSync(backupFile, JSON.stringify(current, null, 2), "utf8");
  } catch {}

  const nextRevision = (Number(current.revision) || 1) + 1;
  const updatedProfile = {
    ...current,
    ...profileData,
    botId: bId,
    style: normalizeStyle(profileData.style || current.style),
    revision: nextRevision,
    updatedAt: new Date().toISOString(),
  };

  const filePath = getProfilePath(bId, root);
  writeJsonAtomic(filePath, updatedProfile);

  // Sync summary metadata to mybots.json
  syncProfileToRegistry(updatedProfile, { root });

  // Update database.json nameServer if present
  try {
    const dbJsonPath = path.join(dir, "database.json");
    if (fs.existsSync(dbJsonPath)) {
      const dbConfig = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));
      dbConfig.nameServer = updatedProfile.nameServer;
      writeJsonAtomic(dbJsonPath, dbConfig);
    }
  } catch {}

  if (auditStore && typeof auditStore.append === "function") {
    auditStore.append({
      action: "bot.profile.update",
      botId: bId,
      actor,
      revision: nextRevision,
      updatedAt: updatedProfile.updatedAt,
    }).catch(() => null);
  }

  return {
    ok: true,
    profile: updatedProfile,
    backup: backupFile,
  };
}

export function updateProfile(botId, patch = {}, options = {}) {
  const bId = String(botId).trim();
  const current = getProfile(bId, { root: options.root });

  const allowedFields = [
    "ownerUid",
    "ownerUsername",
    "ownerName",
    "nameServer",
    "description",
    "botInfo",
    "typePlatform",
    "trialStatus",
    "expiryAt",
    "enabled",
    "adminIdentitySeeds",
    "identityPending",
    "identityPendingReason",
    "resolvedChildAdminUids",
    "adminIdentityResolvedAt",
  ];
  const safePatch = {};
  for (const field of allowedFields) {
    if (patch[field] !== undefined) {
      safePatch[field] = patch[field];
    }
  }

  return saveProfile(bId, { ...current, ...safePatch }, options);
}

export function updateStyle(botId, stylePatch = {}, options = {}) {
  const bId = String(botId).trim();
  const current = getProfile(bId, { root: options.root });

  const validation = validateStyle(stylePatch);
  if (!validation.ok) {
    const err = new Error(`Invalid style configuration: ${validation.errors.join("; ")}`);
    err.code = "INVALID_STYLE";
    err.status = 400;
    err.details = validation.errors;
    throw err;
  }

  const mergedStyle = {
    ...current.style,
    ...stylePatch,
    size: {
      ...(current.style?.size || DEFAULT_STYLE.size),
      ...(stylePatch.size || {}),
    },
    type: {
      ...(current.style?.type || DEFAULT_STYLE.type),
      ...(stylePatch.type || {}),
    },
  };

  return saveProfile(bId, { ...current, style: normalizeStyle(mergedStyle) }, options);
}

export function resetStyle(botId, options = {}) {
  const bId = String(botId).trim();
  const current = getProfile(bId, { root: options.root });
  return saveProfile(bId, { ...current, style: { ...DEFAULT_STYLE } }, options);
}

export function syncProfileToRegistry(profile, { root = process.cwd() } = {}) {
  if (!profile || !profile.botId) return;
  const registryPath = path.join(root, "mybot", "mybots.json");
  const registry = fs.existsSync(registryPath) ? loadMyBotsRegistry(registryPath) : {};

  const bId = profile.botId;
  const entry = registry[bId] || {
    name: bId,
    createdAt: new Date().toISOString(),
  };

  entry.nameServer = profile.nameServer;
  entry.displayName = profile.nameServer; // Maintain backwards compatibility
  entry.ownerUid = profile.ownerUid !== undefined ? profile.ownerUid : (entry.ownerUid || null);
  entry.ownerUsername = profile.ownerUsername !== undefined ? profile.ownerUsername : (entry.ownerUsername || null);
  entry.ownerName = profile.ownerName;
  entry.createdBy = profile.ownerName; // Maintain backwards compatibility
  entry.description = profile.description;
  entry.trialStatus = profile.trialStatus;
  entry.expiryAt = profile.expiryAt;
  entry.enabled = profile.enabled !== false;
  if (profile.adminIdentitySeeds !== undefined) {
    entry.adminIdentitySeeds = profile.adminIdentitySeeds;
  }
  if (profile.identityPending !== undefined) {
    entry.identityPending = profile.identityPending;
  }
  if (profile.identityPendingReason !== undefined) {
    entry.identityPendingReason = profile.identityPendingReason;
  }
  if (profile.resolvedChildAdminUids !== undefined) {
    entry.resolvedChildAdminUids = profile.resolvedChildAdminUids;
  }
  if (profile.adminIdentityResolvedAt !== undefined) {
    entry.adminIdentityResolvedAt = profile.adminIdentityResolvedAt;
  }
  entry.lastUpdated = profile.updatedAt || new Date().toISOString();

  registry[bId] = entry;
  saveMyBotsRegistry(registry, registryPath);
}

export function redactProfile(profile) {
  if (!profile || typeof profile !== "object") return {};
  const copy = { ...profile };
  // Ensure no sensitive fields are attached
  delete copy.cookie;
  delete copy.rawCookie;
  delete copy.rawCookies;
  delete copy.imei;
  delete copy.secret;
  delete copy.password;
  delete copy.credentials;
  return copy;
}

export function migrateBotProfiles({ root = process.cwd() } = {}) {
  const registryPath = path.join(root, "mybot", "mybots.json");
  const registry = fs.existsSync(registryPath) ? loadMyBotsRegistry(registryPath) : {};
  const instancesDir = path.join(root, "mybot", "instances");

  const migrated = [];

  const botIds = new Set(Object.keys(registry));
  if (fs.existsSync(instancesDir)) {
    try {
      const dirs = fs.readdirSync(instancesDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory() && !d.name.startsWith(".")) {
          botIds.add(d.name);
        }
      }
    } catch {}
  }

  for (const bId of botIds) {
    try {
      const profile = getProfile(bId, { root });
      migrated.push(profile);
    } catch (e) {
      console.warn(`[mybot-profile] Failed to migrate profile for bot ${bId}:`, e.message);
    }
  }

  return migrated;
}
