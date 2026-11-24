import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

export const IDENTITY_ERRORS = Object.freeze({
  NOT_FOUND: "IDENTITY_NOT_FOUND",
  NOT_LINKED: "IDENTITY_NOT_LINKED",
  CONFLICT: "IDENTITY_CONFLICT",
  DB_UNAVAILABLE: "IDENTITY_DB_UNAVAILABLE",
  NOT_READY: "IDENTITY_NOT_READY",
});

export class IdentityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeUsername(username) {
  if (typeof username !== "string") return null;
  const cleaned = username.trim().replace(/^@+/, "");
  if (!cleaned) return null;
  // Normalize unicode with NFKC and lowercase
  return cleaned.normalize("NFKC").toLowerCase();
}

export function normalizePhone(phone) {
  if (typeof phone !== "string" && typeof phone !== "number") return null;
  const raw = String(phone).trim();
  if (!raw) return null;

  let cleaned = raw.replace(/[^\d+]/g, "");
  if (!cleaned) return null;

  // Handle Vietnam phone formats:
  // Starts with +84 followed by 9 digits
  if (/^\+84\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  // Starts with 84 followed by 9 digits -> +84...
  if (/^84\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  // Starts with 0 followed by 9 digits -> +84...
  if (/^0\d{9}$/.test(cleaned)) {
    return `+84${cleaned.slice(1)}`;
  }

  // Generic international format
  if (cleaned.startsWith("+")) {
    const digitsOnly = cleaned.slice(1);
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      return cleaned;
    }
  } else if (cleaned.length >= 8 && cleaned.length <= 15) {
    return `+${cleaned}`;
  }

  return null;
}

export function hashPhoneNumber(phone, key = process.env.IDENTITY_PHONE_HASH_KEY) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const hashKey = key || process.env.IDENTITY_PHONE_HASH_KEY;
  if (!hashKey || typeof hashKey !== "string" || !hashKey.trim()) {
    return null;
  }
  return crypto.createHmac("sha256", hashKey.trim()).update(norm).digest("hex");
}

export function redactSensitive(text) {
  if (!text || typeof text !== "string") return text;
  // Redact phone numbers
  let sanitized = text.replace(/(\+?\d{2,4})([\d\s.-]{3,})(\d{3})/g, "$1***$3");
  // Redact tokens/cookies/passwords
  sanitized = sanitized.replace(/(cookie|password|imei|token|secret)=([^&;\s]+)/gi, "$1=[REDACTED]");
  return sanitized;
}

export function extractProfileFromUserInfo(userInfo, targetUid) {
  if (!userInfo || typeof userInfo !== "object" || !targetUid) return null;

  const uidStr = String(targetUid).trim();
  if (!uidStr) return null;

  const { unchanged_profiles, changed_profiles, profiles, data } = userInfo;
  const profileMaps = [
    unchanged_profiles,
    changed_profiles,
    profiles,
    data,
    userInfo,
  ].filter((map) => map && typeof map === "object" && !Array.isArray(map));

  // 1. Exact UID key match
  for (const map of profileMaps) {
    const profile = map[uidStr];
    if (profile && typeof profile === "object") {
      return profile;
    }
  }

  // 2. Versioned key match: <uid>_* (e.g. <uid>_0)
  const versionPrefix = `${uidStr}_`;
  for (const map of profileMaps) {
    for (const [key, profile] of Object.entries(map)) {
      if (key.startsWith(versionPrefix) && profile && typeof profile === "object") {
        return profile;
      }
    }
  }

  // 3. Match via userId, uid, id property
  for (const map of profileMaps) {
    for (const profile of Object.values(map)) {
      if (
        profile &&
        typeof profile === "object" &&
        (String(profile.userId || "") === uidStr ||
         String(profile.uid || "") === uidStr ||
         String(profile.id || "") === uidStr)
      ) {
        return profile;
      }
    }
  }

  // Do NOT return fallback first profile
  return null;
}

const USERNAME_FIELDS = ["username", "userName", "user_name", "zaloUsername"];

function getUsernameFieldFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const field of USERNAME_FIELDS) {
    if (typeof obj[field] === "string" && obj[field].trim()) {
      return obj[field];
    }
  }
  return null;
}

export function extractUsernameFromUserInfo(userInfo, targetUid = null) {
  if (!userInfo || typeof userInfo !== "object") return null;

  // If targetUid is provided, try extracting the specific profile first
  if (targetUid) {
    const profile = extractProfileFromUserInfo(userInfo, targetUid);
    if (profile) {
      const u = getUsernameFieldFromObject(profile);
      if (u) return normalizeUsername(u);
    }
  }

  // 1. Direct fields on userInfo
  const directUsername = getUsernameFieldFromObject(userInfo);
  if (directUsername) return normalizeUsername(directUsername);

  // 2. Direct info or data.info or data
  if (userInfo.data && typeof userInfo.data === "object") {
    const dataUsername = getUsernameFieldFromObject(userInfo.data);
    if (dataUsername) return normalizeUsername(dataUsername);

    if (userInfo.data.info && typeof userInfo.data.info === "object") {
      const infoUsername = getUsernameFieldFromObject(userInfo.data.info);
      if (infoUsername) return normalizeUsername(infoUsername);
    }
  }

  if (userInfo.info && typeof userInfo.info === "object") {
    const infoUsername = getUsernameFieldFromObject(userInfo.info);
    if (infoUsername) return normalizeUsername(infoUsername);
  }

  // 3. Search profile maps (changed_profiles, unchanged_profiles, profiles, data)
  const { unchanged_profiles, changed_profiles, profiles, data } = userInfo;
  const profileMaps = [
    unchanged_profiles,
    changed_profiles,
    profiles,
    data,
    userInfo,
  ].filter((map) => map && typeof map === "object");

  for (const map of profileMaps) {
    if (Array.isArray(map)) {
      for (const item of map) {
        if (targetUid) {
          const uidStr = String(targetUid).trim();
          if (
            item &&
            typeof item === "object" &&
            (String(item.userId || "") === uidStr ||
             String(item.uid || "") === uidStr ||
             String(item.id || "") === uidStr)
          ) {
            const u = getUsernameFieldFromObject(item);
            if (u) return normalizeUsername(u);
          }
        } else {
          const u = getUsernameFieldFromObject(item);
          if (u) return normalizeUsername(u);
        }
      }
    } else {
      if (targetUid) {
        const uidStr = String(targetUid).trim();
        if (map[uidStr]) {
          const u = getUsernameFieldFromObject(map[uidStr]);
          if (u) return normalizeUsername(u);
        }
        for (const [key, val] of Object.entries(map)) {
          if (key.startsWith(`${uidStr}_`)) {
            const u = getUsernameFieldFromObject(val);
            if (u) return normalizeUsername(u);
          }
        }
      }
      if (!targetUid) {
        for (const val of Object.values(map)) {
          const u = getUsernameFieldFromObject(val);
          if (u) return normalizeUsername(u);
        }
      }
    }
  }

  return null;
}

export { extractUsernameFromUserInfo as extractUsername };

export function extractIdentifiersFromProfile(profile, localUid, sourceBotId = null, phoneHashKey = process.env.IDENTITY_PHONE_HASH_KEY) {
  if (!profile && !localUid) return { identifiers: [], canonicalUsername: null, displayUsername: null, displayName: null, avatar: null };

  const rawUsername = profile?.username || profile?.userName || profile?.user_name || profile?.zaloUsername || null;
  const displayUsername = rawUsername ? String(rawUsername).trim().replace(/^@+/, "") : null;
  const canonicalUsername = normalizeUsername(displayUsername);

  const rawPhone = profile?.phoneNumber || profile?.phone || profile?.mobile || null;
  const normalizedPhone = normalizePhone(rawPhone);

  const rawGlobalId = profile?.globalId || profile?.global_id || profile?.zaloId || profile?.zalo_id || null;
  const normalizedGlobalId = rawGlobalId ? String(rawGlobalId).trim() : null;

  const displayName = profile?.displayName || profile?.dName || profile?.name || profile?.zaloName || null;
  const avatar = profile?.avatar || profile?.avatarUrl || profile?.avatar_url || profile?.photo || null;

  const identifiers = [];
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");

  if (canonicalUsername) {
    identifiers.push({
      provider: "zalo",
      identifierType: "username",
      normalizedValue: canonicalUsername,
      verifiedAt: now,
      sourceBotId,
    });
  }

  if (normalizedPhone) {
    const hashedPhone = hashPhoneNumber(normalizedPhone, phoneHashKey);
    if (hashedPhone) {
      identifiers.push({
        provider: "zalo",
        identifierType: "phone",
        normalizedValue: hashedPhone,
        verifiedAt: now,
        sourceBotId,
      });
    }
  }

  if (normalizedGlobalId && normalizedGlobalId !== String(localUid)) {
    identifiers.push({
      provider: "zalo",
      identifierType: "globalId",
      normalizedValue: normalizedGlobalId,
      verifiedAt: now,
      sourceBotId,
    });
  }

  return {
    canonicalUsername,
    displayUsername,
    displayName: displayName ? String(displayName).trim() : null,
    avatar: avatar ? String(avatar).trim() : null,
    identifiers,
  };
}

export async function resolveOrLinkIdentity({
  store,
  api,
  botId,
  localUid,
  source = "message",
  phoneHashKey = process.env.IDENTITY_PHONE_HASH_KEY,
} = {}) {
  if (!store) {
    throw new IdentityError("Identity store unavailable", IDENTITY_ERRORS.DB_UNAVAILABLE);
  }
  if (!botId || !localUid) {
    throw new IdentityError("botId and localUid are required to resolve identity", IDENTITY_ERRORS.NOT_FOUND, { botId, localUid });
  }

  const sBotId = String(botId).trim();
  const sLocalUid = String(localUid).trim();

  // 1. Check existing bot_user_mappings
  try {
    const existingMapping = await store.findMappingByBotAndLocalUid(sBotId, sLocalUid);
    if (existingMapping) {
      if (existingMapping.status === "active") {
        const globalUser = await store.findGlobalUserByUid(existingMapping.global_uid);
        if (globalUser) {
          await store.updateMappingLastSeen({ botId: sBotId, localUid: sLocalUid }).catch(() => {});
          return {
            globalUid: globalUser.global_uid,
            canonicalUsername: globalUser.canonical_username,
            displayUsername: globalUser.display_username,
            displayName: globalUser.display_name,
            avatar: globalUser.avatar,
            localUid: sLocalUid,
            botId: sBotId,
            status: "active",
            isNew: false,
          };
        }
      } else if (existingMapping.status === "pending_conflict") {
        throw new IdentityError(
          `Identity mapping for local UID ${sLocalUid} on bot ${sBotId} is in pending conflict`,
          IDENTITY_ERRORS.CONFLICT,
          { botId: sBotId, localUid: sLocalUid, existingGlobalUid: existingMapping.global_uid }
        );
      }
    }
  } catch (err) {
    if (err instanceof IdentityError) throw err;
    throw new IdentityError(`Database error during mapping lookup: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
  }

  // 2. Fetch user profile from API if available
  let profile = null;
  if (api && typeof api.getUserInfo === "function") {
    try {
      const userInfo = await api.getUserInfo([sLocalUid]);
      profile = extractProfileFromUserInfo(userInfo, sLocalUid);
    } catch (apiErr) {
      console.warn(`[identity-resolver] Could not fetch profile for UID ${sLocalUid} from bot ${sBotId}: ${apiErr.message}`);
    }
  }

  const extracted = extractIdentifiersFromProfile(profile, sLocalUid, sBotId, phoneHashKey);

  // 3. Search for candidate global user
  let candidateUser = null;
  try {
    if (extracted.canonicalUsername) {
      candidateUser = await store.findGlobalUserByCanonicalUsername(extracted.canonicalUsername);
    }

    if (!candidateUser && extracted.identifiers.length > 0) {
      for (const ident of extracted.identifiers) {
        candidateUser = await store.findGlobalUserByIdentifier({
          provider: ident.provider,
          identifierType: ident.identifierType,
          normalizedValue: ident.normalizedValue,
        });
        if (candidateUser) break;
      }
    }
  } catch (err) {
    throw new IdentityError(`Database error during user lookup: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
  }

  // 4. If candidate user found, check for conflicts
  if (candidateUser) {
    const candidateGlobalUid = candidateUser.global_uid;

    try {
      // Check if candidate user is already mapped to a different localUid on this SAME bot
      const existingMappingOnThisBot = await store.findMappingByBotAndGlobalUid(sBotId, candidateGlobalUid);
      if (existingMappingOnThisBot && existingMappingOnThisBot.local_uid !== sLocalUid && existingMappingOnThisBot.status === "active") {
        const conflictReason = `Global user ${candidateGlobalUid} is already actively mapped to local UID ${existingMappingOnThisBot.local_uid} on bot ${sBotId}`;
        await store.recordConflict({
          botId: sBotId,
          localUid: sLocalUid,
          existingGlobalUid: existingMappingOnThisBot.global_uid,
          candidateGlobalUid,
          reason: conflictReason,
          status: "pending",
        });

        throw new IdentityError(conflictReason, IDENTITY_ERRORS.CONFLICT, {
          botId: sBotId,
          localUid: sLocalUid,
          existingLocalUid: existingMappingOnThisBot.local_uid,
          candidateGlobalUid,
        });
      }

      // Safe to link mapping
      await store.addOrUpdateMapping({
        botId: sBotId,
        localUid: sLocalUid,
        globalUid: candidateGlobalUid,
        status: "active",
      });

      // Backfill any newly verified identifiers
      if (extracted.identifiers.length > 0) {
        for (const ident of extracted.identifiers) {
          await store.addIdentifierToUser({
            globalUid: candidateGlobalUid,
            provider: ident.provider,
            identifierType: ident.identifierType,
            normalizedValue: ident.normalizedValue,
            sourceBotId: sBotId,
          }).catch(() => {});
        }
      }

      return {
        globalUid: candidateGlobalUid,
        canonicalUsername: candidateUser.canonical_username || extracted.canonicalUsername,
        displayUsername: candidateUser.display_username || extracted.displayUsername,
        displayName: candidateUser.display_name || extracted.displayName,
        avatar: candidateUser.avatar || extracted.avatar,
        localUid: sLocalUid,
        botId: sBotId,
        status: "active",
        isNew: false,
      };
    } catch (err) {
      if (err instanceof IdentityError) throw err;
      throw new IdentityError(`Failed linking identity to candidate: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
    }
  }

  // 5. No candidate user found -> Check verified identifiers before creating new global user
  if (extracted.identifiers.length === 0 && !extracted.canonicalUsername) {
    throw new IdentityError(
      `No verified identifiers found for local UID ${sLocalUid} on bot ${sBotId}`,
      IDENTITY_ERRORS.NOT_FOUND,
      { botId: sBotId, localUid: sLocalUid }
    );
  }

  const newGlobalUid = uuidv4();
  try {
    const createdUser = await store.createGlobalUserWithIdentity({
      globalUid: newGlobalUid,
      canonicalUsername: extracted.canonicalUsername,
      displayUsername: extracted.displayUsername,
      displayName: extracted.displayName,
      avatar: extracted.avatar,
      status: "active",
      identifiers: extracted.identifiers,
      botId: sBotId,
      localUid: sLocalUid,
    });

    return {
      globalUid: createdUser?.global_uid || newGlobalUid,
      canonicalUsername: createdUser?.canonical_username || extracted.canonicalUsername,
      displayUsername: createdUser?.display_username || extracted.displayUsername,
      displayName: createdUser?.display_name || extracted.displayName,
      avatar: createdUser?.avatar || extracted.avatar,
      localUid: sLocalUid,
      botId: sBotId,
      status: "active",
      isNew: true,
    };
  } catch (err) {
    if (err instanceof IdentityError) throw err;
    if (err.code === "IDENTITY_CONFLICT" || err.code === "ER_DUP_ENTRY" || String(err.message).includes("Duplicate entry")) {
      // Race condition / duplicate alias: try resolving candidate user again
      try {
        if (extracted.canonicalUsername) {
          const retryUser = await store.findGlobalUserByCanonicalUsername(extracted.canonicalUsername);
          if (retryUser) {
            await store.addOrUpdateMapping({
              botId: sBotId,
              localUid: sLocalUid,
              globalUid: retryUser.global_uid,
              status: "active",
            });
            return {
              globalUid: retryUser.global_uid,
              canonicalUsername: retryUser.canonical_username,
              displayUsername: retryUser.display_username,
              displayName: retryUser.display_name,
              avatar: retryUser.avatar,
              localUid: sLocalUid,
              botId: sBotId,
              status: "active",
              isNew: false,
            };
          }
        }
      } catch {}
      throw new IdentityError(`Conflict creating identity: ${err.message}`, IDENTITY_ERRORS.CONFLICT, { originalError: err });
    }
    throw new IdentityError(`Failed creating global user: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
  }
}

export async function resolveUidForBot({
  store,
  botId,
  globalUid,
} = {}) {
  if (!store) {
    throw new IdentityError("Identity store unavailable", IDENTITY_ERRORS.DB_UNAVAILABLE);
  }
  if (!botId || !globalUid) {
    throw new IdentityError("botId and globalUid are required", IDENTITY_ERRORS.NOT_FOUND, { botId, globalUid });
  }

  const sBotId = String(botId).trim();
  const sGlobalUid = String(globalUid).trim();

  try {
    const mapping = await store.findMappingByBotAndGlobalUid(sBotId, sGlobalUid);
    if (!mapping || mapping.status !== "active") {
      throw new IdentityError(
        `No active mapping found for global UID ${sGlobalUid} on bot ${sBotId}`,
        IDENTITY_ERRORS.NOT_LINKED,
        { botId: sBotId, globalUid: sGlobalUid }
      );
    }
    return mapping.local_uid;
  } catch (err) {
    if (err instanceof IdentityError) throw err;
    throw new IdentityError(`Database error resolving UID for bot: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
  }
}

export async function resolveGlobalUser({
  store,
  identifier,
  phoneHashKey = process.env.IDENTITY_PHONE_HASH_KEY,
} = {}) {
  if (!store) {
    throw new IdentityError("Identity store unavailable", IDENTITY_ERRORS.DB_UNAVAILABLE);
  }
  if (!identifier) {
    throw new IdentityError("Identifier is required to resolve global user", IDENTITY_ERRORS.NOT_FOUND);
  }

  const idStr = String(identifier).trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idStr);

  try {
    if (isUuid) {
      const byUid = await store.findGlobalUserByUid(idStr);
      if (byUid) return byUid;
    }

    const canonical = normalizeUsername(idStr);
    if (canonical) {
      const byName = await store.findGlobalUserByCanonicalUsername(canonical);
      if (byName) return byName;
    }

    const byIdent = await store.findGlobalUserByIdentifier({
      provider: "zalo",
      identifierType: "username",
      normalizedValue: canonical || idStr,
    });
    if (byIdent) return byIdent;

    const normPhone = normalizePhone(idStr);
    if (normPhone) {
      const hashedPhone = hashPhoneNumber(normPhone, phoneHashKey);
      if (hashedPhone) {
        const byPhone = await store.findGlobalUserByIdentifier({
          provider: "zalo",
          identifierType: "phone",
          normalizedValue: hashedPhone,
        });
        if (byPhone) return byPhone;
      }
    }

    const byGlobalId = await store.findGlobalUserByIdentifier({
      provider: "zalo",
      identifierType: "globalId",
      normalizedValue: idStr,
    });
    if (byGlobalId) return byGlobalId;

    throw new IdentityError(`Global user not found for identifier ${idStr}`, IDENTITY_ERRORS.NOT_FOUND, { identifier: idStr });
  } catch (err) {
    if (err instanceof IdentityError) throw err;
    throw new IdentityError(`Database error resolving global user: ${err.message}`, IDENTITY_ERRORS.DB_UNAVAILABLE, { originalError: err });
  }
}

export async function hydrateBotIdentity({
  store,
  api,
  botId,
  localUid,
} = {}) {
  return await resolveOrLinkIdentity({
    store,
    api,
    botId: botId || localUid,
    localUid,
    source: "bot_hydration",
  });
}
