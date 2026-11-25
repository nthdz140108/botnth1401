import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { isAdmin } from "../../utils/role-policy.js";
import { sendMessageComplete, sendMessageQuery, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { readCommandConfig, readGroupSettings, writeGroupSettings } from "../../utils/io-json.js";
import { formatSeconds, removeMention } from "../../utils/format-util.js";

function getGlobalPrefix() {
  return readCommandConfig()?.prefix || "!";
}

// Thêm hằng số để định nghĩa giá trị vô thời hạn
const PERMANENT_MUTE = -1;
const MUTE_COMMAND_ALIASES = ["mute", "cam", "câm"];
const UNMUTE_COMMAND_ALIASES = ["unmute", "sua", "sửa", "sủa"];

function isDurationToken(token) {
  if (!token) return false;
  return /^(?:\d+(?:s|g|m|p|h|d)|\d{1,7})$/i.test(String(token).trim());
}

function parseTime(timeStr) {
  if (!timeStr || !isDurationToken(timeStr)) return PERMANENT_MUTE;
  const trimmed = String(timeStr).trim();
  const match = /^(\d+)(s|g|m|p|h|d)?$/i.exec(trimmed);
  if (!match) return PERMANENT_MUTE;

  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();

  if (Number.isNaN(value) || value <= 0) return PERMANENT_MUTE;

  switch (unit) {
    case "s": // giây
    case "g":
      return value;
    case "m": // phút
    case "p":
      return value * 60;
    case "h": // giờ
      return value * 3600;
    case "d": // ngày
      return value * 86400;
    default:
      return value;
  }
}

function stripSurfaceAliases(content, prefix, aliases = []) {
  const normContent = String(content || "").normalize("NFC").trim();
  const normPrefix = String(prefix || "!").normalize("NFC");
  const sorted = [...new Set(aliases.filter(Boolean).map((a) => String(a).normalize("NFC")))].sort(
    (a, b) => b.length - a.length
  );
  const lower = normContent.toLowerCase();
  for (const alias of sorted) {
    const token = `${normPrefix}${alias}`.toLowerCase();
    if (lower === token) return "";
    if (lower.startsWith(token) && /\s/.test(normContent[token.length] || "")) {
      return normContent.slice(token.length).trim();
    }
  }
  // Fallback if a custom alias was used without being listed
  const parts = normContent.split(/\s+/);
  if (parts[0]?.toLowerCase().startsWith(normPrefix.toLowerCase())) {
    return parts.slice(1).join(" ").trim();
  }
  return normContent;
}

function isMuted(groupSettings, threadId, senderId) {
  const muteInfo = groupSettings[threadId]?.muteList?.[senderId];
  if (!muteInfo) return false;

  if (muteInfo.timeMute === PERMANENT_MUTE) return true;
  
  const remainingTime = muteInfo.timeMute - Math.floor(Date.now() / 1000);
  if (remainingTime <= 0) {
    delete groupSettings[threadId].muteList[senderId];
    return false;
  }
  return true;
}

function isAllMuted(groupSettings, threadId) {
  const muteInfo = groupSettings[threadId]?.muteList?.[-1];
  if (!muteInfo) return false;

  if (muteInfo.timeMute === PERMANENT_MUTE) return true;

  const remainingTime = muteInfo.timeMute - Math.floor(Date.now() / 1000);
  if (remainingTime <= 0) {
    delete groupSettings[threadId].muteList[-1];
    return false;
  }
  return true;
}

function isUnmuteCommand(message) {
  if (!message?.data || typeof message.data.content !== "string") return false;
  const prefix = (() => {
    try { return getGlobalPrefix(); } catch { return "!"; }
  })().normalize("NFC").toLowerCase();
  const raw = message.data.content.normalize("NFC").trim().toLowerCase();

  for (const alias of UNMUTE_COMMAND_ALIASES) {
    const cmd = `${prefix}${alias.normalize("NFC").toLowerCase()}`;
    if (raw === cmd || raw.startsWith(`${cmd} `)) return true;
    const idx = raw.indexOf(` ${cmd}`);
    if (idx !== -1) {
      const after = raw[idx + 1 + cmd.length];
      if (after === undefined || /\s/.test(after)) return true;
    }
  }
  return false;
}

/**
 * Listener-time mute enforcement.
 *
 * Capability model (distinct from `adminBox`):
 *  - Key vàng (trưởng nhóm): `groupInfo.creatorId === botId`.
 *  - Key bạc (phó nhóm): `groupInfo.adminIds` includes `botId`.
 * `botCanDeleteGroupMessages` represents whether the bot itself can revoke
 * a member's message in this group. Only that flag governs deletion here;
 * `isAdminBox` is irrelevant to the delete path.
 *
 * Mute applies to everyone, including adminBox users, but a user with
 * `adminBox` rights may still send `!unmute` / `!unmute all` so they can
 * lift the mute on themselves or on the group.
 *
 * @returns {Promise<boolean>} true if the message must be blocked from
 *   chat/command/protection pipelines (muted and not an unmute carve-out).
 */
export async function handleMute(api, message, groupSettings, flags = {}) {
  const {
    isAdminBox = false,
    botCanDeleteGroupMessages = false,
    isSelf = false,
  } = flags || {};

  const senderId = message?.data?.uidFrom;
  const threadId = message?.threadId;
  if (!senderId || !threadId) return false;
  if (!groupSettings[threadId]) return false;

  if (!groupSettings[threadId].muteList) {
    groupSettings[threadId].muteList = {};
  }

  if (isSelf) return false;

  const userMuted = isMuted(groupSettings, threadId, senderId);
  const allMuted = isAllMuted(groupSettings, threadId);
  if (!userMuted && !allMuted) return false;

  // Carve-out: adminBox user sending an unmute command may pass through
  // the mute layer so the unmute can execute and lift the mute.
  if (isAdminBox && isUnmuteCommand(message)) {
    return false;
  }

  if (botCanDeleteGroupMessages && typeof api?.deleteMessage === "function") {
    try {
      await api.deleteMessage(message, false);
    } catch (err) {
      // Listener must not crash if the Zalo API rejects the delete.
      console.error("[handleMute] deleteMessage failed:", err?.message || err);
    }
  }

  // Always block further processing (chat/reply/command/protection) for
  // muted senders, even when the bot lacks delete capability or the API
  // errored, so a muted message never reaches the rest of the pipeline.
  return true;
}

export async function handleMuteList(api, message, groupSettings) {
  const threadId = message.threadId;
  const muteList = groupSettings?.[threadId]?.muteList;
  if (!muteList || typeof muteList !== "object") {
    await sendMessageWarning(api, message, "Hiện Không có người dùng nào bị cấm chat.");
    return;
  }

  const currentTime = Math.floor(Date.now() / 1000);
  for (const [id, muteInfo] of Object.entries(muteList)) {
    if (!muteInfo || (muteInfo.timeMute !== PERMANENT_MUTE && muteInfo.timeMute <= currentTime)) {
      delete muteList[id];
    }
  }

  if (Object.keys(muteList).length === 0) {
    await sendMessageWarning(api, message, "Hiện Không có người dùng nào bị cấm chat.");
    return;
  }

  let muteListMessage = "Danh sách người dùng bị cấm chat:\n";

  if (muteList[-1]) {
    const muteInfo = muteList[-1];
    const timeStr = muteInfo.timeMute === PERMANENT_MUTE
      ? "vô thời hạn"
      : `còn ${formatSeconds(muteInfo.timeMute - currentTime)}`;
    muteListMessage += `- Tất cả thành viên (${timeStr})\n`;
  }

  const mutedUsers = Object.entries(muteList)
    .filter(([id]) => id !== "-1")
    .map(([id, muteInfo], index) => {
      const timeStr = muteInfo.timeMute === PERMANENT_MUTE
        ? "vô thời hạn"
        : `còn ${formatSeconds(muteInfo.timeMute - currentTime)}`;
      return `${index + 1}. ${muteInfo.name || id} (${timeStr})`;
    });

  muteListMessage += mutedUsers.join("\n");

  await api.sendMessage(
    { msg: muteListMessage, quote: message, ttl: 300000 },
    threadId,
    MessageType.GroupMessage
  );
}

export async function addOrUpdateMute(api, message, userId, userName, duration, groupSettings) {
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  if (!groupSettings[threadId].muteList) groupSettings[threadId].muteList = {};
  const currentTime = Math.floor(Date.now() / 1000);
  let isChangeSetting = false;

  if (!groupSettings[threadId].muteList[userId]) {
    groupSettings[threadId].muteList[userId] = {
      name: userName,
      timeMute: duration === PERMANENT_MUTE ? PERMANENT_MUTE : currentTime + duration,
    };
    const timeMsg = duration === PERMANENT_MUTE ? "vô thời hạn" : `trong ${formatSeconds(duration)}`;
    await sendMessageComplete(api, message, `Đã cấm chat người dùng ${userName} ${timeMsg}.`);
    isChangeSetting = true;
  } else {
    const existingMute = groupSettings[threadId].muteList[userId];
    const oldDuration =
      existingMute.timeMute === PERMANENT_MUTE
        ? "vô thời hạn"
        : formatSeconds(Math.max(0, existingMute.timeMute - currentTime));

    existingMute.timeMute = duration === PERMANENT_MUTE ? PERMANENT_MUTE : currentTime + duration;
    const newDuration = duration === PERMANENT_MUTE ? "vô thời hạn" : `trong ${formatSeconds(duration)}`;

    await sendMessageComplete(
      api,
      message,
      `Đã cập nhật thời gian cấm chat cho ${userName}:\n- Cũ: ${oldDuration}\n- Mới: ${newDuration}`
    );
    isChangeSetting = true;
  }

  return isChangeSetting;
}

export async function handleMuteUser(api, message, groupSettings, groupAdmins, aliasCommand = "mute") {
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  if (!groupSettings[threadId].muteList) groupSettings[threadId].muteList = {};

  const content = removeMention(message);
  const prefix = getGlobalPrefix();
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "";
  const body = stripSurfaceAliases(content, prefix, [...MUTE_COMMAND_ALIASES, safeAlias]);
  const tokens = body.split(/\s+/).filter(Boolean);
  const durationToken = tokens.find((tok) => isDurationToken(tok));
  const duration = parseTime(durationToken);

  let isChangeSetting = false;

  if (tokens.some((tok) => tok.toLowerCase() === "all")) {
    isChangeSetting = await addOrUpdateMute(api, message, -1, "All Users", duration, groupSettings);
    return isChangeSetting;
  }

  const mentions = message.data?.mentions;
  if (mentions && mentions.length > 0) {
    for (const mention of mentions) {
      const userId = mention.uid;
      const rawContent = String(message.data?.content || "");
      const extractedName =
        typeof mention.pos === "number" && typeof mention.len === "number"
          ? rawContent.substr(mention.pos, mention.len).replace(/^@/, "").trim()
          : "";
      const userName = extractedName || String(userId);

      const targetIsAdmin =
        isAdmin(userId, threadId, groupAdmins) ||
        (Array.isArray(groupAdmins) && groupAdmins.some((id) => String(id) === String(userId))) ||
        Boolean(groupSettings?.[threadId]?.adminList?.[userId]);

      if (targetIsAdmin) {
        await sendMessageWarning(api, message, `Không thể cấm chat ${userName} vì họ là quản trị viên.`);
        continue;
      }

      if (await addOrUpdateMute(api, message, userId, userName, duration, groupSettings)) {
        isChangeSetting = true;
      }
    }
  } else {
    await sendMessageQuery(api, message, "Vui lòng đề cập (@mention) người dùng cần cấm chat.");
  }
  return isChangeSetting;
}

export async function handleUnmuteUser(api, message, groupSettings, aliasCommand = "unmute") {
  let isChangeSetting = false;
  const content = removeMention(message);
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  if (!groupSettings[threadId].muteList) groupSettings[threadId].muteList = {};

  const prefix = getGlobalPrefix();
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "";
  const body = stripSurfaceAliases(content, prefix, [...UNMUTE_COMMAND_ALIASES, safeAlias]);
  const tokens = body.split(/\s+/).filter(Boolean);

  if (tokens.some((tok) => tok.toLowerCase() === "all")) {
    if (groupSettings[threadId].muteList[-1]) {
      delete groupSettings[threadId].muteList[-1];
      isChangeSetting = true;
      await sendMessageComplete(api, message, "Đã mở chat tất cả thành viên trong nhóm.");
    } else {
      await sendMessageWarning(api, message, "Tất cả thành viên chưa bị cấm chat.");
    }
    return isChangeSetting;
  }

  const unmuteReferences = message.data?.mentions;
  if (unmuteReferences && unmuteReferences.length > 0) {
    for (const mention of unmuteReferences) {
      const userId = mention.uid;
      if (groupSettings[threadId].muteList[userId]) {
        const userName = groupSettings[threadId].muteList[userId];
        delete groupSettings[threadId].muteList[userId];
        isChangeSetting = true;
        await sendMessageComplete(api, message, `Đã mở chat người dùng ${userName.name || userId || userName}.`);
      } else {
        const rawContent = String(message.data?.content || "");
        const extractedName =
          typeof mention.pos === "number" && typeof mention.len === "number"
            ? rawContent.substr(mention.pos, mention.len).replace(/^@/, "").trim()
            : "";
        const userName = extractedName || String(userId);
        await sendMessageWarning(
          api,
          message,
          `Người dùng ${userName} Không tồn tại trong danh sách cấm chat.`
        );
      }
    }
  } else {
    await sendMessageQuery(api, message, "Vui lòng đề cập (@mention) người dùng cần mở chat.");
  }
  return isChangeSetting;
}

var muteCheckInterval;
export function stopMuteCheck() {
  if (muteCheckInterval) {
    clearInterval(muteCheckInterval);
    muteCheckInterval = null;
  }
}

export async function startMuteCheck(api, intervalMs = 5000) {
  if (muteCheckInterval) {
    clearInterval(muteCheckInterval);
  }

  muteCheckInterval = setInterval(async () => {
    try {
      const groupSettings = readGroupSettings();
      let changeSetting = false;
      const currentTime = Math.floor(Date.now() / 1000);

      for (const [threadId, threadSettings] of Object.entries(groupSettings)) {
        if (!threadSettings?.muteList) continue;

        for (const [userId, muteInfo] of Object.entries(threadSettings.muteList)) {
          if (!muteInfo || muteInfo.timeMute === PERMANENT_MUTE) continue;

          if (currentTime >= muteInfo.timeMute) {
            delete threadSettings.muteList[userId];
            changeSetting = true;
            const name = userId === "-1" ? "Tất cả thành viên" : muteInfo.name;
            const capText = " đã được mở chat, hãy phát biểu tích cực hơn nhé!";
            const mentions = userId === "-1" ? [] : [MessageMention(userId, name.length, 0)];
            try {
              await api.sendMessage(
                { msg: name + capText, mentions },
                threadId,
                MessageType.GroupMessage
              );
            } catch (sendErr) {
              console.error("[mute-user] Lỗi gửi thông báo mở khóa chat:", sendErr?.message || sendErr);
            }
          }
        }
      }

      if (changeSetting) {
        writeGroupSettings(groupSettings);
      }
    } catch (err) {
      console.error("[mute-user] Lỗi kiểm tra mở khóa chat:", err?.message || err);
    }
  }, intervalMs);
  muteCheckInterval.unref?.();
  return muteCheckInterval;
}

export async function extendMuteDuration(threadId, userId, userName, groupSettings, extensionDuration = 900) {
  const currentTime = Math.floor(Date.now() / 1000);
  let isChangeSetting = false;

  if (!groupSettings[threadId].muteList) {
    groupSettings[threadId].muteList = {};
  }

  if (!groupSettings[threadId].muteList[userId]) {
    groupSettings[threadId].muteList[userId] = {
      name: userName,
      timeMute: currentTime + extensionDuration,
    };
    isChangeSetting = true;
  } else {
    const existingMute = groupSettings[threadId].muteList[userId];
    
    // Nếu đang mute vĩnh viễn thì giữ nguyên
    if (existingMute.timeMute === PERMANENT_MUTE) {
      return isChangeSetting;
    }
    
    const remainingTime = Math.max(0, existingMute.timeMute - currentTime);
    existingMute.timeMute = currentTime + remainingTime + extensionDuration;
    isChangeSetting = true;
  }

  if (isChangeSetting) {
    writeGroupSettings(groupSettings);
  }
  return isChangeSetting;
}

