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
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

export const des = {
  name: "checkorder",
  type: 1,
  permission: "all",
  countdown: 8,
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

function matchesCheckOrderCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "checkorder").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

function formatTime(timestamp) {
  const num = Number(timestamp);
  if (!Number.isFinite(num) || num <= 0) return "Chưa cập nhật";
  const date = new Date(num * 1000);
  return date.toLocaleString("vi-VN", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
}

export async function handlecheckoderCommand(api, message, aliasCommand = "checkorder") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "checkorder";

  if (!matchesCheckOrderCommand(message, prefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const args =
    extractCommandBody(msgCtx, prefix, effectiveAlias) || getQuotedText(msgCtx);

  if (!args) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Vui lòng nhập mã vận đơn SPX!\n👉 Ví dụ: ${prefix}${effectiveAlias} SPXVN0123456789`,
      false,
      60000,
      true
    );
  }

  const trackingCode = args.trim().split(/\s+/)[0].toUpperCase();
  if (!trackingCode.startsWith("SPXVN")) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Mã vận đơn không hợp lệ! Mã SPX phải bắt đầu bằng "SPXVN".`,
      false,
      60000,
      true
    );
  }

  const url = `https://spx.vn/shipment/order/open/order/get_order_info?spx_tn=${encodeURIComponent(trackingCode)}&language_code=vi`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
      },
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Máy chủ SPX phản hồi không hợp lệ hoặc đang bảo trì.`,
        false,
        60000,
        true
      );
    }

    if (json.retcode !== 0 || !json.data?.sls_tracking_info) {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Không tìm thấy đơn hàng: ${trackingCode}\n${json.message || "Mã vận đơn không tồn tại"}`,
        false,
        60000,
        true
      );
    }

    const info = json.data.sls_tracking_info;
    const records = info.records;

    if (!Array.isArray(records) || records.length === 0) {
      const pendingMsg =
        `📦 TRA CỨU VẬN ĐƠN SPX\n\n` +
        `Mã vận đơn: ${info.sls_tn || trackingCode}\n` +
        `Mã đơn Shopee: ${info.client_order_id || "Không có"}\n` +
        `Trạng thái: 🆕 Đơn hàng mới tạo, đang chờ người gửi giao cho đơn vị vận chuyển.`;
      return sendMessageStateQuote(api, msgCtx, pendingMsg, true, 3600000, false);
    }

    const latest = records[0] || {};
    const trackingName = String(latest?.tracking_name || "");
    const statusLabel =
      trackingName === "Delivered"
        ? "✅ Đã giao"
        : trackingName.includes("Out For Delivery")
          ? "🚚 Đang giao"
          : trackingName.includes("In transit")
            ? "🚛 Đang vận chuyển"
            : "⏳ Chờ lấy hàng";

    let msg = `📦 TRA CỨU VẬN ĐƠN SPX\n\n`;
    msg += `Mã vận đơn: ${info.sls_tn || trackingCode}\n`;
    msg += `Mã đơn Shopee: ${info.client_order_id || "Không có"}\n`;
    msg += `Trạng thái: ${statusLabel} — ${latest?.buyer_description || "Đang xử lý"}\n`;
    msg += `Cập nhật: ${formatTime(latest?.actual_time)}\n\n`;
    msg += `📍 LỊCH SỬ HÀNH TRÌNH:\n`;

    records.forEach((r) => {
      const time = formatTime(r?.actual_time);
      const location = String(r?.current_location?.location_name || "");
      const desc = String(r?.buyer_description || "").trim();

      let line = `${time} │ ${desc}`;
      const cleanLoc = location.replace("28-NDH", "").trim();
      if (cleanLoc && !desc.includes(cleanLoc)) {
        line += ` (${location.replace("28-NDH ", "").replace(" Hub", "")})`;
      }
      msg += `${line}\n`;
    });

    const MAX_LENGTH = 3500;
    if (msg.length <= MAX_LENGTH) {
      return sendMessageStateQuote(api, msgCtx, msg, true, 3600000, false);
    }

    const parts = [];
    let current = `📦 TRA CỨU VẬN ĐƠN - ${trackingCode} (phần 1)\n\n`;
    records.forEach((r) => {
      const locName = r?.current_location?.location_name
        ? ` (${r.current_location.location_name.replace(" Hub", "")})`
        : "";
      const line = `${formatTime(r?.actual_time)} │ ${r?.buyer_description || ""}${locName}\n`;
      if ((current + line).length > MAX_LENGTH - 200 && parts.length < 10) {
        parts.push(current);
        current = `📄 Tiếp theo (phần ${parts.length + 1})\n${line}`;
      } else {
        current += line;
      }
    });
    parts.push(current);

    for (let i = 0; i < parts.length; i++) {
      const isFirst = i === 0;
      await sendMessageStateQuote(api, msgCtx, parts[i], isFirst, 3600000, false);
      if (!isFirst) await new Promise((r) => setTimeout(r, 600));
    }

    return true;
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    const reason = isTimeout ? "Hết thời gian chờ kết nối (10s)" : err?.message || "Lỗi mạng";
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi tra cứu vận đơn ${trackingCode}: ${reason}`,
      true
    );
  }
}

export const handleCheckOrderCommand = handlecheckoderCommand;
