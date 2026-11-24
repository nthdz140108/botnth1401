import { MessageType } from "../../api-zalo/index.js";
import { nameServer, updateNameServer } from "../../utils/server-config.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageResultRequest, 
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { requestRestartForBot, resolveRestartBotId } from "../../utils/util.js";
import { RESTART_EXIT_CODE } from "../../utils/restart-request.js";
import { readManagerFile, writeManagerFile, writeGroupSettings, readGroupSettings } from "../../utils/io-json.js";
import { getGlobalPrefix } from "../../service-debug/service.js";

// Khởi tạo managerData từ file
export const managerData = {
  data: readManagerFile(),
  hasChanges: false,
};

export async function notifyResetGroup(api) {
  const groupRequiredReset = managerData.data.groupRequiredReset;
  if (groupRequiredReset !== "-1") {
    let group;
    try {
      group = await api.getGroupInfo(groupRequiredReset);
    } catch (error) {
      await sendMessageResultRequest(api, MessageType.GroupMessage, groupRequiredReset, "Không thể lấy thông tin nhóm, vui lòng thử lại sau!", true, 30000);
      return;
    }

    await sendMessageResultRequest(api,
      group ? MessageType.GroupMessage : MessageType.DirectMessage,
      groupRequiredReset,
      "Khởi động lại hoàn tất!\nBot đã hoạt động trở lại!", true, 30000);
    managerData.data.groupRequiredReset = "-1";
    managerData.hasChanges = true;
    saveManagerData();
  }
}

export async function exitRestartBot(api, message) {
  try {
    const threadId = message.threadId;
    managerData.data.groupRequiredReset = threadId;
    managerData.hasChanges = true;
    saveManagerData();

    await sendMessageResultRequest(api, message.type ?? MessageType.GroupMessage, threadId, "Tiến hành khởi động lại...", true, 12000);

    requestRestartForBot(resolveRestartBotId(api), { threadId, type: message.type });

    await new Promise(resolve => setTimeout(resolve, 1000));

    process.exit(RESTART_EXIT_CODE);
  } catch (error) {
    await sendMessageFailed(api, message, "Không thể tắt bot: " + error.message, false, 15000);
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
    return api.sendMessage("❌ Vui lòng nhập tên server mới!", message.threadId);
  }

  try {
    await updateNameServer(newName);
    await sendMessageComplete(api, message, `✅ Đã đổi nameServer thành: ${newName}\n`);
  } catch (err) {
    console.error(err);
    await sendMessageFailed(api, message, "⚠️ Lỗi khi đổi nameServer!");
  }
}

export async function handleActiveBotUser(api, message, groupSettings, authorization = null) {
  const content = removeMention(message).trim();
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
    if (groupSettings) {
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

      // Persist to the CURRENT instance's settings file and confirm by
      // re-reading from disk. Only report success once the value actually
      // round-trips (groupId + activeBot present).
      const didPersist = await persistActiveBotSetting(groupSettings, threadId, newStatus);

      const statusMessage = newStatus ? "kích hoạt" : "vô hiệu hóa";
      const caption = didPersist
        ? `Đã ${statusMessage} tương tác thành viên với bot trong nhóm này.`
        : `Không thể lưu trạng thái ${statusMessage} tương tác thành viên với bot trong nhóm này!`;
      if (didPersist) {
        if (newStatus) {
          await sendMessageComplete(api, message, caption);
        } else {
          await sendMessageFailed(api, message, caption);
        }
      } else {
        await sendMessageFailed(api, message, caption);
      }
    } else {
      await sendMessageFailed(api, message, "Không thể setup nhóm ở tin nhắn riêng tư!");
    }

    return true;
  }

  if (subToken === "privatebot") {
    if (!isHigh) {
      await sendMessageFailed(api, message, "Bạn không có quyền thay đổi chế độ tin nhắn riêng tư của bot!");
      return true;
    }
    const privateCommand = (parts[2] || "").trim().toLowerCase();
    let newStatus;
    if (!privateCommand) {
      newStatus = !managerData.data.onBotPrivate;
    } else {
      newStatus = privateCommand === "on" ? true : false;
    }
    managerData.data.onBotPrivate = newStatus;
    managerData.hasChanges = true;
    saveManagerData();
    const statusMessage = newStatus ? "kích hoạt" : "vô hiệu hóa";
    const caption = `Đã ${statusMessage} tương tác lệnh trong tin nhắn riêng tư với tất cả người dùng.`;
    if (newStatus) {
      await sendMessageComplete(api, message, caption);
    } else {
      await sendMessageFailed(api, message, caption);
    }
    return true;
  }

  if (parts[1]?.toLowerCase() === "rs" || subToken === "rs") {
    // Strictly require adminLevelHigh (instance owner / supreme admin)
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

  return false;
}
