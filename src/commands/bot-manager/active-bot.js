import { MessageType } from "../../api-zalo/index.js";
import { nameServer, updateNameServer } from "../../utils/server-config.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageResultRequest,
  sendMessageStateQuote,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { restartSelf, requestRestartForBot, resolveRestartBotId } from "../../utils/util.js";
import { RESTART_EXIT_CODE } from "../../utils/restart-request.js";
import { readManagerFile, writeManagerFile, writeGroupSettings, readGroupSettings } from "../../utils/io-json.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { safeThreadType } from "../shared/command-input-utils.js";

// Khởi tạo managerData từ file
export const managerData = {
  data: readManagerFile(),
  hasChanges: false,
};

export async function notifyResetGroup(api) {
  const groupRequiredReset = managerData.data.groupRequiredReset;
  if (groupRequiredReset && groupRequiredReset !== "-1") {
    let group;
    try {
      group = await api.getGroupInfo(groupRequiredReset);
    } catch {
      group = null;
    }

    await sendMessageResultRequest(
      api,
      group ? MessageType.GroupMessage : MessageType.DirectMessage,
      groupRequiredReset,
      "Khởi động lại hoàn tất!\nBot đã hoạt động trở lại!",
      true,
      30000
    );
    managerData.data.groupRequiredReset = "-1";
    managerData.hasChanges = true;
    saveManagerData();
  }
}

export async function exitRestartBot(api, message) {
  try {
    const threadId = message.threadId;
    const threadType = safeThreadType(message);
    await sendMessageResultRequest(api, threadType, threadId, "Tiến hành khởi động lại...", true, 12000);

    await restartSelf(api, { ...message, type: threadType }, "rs", {
      suppressNotifyBeforeExit: true,
      exitCode: RESTART_EXIT_CODE,
    });
  } catch (error) {
    await sendMessageFailed(api, message, "Không thể khởi động lại bot: " + error.message, false, 15000);
  }
}

export const saveManagerData = () => {
  writeManagerFile(managerData.data);
  managerData.hasChanges = false;
};

/**
 * Persist `activeBot` on the CURRENT instance's group-settings store and confirm
 * the value round-trips to disk. Uses the same canonical group-settings path the
 * runtime reads (so the toggle is visible to chat gating), and it never mutates
 * a shared/foreign instance's store.
 *
 * @returns {Promise<boolean>} true when a direct re-read confirms the setting.
 */
async function persistActiveBotSetting(groupSettings, threadId, newStatus) {
  try {
    writeGroupSettings(groupSettings);
    const reread = readGroupSettings();
    const stored = reread?.[threadId];
    if (!stored || typeof stored !== "object") return false;
    return stored.activeBot === newStatus;
  } catch (error) {
    console.error(`[active-bot] Không thể lưu activeBot cho ${threadId}:`, error.message);
    return false;
  }
}

async function handleSetNameServer(api, message, newName) {
  if (!newName) {
    await sendMessageFailed(api, message, "Vui lòng nhập tên server mới!");
    return;
  }

  try {
    await updateNameServer(newName);
    await sendMessageComplete(api, message, `✅ Đã đổi nameServer thành: ${newName}\n`);
  } catch (err) {
    console.error(err);
    await sendMessageFailed(api, message, "⚠️ Lỗi khi đổi nameServer!");
  }
}

function buildBotCommandUsage(prefix) {
  return [
    "🤖 HƯỚNG DẪN LỆNH QUẢN LÝ BOT",
    `• ${prefix}bot [on|off]: Bật/tắt tương tác thành viên với bot trong nhóm`,
    `• ${prefix}bot privatebot [on|off]: Bật/tắt tương tác lệnh ở tin nhắn riêng tư (Admin cấp cao)`,
    `• ${prefix}bot rs: Khởi động lại bot (Admin cấp cao)`,
    `• ${prefix}bot nameserver [tên mới]: Xem hoặc đổi tên server bot (Admin cấp cao)`,
  ].join("\n");
}

export async function handleActiveBotUser(api, message, groupSettings, authorization = null) {
  const content = (removeMention(message) || "").trim();
  const threadId = message.threadId;
  const prefix = getGlobalPrefix() || "!";
  const authorizationSnapshot = authorization?.authorizationSnapshot || authorization || null;
  const isHigh = Boolean(authorizationSnapshot?.isAdminLevelHigh);

  let botCommand = content;
  if (botCommand.toLowerCase().startsWith(`${prefix.toLowerCase()}bot`)) {
    botCommand = botCommand.slice(`${prefix}bot`.length).trim();
  } else {
    botCommand = botCommand.replace(/^[!?/.]bot\b\s*/i, "").trim();
  }

  const parts = content.split(/\s+/).filter(Boolean);
  const subToken = (parts[1] || botCommand.split(/\s+/)[0] || "").toLowerCase();

  if (!subToken || subToken === "on" || subToken === "off") {
    if (groupSettings && message?.type !== MessageType.DirectMessage) {
      if (!groupSettings[threadId]) {
        groupSettings[threadId] = {};
      }
      let newStatus;
      if (!subToken) {
        newStatus = !groupSettings[threadId].activeBot;
      } else {
        newStatus = subToken === "off" ? false : true;
      }

      groupSettings[threadId].activeBot = newStatus;

      const didPersist = await persistActiveBotSetting(groupSettings, threadId, newStatus);

      const statusMessage = newStatus ? "kích hoạt" : "vô hiệu hóa";
      const caption = didPersist
        ? `Đã ${statusMessage} tương tác thành viên với bot trong nhóm này.`
        : `Không thể lưu trạng thái ${statusMessage} tương tác thành viên với bot trong nhóm này!`;
      if (didPersist) {
        await sendMessageStateQuote(api, message, caption, true, 60000);
      } else {
        await sendMessageFailed(api, message, caption);
      }
    } else {
      await sendMessageFailed(api, message, "Không thể bật/tắt chế độ nhóm ở tin nhắn riêng tư! Dùng `privatebot [on|off]` cho tin nhắn riêng.");
    }

    return true;
  }

  if (subToken === "privatebot") {
    if (!isHigh) {
      await sendMessageFailed(api, message, "Bạn không có quyền thay đổi chế độ tin nhắn riêng tư của bot!");
      return true;
    }
    const privateCommand = (parts[2] || "").trim().toLowerCase();
    if (privateCommand && privateCommand !== "on" && privateCommand !== "off") {
      await sendMessageStateQuote(
        api,
        message,
        `⚠️ Cú pháp: ${prefix}bot privatebot [on|off]`,
        true,
        60000,
        false
      );
      return true;
    }
    let newStatus;
    if (!privateCommand) {
      newStatus = !managerData.data.onBotPrivate;
    } else {
      newStatus = privateCommand === "on";
    }
    managerData.data.onBotPrivate = newStatus;
    managerData.hasChanges = true;
    saveManagerData();
    const statusMessage = newStatus ? "kích hoạt" : "vô hiệu hóa";
    const caption = `Đã ${statusMessage} tương tác lệnh trong tin nhắn riêng tư với tất cả người dùng.`;
    await sendMessageStateQuote(api, message, caption, true, 60000);
    return true;
  }

  if (parts[1]?.toLowerCase() === "rs" || subToken === "rs") {
    if (isHigh) {
      await exitRestartBot(api, message);
      return true;
    }
    await sendMessageFailed(api, message, "Bạn không có quyền khởi động lại bot!");
    return true;
  }

  if (subToken === "nameserver") {
    if (!isHigh) {
      await sendMessageFailed(api, message, "Bạn không có quyền thay đổi nameServer!");
      return true;
    }
    const newName = botCommand.replace(/^nameServer\b/i, "").trim();
    if (!newName) {
      await sendMessageComplete(api, message, `📛 NameServer hiện tại: ${nameServer || "Chưa có nameServer"}`);
      return true;
    }
    await handleSetNameServer(api, message, newName);
    return true;
  }

  await sendMessageStateQuote(
    api,
    message,
    buildBotCommandUsage(prefix),
    true,
    60000,
    false
  );
  return true;
}
