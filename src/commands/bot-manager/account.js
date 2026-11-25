import path from "node:path";
import { MessageType } from "../../api-zalo/models/Message.js";
import { appContext } from "../../api-zalo/context.js";
import { isAdmin } from "../../utils/role-policy.js";
import { getBotId } from "../../utils/env.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { sendMessageComplete, sendMessageFailed, sendMessageQuery, sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { tempDir } from "../../utils/io-json.js";
import { downloadFile, deleteFile } from "../../utils/util.js";
import {
  extractCleanArgs,
  extractCommandBody,
  getQuoteData,
  safeThreadType,
} from "../shared/command-input-utils.js";

const AVATAR_COMMAND_ALIASES = new Set([
  "setavatar-account",
  "setavataraccount",
  "setavtacc",
  "setavt",
  "changeavatar",
]);

function extractAvatarSourceFromQuote(rawAttach) {
  if (!rawAttach) return { url: "", localPath: "" };
  if (typeof rawAttach === "object") {
    const rawUrl = String(
      rawAttach.hdUrl || rawAttach.oriUrl || rawAttach.href || rawAttach.normalUrl || rawAttach.thumbUrl || ""
    ).replace(/\\\//g, "/").trim();
    return { url: rawUrl, localPath: "" };
  }
  const str = String(rawAttach).trim();
  if (!str) return { url: "", localPath: "" };
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object") {
      const rawUrl = String(
        parsed.hdUrl || parsed.oriUrl || parsed.href || parsed.normalUrl || parsed.thumbUrl || ""
      ).replace(/\\\//g, "/").trim();
      return { url: rawUrl, localPath: "" };
    }
  } catch {
    // Not a JSON string; fall through to URL / local path handling
  }
  if (/^https?:\/\//i.test(str)) {
    return { url: str, localPath: "" };
  }
  return { url: "", localPath: str };
}

function resolveAvatarInput(message, prefix, aliasCommand) {
  const quote = getQuoteData(message);
  if (quote?.attach) {
    const fromQuote = extractAvatarSourceFromQuote(quote.attach);
    if (fromQuote.url || fromQuote.localPath) return fromQuote;
  }
  const directAttach = message?.data?.attach || message?.data?.content?.href || null;
  if (directAttach) {
    const fromDirect = extractAvatarSourceFromQuote(directAttach);
    if (fromDirect.url || fromDirect.localPath) return fromDirect;
  }
  const args = extractCleanArgs(message, prefix, aliasCommand);
  const urlArg = args.find((token) => /^https?:\/\//i.test(token));
  if (urlArg) {
    return { url: urlArg, localPath: "" };
  }
  return { url: "", localPath: "" };
}

function normalizeDobString(accountInfo) {
  const fallbackDob = "2000-01-01";
  if (!accountInfo || typeof accountInfo !== "object") return fallbackDob;

  if (typeof accountInfo.dob === "string") {
    const trimmed = accountInfo.dob.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    }
  }

  if (typeof accountInfo.sdob === "string") {
    const trimmed = accountInfo.sdob.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
    }
  }

  if (typeof accountInfo.dob === "number" && Number.isFinite(accountInfo.dob) && accountInfo.dob > 0) {
    const ms = accountInfo.dob < 1e11 ? accountInfo.dob * 1000 : accountInfo.dob;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    }
  }

  return fallbackDob;
}

function formatGenderLabel(gender) {
  if (Number(gender) === 0) return "Nam";
  if (Number(gender) === 1) return "Nữ";
  return "Không xác định";
}

export async function handleRenameCommand(api, message, aliasCommand = "name", options = {}) {
  const senderId = String(message?.data?.uidFrom || message?.senderID || "");
  const threadId = message?.threadId;
  const prefix = getGlobalPrefix();
  const normalizedAlias = String(aliasCommand || message?.aliasCommand || "name").trim().toLowerCase();

  // Branch explicitly on setavatarbox — NEVER fall through to bot account rename!
  if (normalizedAlias === "setavatarbox") {
    const isGroupContext =
      safeThreadType(message) === MessageType.GroupMessage || message?.type === "group";
    if (!isGroupContext || message?.type === MessageType.DirectMessage || message?.type === 0) {
      await sendMessageWarning(api, message, "Lệnh đổi ảnh đại diện nhóm chỉ sử dụng được trong nhóm chat!", false, 15000);
      return true;
    }

    let resolvedGroupInfo = options?.groupInfo || null;
    if (!resolvedGroupInfo && typeof api?.getGroupInfo === "function" && threadId) {
      try {
        const fetched = await api.getGroupInfo(threadId);
        resolvedGroupInfo = fetched?.gridInfoMap?.[threadId] || fetched || null;
      } catch {}
    } else if (resolvedGroupInfo?.gridInfoMap?.[threadId]) {
      resolvedGroupInfo = resolvedGroupInfo.gridInfoMap[threadId];
    }

    const nativeGroupAdmins = new Set(
      [
        resolvedGroupInfo?.creatorId,
        ...(Array.isArray(resolvedGroupInfo?.adminIds) ? resolvedGroupInfo.adminIds : []),
        ...(Array.isArray(options?.groupAdmins) ? options.groupAdmins : []),
      ]
        .filter(Boolean)
        .map(String)
    );

    const callerAllowed = Boolean(
      options?.isAdminLevelHighest ||
      options?.callerIsAdminBox ||
      isAdmin(senderId, threadId) ||
      nativeGroupAdmins.has(senderId)
    );
    if (!callerAllowed) {
      await sendMessageFailed(api, message, "Bạn cần quyền Quản trị viên nhóm để đổi ảnh đại diện nhóm!", false, 15000);
      return true;
    }

    if (typeof api?.changeGroupAvatar !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ đổi ảnh đại diện nhóm.", false, 15000);
      return true;
    }

    const botUid = String(
      getBotId() || appContext?.uid || (await api.getBotId?.().catch?.(() => "")) || api?.getOwnId?.() || ""
    ).trim();
    if (botUid && nativeGroupAdmins.size > 0 && !nativeGroupAdmins.has(botUid) && resolvedGroupInfo?.setting?.blockName) {
      await sendMessageWarning(
        api,
        message,
        "Nhóm đang khóa quyền đổi thông tin, Bot cần có Key Vàng/Key Bạc để đổi ảnh đại diện nhóm!",
        false,
        15000
      );
      return true;
    }

    const { url, localPath } = resolveAvatarInput(message, prefix, normalizedAlias);
    if (!url && !localPath) {
      await sendMessageQuery(
        api,
        message,
        `Vui lòng reply vào một ảnh hoặc kèm URL ảnh: ${prefix}setavatarbox [link_ảnh]`
      );
      return true;
    }

    let downloadedTempPath = null;
    try {
      let avatarFilePath = localPath;
      if (url) {
        const destPath = path.join(tempDir, `group_avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
        downloadedTempPath = await downloadFile(url, destPath, { timeout: 30000 });
        avatarFilePath = downloadedTempPath;
      }
      await api.changeGroupAvatar(threadId, avatarFilePath);
      await sendMessageComplete(api, message, "Đã cập nhật ảnh đại diện cho nhóm thành công!");
    } catch (error) {
      await sendMessageFailed(api, message, `Đổi ảnh đại diện nhóm thất bại: ${error?.message || error}`);
    } finally {
      if (downloadedTempPath) {
        await deleteFile(downloadedTempPath);
      }
    }
    return true;
  }

  if (!options?.isAdminLevelHighest && !isAdmin(senderId)) {
    await sendMessageFailed(api, message, "Bạn không có quyền thay đổi cài đặt tài khoản bot!", false, 10000);
    return true;
  }

  if (normalizedAlias === "myaccount" || normalizedAlias === "myacc") {
    try {
      const accountInfo = typeof api?.fetchAccountInfo === "function"
        ? await api.fetchAccountInfo().catch(() => null)
        : null;
      const botId = accountInfo?.userId || getBotId() || appContext?.uid || (await api.getBotId?.());
      const userInfo = !accountInfo && botId ? await getUserInfoData(api, botId).catch(() => null) : null;
      const displayName = accountInfo?.displayName || accountInfo?.zaloName || userInfo?.name || "Không xác định";
      const dob = accountInfo ? normalizeDobString(accountInfo) : (userInfo?.birthday || "N/A");
      const gender = accountInfo?.gender !== undefined ? formatGenderLabel(accountInfo.gender) : (userInfo?.gender || "N/A");
      const caption = [
        "👤 Thông tin tài khoản Bot:",
        `• Tên hiển thị: ${displayName}`,
        `• UID: ${botId || "Không xác định"}`,
        `• Giới tính: ${gender}`,
        `• Ngày sinh: ${dob}`,
      ].join("\n");
      await sendMessageComplete(api, message, caption);
    } catch (error) {
      await sendMessageWarning(api, message, `Không thể đọc thông tin tài khoản: ${error.message}`, false, 10000);
    }
    return true;
  }

  if (normalizedAlias === "mysetting") {
    try {
      const [accountInfo, rawSettings] = await Promise.all([
        typeof api?.fetchAccountInfo === "function" ? api.fetchAccountInfo().catch(() => null) : Promise.resolve(null),
        typeof api?.getSettings === "function" ? api.getSettings().catch(() => null) : Promise.resolve(null),
      ]);
      const settings = rawSettings?.setting || rawSettings || appContext?.settings || null;
      const botId = accountInfo?.userId || getBotId() || appContext?.uid || (await api?.getBotId?.().catch?.(() => "")) || "N/A";
      const displayName = accountInfo?.displayName || accountInfo?.zaloName || "Không xác định";
      const dob = accountInfo ? normalizeDobString(accountInfo) : "N/A";
      const gender = accountInfo?.gender !== undefined ? formatGenderLabel(accountInfo.gender) : "N/A";
      const phone = accountInfo?.phoneNumber
        ? String(accountInfo.phoneNumber).replace(/(\d{3})\d+(\d{3})/, "$1****$2")
        : "Ẩn/Chưa liên kết";

      const lines = [
        "⚙️ CÀI ĐẶT & HỒ SƠ TÀI KHOẢN BOT",
        `• Tên hiển thị: ${displayName}`,
        `• UID: ${botId}`,
        `• Giới tính: ${gender} | Ngày sinh: ${dob}`,
        `• SĐT: ${phone}`,
      ];

      if (settings && typeof settings === "object" && Object.keys(settings).length > 0) {
        const formatFlag = (v) => (v === 1 || v === true ? "Bật" : v === 0 || v === false ? "Tắt" : String(v));
        if (settings.view_birthday !== undefined) lines.push(`• Hiển thị sinh nhật: ${formatFlag(settings.view_birthday)}`);
        if (settings.show_online_status !== undefined) lines.push(`• Hiển thị trạng thái online: ${formatFlag(settings.show_online_status)}`);
        if (settings.receive_message !== undefined) lines.push(`• Nhận tin nhắn người lạ: ${formatFlag(settings.receive_message)}`);
        if (settings.accept_stranger_call !== undefined) lines.push(`• Nhận cuộc gọi người lạ: ${formatFlag(settings.accept_stranger_call)}`);
        if (settings.add_friend_via_phone !== undefined) lines.push(`• Tìm kết bạn qua SĐT: ${formatFlag(settings.add_friend_via_phone)}`);
        if (settings.add_friend_via_qr !== undefined) lines.push(`• Kết bạn qua mã QR: ${formatFlag(settings.add_friend_via_qr)}`);
        if (settings.add_friend_via_group !== undefined) lines.push(`• Kết bạn từ nhóm chung: ${formatFlag(settings.add_friend_via_group)}`);
      }
      lines.push(`\n💡 Dùng ${prefix}name <tên mới> để đổi tên bot, hoặc ${prefix}setavt (reply ảnh) để đổi avatar.`);
      await sendMessageComplete(api, message, lines.join("\n"));
    } catch (error) {
      await sendMessageWarning(api, message, `Không thể tải cài đặt tài khoản: ${error?.message || error}`, false, 10000);
    }
    return true;
  }

  if (AVATAR_COMMAND_ALIASES.has(normalizedAlias)) {
    if (typeof api.changeAccountAvatar !== "function") {
      await sendMessageWarning(api, message, "API hiện tại chưa hỗ trợ đổi avatar tài khoản.", false, 10000);
      return true;
    }
    const { url, localPath } = resolveAvatarInput(message, prefix, normalizedAlias);
    if (!url && !localPath) {
      await sendMessageQuery(api, message, "Vui lòng reply một ảnh hoặc truyền URL ảnh để đặt avatar tài khoản.");
      return true;
    }
    let downloadedTempPath = null;
    try {
      let avatarFilePath = localPath;
      if (url) {
        const destPath = path.join(tempDir, `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
        downloadedTempPath = await downloadFile(url, destPath, { timeout: 30000 });
        avatarFilePath = downloadedTempPath;
      }
      await api.changeAccountAvatar(avatarFilePath);
      await sendMessageComplete(api, message, "Đã cập nhật avatar tài khoản bot.");
    } catch (error) {
      await sendMessageFailed(api, message, `Đổi avatar thất bại: ${error.message}`);
    } finally {
      if (downloadedTempPath) {
        await deleteFile(downloadedTempPath);
      }
    }
    return true;
  }

  const newName = extractCommandBody(message, prefix, normalizedAlias).trim();
  if (!newName) {
    await sendMessageQuery(api, message, "Vui lòng nhập tên mới để đổi!");
    return true;
  }

  try {
    const accountInfo = typeof api?.fetchAccountInfo === "function"
      ? await api.fetchAccountInfo().catch(() => null)
      : null;
    const currentDob = normalizeDobString(accountInfo);
    const currentGender = accountInfo?.gender !== undefined && accountInfo?.gender !== null
      ? Number(accountInfo.gender)
      : 0;
    await api.changeAccountSetting(newName, currentDob, currentGender);
    await sendMessageComplete(api, message, `Đã đổi tên bot thành: ${newName}`);
  } catch (err) {
    console.error(err);
    await sendMessageFailed(api, message, `Đổi tên thất bại: ${err.message}`);
  }
  return true;
}
