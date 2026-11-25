import { MessageType } from "../../api-zalo/models/Message.js";
import { appContext } from "../../api-zalo/context.js";
import { createGroupInfoImage, clearImagePath } from "../../utils/canvas/index.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
  sendMessageWarning,
} from "../chat-zalo/chat-style/chat-style.js";
import { getCommandConfig, readGroupSettings, writeGroupSettings } from "../../utils/io-json.js";
import { getBotId } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import {
  extractCleanArgs,
  extractCommandBody,
  resolveTargetUsers,
  safeThreadType,
} from "../../commands/shared/command-input-utils.js";
import { getUserInfoData } from "./user-info-data.js";
import { getGroupInfoData } from "./group-info-data.js";

export {
  getDataAllGroup,
  getGroupInfoData,
  getGroupName,
  isHttpNotFound,
  getInFlightGroupRequestCount,
  clearInFlightGroupRequests,
} from "./group-info-data.js";

const groupAutoLockTimers = new Map();

function getPrefix() {
  return getCommandConfig()?.prefix || "!";
}

function isGroupScope(message) {
  if (message?.type === MessageType.DirectMessage || message?.type === 0) return false;
  return safeThreadType(message) === MessageType.GroupMessage || message?.type === "group";
}

function getVietnamMinuteOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return h * 60 + m;
}

function isInsideScheduleWindow(nowMinutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function stopGroupAutoLockTimer(threadId) {
  const existing = groupAutoLockTimers.get(String(threadId));
  if (existing?.timer) {
    clearInterval(existing.timer);
  }
  groupAutoLockTimers.delete(String(threadId));
}

function startGroupAutoLockTimer(api, threadId, startStr, endStr) {
  stopGroupAutoLockTimer(threadId);
  const [sh, sm] = startStr.split(":").map(Number);
  const [eh, em] = endStr.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  const tick = async () => {
    try {
      const currentSettingsAll = readGroupSettings();
      const autoCfg = currentSettingsAll?.[threadId]?.autoLockChat;
      if (!autoCfg?.enabled || autoCfg.mode !== "schedule") {
        stopGroupAutoLockTimer(threadId);
        return;
      }
      const shouldLock = isInsideScheduleWindow(getVietnamMinuteOfDay(), startMin, endMin) ? 1 : 0;
      const entry = groupAutoLockTimers.get(String(threadId));
      if (entry && entry.lastApplied === shouldLock) return;

      const gInfo = await getGroupInfoData(api, threadId).catch(() => null);
      const currentLock = gInfo?.setting?.lockSendMsg ? 1 : 0;
      if (currentLock !== shouldLock) {
        await api.changeGroupSetting(threadId, { ...(gInfo?.setting || {}), lockSendMsg: shouldLock });
      }
      if (entry) entry.lastApplied = shouldLock;
    } catch {}
  };

  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  groupAutoLockTimers.set(String(threadId), { timer, lastApplied: null });
  return tick();
}

function normalizeInviteItems(rawData) {
  if (!rawData) return [];
  const list = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData.invitations)
      ? rawData.invitations
      : Array.isArray(rawData.items)
        ? rawData.items
        : Array.isArray(rawData.groupInfoList)
          ? rawData.groupInfoList
          : rawData.gridInfoMap && typeof rawData.gridInfoMap === "object"
            ? Object.values(rawData.gridInfoMap)
            : [];
  return list
    .map((item) => {
      const info = item?.groupInfo || item?.data || item || {};
      const groupId = String(info.groupId ?? info.grid ?? item?.grid ?? item?.groupId ?? item?.id ?? "").trim();
      if (!groupId) return null;
      return {
        groupId,
        name: String(info.name || info.groupName || item?.name || "Nhóm không tên").trim(),
        totalMember: info.totalMember ?? info.memberCount ?? null,
      };
    })
    .filter(Boolean);
}

async function handleCreateGroupAlias(api, message, aliasCommand) {
  const prefix = getPrefix();
  const body = extractCommandBody(message, prefix, aliasCommand);
  const botUid = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "").trim();

  let groupName = "";
  let memberTokens = [];
  if (body.includes("|")) {
    const [left, ...rightParts] = body.split("|");
    groupName = left.trim();
    memberTokens = rightParts.join(" ").trim().split(/\s+/).filter(Boolean);
  } else {
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    const nameWords = [];
    for (const tok of tokens) {
      const cleaned = tok.replace(/^@+/, "");
      if (/^\d{6,24}$/.test(cleaned)) {
        memberTokens.push(cleaned);
      } else {
        nameWords.push(tok);
      }
    }
    groupName = nameWords.join(" ").trim();
  }

  const members = resolveTargetUsers(message, memberTokens).filter((uid) => uid !== botUid);

  if (!body && members.length === 0) {
    await sendMessageQuery(
      api,
      message,
      `📌 Cú pháp tạo nhóm mới:\n• ${prefix}${aliasCommand} <Tên nhóm> | <UID1 UID2...>\n• ${prefix}${aliasCommand} <Tên nhóm> @tag1 @tag2`
    );
    return true;
  }

  if (members.length === 0) {
    await sendMessageQuery(
      api,
      message,
      `Vui lòng @mention hoặc nhập ít nhất 1 UID thành viên để tạo nhóm!\nVí dụ: ${prefix}${aliasCommand} ${groupName || "Nhóm Dự Án"} | 123456789`
    );
    return true;
  }

  const finalName = groupName || `Nhóm mới ${new Date().toLocaleDateString("vi-VN")}`;
  try {
    const created = await api.createGroup({ name: finalName, members });
    const newGroupId = created?.groupId || created?.grid || "Không xác định";
    await sendMessageComplete(
      api,
      message,
      `✅ Đã tạo nhóm "${finalName}" thành công!\n• ID nhóm: ${newGroupId}\n• Thành viên mời (${members.length}): ${members.join(", ")}`
    );
  } catch (error) {
    await sendMessageFailed(api, message, `Tạo nhóm thất bại: ${error?.message || error}`);
  }
  return true;
}

async function handleInviteBoxAlias(api, message, aliasCommand) {
  const prefix = getPrefix();
  const cleanArgs = extractCleanArgs(message, prefix, aliasCommand);
  const sub = (cleanArgs[0] || "list").toLowerCase();
  const target = (cleanArgs[1] || "").trim();

  try {
    if (!cleanArgs.length || sub === "list" || sub === "ls") {
      const raw = await api.getGroupInviteBoxList({ mpage: 1, page: 0, invPerPage: 20, mcount: 10 });
      const items = normalizeInviteItems(raw);
      if (items.length === 0) {
        await sendMessageStateQuote(api, message, "📭 Hiện không có lời mời tham gia nhóm nào đang chờ.", true, 60000);
        return true;
      }
      const lines = items.map(
        (it, idx) => `${idx + 1}. ${it.name} (ID: ${it.groupId})${it.totalMember ? ` - ${it.totalMember} TV` : ""}`
      );
      const replyText = [
        `📬 HỘP THƯ LỜI MỜI NHÓM (${items.length}):`,
        ...lines,
        "",
        `💡 Duyệt: ${prefix}${aliasCommand} accept <ID | STT | all>`,
        `🗑️ Xóa: ${prefix}${aliasCommand} del <ID | STT | all>`,
      ].join("\n");
      await api.sendMessage({ msg: replyText, quote: message, ttl: 180000 }, message.threadId, safeThreadType(message));
      return true;
    }

    if (sub === "accept" || sub === "acp" || sub === "join") {
      if (!target) {
        await sendMessageQuery(api, message, `Cú pháp: ${prefix}${aliasCommand} accept <ID_nhóm | STT | all>`);
        return true;
      }
      const acceptFn = api.acceptGroupInvite || api.joinGroupInviteBox;
      if (typeof acceptFn !== "function") {
        await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ chấp nhận lời mời nhóm.");
        return true;
      }

      if (target.toLowerCase() === "all") {
        const items = normalizeInviteItems(await api.getGroupInviteBoxList({ mpage: 1, page: 0, invPerPage: 50, mcount: 20 }));
        if (items.length === 0) {
          await sendMessageStateQuote(api, message, "📭 Không có lời mời nhóm nào để chấp nhận.", false, 60000);
          return true;
        }
        let okCount = 0;
        let failCount = 0;
        for (const it of items) {
          try {
            await acceptFn.call(api, it.groupId);
            okCount++;
          } catch {
            failCount++;
          }
        }
        await sendMessageComplete(
          api,
          message,
          `✅ Đã chấp nhận ${okCount}/${items.length} lời mời tham gia nhóm${failCount > 0 ? ` (Thất bại: ${failCount})` : ""}.`
        );
        return true;
      }

      let resolvedGroupId = target;
      if (/^\d{1,3}$/.test(target)) {
        const idx = Number(target) - 1;
        const items = normalizeInviteItems(await api.getGroupInviteBoxList({ mpage: 1, page: 0, invPerPage: 50, mcount: 20 }));
        if (idx < 0 || idx >= items.length) {
          await sendMessageWarning(api, message, `Số thứ tự ${target} không hợp lệ (hiện có ${items.length} lời mời).`);
          return true;
        }
        resolvedGroupId = items[idx].groupId;
      }

      await acceptFn.call(api, resolvedGroupId);
      await sendMessageComplete(api, message, `✅ Đã chấp nhận lời mời vào nhóm (ID: ${resolvedGroupId})!`);
      return true;
    }

    if (sub === "del" || sub === "delete" || sub === "remove" || sub === "xoa") {
      if (!target) {
        await sendMessageQuery(api, message, `Cú pháp: ${prefix}${aliasCommand} del <ID_nhóm | STT | all>`);
        return true;
      }
      if (target.toLowerCase() === "all") {
        const items = normalizeInviteItems(await api.getGroupInviteBoxList({ mpage: 1, page: 0, invPerPage: 50, mcount: 20 }));
        if (items.length === 0) {
          await sendMessageStateQuote(api, message, "📭 Hộp thư lời mời nhóm đã trống.", true, 60000);
          return true;
        }
        await api.deleteGroupInviteBox(items.map((i) => i.groupId), false);
        await sendMessageComplete(api, message, `🗑️ Đã xóa toàn bộ ${items.length} lời mời nhóm.`);
        return true;
      }

      let resolvedGroupId = target;
      if (/^\d{1,3}$/.test(target)) {
        const idx = Number(target) - 1;
        const items = normalizeInviteItems(await api.getGroupInviteBoxList({ mpage: 1, page: 0, invPerPage: 50, mcount: 20 }));
        if (idx < 0 || idx >= items.length) {
          await sendMessageWarning(api, message, `Số thứ tự ${target} không hợp lệ (hiện có ${items.length} lời mời).`);
          return true;
        }
        resolvedGroupId = items[idx].groupId;
      }

      await api.deleteGroupInviteBox(resolvedGroupId, false);
      await sendMessageComplete(api, message, `🗑️ Đã xóa lời mời nhóm (ID: ${resolvedGroupId}).`);
      return true;
    }

    await sendMessageQuery(
      api,
      message,
      `Cú pháp:\n• ${prefix}${aliasCommand} — Xem danh sách lời mời\n• ${prefix}${aliasCommand} accept <ID|STT|all> — Chấp nhận\n• ${prefix}${aliasCommand} del <ID|STT|all> — Xóa lời mời`
    );
  } catch (error) {
    await sendMessageFailed(api, message, `Lỗi thao tác hộp thư lời mời nhóm: ${error?.message || error}`);
  }
  return true;
}

async function handleGroupAutoLockAlias(api, message, aliasCommand, groupSettings = {}) {
  const threadId = message.threadId;
  const senderId = message?.data?.uidFrom;
  const prefix = getPrefix();

  if (!isAdmin(senderId, threadId)) {
    await sendMessageWarning(api, message, "Bạn cần quyền Quản trị viên nhóm để cấu hình khóa chat tự động!");
    return false;
  }

  const rawArg = extractCommandBody(message, prefix, aliasCommand).trim().toLowerCase();
  const effectiveSettings = groupSettings && typeof groupSettings === "object" ? groupSettings : readGroupSettings();
  if (!effectiveSettings[threadId]) effectiveSettings[threadId] = {};

  try {
    const groupInfo = await getGroupInfoData(api, threadId);
    const currentSettings = { ...(groupInfo?.setting || {}) };

    if (!rawArg || rawArg === "status") {
      const isLocked = Boolean(currentSettings.lockSendMsg);
      const autoCfg = effectiveSettings[threadId]?.autoLockChat;
      const scheduleDesc = autoCfg?.enabled && autoCfg?.mode === "schedule"
        ? `${autoCfg.start} - ${autoCfg.end} (Giờ VN)`
        : "Chưa đặt lịch";
      await sendMessageStateQuote(
        api,
        message,
        [
          `🔐 TRẠNG THÁI KHÓA CHAT NHÓM`,
          `• Hiện tại: ${isLocked ? "Đang khóa chat 🔒" : "Đang mở chat 🔓"}`,
          `• Lịch tự động: ${scheduleDesc}`,
          `💡 Cách dùng: ${prefix}${aliasCommand} <on | off | HH:mm-HH:mm>`,
        ].join("\n"),
        isLocked,
        120000
      );
      return false;
    }

    if (rawArg === "on" || rawArg === "lock" || rawArg === "1") {
      stopGroupAutoLockTimer(threadId);
      currentSettings.lockSendMsg = 1;
      await api.changeGroupSetting(threadId, currentSettings);
      effectiveSettings[threadId].autoLockChat = { enabled: true, mode: "manual" };
      writeGroupSettings(effectiveSettings);
      await sendMessageStateQuote(api, message, "🔒 Đã bật khóa chat cho toàn bộ thành viên trong nhóm!", true, 120000);
      return true;
    }

    if (rawArg === "off" || rawArg === "unlock" || rawArg === "0") {
      stopGroupAutoLockTimer(threadId);
      currentSettings.lockSendMsg = 0;
      await api.changeGroupSetting(threadId, currentSettings);
      effectiveSettings[threadId].autoLockChat = { enabled: false };
      writeGroupSettings(effectiveSettings);
      await sendMessageStateQuote(api, message, "🔓 Đã mở khóa chat và tắt lịch khóa tự động của nhóm!", false, 120000);
      return true;
    }

    const schedMatch = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawArg);
    if (schedMatch) {
      const start = `${schedMatch[1].padStart(2, "0")}:${schedMatch[2]}`;
      const end = `${schedMatch[3].padStart(2, "0")}:${schedMatch[4]}`;
      effectiveSettings[threadId].autoLockChat = {
        enabled: true,
        mode: "schedule",
        start,
        end,
      };
      writeGroupSettings(effectiveSettings);
      await startGroupAutoLockTimer(api, threadId, start, end);
      await sendMessageStateQuote(
        api,
        message,
        `⏰ Đã đặt lịch tự động khóa chat nhóm từ ${start} đến ${end} hằng ngày (Giờ Việt Nam)!`,
        true,
        180000
      );
      return true;
    }

    await sendMessageQuery(
      api,
      message,
      `Cú pháp không hợp lệ! Vui lòng dùng:\n• ${prefix}${aliasCommand} on — Khóa chat ngay\n• ${prefix}${aliasCommand} off — Mở khóa chat\n• ${prefix}${aliasCommand} 23:00-06:00 — Hẹn giờ khóa tự động`
    );
  } catch (error) {
    await sendMessageFailed(api, message, `Không thể cập nhật khóa chat nhóm: ${error?.message || error}`);
  }
  return false;
}

async function handleKiemTraAlias(api, message, groupSettings = {}) {
  const threadId = message.threadId;
  try {
    const groupInfo = await getGroupInfoData(api, threadId);
    const admins = await getGroupAdmins(groupInfo);
    const botId = String(getBotId() || appContext?.uid || api?.getOwnId?.() || "").trim();

    let botRoleLabel = "👤 Thành viên thường (Chưa có Key quản trị)";
    if (botId && String(groupInfo?.creatorId) === botId) {
      botRoleLabel = "🔑 Trưởng nhóm (Key Vàng)";
    } else if (botId && admins.map(String).includes(botId)) {
      botRoleLabel = "🗝️ Phó nhóm (Key Bạc)";
    }

    const gs = groupSettings?.[threadId] || readGroupSettings()?.[threadId] || {};
    const flagEntries = [
      ["Tương tác Bot", gs.activeBot],
      ["Duyệt thành viên", gs.memberApprove],
      ["Chào mừng / Tạm biệt", gs.welcomeGroup || gs.byeGroup],
      ["Chống Link", gs.removeLinks || gs.antiLink],
      ["Chống Spam", gs.antiSpam],
      ["Lọc từ thô tục", gs.antiBadWord || gs.filterBadWords],
      ["Chống SĐT", gs.antiPhoneNumber || gs.antiPhone],
      ["Chống Nude", gs.antiNude],
      ["Chống Thu hồi", gs.antiUndo],
      ["Chống Tag ẩn/nhiều", gs.antiTag],
      ["Chống Sticker/GIF", gs.antiSticker || gs.antiStickerLag || gs.antiGif],
      ["Chống Video/Ảnh/File", gs.antiVideo || gs.antiPhoto || gs.antiFile],
      ["Chỉ văn bản (OnlyText)", gs.onlyText],
      ["Chống Bot lạ / Mass Kick", gs.antiBot || gs.antiKickBlock],
    ];

    const activeProtections = flagEntries.filter(([, on]) => Boolean(on)).map(([label]) => label);
    const inactiveCount = flagEntries.length - activeProtections.length;

    const report = [
      `🛡️ BÁO CÁO KIỂM TRA NHÓM: ${groupInfo?.name || threadId}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• ID Nhóm: ${threadId}`,
      `• Thành viên: ${groupInfo?.totalMember ?? groupInfo?.memVerList?.length ?? "N/A"} | QTV Zalo: ${admins.length}`,
      `• Quyền của Bot: ${botRoleLabel}`,
      `• Khóa chat Zalo: ${groupInfo?.setting?.lockSendMsg ? "Đang khóa 🔒" : "Đang mở 🔓"}`,
      `• Phê duyệt vào nhóm: ${groupInfo?.setting?.joinAppr ? "Bật ✅" : "Tắt ❌"}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `✅ Tính năng đang bật (${activeProtections.length}): ${activeProtections.length > 0 ? activeProtections.join(", ") : "Chưa bật tính năng nào"}`,
      `⚪ Tính năng đang tắt: ${inactiveCount} mục`,
    ].join("\n");

    await api.sendMessage(
      { msg: report, quote: message, ttl: 300000 },
      threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    await sendMessageWarning(api, message, `Không thể kiểm tra trạng thái nhóm: ${error?.message || error}`);
  }
  return true;
}

export async function groupInfoCommand(api, message, aliasCommand = "group", args = [], groupSettings = {}) {
  const normalizedAlias = String(aliasCommand || message?.aliasCommand || "group").trim().toLowerCase();

  if (normalizedAlias === "create-group" || normalizedAlias === "creategr") {
    return handleCreateGroupAlias(api, message, normalizedAlias);
  }

  if (normalizedAlias === "invite-box" || normalizedAlias === "invitebox") {
    return handleInviteBoxAlias(api, message, normalizedAlias);
  }

  if (!isGroupScope(message)) {
    await sendMessageWarning(
      api,
      message,
      `⚠️ Lệnh "${getPrefix()}${normalizedAlias}" chỉ có thể sử dụng trong nhóm trò chuyện!`
    );
    return true;
  }

  if (normalizedAlias === "group-autolock") {
    return handleGroupAutoLockAlias(api, message, normalizedAlias, groupSettings);
  }

  if (normalizedAlias === "kiemtra") {
    return handleKiemTraAlias(api, message, groupSettings);
  }

  const threadId = message.threadId;
  let imagePath = null;

  try {
    const groupInfo = await getGroupInfoData(api, threadId);
    const rawOwner = groupInfo?.creatorId
      ? await getUserInfoData(api, groupInfo.creatorId).catch(() => null)
      : null;
    const safeOwner = rawOwner && typeof rawOwner === "object"
      ? rawOwner
      : {
          name: "Không xác định",
          uid: groupInfo?.creatorId || "N/A",
          avatar: "",
        };

    imagePath = await createGroupInfoImage(groupInfo, safeOwner);
    if (imagePath) {
      await api.sendMessage(
        { msg: "", attachments: [imagePath], quote: message, ttl: 600000 },
        threadId,
        MessageType.GroupMessage
      );
    } else {
      const fallbackText = [
        `📋 THÔNG TIN NHÓM: ${groupInfo?.name || "Nhóm"}`,
        `• ID Nhóm: ${threadId}`,
        `• Trưởng nhóm: ${safeOwner.name} (${safeOwner.uid})`,
        `• Tổng thành viên: ${groupInfo?.totalMember ?? groupInfo?.memVerList?.length ?? "N/A"}`,
      ].join("\n");
      await api.sendMessage(
        { msg: fallbackText, quote: message, ttl: 300000 },
        threadId,
        MessageType.GroupMessage
      );
    }
  } catch (error) {
    await sendMessageWarning(
      api,
      message,
      "Đã xảy ra lỗi khi lấy thông tin nhóm. Vui lòng thử lại sau!"
    );
  } finally {
    if (imagePath) await clearImagePath(imagePath);
  }
}

export async function getGroupAdmins(groupInfo) {
  try {
    const admins = Array.isArray(groupInfo?.adminIds)
      ? [...groupInfo.adminIds]
      : [];
    if (groupInfo?.creatorId && !admins.includes(groupInfo.creatorId)) {
      admins.push(groupInfo.creatorId);
    }
    return admins;
  } catch (error) {
    console.error("Failed to get group admins:", error);
    return [];
  }
}
