import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { writeJsonAtomic } from "./json-state.js";
import { isMainBot, assertCanDeleteBot, resolveManagedBotTarget, resolveManagedBotList } from "./mybot-identity.js";
import { releaseCreationQuota } from "./mybot-creation-quota.js";
import { withMyBotsTransaction } from "../Manager/qr-provisioning-registry.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { invalidateBotStartOperation } from "./bot-lifecycle-operation.js";

export function getSortedBotList(myBotsRegistry = {}, projectRoot = process.cwd()) {
  return resolveManagedBotList({ registry: myBotsRegistry, projectRoot, includeMain: true, includeRejected: true });
}

export function resolveTargetBots({
  selector = { type: "self" },
  myBots = {},
  callerUid = "",
  isSystemAdmin = false,
  action = "",
  projectRoot = process.cwd(),
} = {}) {
  return resolveManagedBotTarget({
    selector,
    registry: myBots,
    callerUid,
    isSystemAdmin,
    action,
    projectRoot,
  });
}

export function calculateExtendExpiry(currentExpiryAt, durationMs, now = Date.now()) {
  if (durationMs === -1) return "-1";
  if (currentExpiryAt === "-1") return "-1";

  const numDuration = Number(durationMs);
  if (isNaN(numDuration) || numDuration <= 0) return currentExpiryAt;

  if (currentExpiryAt && typeof currentExpiryAt === "string") {
    const parsedTime = Date.parse(currentExpiryAt);
    if (!isNaN(parsedTime) && parsedTime > now) {
      return new Date(parsedTime + numDuration).toISOString();
    }
  }

  return new Date(now + numDuration).toISOString();
}

export function calculateMinusExpiry(currentExpiryAt, durationMs, now = Date.now()) {
  if (durationMs === -1) {
    return new Date(now - 1000).toISOString();
  }

  const numDuration = Number(durationMs);
  if (isNaN(numDuration) || numDuration <= 0) return currentExpiryAt;

  if (currentExpiryAt === "-1") {
    return "-1";
  }

  if (currentExpiryAt && typeof currentExpiryAt === "string") {
    const parsedTime = Date.parse(currentExpiryAt);
    if (!isNaN(parsedTime)) {
      return new Date(parsedTime - numDuration).toISOString();
    }
  }

  return new Date(now - 1000).toISOString();
}

export async function extendBotExpiryLogic(options = {}) {
  const root = path.resolve(path.dirname(options.registryPath || path.join(process.cwd(), "mybot", "mybots.json")), "..");
  return withMyBotsTransaction({ root, registryPath: options.registryPath }, () => extendBotExpiryLocked(options));
}

async function extendBotExpiryLocked({
  registryPath,
  botKey,
  durationMs,
  now = Date.now(),
  startBotFn = null,
} = {}) {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`File registry không tồn tại: ${registryPath}`);
  }

  const myBots = loadMyBotsRegistry(registryPath);
  const botRecord = myBots[botKey];

  if (!botRecord) {
    return { success: false, error: `Không tìm thấy bot ${botKey} trong registry` };
  }

  const newExpiry = calculateExtendExpiry(botRecord.expiryAt, durationMs, now);
  botRecord.expiryAt = newExpiry;

  if (["expired", "trialExpired"].includes(botRecord.status)) {
    botRecord.status = "stopped";
  }

  botRecord.lastUpdated = new Date(now).toISOString();
  saveMyBotsRegistry(myBots, registryPath);

  return { success: true, botRecord, newExpiry };
}

export async function reduceBotExpiryLogic(options = {}) {
  const root = path.resolve(path.dirname(options.registryPath || path.join(process.cwd(), "mybot", "mybots.json")), "..");
  return withMyBotsTransaction({ root, registryPath: options.registryPath }, () => reduceBotExpiryLocked(options));
}

async function reduceBotExpiryLocked({
  registryPath,
  botKey,
  durationMs,
  now = Date.now(),
} = {}) {
  if (!fs.existsSync(registryPath)) {
    throw new Error(`File registry không tồn tại: ${registryPath}`);
  }

  const myBots = loadMyBotsRegistry(registryPath);
  const botRecord = myBots[botKey];

  if (!botRecord) {
    return { success: false, error: `Không tìm thấy bot ${botKey} trong registry` };
  }

  const newExpiry = calculateMinusExpiry(botRecord.expiryAt, durationMs, now);
  botRecord.expiryAt = newExpiry;

  if (newExpiry !== "-1" && Date.parse(newExpiry) <= now) {
    botRecord.status = "expired";
  }

  botRecord.lastUpdated = new Date(now).toISOString();
  saveMyBotsRegistry(myBots, registryPath);

  return { success: true, botRecord, newExpiry };
}

export async function deleteChildBotLogic(options = {}) {
  const root = path.resolve(options.projectRoot || process.cwd());
  const registryPath = options.registryPath ? path.resolve(options.registryPath) : path.join(root, "mybot", "mybots.json");
  return withMyBotsTransaction({ root, registryPath }, (transaction) => deleteChildBotLocked({ ...options, projectRoot: root, registryPath, transaction }));
}

async function deleteChildBotLocked({
  projectRoot = process.cwd(),
  registryPath,
  botKey,
  actorId = "",
  stopProcessFn = null,
  killProcessFn = null,
  deleteProcessFn = null,
  auditPath = null,
  transaction,
} = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const resolvedRegistryPath = registryPath ? path.resolve(registryPath) : path.join(root, "mybot", "mybots.json");

  if (!fs.existsSync(resolvedRegistryPath)) {
    throw new Error(`File registry không tồn tại: ${resolvedRegistryPath}`);
  }

  const myBots = loadMyBotsRegistry(resolvedRegistryPath);
  const botRecord = myBots[botKey];

  if (!botRecord) {
    return { success: false, error: `Không tìm thấy bot ${botKey} trong registry` };
  }

  // Safety check: protect main bot
  assertCanDeleteBot(botRecord, botKey);
  await invalidateBotStartOperation(botKey, { root });

  // 1. Save previous status and mark as deleting
  const previousStatus = botRecord.status || "stopped";
  botRecord.status = "deleting";
  botRecord.lastUpdated = new Date().toISOString();
  saveMyBotsRegistry(myBots, resolvedRegistryPath);

  try {
    let deleteResult;
    try {
      if (typeof deleteProcessFn === "function") {
        deleteResult = await deleteProcessFn(botKey);
      } else {
        const { PM2Adapter } = await import("../../../runtime/pm2-adapter.js");
        const adapter = new PM2Adapter({ projectRoot: root });
        deleteResult = await adapter.deleteBot(botKey, { botKey, registryPath: resolvedRegistryPath });
      }
    } catch (err) {
      deleteResult = {
        success: false,
        reason: err.code || "pm2_delete_failed",
        verifiedAbsent: false,
        ownershipVerified: false,
        detail: err.message || String(err),
      };
    }

    const isDeleteOk = Boolean(
      deleteResult &&
      typeof deleteResult === "object" &&
      deleteResult.success === true &&
      deleteResult.verifiedAbsent === true &&
      deleteResult.ownershipVerified === true
    );

    if (!isDeleteOk) {
      // Rollback registry status and fail closed
      botRecord.status = previousStatus;
      botRecord.lastDeleteError = deleteResult?.detail || deleteResult?.reason || "PM2 delete failed";
      botRecord.lastUpdated = new Date().toISOString();
      saveMyBotsRegistry(myBots, resolvedRegistryPath);

      return {
        success: false,
        reason: deleteResult?.reason || "pm2_delete_failed",
        pm2Name: deleteResult?.pm2Name || botKey,
        verifiedAbsent: Boolean(deleteResult?.verifiedAbsent),
        ownershipVerified: Boolean(deleteResult?.ownershipVerified),
        detail: deleteResult?.detail || "Không thể xác nhận process đã được xóa khỏi PM2",
        error: `Không thể xóa PM2 process (${deleteResult?.reason || "lỗi"}): ${deleteResult?.detail || "Process vẫn còn trong PM2"}`.trim(),
      };
    }

    // 3. Kill spawned direct-spawn legacy process if present (safe handle only, no raw PID reuse kill)
    if (typeof killProcessFn === "function") {
      try {
        await killProcessFn(botKey);
      } catch (e) {
        console.warn(`Lỗi kill spawned process cho ${botKey}:`, e.message);
      }
    }

    // 3. Collect paths to clean up
    // Account UID is not a storage alias. Deleting that UID path may destroy
    // another legacy bot whose stable management key happens to match it.
    const targetUid = String(botKey);
    const candidateFiles = [
      path.join(root, "mybot", "credentials", `${targetUid}.json`),
      path.join(root, "mybot", "credentials", `${botKey}.json`),
      path.join(root, "mybot", "configs", `list_admin-${targetUid}.json`),
      path.join(root, "mybot", "configs", `list_admin-${botKey}.json`),
      path.join(root, "mybot", "settings", `groupSettings-${targetUid}.json`),
      path.join(root, "mybot", "settings", `groupSettings-${botKey}.json`),
      path.join(root, "mybot", "json-data", `command-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `command-${botKey}.json`),
      path.join(root, "mybot", "json-data", `manager-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `manager-${botKey}.json`),
      path.join(root, "mybot", "json-data", `game_data-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `game_data-${botKey}.json`),
      path.join(root, "mybot", "json-data", `nong-trai-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `nong-trai-${botKey}.json`),
      path.join(root, "mybot", "json-data", `prophylactic-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `prophylactic-${botKey}.json`),
      path.join(root, "mybot", "json-data", `web_config-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `database_config-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `data_training-${targetUid}.json`),
      path.join(root, "mybot", "json-data", `rank_info-${targetUid}.json`),
      path.join(root, "mybot", "bots", `${targetUid}.json`),
      path.join(root, "mybot", "bots", `${botKey}.json`),
      path.join(root, "mybot", "state", `${targetUid}.json`),
      path.join(root, "mybot", "state", `${botKey}.json`),
      path.join(root, "mybot", "state", "reload", `${targetUid}.json`),
      path.join(root, "mybot", "state", "reload", `${botKey}.json`),
      path.join(root, "mybot", "state", "identity", `${targetUid}.json`),
      path.join(root, "mybot", "state", "identity", `${botKey}.json`),
      path.join(root, "mybot", "logs", `bot-${targetUid}.ndjson`),
      path.join(root, "mybot", "logs", `bot-${targetUid}.ndjson.1`),
      path.join(root, "mybot", "logs", `bot-${botKey}.ndjson`),
      path.join(root, "mybot", "logs", `bot-${botKey}.ndjson.1`),
      path.join(root, "data", `reminders_${targetUid}.json`),
      path.join(root, "data", `reminders_${botKey}.json`),
    ];

    const candidateDirs = [
      path.join(root, "mybot", "instances", targetUid),
      path.join(root, "mybot", "instances", botKey),
      path.join(root, "logs", targetUid),
      path.join(root, "logs", botKey),
      path.join(root, "assets", "resources", targetUid),
      path.join(root, "assets", "resources", botKey),
      path.join(root, "assets", "temp", targetUid),
      path.join(root, "assets", "temp", botKey),
    ];

    // Protected paths check
    const protectedPaths = new Set([
      root,
      path.join(root, "src"),
      path.join(root, "assets"),
      path.join(root, "assets", "data"),
      path.join(root, "mybot"),
      path.join(root, "mybot", "state", "admin.json"),
      path.join(root, "mybot", "mybots.json"),
    ]);

    for (const filePath of candidateFiles) {
      if (protectedPaths.has(filePath)) continue;
      if (!filePath.startsWith(root)) continue;
      try {
        if (await fsPromises.access(filePath).then(() => true).catch(() => false)) {
          transaction.trackFile(filePath);
          await fsPromises.unlink(filePath);
        }
      } catch (err) {
        throw new Error(`Không thể xóa file dữ liệu của bot: ${err.code || "DELETE_DATA_FAILED"}`, { cause: err });
      }
    }

    for (const dirPath of candidateDirs) {
      if (protectedPaths.has(dirPath)) continue;
      if (!dirPath.startsWith(root)) continue;
      try {
        if (await fsPromises.access(dirPath).then(() => true).catch(() => false)) {
          await trackDirectoryFiles(dirPath, transaction);
          await fsPromises.rm(dirPath, { recursive: true, force: true });
        }
      } catch (err) {
        throw new Error(`Không thể xóa thư mục dữ liệu của bot: ${err.code || "DELETE_DATA_FAILED"}`, { cause: err });
      }
    }

    // 4. Remove from registry
    delete myBots[botKey];
    saveMyBotsRegistry(myBots, resolvedRegistryPath);

    // 5. Append audit (no secrets)
    if (auditPath) {
      try {
        await fsPromises.mkdir(path.dirname(auditPath), { recursive: true });
        const record = {
          ts: new Date().toISOString(),
          action: "delete",
          botKey,
          targetUid,
          actorId: String(actorId || ""),
          result: "ok",
        };
        await fsPromises.appendFile(auditPath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {}
    }

    // 6. Release creation quota for owner
    const ownerUid = botRecord.ownerUid || botRecord.createdByUid || (/^\d{10,}$/.test(String(botRecord.createdBy || "")) ? botRecord.createdBy : null);
    if (ownerUid) {
      try {
        releaseCreationQuota(ownerUid, targetUid, { projectRoot: root });
      } catch {}
    }

    return {
      success: true,
      reason: "deleted",
      botKey,
      targetUid,
      pm2Name: deleteResult?.pm2Name || botKey,
      verifiedAbsent: true,
      ownershipVerified: true,
      detail: deleteResult?.detail || "",
      cleanedFiles: candidateFiles.length,
      cleanedDirs: candidateDirs.length,
    };
  } catch (error) {
    botRecord.status = previousStatus;
    botRecord.lastDeleteError = error.message;
    botRecord.lastUpdated = new Date().toISOString();
    saveMyBotsRegistry(myBots, resolvedRegistryPath);
    throw error;
  }
}

async function trackDirectoryFiles(directory, transaction) {
  for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Object.assign(new Error("Refusing symlink in bot delete data"), { code: "DELETE_PATH_UNSAFE" });
    if (entry.isDirectory()) await trackDirectoryFiles(file, transaction);
    else if (entry.isFile()) transaction.trackFile(file);
  }
}

export async function cleanExpiredBotsLogic({
  projectRoot = process.cwd(),
  registryPath,
  deleteFn = null,
  now = Date.now(),
} = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const resolvedRegistryPath = registryPath ? path.resolve(registryPath) : path.join(root, "mybot", "mybots.json");

  if (!fs.existsSync(resolvedRegistryPath)) {
    return { cleaned: [], failed: [] };
  }

  const raw = await fsPromises.readFile(resolvedRegistryPath, "utf8");
  const myBots = JSON.parse(raw) || {};

  const expiredList = [];
  for (const [key, record] of Object.entries(myBots)) {
    if (isMainBot(record, key)) continue;
    if (record.expiryAt === "-1") continue;

    const expiryTime = Date.parse(record.expiryAt);
    const isExpiredTime = !isNaN(expiryTime) && expiryTime <= now;
    const isExpiredStatus = record.status === "expired" || record.status === "trialExpired";

    if (isExpiredTime || isExpiredStatus) {
      expiredList.push({ key, record });
    }
  }

  const cleaned = [];
  const failed = [];

  for (const item of expiredList) {
    try {
      if (typeof deleteFn === "function") {
        await deleteFn({ projectRoot: root, registryPath: resolvedRegistryPath, botKey: item.key });
      } else {
        await deleteChildBotLogic({ projectRoot: root, registryPath: resolvedRegistryPath, botKey: item.key });
      }
      cleaned.push({ botKey: item.key, displayName: item.record.displayName || item.key });
    } catch (err) {
      failed.push({ botKey: item.key, error: err.message });
    }
  }

  return { cleaned, failed };
}

export async function sendNotifyToOwners({
  targets = [],
  messageText = "",
  sendFn,
  concurrency = 3,
  timeoutMs = 10000,
  projectRoot = process.cwd(),
} = {}) {
  const root = path.resolve(projectRoot || process.cwd());

  // 1. Filter out Main Bot
  const childTargets = (Array.isArray(targets) ? targets : []).filter((t) => !t.isMain && t.key !== "admin");

  // 2. Group by ownerUid to deduplicate
  const ownerMap = new Map();
  let missingOwnerCount = 0;
  const missingOwnerBots = [];

  for (const target of childTargets) {
    const isMissingResolution = target.ownerResolution === "missing";
    const ownerUid = String(
      target.ownerUid ||
      target.profile?.ownerUid ||
      target.rawRecord?.ownerUid ||
      target.rawRecord?.createdByUid ||
      ""
    ).trim();

    const botUid = String(target.uid || target.key || "").trim();

    // Owner is missing if explicitly marked missing, or no UID, or equals admin, or equals child bot's own UID
    if (isMissingResolution || !ownerUid || ownerUid.toLowerCase() === "admin" || (botUid && ownerUid === botUid)) {
      missingOwnerCount += 1;
      missingOwnerBots.push({
        key: target.key,
        name: target.displayName || target.nameServer || target.key,
        uid: target.uid,
      });
      continue;
    }

    if (!ownerMap.has(ownerUid)) {
      ownerMap.set(ownerUid, []);
    }
    ownerMap.get(ownerUid).push(target);
  }

  const uniqueOwners = Array.from(ownerMap.keys());
  const dedupedCount = Math.max(0, childTargets.length - missingOwnerCount - uniqueOwners.length);

  const auditPath = path.join(root, "logs", "owner-notify-audit.jsonl");
  const appendAudit = (record) => {
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {}
  };

  if (uniqueOwners.length === 0) {
    return {
      totalChildBots: childTargets.length,
      totalOwners: 0,
      successCount: 0,
      failCount: 0,
      deliveredCount: 0,
      acceptedCount: 0,
      deliveredOwners: [],
      acceptedOwners: [],
      failedOwners: [],
      missingOwnerCount,
      missingOwnerBots,
      dedupedCount,
    };
  }

  const failedOwners = [];
  const deliveredOwners = [];
  const acceptedOwners = [];
  let successCount = 0;

  const chunkSize = Math.max(1, concurrency);
  for (let i = 0; i < uniqueOwners.length; i += chunkSize) {
    const chunk = uniqueOwners.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (ownerUid) => {
        let sent = false;
        let lastError = null;
        let receipt = null;
        let attemptsUsed = 0;

        for (let attempt = 0; attempt < 2; attempt++) {
          attemptsUsed += 1;
          try {
            if (typeof sendFn === "function") {
              let timer = null;
              const sendPromise = sendFn(ownerUid, messageText);
              const timeoutPromise = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Send timeout")), timeoutMs);
                if (timer.unref) timer.unref();
              });
              let result;
              try {
                result = await Promise.race([sendPromise, timeoutPromise]);
              } finally {
                if (timer) clearTimeout(timer);
              }
              sent = true;
              successCount += 1;

              const msgId = result?.msgId || result?.messageId || result?.data?.msgId || null;
              if (msgId) {
                receipt = String(msgId);
                deliveredOwners.push({ ownerUid, status: "delivered", receipt, attempts: attemptsUsed });
              } else {
                acceptedOwners.push({ ownerUid, status: "accepted", attempts: attemptsUsed });
              }

              appendAudit({
                ts: new Date().toISOString(),
                ownerUid,
                status: receipt ? "delivered" : "accepted",
                receipt,
                attempts: attemptsUsed,
                botKeys: (ownerMap.get(ownerUid) || []).map((b) => b.key),
              });
              break;
            }
          } catch (err) {
            lastError = err;
            if (attempt < 1) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }
        if (!sent) {
          const errMsg = lastError?.message || "Unknown send failure";
          failedOwners.push({ ownerUid, error: errMsg, attempts: attemptsUsed });
          appendAudit({
            ts: new Date().toISOString(),
            ownerUid,
            status: "failed",
            error: errMsg,
            attempts: attemptsUsed,
            botKeys: (ownerMap.get(ownerUid) || []).map((b) => b.key),
          });
        }
      })
    );
  }

  return {
    totalChildBots: childTargets.length,
    totalOwners: uniqueOwners.length,
    successCount,
    failCount: failedOwners.length,
    deliveredCount: deliveredOwners.length,
    acceptedCount: acceptedOwners.length,
    deliveredOwners,
    acceptedOwners,
    failedOwners,
    missingOwnerCount,
    missingOwnerBots,
    dedupedCount,
  };
}

export async function executeNotifyBroadcast({
  targetUids = [],
  messageText = "",
  sendFn,
  concurrency = 3,
} = {}) {
  const cleanUids = [...new Set(targetUids.map((u) => String(u || "").trim()).filter((u) => u && u.toLowerCase() !== "admin"))];

  if (cleanUids.length === 0) {
    return { total: 0, successCount: 0, failCount: 0, failedUids: [] };
  }

  const failedUids = [];
  let successCount = 0;

  // Process in batches of size `concurrency`
  const chunkSize = Math.max(1, concurrency);
  for (let i = 0; i < cleanUids.length; i += chunkSize) {
    const chunk = cleanUids.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (uid) => {
        try {
          if (typeof sendFn === "function") {
            await sendFn(uid, messageText);
            successCount += 1;
          }
        } catch (error) {
          failedUids.push(uid);
        }
      })
    );
  }

  return {
    total: cleanUids.length,
    successCount,
    failCount: failedUids.length,
    failedUids,
  };
}
