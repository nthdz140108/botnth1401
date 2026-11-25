import fetch from "node-fetch";
import { getGlobalPrefix } from "../service.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

export const EMOTE_LIST = Object.freeze([
  { id: "909049010", name: "Evo P90 - Hoàng Kim Bất Diệt" },
  { id: "909051003", name: "Evo M60 - Sát Thần Săn Mộng" },
  { id: "909033002", name: "Evo MP5 - Thiên Thần Bạch Kim" },
  { id: "909041005", name: "Evo Groza - Địa Chấn Sắc Màu" },
  { id: "909038010", name: "Evo Thompson - Hắc Thạch Long" },
  { id: "909039011", name: "Evo M1014 - Huyết Hỏa" },
  { id: "909040010", name: "Evo MP40 - Tia Chớp Tử Thần" },
  { id: "909000081", name: "Evo M1014 - Long Tộc" },
  { id: "909000085", name: "Evo XM8 - Lôi Thần" },
  { id: "909000063", name: "Evo AK47 - Rồng Xanh" },
  { id: "909000075", name: "Evo MP40 - Mãng Xà" },
  { id: "909033001", name: "Evo M4A1 - Hỏa Ngục" },
  { id: "909000090", name: "Evo Famas - Dạ Xoa" },
  { id: "909000068", name: "Evo Scar - Cá Mập Đen" },
  { id: "909000098", name: "Evo UMP - Phong Cách" },
  { id: "909035007", name: "Evo M1887 - Vũ Trụ Hủy Diệt" },
  { id: "909037011", name: "Evo Tay - Long Trảo Quyền" },
  { id: "909038012", name: "Evo G18 - Chinh Phục" },
  { id: "909035012", name: "Evo AN94 - Tiếng Hú Ác Quỷ" },
  { id: "909042008", name: "Evo Chim Gõ Kiến - Mãnh Hổ Oai Hùng" },
]);

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

function matchesEmoteCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "emote").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

function getEmoteListMessage(prefix, aliasCommand, hasServerConfigured) {
  let msg = "🎭 BẢNG MÃ 20 EMOTE EVO LV7 FREE FIRE\n\n";
  EMOTE_LIST.forEach((e, i) => {
    msg += `${String(i + 1).padStart(2, "0")}. [${e.id}] ${e.name}\n`;
  });
  msg += `\n📌 Cú pháp kích hoạt tổ đội:\n${prefix}${aliasCommand} <teamcode> <UID1> [UID2..4] <số_thứ_tự_1-20>`;
  if (!hasServerConfigured) {
    msg += `\n\n⚙️ Lưu ý: Tính năng bot tự vào tổ đội hiện chưa cấu hình biến môi trường FF_EMOTE_API_URL.`;
  }
  return msg;
}

export async function handleEmoteCommand(api, message, aliasCommand = "emote") {
  const uid = message?.data?.uidFrom;
  if (!uid) return false;

  const prefix = await getGlobalPrefix();
  const effectiveAlias = aliasCommand || "emote";
  if (!matchesEmoteCommand(message, prefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const emoteApiBase = String(process.env.FF_EMOTE_API_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const hasServerConfigured = Boolean(emoteApiBase);

  const body = extractCommandBody(msgCtx, prefix, effectiveAlias);
  if (!body) {
    const listMsg = getEmoteListMessage(prefix, effectiveAlias, hasServerConfigured);
    await sendMessageStateQuote(api, msgCtx, listMsg, true, 180000, true);
    return true;
  }

  const args = body.split(/\s+/).filter(Boolean);
  if (args.length < 3) {
    const listMsg = getEmoteListMessage(prefix, effectiveAlias, hasServerConfigured);
    await sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Sai cú pháp!\n\n${listMsg}`,
      false,
      60000,
      true
    );
    return true;
  }

  const emoteNum = Number.parseInt(args[args.length - 1], 10);
  if (!Number.isInteger(emoteNum) || emoteNum < 1 || emoteNum > EMOTE_LIST.length) {
    const listMsg = getEmoteListMessage(prefix, effectiveAlias, hasServerConfigured);
    await sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Số thứ tự emote không hợp lệ! Vui lòng chọn từ 1 đến ${EMOTE_LIST.length}.\n\n${listMsg}`,
      false,
      60000,
      true
    );
    return true;
  }

  const emote = EMOTE_LIST[emoteNum - 1];
  const teamcode = args[0];
  const uids = args
    .slice(1, -1)
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 4);

  if (uids.length === 0) {
    const listMsg = getEmoteListMessage(prefix, effectiveAlias, hasServerConfigured);
    await sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Thiếu UID người chơi hợp lệ!\n\n${listMsg}`,
      false,
      60000,
      true
    );
    return true;
  }

  if (!hasServerConfigured) {
    await sendMessageStateQuote(
      api,
      msgCtx,
      `🎭 Emote đã chọn: #${emoteNum} — ${emote.name} (ID: ${emote.id})\n` +
        `⚙️ Tính năng điều khiển bot vào tổ đội chưa được bật. Quản trị viên cần cấu hình biến môi trường FF_EMOTE_API_URL để thực thi lệnh join squad.`,
      false,
      90000,
      true
    );
    return true;
  }

  let endpointUrl;
  try {
    const parsedBase = new URL(emoteApiBase);
    if (!["http:", "https:"].includes(parsedBase.protocol)) {
      throw new Error("Invalid protocol");
    }
    endpointUrl = new URL(`${emoteApiBase}/join`);
    endpointUrl.searchParams.set("tc", teamcode);
    endpointUrl.searchParams.set("emote_id", emote.id);
    uids.forEach((u, i) => endpointUrl.searchParams.set(`uid${i + 1}`, u));
  } catch {
    await sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Cấu hình FF_EMOTE_API_URL không hợp lệ!`,
      false,
      60000,
      true
    );
    return true;
  }

  try {
    const res = await fetch(endpointUrl.toString(), {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      await sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Máy chủ Emote phản hồi lỗi HTTP ${res.status}.`,
        false,
        60000,
        true
      );
      return true;
    }

    const data = await res.json().catch(() => ({}));
    const reply =
      `✅ GỬI EMOTE THÀNH CÔNG\n\n` +
      `➤ Teamcode: ${teamcode}\n` +
      `➤ UID: ${uids.join(", ")}\n` +
      `➤ Emote: #${emoteNum} ${emote.name} (${emote.id})\n` +
      `➤ Trạng thái: ${data?.message || "Hoàn tất"}`;

    await sendMessageStateQuote(api, msgCtx, reply, true, 60000, true);
  } catch (e) {
    const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    await sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Lỗi kết nối máy chủ Emote${isTimeout ? " (quá thời gian chờ 8s)" : ""}.`,
      false,
      60000,
      true
    );
  }

  return true;
}
