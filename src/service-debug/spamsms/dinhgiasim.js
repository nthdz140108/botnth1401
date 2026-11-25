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
  name: "dinhgiasim",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withSafeMessageType(message) {
  const fallbackType =
    message?.threadId &&
    message?.data?.uidFrom &&
    String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage;
  const resolvedType = safeThreadType(message, fallbackType);
  return message?.type === resolvedType ? message : { ...message, type: resolvedType };
}

function matchesSimCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "dinhgiasim").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export async function handledinhgiasimCommand(api, message, aliasCommand = "dinhgiasim") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "dinhgiasim";

  if (!matchesSimCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const args = extractCleanArgs(msgCtx, currentPrefix, effectiveAlias);

  if (args.length === 0) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Vui lòng nhập số điện thoại để định giá!\n👉 Cú pháp: ${currentPrefix}${effectiveAlias} <số_điện_thoại>`,
      false,
      60000,
      true
    );
  }

  if (args.length !== 1) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Sai cú pháp! Dùng: ${currentPrefix}${effectiveAlias} <số_điện_thoại>`,
      false,
      60000,
      true
    );
  }

  const sdt = args[0].replace(/[.\-\s]/g, "");
  if (!/^\d{9,11}$/.test(sdt)) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Vui lòng nhập số điện thoại hợp lệ (9–11 chữ số)!`,
      false,
      60000,
      true
    );
  }

  const apiUrl = `https://api.nemg.me/valuation?sdt=${encodeURIComponent(sdt)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();

    if (!json?.success || !json?.data?.valuation) {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Không tìm thấy dữ liệu định giá cho số ${sdt}.`,
        false,
        60000,
        true
      );
    }

    const valuation = json.data.valuation[sdt] || "Không rõ";
    const msg =
      `📱 ĐỊNH GIÁ SIM THÀNH CÔNG\n\n` +
      `➤ Số điện thoại: ${sdt}\n` +
      `➤ Định giá tham khảo: ${valuation}\n\n` +
      `✨ Chúc bạn luôn 8386`;

    return sendMessageStateQuote(api, msgCtx, msg, true, 3600000, false);
  } catch (e) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi khi định giá sim: ${e?.message || "Hết thời gian chờ kết nối"}`,
      true
    );
  }
}
