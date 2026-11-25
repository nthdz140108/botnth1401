import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LRUCache } from "lru-cache";

import { MessageType } from "../../api-zalo/models/index.js";
import { appContext } from "../../api-zalo/context.js";
import { getBotId, getBotName } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import {
  sendMessageFailed,
  sendMessageInsufficientAuthority,
  sendMessageResultRequest,
  sendMessageStateQuote,
  sendMessageWarning,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { getDataAllGroup, getGroupAdmins, getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { createBotRuntimeContext, ensureRuntimeDirectories } from "../../utils/bot-runtime-context.js";
import { removeMention } from "../../utils/format-util.js";
import {
  extractCleanArgs,
  getQuotedUid,
  resolveTargetUsers,
  safeThreadType,
} from "../shared/command-input-utils.js";
import {
  createNqduanApiAdapter,
  createNqduanBridgeRuntime,
  normalizeNqduanMessage,
} from "./nqduan-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEGACY_SRC_TAGET_PATH = path.join(__dirname, "tagetList.json");

const recentJoinBlockDedupe = new LRUCache({ max: 1000, ttl: 5000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureGroupSettings(groupSettings, threadId) {
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  return groupSettings[threadId];
}

function normalizeId(value) {
  return String(value ?? "").trim().split("_")[0];
}

function resolveSafeAlias(aliasCommand, fallback) {
  return typeof aliasCommand === "string" && aliasCommand.trim() ? aliasCommand.trim() : fallback;
}

export function getCanonicalTargetStorePath() {
  const activeCtx = getActiveRuntimeContext();
  if (activeCtx?.dataDir) {
    return path.join(activeCtx.dataDir, "target-list.json");
  }
  const botKey = getBotName() || getBotId() || "admin";
  const context = createBotRuntimeContext(botKey);
  ensureRuntimeDirectories(context);
  return path.join(context.dataDir, "target-list.json");
}

function normalizeStoreShape(rawObj) {
  const normalized = {};
  if (!rawObj || typeof rawObj !== "object" || Array.isArray(rawObj)) return normalized;

  for (const [threadId, entry] of Object.entries(rawObj)) {
    if (!entry || typeof entry !== "object") continue;
    const rawItems = [
      ...(Array.isArray(entry.targetList) ? entry.targetList : []),
      ...(Array.isArray(entry.tagetList) ? entry.tagetList : []),
    ];
    const seen = new Set();
    const mergedList = [];
    for (const item of rawItems) {
      const uid = normalizeId(item?.idUserZalo ?? item?.uid ?? item?.id);
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      mergedList.push({
        idUserZalo: uid,
        senderName: String(item?.senderName || item?.name || uid).trim(),
      });
    }
    normalized[threadId] = { targetList: mergedList };
  }
  return normalized;
}

export async function readUnifiedTargetStore() {
  const canonicalPath = getCanonicalTargetStorePath();
  if (fsSync.existsSync(canonicalPath)) {
    try {
      const raw = await fs.readFile(canonicalPath, "utf8");
      return normalizeStoreShape(JSON.parse(raw.replace(/^\uFEFF/, "")));
    } catch {
      return {};
    }
  }

  const activeCtx = getActiveRuntimeContext();
  const legacyCandidates = [
    activeCtx?.dataDir ? path.join(activeCtx.dataDir, "tagetList.json") : null,
    activeCtx?.stateDir ? path.join(activeCtx.stateDir, "target-list.json") : null,
    LEGACY_SRC_TAGET_PATH,
  ].filter(Boolean);

  let migrated = {};
  let foundLegacy = false;
  for (const legacyPath of legacyCandidates) {
    if (!fsSync.existsSync(legacyPath)) continue;
    try {
      const raw = await fs.readFile(legacyPath, "utf8");
      const parsed = normalizeStoreShape(JSON.parse(raw.replace(/^\uFEFF/, "")));
      for (const [tId, val] of Object.entries(parsed)) {
        if (!migrated[tId]) migrated[tId] = { targetList: [] };
        const existingUids = new Set(migrated[tId].targetList.map((i) => i.idUserZalo));
        for (const item of val.targetList) {
          if (!existingUids.has(item.idUserZalo)) {
            existingUids.add(item.idUserZalo);
            migrated[tId].targetList.push(item);
          }
        }
      }
      foundLegacy = true;
    } catch {}
  }

  if (foundLegacy) {
    await writeUnifiedTargetStore(migrated).catch(() => {});
  }

  return migrated;
}

export async function writeUnifiedTargetStore(data) {
  const filePath = getCanonicalTargetStorePath();
  const normalized = normalizeStoreShape(data);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
    await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), "utf8");
  }
}

export async function isUserTargeted(senderId, threadId) {
  try {
    const data = await readUnifiedTargetStore();
    const normalizedSenderId = normalizeId(senderId);
    const list = data?.[threadId]?.targetList || [];
    return list.some((tagged) => String(tagged.idUserZalo) === normalizedSenderId);
  } catch {
    return false;
  }
}

async function sendConversationText(api, threadId, messageText, ttl = 300000, msgType = MessageType.GroupMessage) {
  await api.sendMessage({ msg: messageText, ttl }, threadId, msgType);
}

export async function handleKickImageCommand(api, message, groupSettings) {
  api = createNqduanApiAdapter(api, { commandName: "kickimg", commandGroup: "antiService" });
  message = normalizeNqduanMessage(message);
  const threadId = message.threadId;
  const content = removeMention(message);
  const status = content.trim().split(/\s+/)[1]?.toLowerCase();
  const setting = ensureGroupSettings(groupSettings, threadId);

  if (status === "on") setting.enableKickImage = true;
  else if (status === "off") setting.enableKickImage = false;
  else setting.enableKickImage = !setting.enableKickImage;

  const newStatus = setting.enableKickImage ? "bật" : "tắt";
  await sendMessageStateQuote(
    api,
    message,
    `Chức năng thông báo kick thành viên đã được ${newStatus}!`,
    setting.enableKickImage,
    300000
  );
  return true;
}

export async function handleBlockImageCommand(api, message, groupSettings) {
  api = createNqduanApiAdapter(api, { commandName: "blockimg", commandGroup: "antiService" });
  message = normalizeNqduanMessage(message);
  const threadId = message.threadId;
  const content = removeMention(message);
  const status = content.trim().split(/\s+/)[1]?.toLowerCase();
  const setting = ensureGroupSettings(groupSettings, threadId);

  if (status === "on") setting.enableBlockImage = true;
  else if (status === "off") setting.enableBlockImage = false;
  else setting.enableBlockImage = !setting.enableBlockImage;

  const newStatus = setting.enableBlockImage ? "bật" : "tắt";
  await sendMessageStateQuote(
    api,
    message,
    `Chức năng thông báo block thành viên đã được ${newStatus}!`,
    setting.enableBlockImage,
    300000
  );
  return true;
}

export async function handleDisperseGroupCommand(api, message, groupInfo = null) {
  const runtime = createNqduanBridgeRuntime({
    commandName: "dispersegroup",
    api,
    message,
  });
  api = runtime.api;
  message = runtime.message;
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;

  if (safeThreadType(message) !== MessageType.GroupMessage) {
    await sendMessageWarning(api, message, "Lệnh này chỉ có thể dùng trong nhóm chat.");
    return false;
  }

  if (!isAdmin(senderId, threadId)) {
    await sendMessageWarning(api, message, "Chỉ quản trị viên cấp cao mới có quyền giải tán nhóm.");
    return false;
  }

  let resolvedInfo = groupInfo?.gridInfoMap?.[threadId] || groupInfo;
  if (!resolvedInfo?.creatorId) {
    resolvedInfo = await getGroupInfoData(api, threadId).catch(() => null);
  }
  const botId = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "").trim();

  if (!resolvedInfo || !botId || String(resolvedInfo.creatorId) !== botId) {
    await sendMessageWarning(
      api,
      message,
      "🔑 Bot chưa giữ Key Vàng (Trưởng nhóm) nên không thể giải tán nhóm này!",
      false
    );
    return false;
  }

  try {
    await sendMessageWarning(api, message, "⚠️ Đang tiến hành GIẢI TÁN NHÓM...", false);
    await api.disperseGroup(threadId);
    return true;
  } catch (error) {
    await sendMessageFailed(api, message, `❌ Giải tán nhóm thất bại: ${error?.message || error}`);
    return false;
  }
}

export async function handleLeaveLockedGroups(api, message) {
  const runtime = createNqduanBridgeRuntime({
    commandName: "leavelock",
    api,
    message,
  });
  api = runtime.api;
  message = runtime.message;
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  const isGroupCall = msgType === MessageType.GroupMessage;
  const botId = String(getBotId() || appContext?.uid || "");

  await sendMessageResultRequest(api, msgType, threadId, "🔍 Đang quét các nhóm bị khóa chat...", true, 15000);

  try {
    const groups = await getDataAllGroup(api);
    let leftCount = 0;

    for (const group of groups) {
      if (isGroupCall && String(group.groupId) === String(threadId)) {
        continue;
      }
      try {
        const groupInfo = await getGroupInfoData(api, group.groupId);
        const isLocked = groupInfo?.lockSendMsg === 1 || groupInfo?.setting?.lockSendMsg === 1;
        if (!isLocked) continue;

        const groupAdmins = await getGroupAdmins(groupInfo);
        if (botId && groupAdmins.map(String).includes(botId)) continue;

        await api.leaveGroup(group.groupId);
        leftCount++;
        await sleep(300);
      } catch (error) {
        console.error(`Lỗi khi xử lý group ${group.groupId}:`, error.message);
      }
    }

    await sendMessageResultRequest(
      api,
      msgType,
      threadId,
      leftCount > 0
        ? `✅ Đã rời ${leftCount} box bị khóa chat (đã bỏ qua các box mà bot là QTV${isGroupCall ? " và box hiện tại" : ""}).`
        : `⚡ Không tìm thấy box nào bị khóa chat cần rời.`,
      true,
      180000
    );
    return true;
  } catch (error) {
    await sendMessageFailed(api, message, `❌ Lỗi khi quét box: ${error.message}`);
    return false;
  }
}

export async function handleLeaveAllBoxCommand(api, message) {
  const runtime = createNqduanBridgeRuntime({
    commandName: "leaveallbox",
    api,
    message,
  });
  api = runtime.api;
  message = runtime.message;
  const commandBoxId = message.threadId;
  const msgType = safeThreadType(message);
  const isGroupCall = msgType === MessageType.GroupMessage;

  try {
    await sendConversationText(
      api,
      commandBoxId,
      isGroupCall
        ? "🚀 Đang rời tất cả box...\n[ Bỏ qua box gọi lệnh ]"
        : "🚀 Đang tiến hành rời tất cả các nhóm...",
      60000,
      msgType
    );

    const groups = await getDataAllGroup(api);
    let successCount = 0;

    for (const group of groups) {
      if (isGroupCall && String(group.groupId) === String(commandBoxId)) continue;
      try {
        await api.leaveGroup(group.groupId);
        successCount++;
      } catch (error) {
        console.error(`Không thoát được nhóm ${group.groupId}:`, error.message);
      }
      await sleep(300);
    }

    await sendConversationText(
      api,
      commandBoxId,
      `✅ Đã rời thành công ${successCount} nhóm.`,
      60000,
      msgType
    );
    return true;
  } catch (error) {
    await sendConversationText(
      api,
      commandBoxId,
      `❌ Lỗi khi xử lý: ${error.message}`,
      60000,
      msgType
    );
    return false;
  }
}

async function applyKeyAction(api, message, threadId, targetId, targetName, action) {
  try {
    if (action === "gold") {
      await api.changeGroupOwner(threadId, targetId);
      await sendMessageStateQuote(api, message, `Đã đưa key vàng cho ${targetName}.`, true, 300000);
      return true;
    }
    if (action === "up") {
      await api.addGroupAdmins(threadId, targetId);
      await sendMessageStateQuote(api, message, `Đã phong key bạc cho ${targetName}.`, true, 300000);
      return true;
    }
    await api.removeGroupAdmins(threadId, targetId);
    await sendMessageStateQuote(api, message, `Đã hạ key của ${targetName}.`, true, 300000);
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể xử lý key cho ${targetName}: ${error.message}`, false, 300000);
    return false;
  }
}

export async function handleKeyCommand(api, message, groupSettings, isAdminLevelHighest, aliasCommand = "key") {
  const runtime = createNqduanBridgeRuntime({
    commandName: "key",
    api,
    message,
    groupSettings,
    isAdminLevelHighest,
  });
  api = runtime.api;
  message = runtime.message;
  groupSettings = runtime.groupSettings;
  isAdminLevelHighest = runtime.permissions.allowed;
  const threadId = message.threadId;
  const senderId = normalizeId(message.data?.uidFrom);
  const prefix = getGlobalPrefix();
  const effectiveAlias = resolveSafeAlias(aliasCommand, "key");
  const args = extractCleanArgs(message, prefix, effectiveAlias);
  const sub = args[0]?.toLowerCase() || "";

  const sendGuide = async (extraWarn = "") => {
    const lines = [
      extraWarn || null,
      "🔑 HƯỚNG DẪN LỆNH KEY",
      `• ${prefix}${effectiveAlias} gold [@mention | reply | UID]: Nhường Key Vàng`,
      `• ${prefix}${effectiveAlias} up [@mention | reply | UID]: Phong Key Bạc`,
      `• ${prefix}${effectiveAlias} down <@mention | reply | UID>: Hạ Key Bạc`,
    ].filter(Boolean);
    await sendMessageStateQuote(api, message, lines.join("\n"), !extraWarn, 600000);
  };

  if (!sub) {
    await sendGuide();
    return true;
  }

  if (sub !== "gold" && sub !== "up" && sub !== "down") {
    await sendGuide(`⚠️ Lệnh con "${sub}" không hợp lệ!`);
    return true;
  }

  if (!isAdminLevelHighest) {
    await sendMessageStateQuote(api, message, "Chỉ chủ bot mới được dùng lệnh key!", false, 300000);
    return true;
  }

  ensureGroupSettings(groupSettings, threadId);

  const rawMentions = Array.isArray(message.data?.mentions) ? message.data.mentions : [];
  const rawContent = typeof message.data?.content === "string" ? message.data.content : "";
  const targets = [];
  const seen = new Set();

  for (const mention of rawMentions) {
    const uid = normalizeId(mention?.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const name =
      typeof mention.pos === "number" && typeof mention.len === "number"
        ? rawContent.substring(mention.pos, mention.pos + mention.len).replace("@", "").trim() || uid
        : uid;
    targets.push({ uid, name });
  }

  const quotedUid = getQuotedUid(message);
  if (quotedUid && !seen.has(quotedUid)) {
    seen.add(quotedUid);
    targets.push({ uid: quotedUid, name: message.data?.quote?.fromD || quotedUid });
  }

  for (const tok of args.slice(1)) {
    const uid = normalizeId(tok.replace(/^@+/, ""));
    if (/^\d{6,24}$/.test(uid) && !seen.has(uid)) {
      seen.add(uid);
      targets.push({ uid, name: uid });
    }
  }

  if (targets.length === 0) {
    if (sub === "down") {
      await sendMessageWarning(
        api,
        message,
        `⚠️ Vui lòng @mention, reply tin nhắn hoặc nhập UID phó nhóm cần hạ key: ${prefix}${effectiveAlias} down <@user|UID>`,
        false
      );
      return true;
    }
    await applyKeyAction(api, message, threadId, senderId, "bạn", sub);
    return true;
  }

  if (sub === "gold" && targets.length > 1) {
    await sendMessageWarning(api, message, "⚠️ Chỉ có thể nhường Key Vàng (Trưởng nhóm) cho 1 người duy nhất!", false);
    return true;
  }

  for (const t of targets) {
    await applyKeyAction(api, message, threadId, t.uid, t.name, sub);
  }

  return true;
}

async function sendUnifiedTargetHelp(api, message, aliasCommand = "target") {
  const prefix = getGlobalPrefix();
  await sendMessageWarning(
    api,
    message,
    [
      `🎯 HƯỚNG DẪN LỆNH ${aliasCommand.toUpperCase()}`,
      `• ${prefix}${aliasCommand} add <@user | reply | UID>: Chặn & tự động chặn khi vào lại`,
      `• ${prefix}${aliasCommand} list: Xem danh sách đang bị target`,
      `• ${prefix}${aliasCommand} remove <STT | UID | @user>: Gỡ khỏi target & mở chặn Zalo`,
      `• ${prefix}${aliasCommand} clear (hoặc remove all): Xóa toàn bộ danh sách target nhóm`,
    ].join("\n"),
    false
  );
}

async function unblockMembersOnZalo(api, threadId, uids) {
  if (!uids.length) return;
  try {
    if (typeof api?.removeGroupBlockedMember === "function") {
      await api.removeGroupBlockedMember(uids, threadId);
    } else if (typeof api?.unblockUsers === "function") {
      await api.unblockUsers(threadId, uids);
    }
  } catch {}
}

export async function executeUnifiedTargetCommand(api, message, groupInfo = null, aliasCommand = "target") {
  const effectiveAlias = resolveSafeAlias(aliasCommand, "target");
  const senderId = normalizeId(message?.data?.uidFrom);
  const threadId = message?.threadId;
  const prefix = getGlobalPrefix();

  if (!isAdmin(senderId, threadId)) {
    await sendMessageInsufficientAuthority(api, message, "Bạn không có quyền sử dụng lệnh này!");
    return false;
  }

  const args = extractCleanArgs(message, prefix, effectiveAlias);
  const firstToken = (args[0] || "").toLowerCase();
  const hasDirectMentionsOrQuote =
    (Array.isArray(message?.data?.mentions) && message.data.mentions.length > 0) ||
    Boolean(getQuotedUid(message));

  let action = firstToken;
  let actionArgs = args.slice(1);

  if (!["add", "list", "ls", "remove", "rm", "del", "clear", "help"].includes(action)) {
    if (hasDirectMentionsOrQuote || /^\d{6,24}$/.test(firstToken)) {
      action = "add";
      actionArgs = args;
    }
  }

  if (!action || action === "help") {
    await sendUnifiedTargetHelp(api, message, effectiveAlias);
    return true;
  }

  if (action === "list" || action === "ls") {
    const targetData = await readUnifiedTargetStore();
    const targetList = targetData[threadId]?.targetList || [];

    if (targetList.length === 0) {
      await sendMessageStateQuote(api, message, "✅ Nhóm này hiện chưa có ai trong danh sách target.", true, 300000);
      return true;
    }

    const lines = targetList
      .map((entry, index) => `${index + 1}. ${entry.senderName || entry.idUserZalo} (${entry.idUserZalo})`)
      .slice(0, 50);

    await sendMessageStateQuote(
      api,
      message,
      `📋 Danh sách target (${targetList.length}):\n${lines.join("\n")}`,
      true,
      300000
    );
    return true;
  }

  if (action === "clear" || (["remove", "rm", "del"].includes(action) && String(actionArgs[0] || "").toLowerCase() === "all")) {
    const targetData = await readUnifiedTargetStore();
    const currentList = targetData[threadId]?.targetList || [];
    if (currentList.length === 0) {
      await sendMessageStateQuote(api, message, "✅ Danh sách target của nhóm đã trống.", true, 300000);
      return true;
    }

    const uidsToUnblock = currentList.map((item) => item.idUserZalo).filter(Boolean);
    targetData[threadId] = { targetList: [] };
    await writeUnifiedTargetStore(targetData);
    await unblockMembersOnZalo(api, threadId, uidsToUnblock);

    await sendMessageStateQuote(
      api,
      message,
      `✅ Đã xóa toàn bộ ${currentList.length} người dùng khỏi danh sách target và gửi yêu cầu mở chặn nhóm.`,
      true,
      300000
    );
    return true;
  }

  if (["remove", "rm", "del"].includes(action)) {
    const targetData = await readUnifiedTargetStore();
    const targetList = targetData[threadId]?.targetList || [];
    if (targetList.length === 0) {
      await sendMessageStateQuote(api, message, "✅ Danh sách target của nhóm hiện đang trống.", true, 300000);
      return true;
    }

    const directUids = resolveTargetUsers(message, actionArgs);
    if (directUids.length > 0) {
      const removeSet = new Set(directUids);
      const removedEntries = targetList.filter((item) => removeSet.has(String(item.idUserZalo)));
      if (removedEntries.length === 0) {
        await sendMessageWarning(api, message, "Người dùng được chọn không có trong danh sách target.", false);
        return true;
      }
      targetData[threadId].targetList = targetList.filter((item) => !removeSet.has(String(item.idUserZalo)));
      await writeUnifiedTargetStore(targetData);
      await unblockMembersOnZalo(api, threadId, removedEntries.map((r) => r.idUserZalo));
      await sendMessageStateQuote(
        api,
        message,
        `✅ Đã gỡ khỏi danh sách target & mở chặn: ${removedEntries.map((r) => `${r.senderName} (${r.idUserZalo})`).join(", ")}.`,
        true,
        300000
      );
      return true;
    }

    const indexToRemove = Number.parseInt(actionArgs[0], 10);
    if (!Number.isInteger(indexToRemove) || indexToRemove <= 0) {
      await sendMessageWarning(
        api,
        message,
        `Vui lòng nhập số thứ tự, UID hoặc @mention cần xóa.\nDùng ${prefix}${effectiveAlias} list để xem danh sách.`,
        false
      );
      return true;
    }

    if (indexToRemove > targetList.length) {
      await sendMessageWarning(api, message, `Số thứ tự ${indexToRemove} không có trong danh sách (1-${targetList.length}).`, false);
      return true;
    }

    const removed = targetList[indexToRemove - 1];
    targetData[threadId].targetList = targetList.filter((_, idx) => idx !== indexToRemove - 1);
    await writeUnifiedTargetStore(targetData);
    await unblockMembersOnZalo(api, threadId, [removed.idUserZalo]);

    await sendMessageStateQuote(
      api,
      message,
      `✅ Đã xóa '${removed.senderName || removed.idUserZalo}' (STT ${indexToRemove}) khỏi danh sách target và mở chặn nhóm.`,
      true,
      300000
    );
    return true;
  }

  if (action === "add") {
    let resolvedInfo =
      groupInfo && (groupInfo.creatorId || groupInfo.adminIds || groupInfo.gridInfoMap)
        ? groupInfo.gridInfoMap?.[threadId] || groupInfo
        : null;
    if (!resolvedInfo) {
      resolvedInfo = await getGroupInfoData(api, threadId).catch(() => null);
    }

    const botId = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "").trim();
    const nativeGroupAdmins = new Set(
      [resolvedInfo?.creatorId, ...(Array.isArray(resolvedInfo?.adminIds) ? resolvedInfo.adminIds : [])]
        .filter(Boolean)
        .map(String)
    );

    if (botId && nativeGroupAdmins.size > 0 && !nativeGroupAdmins.has(botId)) {
      await sendMessageWarning(
        api,
        message,
        "🔑 Bot cần quyền Quản trị viên nhóm (Key Vàng/Key Bạc) để chặn và quản lý danh sách target!",
        false
      );
      return true;
    }

    const candidateUids = resolveTargetUsers(message, actionArgs);
    if (candidateUids.length === 0) {
      await sendMessageWarning(
        api,
        message,
        `Vui lòng @mention, reply tin nhắn hoặc nhập UID người cần target: ${prefix}${effectiveAlias} add <@user|UID>`,
        false
      );
      return true;
    }

    const rawContent = typeof message?.data?.content === "string" ? message.data.content : "";
    const mentionNameMap = new Map();
    for (const m of Array.isArray(message?.data?.mentions) ? message.data.mentions : []) {
      const mUid = normalizeId(m?.uid);
      if (mUid && typeof m.pos === "number" && typeof m.len === "number") {
        mentionNameMap.set(mUid, rawContent.substring(m.pos, m.pos + m.len).replace("@", "").trim());
      }
    }

    const usersToProcess = [];
    const skippedAdmins = [];

    for (const userId of candidateUids) {
      if (userId === botId || isAdmin(userId, threadId) || nativeGroupAdmins.has(userId)) {
        skippedAdmins.push(mentionNameMap.get(userId) || userId);
        continue;
      }
      let userName = mentionNameMap.get(userId) || "";
      if (!userName) {
        const info = await getUserInfoData(api, userId).catch(() => null);
        userName = info?.name || userId;
      }
      usersToProcess.push({ uid: userId, name: userName });
    }

    if (usersToProcess.length === 0) {
      await sendMessageWarning(
        api,
        message,
        skippedAdmins.length > 0
          ? `Không thể target Quản trị viên / Chủ nhóm / Bot: ${skippedAdmins.join(", ")}`
          : "Không có người dùng hợp lệ để target!",
        false
      );
      return true;
    }

    const targetData = await readUnifiedTargetStore();
    if (!targetData[threadId]) targetData[threadId] = { targetList: [] };

    const uidsToBlock = usersToProcess.map((u) => u.uid);
    let errorSet = new Set();
    if (typeof api?.blockUsers === "function") {
      try {
        const blockResult = await api.blockUsers(threadId, uidsToBlock);
        errorSet = new Set((blockResult?.errorMembers || []).map(String));
      } catch {
        errorSet = new Set(uidsToBlock);
      }
    }

    let addedNew = false;
    const successfullyBlockedNames = [];
    const savedForFutureNames = [];
    const alreadyTargetedNames = [];

    for (const user of usersToProcess) {
      const label = `${user.name} (${user.uid})`;
      const alreadyTargeted = targetData[threadId].targetList.some((tagged) => String(tagged.idUserZalo) === user.uid);
      if (alreadyTargeted) {
        alreadyTargetedNames.push(label);
        continue;
      }

      targetData[threadId].targetList.push({ idUserZalo: user.uid, senderName: user.name });
      addedNew = true;

      if (errorSet.has(user.uid)) savedForFutureNames.push(label);
      else successfullyBlockedNames.push(label);
    }

    if (addedNew) {
      await writeUnifiedTargetStore(targetData);
    }

    const lines = [];
    if (successfullyBlockedNames.length > 0) {
      lines.push(`✅ Đã target & chặn khỏi nhóm: ${successfullyBlockedNames.join(", ")}`);
    }
    if (savedForFutureNames.length > 0) {
      lines.push(`📌 Đã thêm vào target (sẽ tự động chặn ngay khi vào nhóm): ${savedForFutureNames.join(", ")}`);
    }
    if (alreadyTargetedNames.length > 0) {
      lines.push(`ℹ️ Đã có sẵn trong danh sách target: ${alreadyTargetedNames.join(", ")}`);
    }
    if (skippedAdmins.length > 0) {
      lines.push(`⚠️ Bỏ qua QTV/Bot: ${skippedAdmins.join(", ")}`);
    }

    await sendMessageStateQuote(api, message, lines.join("\n"), true, 300000);
    return true;
  }

  await sendUnifiedTargetHelp(api, message, effectiveAlias);
  return true;
}

export async function handleTargetCommand(api, message, aliasCommand = "target") {
  const runtime = createNqduanBridgeRuntime({
    commandName: "target",
    api,
    message,
  });
  return executeUnifiedTargetCommand(runtime.api, runtime.message, null, aliasCommand || "target");
}

export async function processUnifiedTargetJoin(api, event) {
  const threadId = event?.threadId;
  const updateMembers = event?.data?.updateMembers || [];
  if (!threadId || !updateMembers.length) return false;

  const targetData = await readUnifiedTargetStore();
  const groupTargetList = targetData?.[threadId]?.targetList || [];
  if (!groupTargetList.length) return false;

  const targetedMap = new Map(groupTargetList.map((item) => [String(item.idUserZalo), item.senderName || item.idUserZalo]));
  const matchedMembers = updateMembers.filter((m) => targetedMap.has(normalizeId(m?.id ?? m)));
  if (!matchedMembers.length) return false;

  // Deduplicate if both handleMemberJoin and handleTargetOnJoin fire on the same join event
  const pendingToBlock = [];
  let alreadyHandledInWindow = false;
  for (const m of matchedMembers) {
    const uid = normalizeId(m?.id ?? m);
    const dedupeKey = `${threadId}:${uid}`;
    if (recentJoinBlockDedupe.has(dedupeKey)) {
      alreadyHandledInWindow = true;
    } else {
      pendingToBlock.push({ uid, fallbackName: m?.dName || m?.name || targetedMap.get(uid) || uid });
    }
  }

  if (pendingToBlock.length === 0 && alreadyHandledInWindow) {
    return true;
  }

  const botId = String(
    getBotId() || appContext?.uid || (await api?.getBotId?.().catch?.(() => "")) || api?.getOwnId?.() || ""
  ).trim();
  const groupInfo = await getGroupInfoData(api, threadId).catch(() => null);
  const groupAdmins = groupInfo ? await getGroupAdmins(groupInfo).catch(() => []) : [];
  const botIsZaloGroupAdmin = Boolean(botId && groupAdmins.map(String).includes(botId));

  if (!botIsZaloGroupAdmin) {
    return false;
  }

  let blockedAny = false;
  const blockedLabels = [];
  for (const { uid, fallbackName } of pendingToBlock) {
    try {
      const res = await api.blockUsers(threadId, [uid]);
      const failed = Array.isArray(res?.errorMembers) && res.errorMembers.map(String).includes(uid);
      if (!failed) {
        recentJoinBlockDedupe.set(`${threadId}:${uid}`, true);
        blockedAny = true;
        const userInfo = await getUserInfoData(api, uid).catch(() => null);
        blockedLabels.push(userInfo?.name || fallbackName);
      }
    } catch {}
  }

  if (blockedLabels.length > 0) {
    await sendConversationText(
      api,
      threadId,
      `🚨 Đã tự động chặn ${blockedLabels.join(", ")} do nằm trong danh sách target của nhóm!`,
      300000,
      MessageType.GroupMessage
    ).catch(() => {});
  }

  return blockedAny || alreadyHandledInWindow;
}

export async function handleTargetOnJoin(api, event) {
  return processUnifiedTargetJoin(api, event);
}
