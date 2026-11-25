import { MessageType } from "../../api-zalo/models/Message.js";
import { isAdmin } from "../../utils/role-policy.js";
import {
  sendMessageComplete,
  sendMessageQuery,
  sendMessageWarning,
} from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { removeMention } from "../../utils/format-util.js";
import {
  extractCleanArgs,
  getQuotedUid,
  resolveTargetUsers,
  safeThreadType,
} from "../../commands/shared/command-input-utils.js";

function parseMuteDurationSeconds(raw) {
  if (!raw) return { seconds: -1, label: "vĩnh viễn" };
  const match = /^(\d+)(s|g|m|p|h|d)?$/i.exec(String(raw).trim());
  if (!match) return null;
  const val = Number.parseInt(match[1], 10);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = (match[2] || "m").toLowerCase();
  if (unit === "s" || unit === "g") return { seconds: val, label: `${val} giây` };
  if (unit === "m" || unit === "p") return { seconds: val * 60, label: `${val} phút` };
  if (unit === "h") return { seconds: val * 3600, label: `${val} giờ` };
  if (unit === "d") return { seconds: val * 86400, label: `${val} ngày` };
  return { seconds: val * 60, label: `${val} phút` };
}

export async function handleWhiteList(api, message, groupSettings = {}, groupAdmins = [], aliasCommand = "whitelist") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const effectiveAlias = String(aliasCommand || message?.aliasCommand || "whitelist").trim().toLowerCase();

  // Branch explicitly for setmute: mute/unmute conversation notifications for bot, NEVER touching whiteList!
  if (effectiveAlias === "setmute") {
    const args = extractCleanArgs(message, prefix, "setmute");
    const sub = (args[0] || "").toLowerCase();
    const muteType = safeThreadType(message) === MessageType.DirectMessage ? 1 : 2;

    if (!sub || sub === "help") {
      await sendMessageQuery(
        api,
        message,
        `🔔 Cú pháp tắt/bật thông báo hội thoại cho Bot:\n• ${prefix}setmute on [30p|1h|8h] — Tắt thông báo (mặc định vĩnh viễn)\n• ${prefix}setmute off — Bật lại thông báo`
      );
      return false;
    }

    if (typeof api?.setMute !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ thao tác tắt/bật thông báo hội thoại.");
      return false;
    }

    try {
      if (["off", "unmute", "0", "mo", "mở"].includes(sub)) {
        await api.setMute(threadId, -1, 3, muteType);
        await sendMessageComplete(api, message, "🔔 Đã bật lại thông báo cho cuộc trò chuyện này.");
        return false;
      }

      let durationInfo = { seconds: -1, label: "vĩnh viễn" };
      if (["on", "mute", "1", "tat", "tắt"].includes(sub)) {
        if (args[1]) {
          const parsed = parseMuteDurationSeconds(args[1]);
          if (!parsed) {
            await sendMessageQuery(api, message, `Thời lượng không hợp lệ. Ví dụ: ${prefix}setmute on 1h hoặc ${prefix}setmute off`);
            return false;
          }
          durationInfo = parsed;
        }
      } else {
        const parsed = parseMuteDurationSeconds(sub);
        if (!parsed) {
          await sendMessageQuery(api, message, `Tham số không hợp lệ! Dùng: ${prefix}setmute <on | off | 30p | 1h | 8h>`);
          return false;
        }
        durationInfo = parsed;
      }

      await api.setMute(threadId, durationInfo.seconds, 1, muteType);
      await sendMessageComplete(
        api,
        message,
        `🔕 Đã tắt thông báo cuộc trò chuyện (${durationInfo.label}) cho bot.`
      );
    } catch (error) {
      await sendMessageWarning(api, message, `Không thể cập nhật thông báo hội thoại: ${error?.message || error}`);
    }
    return false;
  }

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  const args = extractCleanArgs(message, prefix, effectiveAlias);
  const command = args[0]?.toLowerCase();
  let isChangeSetting = false;

  if (!command || (command !== "add" && command !== "remove")) {
    const currentWhiteList = groupSettings[threadId]?.whiteList || {};
    if (Object.keys(currentWhiteList).length === 0) {
      await sendMessageWarning(
        api,
        message,
        "Hiện không có người dùng nào trong danh sách white-list."
      );
      return isChangeSetting;
    }

    let whiteListMessage = "Danh sách người dùng trong white-list:\n";
    const idWhiteList = Object.keys(currentWhiteList).map((id) => `${id}_0`);
    let whiteListInfo = { profiles: {} };
    if (typeof api?.getGroupMembers === "function") {
      try {
        whiteListInfo = (await api.getGroupMembers(idWhiteList)) || { profiles: {} };
      } catch {
        whiteListInfo = { profiles: {} };
      }
    }
    const whiteListUsers = idWhiteList
      .map((id, index) => {
        const userId = id.split("_")[0];
        const profile = whiteListInfo?.profiles?.[userId] || whiteListInfo?.profiles?.[id];
        const displayName =
          profile?.zaloName ||
          profile?.displayName ||
          profile?.dName ||
          groupSettings[threadId]?.whiteList?.[userId]?.name ||
          userId;
        return `${index + 1}. ${displayName}`;
      })
      .join("\n");

    whiteListMessage += whiteListUsers;

    await api.sendMessage(
      { msg: whiteListMessage, quote: message, ttl: 300000 },
      threadId,
      safeThreadType(message)
    );
    return isChangeSetting;
  }

  const mentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];

  if (command === "remove" && (!mentions || mentions.length === 0) && !getQuotedUid(message)) {
    const indexToRemove = parseInt(args[1], 10);
    if (!isNaN(indexToRemove) && String(args[1] || "").length < 6) {
      const whiteList = groupSettings[threadId].whiteList || {};
      const whiteListArray = Object.entries(whiteList);

      if (indexToRemove > 0 && indexToRemove <= whiteListArray.length) {
        const [userId, userInfo] = whiteListArray[indexToRemove - 1];
        delete groupSettings[threadId].whiteList[userId];
        await sendMessageComplete(
          api,
          message,
          `Đã xóa ${userInfo?.name || userId} khỏi danh sách white-list.`
        );
        return true;
      } else {
        await sendMessageWarning(
          api,
          message,
          `Số thứ tự không hợp lệ. Vui lòng chọn số từ 1 đến ${whiteListArray.length}.`
        );
        return false;
      }
    }
  }

  const targetEntries = [];
  if (mentions.length > 0) {
    const rawContent = String(message?.data?.content || "");
    for (const mention of mentions) {
      if (!mention?.uid) continue;
      const userId = String(mention.uid).trim();
      const userName =
        typeof mention.pos === "number" && typeof mention.len === "number"
          ? rawContent.substr(mention.pos, mention.len).replace("@", "").trim() || userId
          : userId;
      targetEntries.push({ userId, userName });
    }
  } else {
    const resolvedUids = resolveTargetUsers(message, args.slice(1));
    for (const uid of resolvedUids) {
      const existingName = groupSettings[threadId]?.whiteList?.[uid]?.name || uid;
      targetEntries.push({ userId: uid, userName: existingName });
    }
  }

  if (targetEntries.length === 0) {
    await sendMessageQuery(
      api,
      message,
      "Vui lòng đề cập (@mention), reply tin nhắn người dùng hoặc nhập số thứ tự/UID để thêm/xóa khỏi white-list."
    );
    return isChangeSetting;
  }

  if (!groupSettings[threadId].whiteList) {
    groupSettings[threadId].whiteList = {};
  }

  for (const { userId, userName } of targetEntries) {
    if (command === "add") {
      if (isAdmin(userId, threadId, groupAdmins)) {
        await sendMessageWarning(
          api,
          message,
          `${userName} đã là quản trị viên nên không cần thêm vào white-list.`
        );
        continue;
      }

      if (!groupSettings[threadId].whiteList[userId]) {
        groupSettings[threadId].whiteList[userId] = {
          name: userName,
        };
        await sendMessageComplete(
          api,
          message,
          `Đã thêm ${userName} vào danh sách white-list.`
        );
        isChangeSetting = true;
      } else {
        await sendMessageWarning(
          api,
          message,
          `${userName} đã có trong danh sách white-list.`
        );
      }
    } else if (command === "remove") {
      if (groupSettings[threadId].whiteList[userId]) {
        const storedName = groupSettings[threadId].whiteList[userId]?.name || userName;
        delete groupSettings[threadId].whiteList[userId];
        await sendMessageComplete(
          api,
          message,
          `Đã xóa ${storedName} khỏi danh sách white-list.`
        );
        isChangeSetting = true;
      } else {
        await sendMessageWarning(
          api,
          message,
          `${userName} không có trong danh sách white-list.`
        );
      }
    }
  }

  return isChangeSetting;
}

export function isInWhiteList(groupSettings, threadId, senderId) {
  const whiteList = groupSettings?.[threadId]?.whiteList;
  if (!whiteList || !senderId) return false;
  if (Array.isArray(whiteList)) {
    return whiteList.includes(senderId);
  }
  return Boolean(whiteList[senderId]);
}

