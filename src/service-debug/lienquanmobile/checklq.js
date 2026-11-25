import fetch from "node-fetch";
import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCleanArgs,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

export const des = {
  name: "checklq",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesCheckLqCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "checklq").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export function maskEmail(raw) {
  const str = String(raw ?? "").trim();
  if (!str || str === "Không có" || str === "N/A") return str || "Không có";
  const atIdx = str.indexOf("@");
  if (atIdx <= 0) return maskGenericSecret(str);
  const local = str.slice(0, atIdx);
  const domain = str.slice(atIdx);
  if (local.length <= 2) return `${local[0] || "*"}***${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}${domain}`;
}

export function maskPhone(raw) {
  const str = String(raw ?? "").trim();
  if (!str || str === "Không có" || str === "N/A") return str || "Không có";
  const digits = str.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return `${digits.slice(0, 3)}****${digits.slice(-2)}`;
}

export function maskGenericSecret(raw) {
  const str = String(raw ?? "").trim();
  if (!str || str === "Không có" || str === "N/A") return str || "Không có";
  if (str.length <= 4) return "****";
  return `${str.slice(0, 2)}****${str.slice(-2)}`;
}

export function maskIpAddress(raw) {
  const str = String(raw ?? "").trim();
  if (!str) return "N/A";
  const parts = str.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  return maskGenericSecret(str);
}

export async function handlechecklqCommand(api, message, aliasCommand = "checklq") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "checklq";

  if (!matchesCheckLqCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  // P0 SECURITY: Strictly enforce DirectMessage (0) so user passwords are NEVER handled or quoted in groups
  const threadType = safeThreadType(message, MessageType.GroupMessage);
  if (threadType !== MessageType.DirectMessage || message?.isGroup === true) {
    try {
      await api?.deleteMessage?.(message, false);
    } catch {}
    return api.sendMessage(
      {
        msg:
          `🔒 Bảo mật: Tuyệt đối không nhập tài khoản và mật khẩu trong nhóm công khai!\n` +
          `Vui lòng xóa tin nhắn vừa gửi (hoặc đổi mật khẩu ngay) và chỉ sử dụng lệnh ${currentPrefix}${effectiveAlias} trong tin nhắn riêng (Direct Message).`,
        ttl: 60000,
      },
      message.threadId,
      threadType
    );
  }

  const dmCtx = message?.type === MessageType.DirectMessage
    ? message
    : { ...message, type: MessageType.DirectMessage };

  const args = extractCleanArgs(dmCtx, currentPrefix, effectiveAlias);
  if (args.length < 2) {
    return sendMessageStateQuote(
      api,
      dmCtx,
      `❌ Vui lòng nhập tài khoản và mật khẩu trong tin nhắn riêng.\n` +
        `👉 Cú pháp: ${currentPrefix}${effectiveAlias} <tài_khoản> <mật_khẩu>`,
      false,
      60000,
      true
    );
  }

  const checkApiBase = String(process.env.LQ_CHECK_API_URL || "").trim();
  if (!checkApiBase) {
    return sendMessageStateQuote(
      api,
      dmCtx,
      `🔒 Bảo mật: Máy chủ kiểm tra nội bộ (LQ_CHECK_API_URL) hiện chưa được cấu hình.\n` +
        `Hệ thống đã chặn việc gửi thông tin đăng nhập sang máy chủ bên thứ ba để bảo vệ an toàn tài khoản của bạn.`,
      false,
      60000,
      true
    );
  }

  const account = args[0];
  const password = args.slice(1).join(" ");

  try {
    const endpoint = new URL(checkApiBase);
    const res = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ acc: account, pass: password }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return sendMessageStateQuote(
        api,
        dmCtx,
        `❌ Máy chủ kiểm tra phản hồi lỗi (HTTP ${res.status}).`,
        false,
        60000,
        true
      );
    }

    const json = await res.json();
    if (!json || !json.ok) {
      return sendMessageStateQuote(
        api,
        dmCtx,
        `❌ Không tìm thấy thông tin tài khoản hoặc thông tin đăng nhập không chính xác.`,
        false,
        60000,
        true
      );
    }

    // Explicitly purge any tokens before formatting output
    delete json.access_token;
    delete json.token;
    delete json.password;

    let msg = `🔍 THÔNG TIN TÀI KHOẢN LIÊN QUÂN\n\n`;
    msg += `👤 Username: ${json.username || account}\n`;
    msg += `🆔 UID: ${json.uid || "N/A"}\n`;
    msg += `🔑 Loại tài khoản: ${json.loaiacc || "N/A"}\n`;
    msg += `🎮 Nickname: ${json.playername || "N/A"}\n`;
    msg += `⭐ Level: ${json.level ?? "N/A"}\n`;
    msg += `🏆 Rank: ${json.rank || "N/A"}\n`;
    msg += `🎨 Skin: ${json.skin ?? "N/A"}\n`;
    msg += `📅 Ngày tạo: ${json.regtime || "N/A"}\n`;
    msg += `🚫 Tình trạng khóa: ${json.bantime || "Không"}\n`;
    msg += `💎 Quân huy: ${json.quanhuy ?? "N/A"}\n`;
    msg += `📩 Email: ${maskEmail(json.email)}\n`;
    msg += `📱 SĐT: ${maskPhone(json.mobile)}\n`;
    msg += `📘 Facebook: ${json.fb ? maskGenericSecret(json.fb) : "Không liên kết"}\n`;
    msg += `🔒 CCCD/CMND: ${json.cmnd ? maskGenericSecret(json.cmnd) : "Không có"}\n`;

    if (Array.isArray(json.login_history) && json.login_history.length > 0) {
      msg += `\n🕒 LỊCH SỬ ĐĂNG NHẬP GẦN ĐÂY:\n`;
      json.login_history.slice(0, 3).forEach((item, i) => {
        msg += `#${i + 1}: IP ${maskIpAddress(item?.ip)} • ${item?.thanh_pho || "?"}, ${item?.quoc_gia || "?"} (${item?.thoigian || ""})\n`;
      });
    }

    return sendMessageStateQuote(api, dmCtx, msg.trim(), true, 1800000, false);
  } catch {
    return sendMessageFailed(
      api,
      dmCtx,
      `❌ Không thể kết nối máy chủ kiểm tra tài khoản lúc này. Vui lòng thử lại sau.`,
      true
    );
  }
}
