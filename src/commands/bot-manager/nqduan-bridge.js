import fs from "node:fs/promises";
import path from "node:path";

import { MessageType } from "../../api-zalo/models/index.js";
import { getBotId } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import { sendMessageFailed, sendMessageResultRequest, sendMessageStateQuote, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { getDataAllGroup, getGroupAdmins, getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { createBotRuntimeContext, ensureRuntimeDirectories } from "../../utils/bot-runtime-context.js";
import { removeMention } from "../../utils/format-util.js";
import {
  createNqduanApiAdapter,
  createNqduanBridgeRuntime,
  normalizeNqduanMessage,
} from "./nqduan-adapter.js";

function ensureGroupSettings(groupSettings, threadId) {
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  return groupSettings[threadId];
}

function getTargetStorePath() {
  const botId = getBotId() || "admin";
  const context = createBotRuntimeContext(botId);
  ensureRuntimeDirectories(context);
  return path.join(context.stateDir, "target-list.json");
}

async function readTargetStore() {
  try {
    const raw = await fs.readFile(getTargetStorePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeTargetStore(data) {
  const filePath = getTargetStorePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function readCommandParts(message) {
  return removeMention(message).trim().split(/\s+/).filter(Boolean);
}

async function sendGroupText(api, threadId, messageText, ttl = 300000) {
  await api.sendMessage({ msg: messageText, ttl }, threadId, MessageType.GroupMessage);
}

export async function handleKickImageCommand(api, message, groupSettings) {
  api = createNqduanApiAdapter(api, { commandName: "kickimg", commandGroup: "antiService" });
  message = normalizeNqduanMessage(message);
  const threadId = message.threadId;
  const content = removeMention(message);
  const status = content.split(/\s+/)[1];
  const setting = ensureGroupSettings(groupSettings, threadId);

  if (status === "on") setting.enableKickImage = true;
  else if (status === "off") setting.enableKickImage = false;
  else setting.enableKickImage = !setting.enableKickImage;

  const newStatus = setting.enableKickImage ? "bật" : "tắt";
  await sendMessageStateQuote(api, message, `Chức năng thông báo kick thành viên đã được ${newStatus}!`, setting.enableKickImage, 300000);
  return true;
}

export async function handleBlockImageCommand(api, message, groupSettings) {
  api = createNqduanApiAdapter(api, { commandName: "blockimg", commandGroup: "antiService" });
  message = normalizeNqduanMessage(message);
  const threadId = message.threadId;
  const content = removeMention(message);
  const status = content.split(/\s+/)[1];
  const setting = ensureGroupSettings(groupSettings, threadId);

  if (status === "on") setting.enableBlockImage = true;
  else if (status === "off") setting.enableBlockImage = false;
  else setting.enableBlockImage = !setting.enableBlockImage;

  const newStatus = setting.enableBlockImage ? "bật" : "tắt";
  await sendMessageStateQuote(api, message, `Chức năng thông báo block thành viên đã được ${newStatus}!`, setting.enableBlockImage, 300000);
  return true;
}

export async function handleDisperseGroupCommand(api, message) {
  const runtime = createNqduanBridgeRuntime({
    commandName: "dispersegroup",
    api,
    message,
  });
  api = runtime.api;
  message = runtime.message;
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;

  if (message.type !== MessageType.GroupMessage) {
    await sendMessageWarning(api, message, "Lệnh này chỉ có thể dùng trong nhóm chat.");
    return false;
  }

  if (!isAdmin(senderId, threadId)) {
    await sendMessageWarning(api, message, "Chỉ quản trị viên nhóm mới có quyền giải tán nhóm.");
    return false;
  }

  await sendMessageWarning(api, message, "⚠️ Đang tiến hành GIẢI TÁN NHÓM...", false);
  await api.disperseGroup(threadId);
  return true;
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
  const botId = getBotId();

  await sendMessageResultRequest(api, MessageType.GroupMessage, threadId, "🔍 Đang quét các box...", true, 10000);

  try {
    const groups = await getDataAllGroup(api);
    let leftCount = 0;

    for (const group of groups) {
      try {
        const groupInfo = await getGroupInfoData(api, group.groupId);
        const isLocked = groupInfo?.lockSendMsg === 1 || groupInfo?.setting?.lockSendMsg === 1;
        if (!isLocked) continue;

        const groupAdmins = await getGroupAdmins(groupInfo);
        if (groupAdmins.includes(botId?.toString?.() || String(botId))) continue;

        await api.leaveGroup(group.groupId);
        leftCount++;
      } catch (error) {
        console.error(`Lỗi khi xử lý group ${group.groupId}:`, error.message);
      }
    }

    await sendMessageResultRequest(
      api,
      MessageType.GroupMessage,
      threadId,
      leftCount > 0
        ? `✅ Đã rời ${leftCount} box bị khóa chat (đã bỏ qua các box mà bot là admin).`
        : `⚡ Không tìm thấy box nào bị khóa chat hoặc tất cả box khóa đều là admin.`,
      true,
      180000,
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

  try {
    await sendGroupText(api, commandBoxId, "🚀 Đang rời tất cả box...\n[ Bỏ qua box gọi lệnh ]");

    const groups = await getDataAllGroup(api);
    let successCount = 0;

    for (const group of groups) {
      if (group.groupId === commandBoxId) continue;
      try {
        await api.leaveGroup(group.groupId);
        successCount++;
      } catch (error) {
        console.error(`Không thoát được nhóm ${group.groupId}:`, error.message);
      }
    }

    await sendGroupText(api, commandBoxId, `✅ Đã rời thành công ${successCount} box.`, 60000);
    return true;
  } catch (error) {
    await sendGroupText(api, commandBoxId, `❌ Lỗi khi xử lý: ${error.message}`, 60000);
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

export async function handleKeyCommand(api, message, groupSettings, isAdminLevelHighest) {
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
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const content = removeMention(message).toLowerCase().trim();

  if (!content.startsWith(`${prefix}key`) && !content.startsWith("key")) {
    return false;
  }

  const cleanCmd = content.replace(prefix, "").trim();
  if (cleanCmd === "key" || cleanCmd === "key ") {
    await sendMessageStateQuote(
      api,
      message,
      [
        "🔑 HƯỚNG DẪN LỆNH KEY",
        `• ${prefix}key gold @mention: đưa key vàng`,
        `• ${prefix}key up @mention: phong key bạc`,
        `• ${prefix}key down @mention: hạ key bạc`,
      ].join("\n"),
      true,
      600000,
    );
    return true;
  }

  if (!cleanCmd.startsWith("key gold") && !cleanCmd.startsWith("key up") && !cleanCmd.startsWith("key down")) {
    return false;
  }

  if (!isAdminLevelHighest) {
    await sendMessageStateQuote(api, message, "Chỉ chủ bot mới được dùng lệnh key!", false, 300000);
    return true;
  }

  const action = cleanCmd.includes("key gold") ? "gold" : cleanCmd.includes("key up") ? "up" : "down";
  const mentions = message.data.mentions || [];
  const args = readCommandParts(message).slice(2);
  const groupState = ensureGroupSettings(groupSettings, threadId);

  if (mentions.length === 0 && args.length === 0) {
    await applyKeyAction(api, message, threadId, senderId, "bạn", action);
  } else if (mentions.length > 0) {
    for (const mention of mentions) {
      const targetId = normalizeId(mention.uid);
      const targetName = message.data.content.substring(mention.pos, mention.pos + mention.len).replace("@", "").trim() || targetId;
      await applyKeyAction(api, message, threadId, targetId, targetName, action);
    }
  } else {
    for (const uid of args) {
      const targetId = normalizeId(uid);
      if (!targetId) continue;
      await applyKeyAction(api, message, threadId, targetId, targetId, action);
    }
  }

  void groupState;
  return true;
}

async function readTargetList() {
  return await readTargetStore();
}

async function writeTargetList(targetData) {
  await writeTargetStore(targetData);
}

async function isUserTagged(senderId, threadId) {
  const data = await readTargetList();
  const normalizedSenderId = String(senderId);
  const groupData = data[threadId] || { targetList: [] };
  return groupData.targetList.some((tagged) => tagged.idUserZalo === normalizedSenderId);
}

async function sendTargetHelp(api, message) {
  const prefix = getGlobalPrefix();
  await sendMessageWarning(
    api,
    message,
    [
      "🚨 Sai cú pháp!",
      `• ${prefix}target add @user|UID`,
      `• ${prefix}target list`,
      `• ${prefix}target remove [số thứ tự]`,
      `• ${prefix}target remove all`,
    ].join("\n"),
    false,
  );
}

async function handleTargetAdd(api, message, args) {
  const threadId = message.threadId;
  const targetData = await readTargetList();
  if (!targetData[threadId]) targetData[threadId] = { targetList: [] };

  const uidsToBlock = [];
  const usersToProcess = [];

  if (message.data.mentions && message.data.mentions.length > 0) {
    for (const mention of message.data.mentions) {
      const userId = normalizeId(mention.uid);
      if (isAdmin(userId, threadId)) {
        await sendMessageWarning(api, message, `Đại Ca không thể target quản trị viên: ${mention.name || userId}`, false);
        continue;
      }
      const userName = message.data.content.substring(mention.pos, mention.pos + mention.len).replace("@", "");
      uidsToBlock.push(userId);
      usersToProcess.push({ uid: userId, name: userName });
    }
  } else if (args.length > 0) {
    for (const uidArg of args) {
      const userId = normalizeId(uidArg);
      if (!userId) continue;
      if (!/^\d+$/.test(userId)) {
        await sendMessageWarning(api, message, `"${userId}" không phải là UID hợp lệ.`, false);
        continue;
      }
      if (isAdmin(userId, threadId)) {
        await sendMessageWarning(api, message, `Đại Ca không thể target quản trị viên: ${userId}`, false);
        continue;
      }

      try {
        const userInfo = await getUserInfoData(api, userId);
        uidsToBlock.push(userId);
        usersToProcess.push({ uid: userId, name: userInfo.name || userId });
      } catch {
        await sendMessageWarning(api, message, `Không tìm thấy tài khoản với UID: ${userId}`, false);
      }
    }
  } else {
    await sendMessageWarning(api, message, "Đại Ca muốn target ai? Hãy @tag hoặc nhập UID.", false);
    return;
  }

  if (usersToProcess.length === 0) return;

  let blockResult = { errorMembers: [] };
  if (uidsToBlock.length > 0) {
    try {
      blockResult = await api.blockUsers(threadId, uidsToBlock);
    } catch (error) {
      console.error("Lỗi khi gọi api.blockUsers:", error);
      blockResult.errorMembers = [...uidsToBlock];
    }
  }

  let addedNew = false;
  const successfullyBlockedNames = [];
  const failedToBlockButTargetedNames = [];
  const alreadyTargetedNames = [];

  for (const user of usersToProcess) {
    const alreadyTargeted = targetData[threadId].targetList.some((tagged) => tagged.idUserZalo === user.uid);
    if (alreadyTargeted) {
      alreadyTargetedNames.push(user.name);
      continue;
    }

    targetData[threadId].targetList.push({ idUserZalo: user.uid, senderName: user.name });
    addedNew = true;

    if (blockResult.errorMembers?.includes(user.uid)) failedToBlockButTargetedNames.push(user.name);
    else successfullyBlockedNames.push(user.name);
  }

  if (addedNew) await writeTargetList(targetData);

  const lines = [];
  if (successfullyBlockedNames.length > 0) lines.push(`✅ Đã target và chặn thành công: ${successfullyBlockedNames.join(", ")}`);
  if (failedToBlockButTargetedNames.length > 0) lines.push(`⚠️ Không tìm thấy trong nhóm nhưng đã thêm vào target: ${failedToBlockButTargetedNames.join(", ")}`);
  if (alreadyTargetedNames.length > 0) lines.push(`❌ Đã target từ trước: ${alreadyTargetedNames.join(", ")}`);

  if (lines.length > 0) {
    await sendMessageStateQuote(api, message, lines.join("\n"), true, 300000);
  }
}

async function handleTargetList(api, message) {
  const threadId = message.threadId;
  const targetData = await readTargetList();
  const targetList = targetData[threadId]?.targetList || [];

  if (targetList.length === 0) {
    await sendMessageStateQuote(api, message, "✅ Nhóm này chưa target ai.", true, 300000);
    return;
  }

  const lines = targetList
    .map((entry, index) => `${index + 1}. ${entry.senderName || entry.idUserZalo} (${entry.idUserZalo})`)
    .slice(0, 50);

  await sendMessageStateQuote(api, message, `📋 Danh sách target:\n${lines.join("\n")}`, true, 300000);
}

async function handleTargetRemove(api, message, args) {
  const threadId = message.threadId;
  const indexToRemove = Number.parseInt(args[0], 10);

  if (!Number.isInteger(indexToRemove) || indexToRemove <= 0) {
    await sendMessageWarning(api, message, `Vui lòng nhập số thứ tự hợp lệ để xóa.\nDùng ${getGlobalPrefix()}target list để xem số.`, false);
    return;
  }

  const targetData = await readTargetList();
  const targetList = targetData[threadId]?.targetList || [];
  if (indexToRemove > targetList.length) {
    await sendMessageWarning(api, message, `Số thứ tự ${indexToRemove} không có trong danh sách.`, false);
    return;
  }

  const removed = targetList[indexToRemove - 1];
  targetData[threadId].targetList = targetList.filter((_, idx) => idx !== indexToRemove - 1);
  await writeTargetList(targetData);
  await sendMessageStateQuote(api, message, `✅ Đã xóa '${removed.senderName || removed.idUserZalo}' (STT ${indexToRemove}) khỏi danh sách target.`, true, 300000);
}

async function handleTargetRemoveAll(api, message) {
  const threadId = message.threadId;
  const targetData = await readTargetList();
  const originalLength = (targetData[threadId]?.targetList || []).length;
  if (originalLength === 0) {
    await sendMessageStateQuote(api, message, "✅ Danh sách target đã trống.", true, 300000);
    return;
  }

  targetData[threadId].targetList = [];
  await writeTargetList(targetData);
  await sendMessageStateQuote(api, message, `✅ Đã xóa toàn bộ ${originalLength} người dùng khỏi danh sách target.`, true, 300000);
}

export async function handleTargetCommand(api, message) {
  const runtime = createNqduanBridgeRuntime({
    commandName: "target",
    api,
    message,
  });
  api = runtime.api;
  message = runtime.message;
  const senderId = message.data.uidFrom;
  const threadId = message.threadId;

  if (!isAdmin(senderId, threadId)) {
    await sendMessageWarning(api, message, "Bạn không có quyền sử dụng lệnh này!");
    return false;
  }

  const prefix = getGlobalPrefix();
  const content = removeMention(message).slice(prefix.length).trim();
  const args = content.split(/\s+/);
  args.shift();
  const action = args.shift()?.toLowerCase();

  switch (action) {
    case "add":
      await handleTargetAdd(api, message, args);
      break;
    case "list":
      await handleTargetList(api, message);
      break;
    case "remove":
      if (args[0]?.toLowerCase() === "all") {
        await handleTargetRemoveAll(api, message);
      } else {
        await handleTargetRemove(api, message, args);
      }
      break;
    default:
      await sendTargetHelp(api, message);
  }

  return true;
}

export async function handleTargetOnJoin(api, event) {
  const threadId = event.threadId;
  const updateMembers = event.data?.updateMembers || [];
  if (!updateMembers.length) return false;

  const botId = getBotId();
  const groupInfo = await getGroupInfoData(api, threadId).catch(() => null);
  const groupAdmins = groupInfo ? await getGroupAdmins(groupInfo).catch(() => []) : [];
  if (!botId || !groupAdmins.includes(String(botId))) return false;

  let handled = false;
  for (const member of updateMembers) {
    const userId = normalizeId(member.id);
    if (!(await isUserTagged(userId, threadId))) continue;

    handled = true;
    const userInfo = await getUserInfoData(api, userId).catch(() => ({ name: member.name || userId, avatar: null }));
    await api.blockUsers(threadId, [userId]).catch(() => {});
    await sendGroupText(api, threadId, `🚨 ${userInfo.name || userId} đã bị chặn tự động do nằm trong danh sách target!`);
  }

  return handled;
}
