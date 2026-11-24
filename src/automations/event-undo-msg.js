import { initGroupSettings } from "../commands/command.js";
import { getBotId } from "../utils/env.js";
import { isAdmin } from "../utils/role-policy.js";
import { antiUndoGroup } from "../service-debug/anti-service/anti-undo.js";
import { getGroupAdmins, getGroupInfoData } from "../service-debug/info-service/group-info.js";
import { readGroupSettings } from "../utils/io-json.js";

export async function undoMessageEvents(api, undo) {
  const threadId = undo?.data?.idTo || undo?.threadId;
  const senderId = undo?.data?.uidFrom || undo?.senderId;
  const idBot = getBotId();
  const isSelf = String(idBot) === String(senderId);
  const isGroup = undo?.isGroup ?? true;

  if (isGroup && threadId) {
    let groupInfo;
    let groupAdmins;
    try {
      groupInfo = await getGroupInfoData(api, threadId);
      groupAdmins = await getGroupAdmins(groupInfo);
    } catch (err) {
      console.warn(`[antiundo] Không thể xác minh quyền quản trị nhóm ${threadId}: ${err?.message || err}`);
      return;
    }

    if (!groupInfo || !Array.isArray(groupAdmins)) {
      console.warn(`[antiundo] Không thể xác minh quyền quản trị nhóm ${threadId}: dữ liệu nhóm không hợp lệ`);
      return;
    }

    const botIsAdminBox = groupAdmins.includes(idBot.toString());
    const isAdminBox = isAdmin(senderId, threadId, groupAdmins);
    const groupSettings = api?.groupSettings || readGroupSettings();
    try {
      initGroupSettings(groupSettings, threadId, groupInfo?.name);
    } catch {}

    await antiUndoGroup(api, undo, isAdminBox, groupSettings, botIsAdminBox, isSelf);
  }
}
