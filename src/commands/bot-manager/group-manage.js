import { MessageType } from "../../api-zalo/models/Message.js";
import { appContext } from "../../api-zalo/context.js";
import * as cv from "../../utils/canvas/index.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { getGroupInfoData } from "../../service-debug/info-service/group-info-data.js";
import {
  sendMessageWarning,
  sendMessageFromSQL,
  sendMessageInsufficientAuthority,
  sendMessageStateQuote,
  sendMessageCompleteRequest,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import {
  tempDir,
  readGroupSettings,
  getCommandConfig,
  isMainBotAdmin,
} from "../../utils/io-json.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { isAdmin } from "../../utils/role-policy.js";
import { getBotId } from "../../utils/env.js";
import { removeMention } from "../../utils/format-util.js";
import { managerData, saveManagerData } from "./active-bot.js";
import fsOnly from "fs";
import path from "path";
import { createBlockedBotListImage } from "../../utils/canvas/listblockbot-cavas.js";
import { createCanvas, loadImage } from "canvas";
import { deleteFile } from "../../utils/util.js";
import {
  extractCleanArgs,
  getQuotedUid,
  resolveTargetUsers,
  safeThreadType,
} from "../shared/command-input-utils.js";
import {
  executeUnifiedTargetCommand,
  isUserTargeted,
  processUnifiedTargetJoin,
} from "./nqduan-bridge.js";

const BATCH_MODERATION_SIZE = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveSafeAlias(aliasCommand, fallback) {
  return typeof aliasCommand === "string" && aliasCommand.trim() ? aliasCommand.trim() : fallback;
}

function normalizeId(value) {
  return String(value ?? "").trim().split("_")[0];
}

function extractMentionNameMap(message) {
  const map = new Map();
  const rawContent = typeof message?.data?.content === "string" ? message.data.content : "";
  const mentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];
  for (const m of mentions) {
    const uid = normalizeId(m?.uid);
    if (!uid) continue;
    if (typeof m.pos === "number" && typeof m.len === "number" && rawContent) {
      map.set(uid, rawContent.substring(m.pos, m.pos + m.len).replace("@", "").trim());
    }
  }
  return map;
}

export async function handleKick(api, message, groupInfo, aliasCommand = "kick") {
  const threadId = message.threadId;
  const effectiveAlias = resolveSafeAlias(aliasCommand, "kick");
  const prefix = getGlobalPrefix();

  let resolvedGroup =
    groupInfo && (groupInfo.name || groupInfo.creatorId || groupInfo.gridInfoMap)
      ? groupInfo.gridInfoMap?.[threadId] || groupInfo
      : null;
  if (!resolvedGroup && typeof api?.getGroupInfo === "function" && threadId) {
    try {
      const fetched = await api.getGroupInfo(threadId);
      resolvedGroup = fetched?.gridInfoMap?.[threadId] || fetched || null;
    } catch {}
  }

  const groupName = resolvedGroup?.name || "Nhóm";
  const groupType = resolvedGroup?.groupType ?? resolvedGroup?.type ?? 1;
  const senderName = message?.data?.dName || "Quản trị viên";
  const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);
  const candidateUids = resolveTargetUsers(message, cleanArgs);

  if (candidateUids.length === 0) {
    await sendMessageWarning(
      api,
      message,
      ":D Đại Ca muốn kick ai? Hãy @mention, reply tin nhắn hoặc nhập UID! 🚀",
      false
    );
    return;
  }

  const botId = String(getBotId() || appContext?.uid || "");
  const nativeGroupAdmins = new Set(
    [resolvedGroup?.creatorId, ...(resolvedGroup?.adminIds || [])].filter(Boolean).map(String)
  );
  const mentionNames = extractMentionNameMap(message);
  const uids = [];
  const userInfoByUid = new Map();

  for (const targetUid of candidateUids) {
    if (String(targetUid) === botId || isAdmin(targetUid, threadId) || nativeGroupAdmins.has(String(targetUid))) {
      await sendMessageWarning(
        api,
        message,
        "Đại Ca không thể bảo em kick quản trị viên hoặc chính bot được 🚀",
        false
      );
      continue;
    }
    uids.push(targetUid);
    try {
      const userInfo = await getUserInfoData(api, targetUid);
      if (userInfo) {
        userInfoByUid.set(String(targetUid), userInfo);
      } else {
        userInfoByUid.set(String(targetUid), { uid: targetUid, name: mentionNames.get(targetUid) || targetUid });
      }
    } catch {
      userInfoByUid.set(String(targetUid), { uid: targetUid, name: mentionNames.get(targetUid) || targetUid });
    }
  }

  if (uids.length === 0) {
    return;
  }

  try {
    const result = await api.removeUserFromGroup(threadId, uids);
    const errorList = Array.isArray(result?.errorMembers) ? result.errorMembers.map(String) : [];
    const errorSet = new Set(errorList);
    const succeededUids = uids.filter((id) => !errorSet.has(String(id)));

    if (succeededUids.length === 0) {
      await sendMessageWarning(
        api,
        message,
        "Đưa Em Key Vàng 🔑, Em Kick Cho Đại Ca Xem :D 🚀",
        false
      );
      return;
    }

    const useKickImage = Boolean(readGroupSettings()?.[threadId]?.enableKickImage);
    if (!useKickImage) {
      const kickedNames = succeededUids.map((uid) => {
        const info = userInfoByUid.get(String(uid));
        return info?.name || info?.dName || uid;
      });
      const failSuffix = errorSet.size > 0 ? `\n⚠️ Không thể kick: ${[...errorSet].join(", ")}` : "";
      await sendMessageStateQuote(
        api,
        message,
        `🚨 Đã kick ${kickedNames.join(", ")} khỏi nhóm!${failSuffix}`,
        true,
        300000
      );
      return;
    }

    for (const uid of succeededUids) {
      const userInfo = userInfoByUid.get(String(uid)) || { uid, name: uid };
      let imagePath = null;
      try {
        imagePath = await cv.createKickImage(
          userInfo,
          groupName,
          groupType,
          userInfo.genderId,
          senderName,
          false
        );

        await api.sendMessage(
          {
            msg: "",
            attachments: imagePath ? [imagePath] : [],
          },
          threadId,
          MessageType.GroupMessage
        );
      } catch (error) {
        console.error("Lỗi khi tạo và gửi ảnh kết quả kick:", error);
      } finally {
        await cv.clearImagePath(imagePath);
      }
    }

    if (errorSet.size > 0) {
      await sendMessageWarning(
        api,
        message,
        `⚠️ Một số thành viên không thể kick (${[...errorSet].join(", ")}).`,
        false
      );
    }
  } catch (error) {
    console.error("Lỗi khi thực hiện kick:", error);
    await sendMessageWarning(
      api,
      message,
      "Đưa Em Key Vàng 🔑, Em Kick Cho Đại Ca Xem :D 🚀",
      false
    );
  }
}

export async function handleKickAll(api, message, groupInfo) {
  const threadId = message.threadId;
  try {
    let group;
    try {
      group = await api.getGroupInfo(threadId);
    } catch {
      await sendMessageWarning(api, message, "Không thể lấy thông tin nhóm, vui lòng thử lại sau!", false);
      return;
    }

    const groupData = group?.gridInfoMap?.[threadId] || group;
    if (!groupData || typeof groupData !== "object") {
      await sendMessageWarning(api, message, "Lỗi: Không thể lấy thông tin nhóm! 🚀", false);
      return;
    }

    const creatorId = String(groupData.creatorId || "");
    const botId = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "");
    const groupAdminSet = new Set((groupData.adminIds || []).map(String));

    if (botId && (creatorId || groupAdminSet.size > 0) && creatorId !== botId && !groupAdminSet.has(botId)) {
      await sendMessageWarning(
        api,
        message,
        "🔑 Bot chưa có quyền Quản trị viên nhóm (Key Vàng/Key Bạc) để kick toàn bộ thành viên!",
        false
      );
      return;
    }

    const rawMembers = Array.isArray(groupData.memVerList)
      ? groupData.memVerList
      : Array.isArray(groupData.memberIds)
        ? groupData.memberIds
        : [];
    const memberList = rawMembers.map((member) => String(member).split("_")[0]).filter(Boolean);

    if (memberList.length === 0) {
      await sendMessageWarning(api, message, "Lỗi: Không thể lấy danh sách thành viên nhóm! 🚀", false);
      return;
    }

    const validMembers = [...new Set(memberList)].filter(
      (uid) => uid && uid !== creatorId && uid !== botId && !groupAdminSet.has(uid) && !isAdmin(uid, threadId)
    );
    if (validMembers.length === 0) {
      await sendMessageWarning(api, message, "Không có thành viên thường nào để kick! 🚀", false);
      return;
    }

    const batches = chunkArray(validMembers, BATCH_MODERATION_SIZE);
    let kickedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        const result = await api.removeUserFromGroup(threadId, batch);
        const errorMembers = Array.isArray(result?.errorMembers) ? result.errorMembers : [];
        kickedCount += Math.max(0, batch.length - errorMembers.length);
        failedCount += errorMembers.length;
      } catch (err) {
        failedCount += batch.length;
        console.error("Lỗi khi kick batch thành viên:", err?.message || err);
      }
      if (i + 1 < batches.length) {
        await sleep(300);
      }
    }

    if (kickedCount === 0) {
      await sendMessageWarning(
        api,
        message,
        "Không thể kick thành viên — hãy kiểm tra quyền Key Vàng/Key Bạc của Bot trong nhóm! 🚀",
        false
      );
      return;
    }

    await sendMessageStateQuote(
      api,
      message,
      `✅ Đã kick ${kickedCount}/${validMembers.length} thành viên${failedCount > 0 ? ` (Thất bại: ${failedCount})` : ""}!`,
      true,
      300000
    );
  } catch (error) {
    console.error("Lỗi khi kick tất cả thành viên:", error);
    await sendMessageWarning(api, message, "Đưa Em Key Vàng 🔑, Em Kick Tất Cả Cho Đại Ca Xem :D 🚀", false);
  }
}

export async function handleGroupManage(api, message) {
  const { threadId, senderId } = message;

  if (!isAdmin(senderId, threadId)) {
    await api.sendMessage("Bạn không có quyền sử dụng lệnh này!", threadId);
    return;
  }

  getCommandConfig();
  await api.sendMessage("Đang xử lý lệnh quản lý nhóm...", threadId);
}

export async function handleBlock(api, message, groupInfo, aliasCommand = "block") {
  const threadId = message.threadId;
  const senderId = normalizeId(message?.data?.uidFrom);
  const effectiveAlias = resolveSafeAlias(aliasCommand, "block").toLowerCase();
  const prefix = getGlobalPrefix();
  const msgType = safeThreadType(message);
  const isDM = msgType === MessageType.DirectMessage || message?.type === 0;
  const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);

  // Branch explicitly for blockmessage / block-user: block personal Zalo messages (works in both DM & Group)
  if (effectiveAlias === "blockmessage" || effectiveAlias === "block-user") {
    let targets = resolveTargetUsers(message, cleanArgs);
    if (
      targets.length === 0 &&
      isDM &&
      threadId &&
      normalizeId(threadId) !== senderId &&
      /^\d+$/.test(normalizeId(threadId))
    ) {
      targets = [normalizeId(threadId)];
    }

    if (targets.length === 0) {
      await sendMessageWarning(
        api,
        message,
        `Vui lòng nhập UID, @mention hoặc reply người cần chặn tin nhắn Zalo:\n${prefix}${effectiveAlias} <UID | @user>`,
        false
      );
      return true;
    }

    if (typeof api?.blockUser !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ chặn tin nhắn cá nhân Zalo.", false);
      return true;
    }

    const botId = String(getBotId() || appContext?.uid || "");
    const blockedList = [];
    const failedList = [];

    for (const uid of targets) {
      if (String(uid) === botId || isAdmin(uid, threadId)) {
        failedList.push(`${uid} (Không thể chặn Admin/Bot)`);
        continue;
      }
      try {
        await api.blockUser(uid);
        const info = await getUserInfoData(api, uid).catch(() => null);
        blockedList.push(info?.name ? `${info.name} (${uid})` : uid);
      } catch (err) {
        failedList.push(`${uid} (${err?.message || "Lỗi"})`);
      }
    }

    const summaryLines = [];
    if (blockedList.length > 0) summaryLines.push(`🚫 Đã chặn tin nhắn Zalo: ${blockedList.join(", ")}`);
    if (failedList.length > 0) summaryLines.push(`❌ Không thể chặn: ${failedList.join(", ")}`);

    await api.sendMessage(
      { msg: summaryLines.join("\n"), quote: message, ttl: 300000 },
      threadId,
      msgType
    );
    return true;
  }

  // Group block (`block` / `chan`) requires group scope
  if (isDM) {
    await sendMessageWarning(
      api,
      message,
      `⚠️ Lệnh "${prefix}${effectiveAlias}" chỉ dùng để chặn thành viên trong nhóm!\n💡 Để chặn tin nhắn riêng Zalo, hãy dùng: ${prefix}blockmessage <UID>`,
      false
    );
    return true;
  }

  let resolvedGroup =
    groupInfo && (groupInfo.name || groupInfo.creatorId || groupInfo.gridInfoMap)
      ? groupInfo.gridInfoMap?.[threadId] || groupInfo
      : null;
  if (!resolvedGroup && typeof api?.getGroupInfo === "function" && threadId) {
    try {
      const fetched = await api.getGroupInfo(threadId);
      resolvedGroup = fetched?.gridInfoMap?.[threadId] || fetched || null;
    } catch {}
  }

  const groupName = resolvedGroup?.name || "Nhóm";
  const groupType = resolvedGroup?.groupType ?? resolvedGroup?.type ?? 1;
  const senderName = message?.data?.dName || "Quản trị viên";
  const candidateUids = resolveTargetUsers(message, cleanArgs);

  if (candidateUids.length === 0) {
    await sendMessageWarning(
      api,
      message,
      ":D Đại Ca muốn chặn ai? Hãy @mention, reply tin nhắn hoặc nhập UID! 🚀",
      false
    );
    return;
  }

  const botId = String(getBotId() || appContext?.uid || "");
  const nativeGroupAdmins = new Set(
    [resolvedGroup?.creatorId, ...(resolvedGroup?.adminIds || [])].filter(Boolean).map(String)
  );
  const mentionNames = extractMentionNameMap(message);
  const uids = [];
  const userInfoByUid = new Map();

  for (const targetUid of candidateUids) {
    if (String(targetUid) === botId || isAdmin(targetUid, threadId) || nativeGroupAdmins.has(String(targetUid))) {
      await sendMessageWarning(
        api,
        message,
        "Đại Ca không thể bảo em block quản trị viên hoặc chính bot được 🚀",
        false
      );
      continue;
    }
    uids.push(targetUid);
    try {
      const userInfo = await getUserInfoData(api, targetUid);
      if (userInfo) {
        userInfoByUid.set(String(targetUid), userInfo);
      } else {
        userInfoByUid.set(String(targetUid), { uid: targetUid, name: mentionNames.get(targetUid) || targetUid });
      }
    } catch {
      userInfoByUid.set(String(targetUid), { uid: targetUid, name: mentionNames.get(targetUid) || targetUid });
    }
  }

  if (uids.length === 0) {
    return;
  }

  try {
    const result = await api.blockUsers(threadId, uids);
    const errorList = Array.isArray(result?.errorMembers) ? result.errorMembers.map(String) : [];
    const errorSet = new Set(errorList);
    const succeededUids = uids.filter((id) => !errorSet.has(String(id)));

    if (succeededUids.length === 0) {
      await sendMessageWarning(
        api,
        message,
        "Đưa Em Key Vàng 🔑, Em Block Cho Đại Ca Xem :D 🚀",
        false
      );
      return;
    }

    const useBlockImage = Boolean(readGroupSettings()?.[threadId]?.enableBlockImage);
    if (!useBlockImage) {
      const blockedNames = succeededUids.map((uid) => {
        const info = userInfoByUid.get(String(uid));
        return info?.name || info?.dName || uid;
      });
      const failSuffix = errorSet.size > 0 ? `\n⚠️ Không thể chặn: ${[...errorSet].join(", ")}` : "";
      await sendMessageStateQuote(
        api,
        message,
        `🚨 Đã chặn ${blockedNames.join(", ")} khỏi nhóm!${failSuffix}`,
        true,
        300000
      );
      return;
    }

    for (const uid of succeededUids) {
      const userInfo = userInfoByUid.get(String(uid)) || { uid, name: uid };
      let imagePath = null;
      try {
        imagePath = await cv.createBlockImage(
          userInfo,
          groupName,
          groupType,
          userInfo.genderId,
          senderName,
          false
        );

        await api.sendMessage(
          {
            msg: "",
            attachments: imagePath ? [imagePath] : [],
          },
          threadId,
          MessageType.GroupMessage
        );
      } catch (error) {
        console.error("Lỗi khi tạo và gửi ảnh kết quả block:", error);
      } finally {
        await cv.clearImagePath(imagePath);
      }
    }

    if (errorSet.size > 0) {
      await sendMessageWarning(
        api,
        message,
        `⚠️ Một số thành viên không thể chặn (${[...errorSet].join(", ")}).`,
        false
      );
    }
  } catch (error) {
    console.error("Lỗi khi thực hiện block:", error);
    await sendMessageWarning(
      api,
      message,
      "Đưa Em Key Vàng 🔑, Em Block Cho Đại Ca Xem :D 🚀",
      false
    );
  }
}

export async function handleBlockAll(api, message, groupInfo, options = {}) {
  const threadId = message.threadId;
  const senderId = String(message?.data?.uidFrom || "");

  try {
    if (!senderId) {
      await sendMessageWarning(api, message, "Lỗi: Không thể xác định người gửi! 🚀", false);
      return;
    }

    let group;
    try {
      group = await api.getGroupInfo(threadId);
    } catch {
      await sendMessageWarning(api, message, "Không thể lấy thông tin nhóm, vui lòng thử lại sau!", false);
      return;
    }

    const groupData = group?.gridInfoMap?.[threadId] || group;
    if (!groupData || typeof groupData !== "object") {
      await sendMessageWarning(api, message, "Lỗi: Không thể lấy thông tin nhóm! 🚀", false);
      return;
    }

    const creatorId = String(groupData.creatorId || "");
    const adminSet = new Set((groupData.adminIds || []).map(String));
    const botId = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "");
    const callerIsSupreme = Boolean(
      (options && typeof options === "object" && options.isAdminLevelHighest) ||
      options === true ||
      isMainBotAdmin(senderId)
    );

    if (senderId !== creatorId && !adminSet.has(senderId) && !callerIsSupreme) {
      await sendMessageWarning(
        api,
        message,
        "Bạn cần là Quản trị tối cao hoặc cầm Key Vàng/Key Bạc để thực hiện lệnh này! 🔑",
        false
      );
      return;
    }

    if (botId && (creatorId || adminSet.size > 0) && botId !== creatorId && !adminSet.has(botId)) {
      await sendMessageWarning(
        api,
        message,
        "🔑 Bot chưa có quyền Quản trị viên nhóm (Key Vàng/Key Bạc) để chặn toàn bộ thành viên!",
        false
      );
      return;
    }

    const rawMembers = Array.isArray(groupData.memVerList)
      ? groupData.memVerList
      : Array.isArray(groupData.memberIds)
        ? groupData.memberIds
        : [];
    const memberList = rawMembers.map((member) => String(member).split("_")[0]).filter(Boolean);
    if (memberList.length === 0) {
      await sendMessageWarning(api, message, "Lỗi: Không thể lấy danh sách thành viên nhóm! 🚀", false);
      return;
    }

    const validMembers = [...new Set(memberList)].filter(
      (uid) => uid && uid !== creatorId && uid !== botId && !isAdmin(uid, threadId) && !adminSet.has(uid)
    );
    if (validMembers.length === 0) {
      await sendMessageWarning(api, message, "Không có thành viên thường nào để chặn! 🚀", false);
      return;
    }

    const batches = chunkArray(validMembers, BATCH_MODERATION_SIZE);
    let blockedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        const result = await api.blockUsers(threadId, batch);
        const errorMembers = Array.isArray(result?.errorMembers) ? result.errorMembers : [];
        blockedCount += Math.max(0, batch.length - errorMembers.length);
        failedCount += errorMembers.length;
      } catch {
        failedCount += batch.length;
      }
      if (i + 1 < batches.length) {
        await sleep(300);
      }
    }

    if (blockedCount === 0) {
      await sendMessageWarning(
        api,
        message,
        "Không thể chặn thành viên — hãy kiểm tra Key Vàng/Key Bạc của Bot trong nhóm! 🚀",
        false
      );
      return;
    }

    await sendMessageStateQuote(
      api,
      message,
      `✅ Đã chặn ${blockedCount}/${validMembers.length} thành viên${failedCount > 0 ? ` (Thất bại: ${failedCount})` : ""}!`,
      true,
      300000
    );
  } catch {
    await sendMessageWarning(api, message, "Đưa Em Key Vàng hoặc Key Bạc 🔑, Em Block Tất Cả Cho Đại Ca Xem :D 🚀", false);
  }
}

export async function handleKeyCommands(
  api,
  message,
  groupSettings,
  isAdminLevelHighest,
  aliasCommand = "",
  canonicalName = ""
) {
  const content = removeMention(message).trim();
  const senderId = normalizeId(message?.data?.uidFrom);
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();

  const cmdToken = String(
    canonicalName ||
    (typeof aliasCommand === "string" ? aliasCommand : "") ||
    (content.toLowerCase().startsWith(prefix.toLowerCase())
      ? content.slice(prefix.length).trim().split(/\s+/)[0]
      : content.split(/\s+/)[0]) ||
    ""
  )
    .trim()
    .toLowerCase();

  const goldAliases = new Set(["keygold", "keyvang"]);
  const silverAliases = new Set(["keysilver", "keybac"]);
  const unkeyAliases = new Set(["unkey", "xoakey"]);

  let action = "";
  if (canonicalName === "keygold" || goldAliases.has(cmdToken)) action = "gold";
  else if (canonicalName === "keysilver" || silverAliases.has(cmdToken)) action = "silver";
  else if (canonicalName === "unkey" || unkeyAliases.has(cmdToken)) action = "unkey";
  else return false;

  if (!isAdminLevelHighest) {
    const caption = "Chỉ Quản trị viên cấp cao mới được sử dụng lệnh này!";
    await sendMessageInsufficientAuthority(api, message, caption);
    return false;
  }

  const effectiveAlias = resolveSafeAlias(aliasCommand, canonicalName || cmdToken);
  const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);
  const mentionNames = extractMentionNameMap(message);
  const targetUids = resolveTargetUsers(message, cleanArgs);

  if (targetUids.length === 0) {
    if (action === "unkey") {
      await sendMessageWarning(api, message, "Vui lòng @mention, reply tin nhắn hoặc nhập UID người cần gỡ key!", false);
      return true;
    }
    await handleKeyAction(api, message, threadId, senderId, action, "Bạn");
    return true;
  }

  if (action === "gold" && targetUids.length > 1) {
    await sendMessageWarning(
      api,
      message,
      "⚠️ Chỉ có thể nhường Key Vàng (Trưởng nhóm) cho duy nhất 1 thành viên!",
      false
    );
    return true;
  }

  for (const targetId of targetUids) {
    const targetName =
      mentionNames.get(targetId) ||
      (targetId === getQuotedUid(message) ? message?.data?.quote?.fromD : "") ||
      targetId;
    await handleKeyAction(api, message, threadId, targetId, action, targetName);
  }

  return true;
}

async function handleKeyAction(api, message, threadId, targetId, action, targetName) {
  switch (action) {
    case "gold":
      try {
        await api.changeGroupOwner(threadId, targetId);
        await sendMessageStateQuote(api, message, `Đã nhường key vàng cho ${targetName}.`, true, 300000);
      } catch {
        await sendMessageStateQuote(api, message, `Không đủ quyền hạn để nhường key vàng cho ${targetName}.`, false, 300000);
      }
      break;
    case "silver":
      try {
        await api.addGroupAdmins(threadId, targetId);
        await sendMessageStateQuote(api, message, `Đã phong key bạc cho ${targetName}.`, true, 300000);
      } catch {
        await sendMessageStateQuote(api, message, `Không đủ quyền hạn để phong key bạc cho ${targetName}.`, false, 300000);
      }
      break;
    case "unkey":
      try {
        await api.removeGroupAdmins(threadId, targetId);
        await sendMessageStateQuote(api, message, `Đã xóa key phó nhóm của ${targetName}.`, true, 300000);
      } catch {
        await sendMessageStateQuote(api, message, `${targetName} không có key để xóa hoặc bot thiếu quyền.`, false, 300000);
      }
      break;
  }
}

export async function handleBlockBot(api, message, groupSettings, aliasCommand = "blockbot") {
  const threadId = message.threadId;
  const senderId = normalizeId(message?.data?.uidFrom);
  const msgType = safeThreadType(message);
  const isDM = msgType === MessageType.DirectMessage || message?.type === 0;
  const prefix = getGlobalPrefix();
  const effectiveAlias = resolveSafeAlias(aliasCommand, "blockbot");
  const listIdBlock = [];
  let messageContent = "";

  if (!isAdmin(senderId, isDM ? undefined : threadId)) {
    try {
      await sendMessageInsufficientAuthority(api, message, "Bạn không có quyền sử dụng lệnh này!");
    } catch (error) {
      console.error("Lỗi khi gửi thông báo thiếu quyền:", error);
    }
    return;
  }

  if (!managerData.data) {
    managerData.data = { blockBot: [] };
  } else if (!Array.isArray(managerData.data.blockBot)) {
    managerData.data.blockBot = [];
  }

  try {
    const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);
    const mentionNames = extractMentionNameMap(message);
    let candidateUids = resolveTargetUsers(message, cleanArgs);

    // In DM with no explicit UID/quote/mention: target peer threadId ONLY when threadId !== senderId!
    if (
      candidateUids.length === 0 &&
      isDM &&
      threadId &&
      normalizeId(threadId) !== senderId &&
      /^\d+$/.test(normalizeId(threadId))
    ) {
      candidateUids = [normalizeId(threadId)];
    }

    if (candidateUids.length === 0) {
      await api.sendMessage(
        {
          msg: isDM
            ? `🚨 Vui lòng nhập UID người dùng cần chặn tương tác bot: ${prefix}${effectiveAlias} <UID>`
            : `🚨 Vui lòng @mention, reply tin nhắn hoặc nhập UID người dùng để chặn!`,
          quote: message,
          ttl: 120000,
        },
        threadId,
        msgType
      );
      return true;
    }

    const botId = String(getBotId() || appContext?.uid || "");

    for (const targetId of candidateUids) {
      let targetName = mentionNames.get(targetId) || "";
      if (!targetName) {
        const userInfo = await getUserInfoData(api, targetId).catch(() => null);
        targetName = userInfo?.name || targetId;
      }

      if (targetId === botId || isAdmin(targetId, isDM ? undefined : threadId)) {
        messageContent += `🚨 Không thể chặn Quản trị viên / Bot: ${targetName}\n`;
      } else {
        listIdBlock.push({ targetId, targetName });
      }
    }

    if (listIdBlock.length > 0) {
      const blockData = managerData.data;
      const blockedUsers = [];
      const alreadyBlockedUsers = [];

      for (const item of listIdBlock) {
        const isBlocked = blockData.blockBot.some((blocked) => String(blocked.idUserZalo) === String(item.targetId));
        if (isBlocked) {
          alreadyBlockedUsers.push(`${item.targetName} (${item.targetId})`);
        } else {
          blockData.blockBot.push({
            idUserZalo: item.targetId,
            senderName: item.targetName,
          });
          blockedUsers.push(`${item.targetName} (${item.targetId})`);
        }
      }

      if (blockedUsers.length > 0) {
        messageContent += `✅ Đã chặn tương tác bot đối với: ${blockedUsers.join(", ")}\n`;
      }
      if (alreadyBlockedUsers.length > 0) {
        messageContent += `❌ Những người đã bị chặn từ trước: ${alreadyBlockedUsers.join(", ")}\n`;
      }
    }

    if (messageContent.trim() === "") {
      messageContent = "🚨 Không có mục tiêu hợp lệ để chặn!";
    }

    await api.sendMessage(
      {
        msg: messageContent.trim(),
        quote: message,
        ttl: 300000,
      },
      threadId,
      msgType
    );

    if (listIdBlock.length > 0) {
      managerData.hasChanges = true;
      saveManagerData();
    }
    return true;
  } catch (error) {
    console.error("Lỗi trong handleBlockBot:", error);
    try {
      await api.sendMessage(
        {
          msg: "🚨 Đã có lỗi xảy ra khi xử lý lệnh chặn bot, vui lòng thử lại!",
          quote: message,
          ttl: 300000,
        },
        threadId,
        msgType
      );
    } catch {}
  }
}

export async function handleUnblockBot(api, message, groupSettings, aliasCommand = "unblockbot") {
  const threadId = message.threadId;
  const senderId = normalizeId(message?.data?.uidFrom);
  const msgType = safeThreadType(message);
  const isDM = msgType === MessageType.DirectMessage || message?.type === 0;
  const prefix = getGlobalPrefix();
  const effectiveAlias = resolveSafeAlias(aliasCommand, "unblockbot").toLowerCase();

  const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);
  const mentionNames = extractMentionNameMap(message);
  let candidateUids = resolveTargetUsers(message, cleanArgs);

  if (
    candidateUids.length === 0 &&
    isDM &&
    threadId &&
    normalizeId(threadId) !== senderId &&
    /^\d+$/.test(normalizeId(threadId))
  ) {
    candidateUids = [normalizeId(threadId)];
  }

  // Branch explicitly for unblockmessage: unblock personal Zalo messages
  if (effectiveAlias === "unblockmessage") {
    if (candidateUids.length === 0) {
      await api.sendMessage(
        {
          msg: `🚨 Vui lòng nhập UID, @mention hoặc reply người cần mở chặn tin nhắn Zalo: ${prefix}unblockmessage <UID>`,
          quote: message,
          ttl: 60000,
        },
        threadId,
        msgType
      );
      return true;
    }

    if (typeof api?.unblockUser !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ mở chặn tin nhắn cá nhân Zalo.", false);
      return true;
    }

    const okList = [];
    const failList = [];
    for (const uid of candidateUids) {
      try {
        await api.unblockUser(uid);
        const info = await getUserInfoData(api, uid).catch(() => null);
        okList.push(info?.name ? `${info.name} (${uid})` : uid);
      } catch (err) {
        failList.push(`${uid} (${err?.message || "Lỗi"})`);
      }
    }

    const lines = [];
    if (okList.length > 0) lines.push(`✅ Đã mở chặn tin nhắn Zalo: ${okList.join(", ")}`);
    if (failList.length > 0) lines.push(`❌ Không thể mở chặn: ${failList.join(", ")}`);

    await api.sendMessage(
      { msg: lines.join("\n"), quote: message, ttl: 300000 },
      threadId,
      msgType
    );
    return true;
  }

  if (candidateUids.length === 0) {
    await api.sendMessage(
      {
        msg: `🚨 Vui lòng @mention, reply tin nhắn hoặc nhập UID người dùng cần bỏ chặn tương tác bot!`,
        quote: message,
        ttl: 60000,
      },
      threadId,
      msgType
    );
    return true;
  }

  if (!managerData.data) managerData.data = { blockBot: [] };
  if (!Array.isArray(managerData.data.blockBot)) managerData.data.blockBot = [];
  const blockData = managerData.data;

  const unblockUsers = [];
  const notBlockedUsers = [];

  for (const targetId of candidateUids) {
    const blockedUserIndex = blockData.blockBot.findIndex(
      (blocked) => String(blocked.idUserZalo) === String(targetId)
    );
    const storedEntry = blockedUserIndex !== -1 ? blockData.blockBot[blockedUserIndex] : null;
    let displayName = mentionNames.get(targetId) || storedEntry?.senderName || "";
    if (!displayName) {
      const userInfo = await getUserInfoData(api, targetId).catch(() => null);
      displayName = userInfo?.name || targetId;
    }

    if (blockedUserIndex !== -1) {
      blockData.blockBot.splice(blockedUserIndex, 1);
      unblockUsers.push(`${displayName} (${targetId})`);
    } else {
      notBlockedUsers.push(`${displayName} (${targetId})`);
    }
  }

  let messageContent = "";
  if (unblockUsers.length > 0) {
    messageContent += `✅ Đã bỏ chặn tương tác bot đối với: ${unblockUsers.join(", ")}\n`;
  }
  if (notBlockedUsers.length > 0) {
    messageContent += `❌ Các người dùng sau không bị chặn: ${notBlockedUsers.join(", ")}`;
  }

  await api.sendMessage(
    { msg: messageContent.trim(), quote: message, ttl: 300000 },
    threadId,
    msgType
  );

  if (unblockUsers.length > 0) {
    managerData.hasChanges = true;
    saveManagerData();
  }
  return true;
}

export async function handleListBlockBot(api, message, aliasCommand = "listblockbot") {
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  const isDM = msgType === MessageType.DirectMessage || message?.type === 0;
  const prefix = getGlobalPrefix();
  const effectiveAlias = resolveSafeAlias(aliasCommand, "listblockbot").toLowerCase();
  const cleanArgs = extractCleanArgs(message, prefix, effectiveAlias);
  const requestedPage = Math.max(1, Number.parseInt(cleanArgs[0], 10) || 1);
  const PAGE_SIZE = 50;

  // Branch explicitly for list-block-group: list Zalo group blocked members
  if (effectiveAlias === "list-block-group") {
    if (isDM) {
      await sendMessageWarning(
        api,
        message,
        `⚠️ Lệnh "${prefix}list-block-group" chỉ dùng trong nhóm để xem danh sách bị chặn của nhóm Zalo!`,
        false
      );
      return true;
    }

    try {
      let rawList = [];
      if (typeof api?.getGroupBlockedMember === "function") {
        const res = await api.getGroupBlockedMember({ page: requestedPage, count: PAGE_SIZE }, threadId);
        rawList = Array.isArray(res?.blocked_members)
          ? res.blocked_members
          : Array.isArray(res?.members)
            ? res.members
            : Array.isArray(res)
              ? res
              : [];
      } else if (typeof api?.getGroupBlockList === "function") {
        const res = await api.getGroupBlockList(threadId, requestedPage);
        rawList = Array.isArray(res?.blocked_members) ? res.blocked_members : [];
      } else {
        await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ xem danh sách chặn của nhóm.", false);
        return true;
      }

      if (rawList.length === 0) {
        await api.sendMessage(
          {
            msg: requestedPage > 1
              ? `📭 Trang ${requestedPage} không có thành viên bị chặn nào.`
              : `✅ Hiện không có ai nằm trong danh sách chặn của nhóm này.`,
            quote: message,
            ttl: 180000,
          },
          threadId,
          msgType
        );
        return true;
      }

      const normalizedMembers = rawList.map((m) => ({
        id: String(m?.id || m?.userId || m?.uid || "").trim(),
        dName: String(m?.dName || m?.zaloName || m?.displayName || m?.id || "Không xác định").trim(),
        avatar: m?.avatar && !String(m.avatar).startsWith("http") ? `https:${m.avatar}` : m?.avatar || "",
      }));

      let imagePath = null;
      try {
        imagePath = await createBlockListImage(normalizedMembers, "Nhóm");
        await api.sendMessage(
          {
            msg: `🛑 Danh sách thành viên bị chặn trong nhóm (Trang ${requestedPage} — ${normalizedMembers.length} người):`,
            attachments: [imagePath],
            quote: message,
            ttl: 300000,
          },
          threadId,
          msgType
        );
      } catch {
        const startIdx = (requestedPage - 1) * PAGE_SIZE;
        const lines = normalizedMembers.map((m, idx) => `${startIdx + idx + 1}. ${m.dName}${m.id ? ` (${m.id})` : ""}`);
        await api.sendMessage(
          {
            msg: `🛑 Danh sách thành viên bị chặn trong nhóm (Trang ${requestedPage}):\n${lines.join("\n")}`,
            quote: message,
            ttl: 300000,
          },
          threadId,
          msgType
        );
      } finally {
        if (imagePath) {
          await deleteFile(imagePath);
        }
      }
    } catch (error) {
      await sendMessageWarning(
        api,
        message,
        `Không thể tải danh sách chặn của nhóm (hãy kiểm tra quyền QTV nhóm của bot): ${error?.message || error}`,
        false
      );
    }
    return true;
  }

  if (!managerData.data) managerData.data = { blockBot: [] };
  if (!Array.isArray(managerData.data.blockBot)) managerData.data.blockBot = [];
  const listBlockedUsers = managerData.data.blockBot;

  if (listBlockedUsers.length === 0) {
    await api.sendMessage(
      { msg: `✅ Hiện không có ai bị chặn tương tác với bot.`, ttl: 300000 },
      threadId,
      msgType
    );
    return true;
  }

  const totalPages = Math.max(1, Math.ceil(listBlockedUsers.length / PAGE_SIZE));
  const safePage = Math.min(requestedPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pageItems = listBlockedUsers.slice(startIndex, startIndex + PAGE_SIZE);

  let filePath = null;
  try {
    filePath = await createBlockedBotListImage(pageItems, {
      page: safePage,
      totalPages,
      startIndex,
    });
    const pageCaption =
      totalPages > 1
        ? `🛑 Danh sách người dùng bị chặn tương tác bot (${listBlockedUsers.length} người — Trang ${safePage}/${totalPages}).\n💡 Gõ ${prefix}${effectiveAlias} <trang> để xem trang khác.`
        : `🛑 Danh sách người dùng bị chặn tương tác với bot (${listBlockedUsers.length} người).`;
    await api.sendMessage(
      {
        msg: pageCaption,
        attachments: [filePath],
        ttl: 300000,
      },
      threadId,
      msgType
    );
  } catch {
    const lines = pageItems.map(
      (u, idx) => `${startIndex + idx + 1}. ${u.senderName || u.idUserZalo} (${u.idUserZalo})`
    );
    await api.sendMessage(
      {
        msg: `🛑 Danh sách bị chặn bot (Trang ${safePage}/${totalPages}):\n${lines.join("\n")}`,
        ttl: 300000,
      },
      threadId,
      msgType
    );
  } finally {
    if (filePath) {
      await deleteFile(filePath);
    }
  }
  return true;
}

export function isUserBlocked(senderId) {
  try {
    const blockData = managerData.data;
    if (!blockData || !blockData.blockBot) {
      return false;
    }

    return blockData.blockBot.some((blocked) => String(blocked.idUserZalo) === String(senderId));
  } catch (error) {
    console.error("Lỗi khi kiểm tra trạng thái block:", error);
    return false;
  }
}

export async function handleSettingGroupCommand(api, message, groupInfo, aliasCommand = "settinggroup") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const effectiveAlias = resolveSafeAlias(aliasCommand, "settinggroup");
  const args = extractCleanArgs(message, prefix, effectiveAlias);

  let resolvedGroup =
    groupInfo && (groupInfo.setting || groupInfo.name || groupInfo.creatorId || groupInfo.gridInfoMap)
      ? groupInfo.gridInfoMap?.[threadId] || groupInfo
      : null;

  if (!resolvedGroup?.setting) {
    const freshInfo = await getGroupInfoData(api, threadId).catch(() => null);
    if (freshInfo) resolvedGroup = freshInfo;
  }

  if (args.length < 1) {
    const result = {
      success: false,
      message:
        `Sử dụng: ${prefix}${effectiveAlias} <loại config> <giá trị>` +
        `\n\n[Cài đặt Bật/Tắt] (on/off hoặc 1/0):` +
        `\n- lockchat: ${resolvedGroup?.setting?.lockSendMsg ? "Tắt" : "Mở"} chat trong nhóm` +
        `\n- lockview: ${resolvedGroup?.setting?.lockViewMember ? "Tắt" : "Mở"} xem thành viên trong nhóm` +
        `\n- history: ${resolvedGroup?.setting?.enableMsgHistory ? "Mở" : "Tắt"} cho phép thành viên mới đọc tin nhắn gần nhất` +
        `\n- joinappr: ${resolvedGroup?.setting?.joinAppr ? "Mở" : "Tắt"} chế độ phê duyệt thành viên` +
        `\n- showkey: ${resolvedGroup?.setting?.signAdminMsg ? "Mở" : "Tắt"} hiển thị key quản trị` +
        `\n\n[Cài đặt Chuỗi]:` +
        `\n- name <tên mới>: Đổi tên nhóm`,
    };
    await sendMessageFromSQL(api, message, result, false, 60000);
    return;
  }

  const settingType = args[0].toLowerCase();
  const value = args.slice(1).join(" ").trim();

  if (["name"].includes(settingType)) {
    if (!value) {
      await sendMessageStateQuote(api, message, `Vui lòng nhập giá trị cho cài đặt ${settingType}`, false, 60000);
      return;
    }

    try {
      await api.changeGroupName(threadId, value);
      await sendMessageStateQuote(api, message, `Tên nhóm đã được đổi thành ${value}`, true, 60000);
      return;
    } catch (error) {
      console.error(`Lỗi khi thay đổi ${settingType}:`, error);
      await sendMessageStateQuote(api, message, `Không thể thay đổi ${settingType}: ${error.message}`, false, 60000);
      return;
    }
  }

  if (!value || !["on", "off", "0", "1"].includes(value.toLowerCase())) {
    await sendMessageStateQuote(api, message, `Vui lòng chọn on/off hoặc 1/0 để thay đổi cài đặt`, false, 60000);
    return;
  }

  const newValue = ["on", "1"].includes(value.toLowerCase()) ? 1 : 0;
  if (!resolvedGroup?.setting) {
    const fresh = await getGroupInfoData(api, threadId).catch(() => null);
    if (fresh) resolvedGroup = fresh;
  }
  const currentSettings = { ...(resolvedGroup?.setting || {}) };

  try {
    switch (settingType) {
      case "lockchat": {
        currentSettings.lockSendMsg = newValue;
        const status = newValue === 1 ? "tắt" : "mở";
        await updateGroupSetting(api, message, threadId, currentSettings, `Đã ${status} chat cho tất cả thành viên!`);
        break;
      }

      case "lockview": {
        currentSettings.lockViewMember = newValue;
        const memberStatus = newValue === 1 ? "tắt" : "mở";
        await updateGroupSetting(api, message, threadId, currentSettings, `Đã ${memberStatus} xem thành viên trong nhóm!`);
        break;
      }

      case "history": {
        currentSettings.enableMsgHistory = newValue;
        const historyStatus = newValue === 1 ? "mở" : "tắt";
        await updateGroupSetting(api, message, threadId, currentSettings, `Đã ${historyStatus} cho phép thành viên mới đọc tin nhắn gần nhất!`);
        break;
      }

      case "joinappr": {
        currentSettings.joinAppr = newValue;
        const joinApprStatus = newValue === 1 ? "mở" : "tắt";
        await updateGroupSetting(api, message, threadId, currentSettings, `Đã ${joinApprStatus} chế độ phê duyệt thành viên!`);
        break;
      }

      case "showkey": {
        currentSettings.signAdminMsg = newValue;
        const showKeyStatus = newValue === 1 ? "mở" : "tắt";
        await updateGroupSetting(api, message, threadId, currentSettings, `Đã ${showKeyStatus} hiển thị key quản trị!`);
        break;
      }

      default:
        await sendMessageStateQuote(api, message, `Loại cài đặt '${settingType}' không hợp lệ!`, false, 60000);
        break;
    }
  } catch (error) {
    console.error("Lỗi khi thay đổi cài đặt nhóm:", error);
    await sendMessageStateQuote(api, message, `Không thể thay đổi cài đặt nhóm: ${error.message}`, false, 60000);
  }
}

export async function handleGroupBlockList(api, message, args, aliasCommand, groupTypeString) {
  const prefix = getGlobalPrefix(api.getBotId());
  const threadId = message.threadId;
  const botId = api.getBotId();

  if (args.length < 1) {
    await sendMessageStateQuote(
      api,
      message,
      `Cú pháp câu lệnh: ${prefix}${aliasCommand} block <add/remove/list> <@mention|index>\n` +
      `list: hiển thị danh sách đối tượng chặn trong ${groupTypeString}.\n` +
      `add: thêm đối tượng vào danh sách chặn (thông qua mention hoặc uid chỉ định).\n` +
      `remove: xóa đối tượng khỏi danh sách chặn thông qua index hoặc 'all' để xóa toàn bộ.`,
      false,
      60000,
      false
    );
    return;
  }

  const action = args[0].toLowerCase();
  switch (action) {
    case "add":
      const uid = args[1];
      let userInfo;
      try {
        userInfo = await getUserInfoData(api, uid);
      } catch (error) {
        console.error(`Không thể lấy thông tin cho người dùng ${uid}:`, error);
      }

      const result = await api.blockUsers(message.threadId, [uid]);
      if (result.errorMembers && result.errorMembers.length > 0) {
        await sendMessageWarning(api, message, "Ném Đây Cái Key Vàng 🔑, Tôi Block Cho Bạn Xem :D 🚀", false);
        return;
      }

      await sendMessageStateQuote(
        api,
        message,
        `🚨 Đã chặn tài khoản sau khỏi ${groupTypeString}: ${userInfo ? userInfo.name : uid}.`,
        false,
        300000,
        false
      );
      break;

    case "remove":
      try {
        const stt = args[1]?.toLowerCase();
        const blockList = await getGroupBlockList(api, message);
        if (blockList && blockList.length > 0) {
          if (stt === "all") {
            const uidsToUnblock = blockList.map((item) => item.id);
            const result = await api.unblockUsers(message.threadId, uidsToUnblock);
            if (result.errorMembers && result.errorMembers.length > 0) {
              await sendMessageWarning(api, message, `Mình không đủ quyền hạn để thực hiện hành động này`);
              return;
            }
            await sendMessageStateQuote(
              api,
              message,
              `🚨 Đã mở chặn toàn bộ tài khoản trong danh sách chặn của ${groupTypeString}.`,
              false,
              300000,
              false
            );
            return;
          }
          if (isNaN(stt)) {
            await sendMessageStateQuote(
              api,
              message,
              `🚨 Vui lòng nhập số thứ tự, uid của tài khoản cần mở chặn, hoặc 'all' để xóa toàn bộ trong ${groupTypeString}.\n` +
              `Để xem danh sách chặn, chat: ${prefix}${aliasCommand} block list`,
              false,
              60000,
              false
            );
            return;
          }
          let target;
          target = blockList.find((item) => item.id === stt);
          if (!target) {
            const index = parseInt(stt) - 1;
            if (index < 0 || index >= blockList.length) {
              await sendMessageStateQuote(
                api,
                message,
                `🚨 Số thứ tự không hợp lệ, vui lòng nhập lại hoặc kiểm tra lại danh sách chặn.\n` +
                `Để xem danh sách chặn, chat: ${prefix}${aliasCommand} block list`,
                false,
                60000,
                false
              );
              return;
            }
            target = blockList[index];
          }
          const result = await api.unblockUsers(message.threadId, [target.id]);
          if (result.errorMembers && result.errorMembers.length > 0) {
            await sendMessageWarning(api, message, `Mình không đủ quyền hạn để thực hiện hành động này`);
            return;
          }
          await sendMessageStateQuote(
            api,
            message,
            `🚨 Đã mở chặn tài khoản sau trong ${groupTypeString}: ${target.dName}.`,
            false,
            300000,
            false
          );
        } else {
          await sendMessageStateQuote(
            api,
            message,
            `🚨 Không có ai bị chặn trong ${groupTypeString} này để mở chặn.`,
            false,
            60000,
            false
          );
        }
      } catch (error) {
        await sendMessageStateQuote(
          api,
          message,
          `Không thể lấy được danh sách chặn thành viên từ ${groupTypeString}`,
          false,
          60000,
          false
        );
      }
      break;

    case "list":
      try {
        const blockList = await getGroupBlockList(api, message);
        if (blockList && blockList.length > 0) {
          let imagePath = null;
          try {
            imagePath = await createBlockListImage(blockList, groupTypeString);
            await sendMessageCompleteRequest(
              api,
              message,
              {
                caption: `Đây là danh sách người dùng bị chặn trong ${groupTypeString}.`,
                imagePath,
              },
              600000
            );
          } catch (error) {
            // Fallback về text nếu có lỗi
            const listBlockedUsers = blockList.map((blocked) => blocked.dName);
            const chunksArr = chunkArray(listBlockedUsers, 50);
            await sendMessageStateQuote(
              api,
              message,
              `Danh sách tài khoản bị chặn trong ${groupTypeString} này:\n${chunksArr[0]
                .map((user, index) => `- ${index + 1}. ${user}`)
                .join("\n")}`,
              false,
              180000,
              false
            );
            if (chunksArr.length > 1) {
              for (let i = 1; i < chunksArr.length; i++) {
                await sendMessageStateQuote(
                  api,
                  message,
                  chunksArr[i].map((user, index) => `- ${index + 1 + i * 50}. ${user}`).join("\n"),
                  false,
                  180000,
                  false
                );
              }
            }
          } finally {
            deleteFile(imagePath);
          }
        } else {
          await sendMessageStateQuote(
            api,
            message,
            `🚨 Không có ai bị chặn trong ${groupTypeString} này.`,
            false,
            60000,
            false
          );
        }
      } catch (error) {
        await sendMessageStateQuote(
          api,
          message,
          `Không thể lấy được danh sách chặn thành viên từ ${groupTypeString}`,
          false,
          60000,
          false
        );
      }
      break;

    default:
      await sendMessageStateQuote(
        api,
        message,
        `Cú pháp câu lệnh: ${prefix}${aliasCommand} block <add/remove/list> <uid for add|index for remove>\n` +
        `list: hiển thị danh sách đối tượng chặn trong ${groupTypeString}.\n` +
        `add: thêm đối tượng vào danh sách chặn (thông qua mention hoặc uid chỉ định).\n` +
        `remove: xóa đối tượng khỏi danh sách chặn thông qua index hoặc 'all' để xóa toàn bộ.`,
        false,
        60000,
        false
      );
      break;
  }
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

export async function getGroupBlockList(api, message) {
  const threadId = message.threadId;
  let listBlockedUsers = [];
  let continueGet = true;
  let page = 1;

  try {
    while (continueGet) {
      const blockList = await api.getGroupBlockList(threadId, page);
      if (blockList && blockList.blocked_members && blockList.blocked_members.length > 0) {
        blockList.blocked_members = blockList.blocked_members.map((member) => {
          if (member.avatar && !member.avatar.startsWith("https:")) {
            member.avatar = "https:" + member.avatar;
          }
          if (member.avatar_25 && !member.avatar_25.startsWith("https:")) {
            member.avatar_25 = "https:" + member.avatar_25;
          }
          return member;
        });
        listBlockedUsers = [...listBlockedUsers, ...blockList.blocked_members];
        continueGet = blockList.has_more;
        page += 1;
      } else {
        continueGet = false;
      }
    }
    return listBlockedUsers;
  } catch (error) {
    throw error;
  }
}



async function createBlockListImage(blockList, groupTypeString) {
  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = "bold 32px BeVietnamPro";

  // Tính toán kích thước cần thiết
  const avatarSize = 80;
  const padding = 30;
  const nameWidth = 400;
  const levelWidth = 200;
  const extraPadding = padding * 4;

  // Tính tổng số người dùng bị block
  const totalBlockedUsers = blockList.length;
  const useDoubleColumn = totalBlockedUsers > 10;

  // Tính width tổng (nhân đôi nếu 2 cột)
  const columnWidth = avatarSize + nameWidth + levelWidth + extraPadding;
  const width = useDoubleColumn ? columnWidth * 2 + padding * 2 : columnWidth;

  // Tính chiều cao (chia 2 nếu 2 cột)
  const headerHeight = 180;
  const itemHeight = 120;
  const itemsPerColumn = useDoubleColumn ? Math.ceil(totalBlockedUsers / 2) : totalBlockedUsers;
  const height = headerHeight + itemsPerColumn * itemHeight + 40;

  // Tạo canvas chính
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Vẽ background với gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(59, 130, 246, 0.9)");
  gradient.addColorStop(1, "rgba(17, 24, 39, 0.95)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Vẽ tiêu đề chính
  let yPos = padding * 2;
  ctx.textAlign = "center";
  ctx.font = "bold 48px BeVietnamPro";
  ctx.fillStyle = cv.getRandomGradient(ctx, width);
  ctx.fillText("BLOCK-LIST-IN-GROUP", width / 2, yPos);

  // Vẽ phụ đề
  yPos += 80;
  ctx.font = "bold 36px BeVietnamPro";
  ctx.fillStyle = "#FFD700";
  ctx.fillText(`Danh Sách Chặn Của ${groupTypeString}`, width / 2, yPos);
  yPos += 40;

  if (useDoubleColumn) {
    // Chia danh sách thành 2 cột
    const midPoint = Math.ceil(blockList.length / 2);

    // Vẽ cột trái
    let leftYPos = yPos;
    for (let i = 0; i < midPoint; i++) {
      if (blockList[i]) {
        leftYPos = await drawBlockedItem(ctx, blockList[i], leftYPos, i + 1, padding, 0, useDoubleColumn);
      }
    }

    // Vẽ cột phải
    let rightYPos = yPos;
    for (let i = midPoint; i < blockList.length; i++) {
      if (blockList[i]) {
        rightYPos = await drawBlockedItem(
          ctx,
          blockList[i],
          rightYPos,
          i + 1,
          padding,
          columnWidth + padding * 2 - 30,
          useDoubleColumn
        );
      }
    }

    // Vẽ đường phân cách giữa 2 cột
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(width / 2, yPos - 20, 2, height - yPos);
  } else {
    // Vẽ 1 cột như bình thường
    let index = 1;
    for (const blockedUser of blockList) {
      yPos = await drawBlockedItem(ctx, blockedUser, yPos, index++, padding, 0, useDoubleColumn);
    }
  }

  // Lưu và trả về đường dẫn ảnh
  const outputPath = path.join(tempDir, `block_list_${Date.now()}.png`);
  const out = fsOnly.createWriteStream(outputPath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);

  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(outputPath));
    out.on("error", reject);
  });
}

async function drawBlockedItem(ctx, blockedUser, yPos, index, padding, xOffset, isDoubleColumn) {
  const itemHeight = 120;
  try {
    const avatarSize = 80;
    const itemPadding = 20;

    // Vẽ background cho item
    ctx.fillStyle = "rgba(29, 18, 18, 0.1)";
    ctx.beginPath();

    // Tính toán width của background
    const backgroundWidth = isDoubleColumn ? (ctx.canvas.width - padding * 4) / 2 : ctx.canvas.width - padding * 2;

    ctx.roundRect(padding + xOffset, yPos, backgroundWidth, itemHeight - itemPadding, 10);
    ctx.fill();

    // Vẽ avatar
    if (blockedUser.avatar && cv.isValidUrl(blockedUser.avatar)) {
      const avatar = await loadImage(blockedUser.avatar);
      const avatarX = padding * 2 + xOffset;
      const avatarY = yPos + (itemHeight - avatarSize) / 2 - itemPadding / 2;

      // Vẽ viền avatar
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 3, 0, Math.PI * 2);
      const borderGradient = ctx.createLinearGradient(avatarX, avatarY, avatarX + avatarSize, avatarY + avatarSize);
      borderGradient.addColorStop(0, "#dc3545");
      borderGradient.addColorStop(1, "#c82333");
      ctx.fillStyle = borderGradient;
      ctx.fill();

      // Vẽ avatar trong clip path tròn
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
    }

    // Vẽ separator
    const separatorX = padding * 3 + avatarSize + xOffset;
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(separatorX, yPos + itemPadding - 8, 2, itemHeight - itemPadding * 2);

    // Vẽ thông tin
    const textX = separatorX + padding * 2 - 20;
    const textY = yPos + itemPadding;

    ctx.textAlign = "left";
    ctx.font = "bold 32px BeVietnamPro";
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(`${index}. ${blockedUser.dName}`, textX, textY + 20);

    ctx.font = "28px BeVietnamPro";
    ctx.fillStyle = "#dc3545";
    ctx.fillText("Người Dùng Bị Chặn", textX, textY + 60);

    return yPos + itemHeight;
  } catch (error) {
    console.error("Lỗi khi vẽ thông tin người dùng bị block:", error);
    return yPos + itemHeight;
  }
}

async function updateGroupSetting(api, message, threadId, settings, successMessage) {
  await api.changeGroupSetting(threadId, settings);
  await sendMessageStateQuote(api, message, successMessage, true, 60000);
}

export async function isUserTagged(senderId, threadId) {
  return isUserTargeted(senderId, threadId);
}

export async function handleTaget(api, message, groupInfo, aliasCommand = "taget") {
  return executeUnifiedTargetCommand(api, message, groupInfo, resolveSafeAlias(aliasCommand, "taget"));
}

export async function handleMemberJoin(api, event) {
  return processUnifiedTargetJoin(api, event);
}