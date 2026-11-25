import { sendMessageStateQuote, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { removeMention } from "../../utils/format-util.js";
import { extractCommandBody } from "../shared/command-input-utils.js";
import { getWelcomeSettingKey } from "./welcome-command.js";

export async function handleWelcomeBye(api, message, groupSettings, canonicalCommand) {
  const content = removeMention(message).trim();
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  const [rawCommand, rawOption] = content.split(/\s+/);
  const option = rawOption ? rawOption.toLowerCase() : "";
  const safeCanonical = typeof canonicalCommand === "string" ? canonicalCommand : "";
  const settingKey = getWelcomeSettingKey(safeCanonical || rawCommand, prefix);
  let newStatus;
  if (option === "on") {
    newStatus = true;
  } else if (option === "off") {
    newStatus = false;
  } else if (!option) {
    if (!settingKey) {
      await sendMessageWarning(
        api,
        message,
        "Cú pháp không hợp lệ. Vui lòng sử dụng '!welcome', '!bye' hoặc '!updategroup' cùng với [on/off]"
      );
      return false;
    }
    newStatus = !groupSettings[threadId][settingKey];
  } else {
    await sendMessageWarning(
      api,
      message,
      "Cú pháp không hợp lệ..!"
    );
    return false;
  }

  if (!settingKey) {
    await sendMessageWarning(api, message, "Lệnh không hợp lệ!");
    return false;
  }

  groupSettings[threadId][settingKey] = newStatus;
  const status = newStatus ? "bật" : "tắt";
  let featureName;

  switch (settingKey) {
    case "welcomeGroup":
      featureName = "chào mừng thành viên mới";
      break;
    case "byeGroup":
      featureName = "tạm biệt thành viên rời nhóm";
      break;
    case "updateGroup":
      featureName = "thông báo cập nhật nhóm";
      break;
    default:
      featureName = "tính năng";
  }

  await sendMessageStateQuote(
    api,
    message,
    `Đã ${status} chức năng ${featureName}!`,
    newStatus,
    300000
  );

  return true;
}

export async function handleApprove(api, message, groupSettings) {
  const content = removeMention(message).trim();
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  const [, rawOption] = content.split(/\s+/);
  const option = rawOption ? rawOption.toLowerCase() : "";
  let newStatus;
  if (option === "on") {
    newStatus = true;
  } else if (option === "off") {
    newStatus = false;
  } else if (!option) {
    newStatus = !groupSettings[threadId].memberApprove;
  } else {
    await sendMessageWarning(
      api,
      message,
      "Cú pháp Không hợp lệ. Vui lòng sử dụng '!approve [on/off]'."
    );
    return false;
  }

  groupSettings[threadId].memberApprove = newStatus;

  const status = newStatus ? "bật" : "tắt";
  await sendMessageStateQuote(api, message, `Đã ${status} chức năng tự động phê duyệt thành viên mới!`, newStatus, 300000);
  if (newStatus && typeof api?.handleGroupPendingMembers === "function") {
    try {
      await api.handleGroupPendingMembers(threadId, true);
    } catch (error) {
      console.warn(`[approve] Không thể duyệt danh sách chờ hiện tại của nhóm ${threadId}:`, error?.message || error);
    }
  }
  return true;
}

export async function handlePrWelcome(api, message, groupSettings, aliasCommand = "prwelcome") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "prwelcome";
  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  const body = extractCommandBody(message, prefix, safeAlias);
  const [firstToken = "", ...restTokens] = body.split(/\s+/);
  const subCmd = firstToken.toLowerCase();

  if (subCmd === "set") {
    const prText = body.slice(firstToken.length).trim();
    if (!prText) {
      await sendMessageWarning(
        api,
        message,
        `Vui lòng nhập nội dung PR chào mừng!\nVí dụ: ${prefix}${safeAlias} set Chào mừng bạn đến với nhóm!`
      );
      return false;
    }
    groupSettings[threadId].prWelcomeText = prText;
    groupSettings[threadId].prWelcome = true;
    await sendMessageStateQuote(
      api,
      message,
      `Đã cập nhật nội dung và bật PR chào mừng thành viên mới!\n📝 Nội dung: ${prText}`,
      true,
      300000
    );
    return true;
  }

  let newStatus;
  if (subCmd === "on" && restTokens.length === 0) {
    newStatus = true;
  } else if (subCmd === "off" && restTokens.length === 0) {
    newStatus = false;
  } else if (!subCmd) {
    newStatus = !groupSettings[threadId].prWelcome;
  } else {
    await sendMessageWarning(
      api,
      message,
      `Cú pháp không hợp lệ! Sử dụng:\n• ${prefix}${safeAlias} [on/off]\n• ${prefix}${safeAlias} set <nội dung PR>`
    );
    return false;
  }

  groupSettings[threadId].prWelcome = newStatus;
  const status = newStatus ? "bật" : "tắt";
  await sendMessageStateQuote(
    api,
    message,
    `Đã ${status} chức năng PR chào mừng thành viên mới!`,
    newStatus,
    300000
  );
  return true;
}
