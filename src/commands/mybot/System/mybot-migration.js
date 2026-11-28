import fs from "fs";
import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
import { writeJsonAtomic } from "./json-state.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { getProfile, updateProfile } from "./mybot-profile-service.js";
import { validateAdminIdentitySeeds } from "./child-admin-resolver.js";
import { normalizeUsername } from "./mybot-identity.js";

/**
 * Perform idempotent legacy identity migration on mybots.json registry
 */
export function migrateLegacyMyBotIdentities({ projectRoot = getProjectRoot(), root: customRoot = null, backup = true } = {}) {
  const root = customRoot || projectRoot || getProjectRoot();
  const registryPath = path.join(root, "mybot", "mybots.json");

  if (!fs.existsSync(registryPath)) {
    return {
      success: true,
      migratedCount: 0,
      manualCount: 0,
      totalCount: 0,
      backupPath: null,
      details: [],
    };
  }

  const registry = loadMyBotsRegistry(registryPath);
  const botKeys = Object.keys(registry);

  let backupPath = null;
  if (backup) {
    const backupDir = path.join(root, "mybot", "state", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `mybots-pre-identity-migration-${Date.now()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(registry, null, 2), "utf8");
  }

  let migratedCount = 0;
  let repairedCount = 0;
  let unresolvedCount = 0;
  const details = [];

  for (const key of botKeys) {
    const bot = registry[key];
    if (!bot || typeof bot !== "object") continue;

    const isMain = bot.isMain === true || key === "admin" || String(bot.name || "").toLowerCase() === "admin";
    const botUid = String(bot.uid || bot.botId || key).trim();
    const profile = getProfile(key, { root });

    let ownerUid = null;
    let createdByUid = null;
    let ownerResolution = "missing";
    let isRepaired = false;
    let isUnresolved = false;

    if (isMain) {
      ownerUid = botUid !== "admin" ? botUid : "admin";
      createdByUid = ownerUid;
      ownerResolution = "verified";
    } else {
      let isLegacyCreator = false;
      // Look for evidence of creator UID
      // 1. bot.createdByUid or profile.createdByUid
      if (bot.createdByUid && /^\d{10,}$/.test(String(bot.createdByUid).trim())) {
        createdByUid = String(bot.createdByUid).trim();
      } else if (profile?.createdByUid && /^\d{10,}$/.test(String(profile.createdByUid).trim())) {
        createdByUid = String(profile.createdByUid).trim();
      }

      // 2. Credential file written from Main Bot session (mybot/credentials/<botUid>.json has uid field)
      if (!createdByUid) {
        try {
          const credPath = path.join(root, "mybot", "credentials", `${key}.json`);
          if (fs.existsSync(credPath)) {
            const parsedCred = JSON.parse(fs.readFileSync(credPath, "utf8").replace(/^\uFEFF/, ""));
            const credUid = String(parsedCred?.uid || "").trim();
            if (credUid && /^\d{10,}$/.test(credUid) && credUid !== botUid) {
              createdByUid = credUid;
            }
          }
        } catch {}
      }

      // 3. Legacy createdBy if numeric UID
      if (!createdByUid && bot.createdBy && /^\d{10,}$/.test(String(bot.createdBy).trim()) && String(bot.createdBy).trim() !== botUid) {
        createdByUid = String(bot.createdBy).trim();
        isLegacyCreator = true;
      }

      // 4. profile.ownerUid if different from botUid and not admin
      if (!createdByUid && profile?.ownerUid && /^\d{10,}$/.test(String(profile.ownerUid).trim()) && String(profile.ownerUid).trim() !== botUid && String(profile.ownerUid).trim().toLowerCase() !== "admin") {
        createdByUid = String(profile.ownerUid).trim();
      }

      // Determine ownerUid and ownerResolution
      if (bot.ownerResolution === "legacy" && bot.ownerUid) {
        ownerUid = String(bot.ownerUid).trim();
        ownerResolution = "legacy";
        createdByUid = createdByUid || ownerUid;
      } else if (bot.ownerUid && String(bot.ownerUid).trim() !== botUid && String(bot.ownerUid).trim().toLowerCase() !== "admin") {
        // Already had distinct verified owner
        ownerUid = String(bot.ownerUid).trim();
        ownerResolution = bot.ownerResolution || "verified";
        createdByUid = createdByUid || ownerUid;
      } else if (createdByUid && createdByUid !== botUid) {
        // Has evidence of creator
        ownerUid = createdByUid;
        ownerResolution = isLegacyCreator ? "legacy" : "verified";
        isRepaired = true;
      } else if (bot.ownerUid && String(bot.ownerUid).trim() === botUid) {
        // Self-owned bot record: MUST BE PRESERVED!
        ownerUid = botUid;
        ownerResolution = "self";
        createdByUid = bot.createdByUid ? String(bot.createdByUid).trim() : botUid;
        isUnresolved = true;
      } else if (!bot.ownerUid && botUid && /^\d{10,}$/.test(botUid)) {
        // No ownerUid specified, no creator evidence: belongs to bot UID itself
        ownerUid = botUid;
        ownerResolution = "self";
        createdByUid = botUid;
        isUnresolved = true;
      } else {
        ownerUid = null;
        ownerResolution = "missing";
        isUnresolved = true;
      }
    }

    // 2. Validate adminIdentitySeeds
    const rawSeeds = bot.adminIdentitySeeds || profile?.adminIdentitySeeds || {
      botAdminUsername: bot.botAdminUsername || null,
      ownerUsername: bot.ownerUsername || null,
      selfUsername: bot.selfUsername || bot.zaloUsername || null,
    };

    const seedVal = validateAdminIdentitySeeds(rawSeeds);
    let identityPending = false;
    let identityPendingReason = null;

    if (!isMain) {
      // Fail-closed migration: seeds are informational for startup, but a child
      // bot whose owner/main usernames cannot be resolved must be marked
      // identityPending — never grant admin via copied foreign UIDs.
      bot.adminIdentitySeeds = seedVal.normalized;
      const hasResolvableSeeds = Boolean(
        seedVal.normalized.botAdminUsername &&
        seedVal.normalized.ownerUsername &&
        seedVal.normalized.selfUsername
      );
      identityPending = !hasResolvableSeeds;
      identityPendingReason = identityPending
        ? "Chưa cấu hình đủ 3 admin identity seeds; quyền cao fail-closed cho tới khi resolve qua session bot."
        : null;
    }

    const prevOwner = bot.ownerUid || null;
    const prevCreatedBy = bot.createdByUid || null;
    const prevResolution = bot.ownerResolution || "missing";
    const prevPending = Boolean(bot.identityPending);

    const changed =
      prevOwner !== (ownerUid || null) ||
      prevCreatedBy !== (createdByUid || null) ||
      prevResolution !== (ownerResolution || "missing") ||
      prevPending !== identityPending ||
      (!bot.database || String(bot.database).trim() === "") ||
      (isMain && String(bot.database || "").trim().toLowerCase() === "admin") ||
      (!bot.webPort || String(bot.webPort).trim() === "");

    if (changed) {
      bot.ownerUid = ownerUid;
      if (createdByUid) {
        bot.createdByUid = createdByUid;
      } else if (bot.createdByUid) {
        delete bot.createdByUid;
      }
      bot.ownerResolution = ownerResolution;
      bot.identityPending = identityPending;
      if (!bot.database || String(bot.database).trim() === "" || (isMain && String(bot.database).trim().toLowerCase() === "admin")) {
        bot.database = isMain ? "nthdz" : botUid;
      }
      if (!bot.webPort || String(bot.webPort).trim() === "") {
        bot.webPort = isMain ? "2000" : "4444";
      }
      if (identityPendingReason) {
        bot.identityPendingReason = identityPendingReason;
      } else {
        delete bot.identityPendingReason;
      }
      bot.lastUpdated = new Date().toISOString();
      migratedCount++;
    }

    if (isRepaired) {
      repairedCount++;
    }
    if (isUnresolved || identityPending) {
      unresolvedCount++;
    }

    try {
      updateProfile(key, {
        ownerUid,
        createdByUid,
        adminIdentitySeeds: bot.adminIdentitySeeds || null,
        identityPending,
        identityPendingReason,
      }, { root });
    } catch {}

    details.push({
      key,
      botUid,
      isMain,
      ownerUid,
      createdByUid,
      ownerResolution,
      identityPending,
      identityPendingReason,
      changed,
      isRepaired,
      isUnresolved,
    });
  }

  saveMyBotsRegistry(registry, registryPath);

  return {
    success: true,
    migratedCount,
    repairedCount,
    unresolvedCount,
    manualCount: unresolvedCount,
    totalCount: botKeys.length,
    backupPath,
    details,
  };
}

export const migrateLegacyMyBotIdentity = migrateLegacyMyBotIdentities;
