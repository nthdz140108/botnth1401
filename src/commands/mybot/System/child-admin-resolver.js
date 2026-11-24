import fs from "fs";
import path from "path";
import { normalizeUsername, extractUsernameFromUserInfo, extractUsername } from "../../../identity/identity-resolver.js";
import { writeJsonAtomic } from "./json-state.js";
import { getProfile, updateProfile } from "./mybot-profile-service.js";
import { getProjectRoot } from "../../../utils/env.js";

export { normalizeUsername, extractUsernameFromUserInfo, extractUsername };

/**
 * Validate identity seed usernames.
 *
 * Lenient by design: canonical usernames are NOT mandatory. An account without a
 * Zalo username seed is accepted (falls back to empty string). Matching usernames
 * (botAdminUsername === selfUsername, ownerUsername === selfUsername) are allowed
 * because the child bot itself and its creator are always treated as Supreme Admins.
 *
 * Always returns `valid: true` so identity seeds never block QR login or bot startup.
 */
export function validateAdminIdentitySeeds(seeds) {
  if (!seeds || typeof seeds !== "object") {
    return {
      valid: true,
      missing: ["botAdminUsername", "ownerUsername", "selfUsername"],
      errors: ["Seeds object is missing, falling back to bot UID + owner UID"],
      normalized: { botAdminUsername: null, ownerUsername: null, selfUsername: null },
    };
  }

  const missing = [];
  const errors = [];
  const botAdmin = normalizeUsername(seeds.botAdminUsername);
  const owner = normalizeUsername(seeds.ownerUsername);
  const self = normalizeUsername(seeds.selfUsername);

  // Missing seeds are informational only — they never make validation fail.
  if (!botAdmin || botAdmin === "admin") missing.push("botAdminUsername");
  if (!owner || owner === "admin") missing.push("ownerUsername");
  if (!self || self === "admin") missing.push("selfUsername");

  if (botAdmin && botAdmin === "admin") errors.push("botAdminUsername cannot be literal 'admin'");
  if (owner && owner === "admin") errors.push("ownerUsername cannot be literal 'admin'");
  if (self && self === "admin") errors.push("selfUsername cannot be literal 'admin'");

  if (missing.length === 0) {
    if (botAdmin === self) errors.push("botAdminUsername matches selfUsername (allowed: bot is its own admin)");
    if (owner === self) errors.push("ownerUsername matches selfUsername (allowed: creator is the bot)");
    // botAdmin === owner is VALID: admin creating a bot for themselves
  }

  return {
    valid: true,
    missing,
    errors,
    normalized: {
      botAdminUsername: botAdmin || null,
      ownerUsername: owner || null,
      selfUsername: self || null,
    },
  };
}

/**
 * Read identity seeds for a bot from profile and registry
 */
export function getAdminIdentitySeeds(botUid, { projectRoot = getProjectRoot(), registry = null } = {}) {
  const root = projectRoot || getProjectRoot();
  const bUid = String(botUid || "").trim();
  if (!bUid) return null;

  // 1. Check profile.json
  const profile = getProfile(bUid, { root });
  if (profile?.adminIdentitySeeds) {
    return validateAdminIdentitySeeds(profile.adminIdentitySeeds).normalized;
  }

  // 2. Check mybots.json
  let reg = registry;
  if (!reg) {
    const regPath = path.join(root, "mybot", "mybots.json");
    if (fs.existsSync(regPath)) {
      try {
        reg = JSON.parse(fs.readFileSync(regPath, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        reg = {};
      }
    }
  }

  const regEntry = reg?.[bUid];
  if (regEntry?.adminIdentitySeeds) {
    return validateAdminIdentitySeeds(regEntry.adminIdentitySeeds).normalized;
  }

  // 3. Synthesize from individual fields if present
  const candidate = {
    botAdminUsername: regEntry?.botAdminUsername || profile?.botAdminUsername || null,
    ownerUsername: regEntry?.ownerUsername || profile?.ownerUsername || null,
    selfUsername: regEntry?.selfUsername || regEntry?.zaloUsername || regEntry?.canonicalUsername || profile?.zaloUsername || null,
  };

  return validateAdminIdentitySeeds(candidate).normalized;
}

function extractUsernameFromContact(contact) {
  return extractUsernameFromUserInfo(contact);
}

/**
 * Resolve a single canonical username to local UID in child session
 */
export async function resolveUsernameInChildSession({
  api,
  canonicalUsername,
  botUid,
  projectRoot = getProjectRoot(),
  store = null,
  friendsCache = null,
} = {}) {
  if (!canonicalUsername) return null;
  const normTarget = normalizeUsername(canonicalUsername);
  if (!normTarget) return null;

  const currentOwnId = typeof api?.getOwnId === "function" ? api.getOwnId() : (api?.currentUserId || api?.botUid);

  // 1. Check if target username matches child bot's own session
  if (api && currentOwnId) {
    try {
      if (typeof api.getUserInfo === "function") {
        const ownInfo = await api.getUserInfo([String(currentOwnId)]);
        const ownUsername = extractUsernameFromContact(
          ownInfo?.[String(currentOwnId)] || ownInfo?.data?.[String(currentOwnId)] || ownInfo
        );
        if (ownUsername && ownUsername === normTarget) {
          return String(currentOwnId).trim();
        }
      }
    } catch {}
  }

  // 2. Query MySQL Identity Store if available
  if (store) {
    try {
      const globalUser = await store.findGlobalUserByCanonicalUsername(normTarget);
      if (globalUser?.global_uid) {
        const mapping = await store.findMappingByBotAndGlobalUid(String(botUid || currentOwnId), globalUser.global_uid);
        if (mapping?.status === "active" && mapping?.local_uid) {
          return String(mapping.local_uid).trim();
        }
      }
    } catch (e) {
      console.warn(`[child-admin-resolver] Identity store lookup error: ${e.message}`);
    }
  }

  // 3. Search child bot friend list / contacts
  if (api && typeof api.fetchAllFriend === "function") {
    try {
      let friends = friendsCache;
      if (!friends) {
        const friendsData = await api.fetchAllFriend();
        friends = Array.isArray(friendsData) ? friendsData : (friendsData?.friends || friendsData?.data || []);
      }
      if (Array.isArray(friends)) {
        const matches = [];
        for (const friend of friends) {
          const uName = extractUsernameFromContact(friend);
          if (uName && uName === normTarget) {
            const fUid = friend.userId || friend.uid || friend.id;
            if (fUid) matches.push(String(fUid).trim());
          }
        }
        if (matches.length === 1) {
          return matches[0];
        }
        if (matches.length > 1) {
          const err = new Error(`Username "${normTarget}" maps to multiple UIDs (${matches.join(", ")}) in child session`);
          err.code = "IDENTITY_CONFLICT";
          throw err;
        }
      }
    } catch (e) {
      if (e.code === "IDENTITY_CONFLICT") throw e;
      console.warn(`[child-admin-resolver] fetchAllFriend lookup error: ${e.message}`);
    }
  }

  // 4. If friends/contacts lookup did not find, check candidate UIDs from local registry/state and verify with getUserInfo
  if (api && typeof api.getUserInfo === "function") {
    try {
      // Check known contacts or candidates
      const root = projectRoot || getProjectRoot();
      const candidates = new Set();
      const adminState = path.join(root, "mybot", "state", "admin.json");
      if (fs.existsSync(adminState)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(adminState, "utf8").replace(/^\uFEFF/, ""));
          if (parsed.uid && parsed.uid !== "admin") candidates.add(String(parsed.uid).trim());
        } catch {}
      }
      const regPath = path.join(root, "mybot", "mybots.json");
      if (fs.existsSync(regPath)) {
        try {
          const reg = JSON.parse(fs.readFileSync(regPath, "utf8").replace(/^\uFEFF/, ""));
          for (const rec of Object.values(reg)) {
            if (rec?.ownerUid) candidates.add(String(rec.ownerUid).trim());
            if (rec?.uid && rec.uid !== "admin") candidates.add(String(rec.uid).trim());
          }
        } catch {}
      }

      for (const candUid of candidates) {
        if (!candUid || candUid === "admin") continue;
        try {
          const uInfo = await api.getUserInfo([candUid]);
          const candidateProfile = uInfo?.[candUid] || uInfo?.data?.[candUid] || uInfo;
          const uName = extractUsernameFromContact(candidateProfile);
          if (uName && uName === normTarget) {
            return candUid;
          }
        } catch {}
      }
    } catch {}
  }

  return null;
}

/**
 * Resolve child admin identities in child bot's own session.
 *
 * Fail-closed by design: only UIDs that are actually verified in THIS bot's own
 * session (by canonical username match through getUserInfo / contacts) are granted
 * Supreme Admin. The bot's own UID is always a Supreme Admin. If the owner or main
 * admin usernames cannot be resolved locally, they are NOT granted admin and the
 * bot is marked identityPending — foreign UIDs observed from the Main session
 * (profile.ownerUid, registry.ownerUid, createdBy) are NEVER copied into the child
 * admin list.
 */
export async function resolveChildAdminIdentities({
  api,
  botUid,
  seeds = null,
  projectRoot = getProjectRoot(),
  store = null,
} = {}) {
  const root = projectRoot || getProjectRoot();
  const bUid = String(botUid || (typeof api?.getOwnId === "function" ? api.getOwnId() : "")).trim();
  if (!bUid) {
    console.error("[child-admin-resolver] CHILD_ADMIN_RESOLUTION_FAILED: botUid is required, cannot resolve admins");
    return {
      success: false,
      error: "botUid is required",
      code: "CHILD_ADMIN_RESOLUTION_FAILED",
      selfUid: null,
      ownerUid: null,
      botAdminUid: null,
      resolvedAdmins: [],
      fallback: true,
    };
  }

  const effectiveSeeds = seeds || getAdminIdentitySeeds(bUid, { projectRoot: root });
  const validation = validateAdminIdentitySeeds(effectiveSeeds);
  const { botAdminUsername, ownerUsername, selfUsername } = validation.normalized;

  // Prefetch friends list once if possible
  let friendsCache = null;
  if (api && typeof api.fetchAllFriend === "function") {
    try {
      const res = await api.fetchAllFriend();
      friendsCache = Array.isArray(res) ? res : (res?.friends || res?.data || []);
    } catch {}
  }

  // Resolve the bot's own UID — this is always a guaranteed Supreme Admin.
  const selfUid = bUid;
  let ownerUid = null;
  let botAdminUid = null;

  const resolutionErrors = [];

  if (api && (ownerUsername || botAdminUsername)) {
    try {
      [ownerUid, botAdminUid] = await Promise.all([
        ownerUsername
          ? resolveUsernameInChildSession({
              api,
              canonicalUsername: ownerUsername,
              botUid: bUid,
              projectRoot: root,
              store,
              friendsCache,
            })
          : Promise.resolve(null),
        botAdminUsername
          ? resolveUsernameInChildSession({
              api,
              canonicalUsername: botAdminUsername,
              botUid: bUid,
              projectRoot: root,
              store,
              friendsCache,
            })
          : Promise.resolve(null),
      ]);
    } catch (resolutionErr) {
      resolutionErrors.push(resolutionErr.message);
    }
  }

  // CRITICAL: Do NOT fall back to profile.ownerUid, registry.ownerUid, or
  // registry.createdBy. Those UIDs were observed from a different bot session
  // (Main) and are NOT valid local UIDs in this child session. Using a foreign
  // UID as a Supreme Admin would let the wrong Zalo account control this bot.
  //
  // If the owner/main usernames could not be resolved into a local UID through
  // the child's own session, those identities remain unresolved and only the
  // bot's own UID is granted Supreme Admin (fail-closed).

  // botAdminUid unresolved → null (fail-closed, no fallback to ownerUid or selfUid)
  if (!botAdminUid) {
    botAdminUid = null;
  }

  // Build the admin set: bot itself is the only guaranteed Supreme Admin.
  // Unresolved owner/botAdmin UIDs are NOT included to prevent foreign UID injection.
  const adminSet = new Set();
  for (const uid of [selfUid]) {
    const cleaned = String(uid || "").trim();
    if (cleaned && cleaned.toLowerCase() !== "admin") {
      adminSet.add(cleaned);
    }
  }
  // Only add ownerUid and botAdminUid if they were actually resolved through
  // the child session (verified by username match).
  for (const uid of [ownerUid, botAdminUid]) {
    const cleaned = String(uid || "").trim();
    if (cleaned && cleaned.toLowerCase() !== "admin" && cleaned !== selfUid) {
      adminSet.add(cleaned);
    }
  }

  const resolvedAdmins = Array.from(adminSet);
  if (resolvedAdmins.length === 0) {
    resolvedAdmins.push(selfUid);
  }

  const allResolved = Boolean(ownerUid && botAdminUid);
  const usedFallback = !allResolved;
  const fallbackNote = usedFallback
    ? "Không resolve được đủ username qua danh bá; chỉ ghi bot UID làm Admin Tối Cao (fail-closed)."
    : null;

  // Write local admin-list.json to instance data directory
  const instanceDataDir = path.join(root, "mybot", "instances", bUid, "data");
  fs.mkdirSync(instanceDataDir, { recursive: true });
  const adminListPath = path.join(instanceDataDir, "admin-list.json");
  writeJsonAtomic(adminListPath, resolvedAdmins);

  // Sync legacy path for backwards compatibility
  const legacyConfigsDir = path.join(root, "mybot", "configs");
  fs.mkdirSync(legacyConfigsDir, { recursive: true });
  const legacyAdminListPath = path.join(legacyConfigsDir, `list_admin-${bUid}.json`);
  writeJsonAtomic(legacyAdminListPath, resolvedAdmins);

  // Write audit metadata
  const auditPath = path.join(instanceDataDir, "admin-identity-audit.json");
  const auditRecord = {
    resolvedAt: new Date().toISOString(),
    botUid: bUid,
    sessionBotId: typeof api?.getOwnId === "function" ? api.getOwnId() : bUid,
    seeds: {
      botAdminUsername: botAdminUsername || null,
      ownerUsername: ownerUsername || null,
      selfUsername: selfUsername || null,
    },
    resolvedUids: {
      selfUid,
      ownerUid,
      botAdminUid,
    },
    adminList: resolvedAdmins,
    status: usedFallback ? "identityPending" : "verified",
    identityPending: usedFallback,
    fallbackNote,
    resolutionErrors,
  };
  writeJsonAtomic(auditPath, auditRecord);

  // Update profile and registry with active resolution status.
  // Fail-closed: when owner/main identities are unresolved, the bot is marked
  // identityPending so high-privilege checks fail closed (no fabricated admin
  // via foreign UID fallback). The bot's own UID remains the only verified admin.
  try {
    updateProfile(bUid, {
      ownerUid: ownerUid || null,
      adminIdentitySeeds: { botAdminUsername: botAdminUsername || null, ownerUsername: ownerUsername || null, selfUsername: selfUsername || null },
      identityPending: usedFallback,
      identityPendingReason: usedFallback ? fallbackNote : null,
      resolvedChildAdminUids: resolvedAdmins,
      adminIdentityResolvedAt: auditRecord.resolvedAt,
    }, { root });
  } catch {}

  return {
    success: true,
    selfUid,
    ownerUid: ownerUid || null,
    botAdminUid: botAdminUid || null,
    resolvedAdmins,
    fallback: usedFallback,
    identityPending: usedFallback,
    audit: auditRecord,
  };
}
