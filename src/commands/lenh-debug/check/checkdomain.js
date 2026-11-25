import { getGlobalPrefix } from "../../../service-debug/service.js";
import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";
import { removeMention } from "../../../utils/format-util.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "checkdomain",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesCheckDomainCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "checkdomain").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export function extractDomainHostname(rawInput) {
  let token = String(rawInput ?? "").trim().split(/\s+/)[0] || "";
  if (!token) return "";

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      token = new URL(token).hostname;
    } else if (token.includes("/") || token.includes("?") || token.includes("#")) {
      token = new URL(`https://${token}`).hostname;
    }
  } catch {
    token = token
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split(/[/?#]/)[0]
      .split(":")[0];
  }

  token = token
    .replace(/^www\./i, "")
    .replace(/[^a-zA-Z0-9.-]/g, "")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();

  return token.includes(".") ? token : "";
}

export async function handleCheckdomainCommand(api, message, aliasCommand = "checkdomain") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "checkdomain";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesCheckDomainCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const rawArg =
    extractCommandBody(message, currentPrefix, effectiveAlias) || getQuotedText(message);
  const domain = extractDomainHostname(rawArg);

  if (!domain) {
    return api.sendMessage(
      {
        msg: `❌ Vui lòng nhập tên miền hoặc URL hợp lệ!\n👉 Cú pháp: ${currentPrefix}${effectiveAlias} <domain>`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const isDotVN = domain.endsWith(".vn");
  const apiUrl = `https://whois.inet.vn/api/whois/domainspecify/${encodeURIComponent(domain)}`;

  try {
    const data = await fetchJsonWithCache(apiUrl, {
      provider: "checkdomain",
      ttlMs: 10 * 60 * 1000,
      timeoutMs: 10000,
      retries: 1,
    });

    if (
      data?.code === "1" ||
      String(data?.message || "").toLowerCase().includes("does not exist")
    ) {
      const fee = data.fee || "Không rõ";
      const reg = data.reg || "Không rõ";
      const ren = data.ren || "Không rõ";
      const feeMsg =
        `🔍 Thông Tin Tên Miền: ${domain}\n` +
        `⚠️ Tên miền chưa được đăng ký.\n\n` +
        `💰 Phí đăng ký: ${Number(reg) ? Number(reg).toLocaleString("vi-VN") : reg}đ\n` +
        `♻️ Phí gia hạn: ${Number(ren) ? Number(ren).toLocaleString("vi-VN") : ren}đ\n` +
        `🛒 Tổng giá (năm đầu): ${Number(fee) ? Number(fee).toLocaleString("vi-VN") : fee}đ\n` +
        `🔗 Đăng ký tại: https://inet.vn`;
      return api.sendMessage({ msg: feeMsg, ttl: 86400000 }, threadId, threadType);
    }

    if (data?.code !== "0") {
      throw new Error(data?.message || "Không thể lấy thông tin WHOIS cho tên miền này.");
    }

    const nameServers = Array.isArray(data.nameServer)
      ? `[ ${data.nameServer.join(", ")} ]`
      : "Không rõ";
    const status = Array.isArray(data.status)
      ? `[ ${data.status.join(", ")} ]`
      : "Không rõ";
    const msg =
      `🔍 Thông Tin Tên Miền: ${data.domainName || domain}\n` +
      `👤 Người Đăng Ký: ${isDotVN ? data.registrantName || "Không công khai" : data.registrantName || "Bảo mật WHOIS"}\n` +
      `🏢 Đơn Vị Đăng Ký: ${data.registrar || "Không rõ"}\n` +
      `📅 Ngày Đăng Ký: ${data.creationDate || "Không rõ"}\n` +
      `📅 Ngày Hết Hạn: ${data.expirationDate || "Không rõ"}\n` +
      `🔐 DNSSEC: ${data.DNSSEC || "Không rõ"}\n` +
      `🖥️ Name Servers: ${nameServers}\n` +
      `⚙️ Trạng Thái: ${status}`;
    return api.sendMessage({ msg, ttl: 86400000 }, threadId, threadType);
  } catch (err) {
    return api.sendMessage(
      {
        msg: `❌ Không thể tra cứu tên miền "${domain}" lúc này.\n📖 Lý do: ${err?.message || "Lỗi kết nối"}`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }
}
