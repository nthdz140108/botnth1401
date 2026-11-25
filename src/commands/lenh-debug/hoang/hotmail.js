import fetch from "node-fetch";
import { LRUCache } from "lru-cache";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import { removeMention } from "../../../utils/format-util.js";
import {
  safeThreadType,
  extractCleanArgs,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "mail10p",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const mailSessionCache = new LRUCache({
  max: 1000,
  ttl: 15 * 60 * 1000,
});

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

function matchesMailCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const candidates = new Set([
    String(aliasCommand || "mail10p").trim(),
    "mail10p",
    "10minutemail",
  ]);
  for (const name of candidates) {
    if (!name) continue;
    const pattern = new RegExp(
      `^\\s*${escapeRegExp(prefix)}\\s*${escapeRegExp(name)}(?:[\\s_]+|$)`,
      "i"
    );
    if (pattern.test(cleaned)) return true;
  }
  return false;
}

function mergeCookies(prevCookie, response) {
  const jar = new Map();
  for (const part of String(prevCookie || "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      jar.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
    }
  }

  let rawSetCookies = [];
  if (typeof response?.headers?.getSetCookie === "function") {
    rawSetCookies = response.headers.getSetCookie();
  } else if (typeof response?.headers?.raw === "function") {
    rawSetCookies = response.headers.raw()["set-cookie"] || [];
  } else {
    const single = response?.headers?.get?.("set-cookie");
    if (single) rawSetCookies = [single];
  }

  for (const headerVal of rawSetCookies) {
    const pair = String(headerVal || "").split(";")[0]?.trim() || "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function stripHtmlToText(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetch10MinuteMailJson(url, cookie = "") {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/plain, */*",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`10minutemail HTTP ${res.status}`);
  }
  const nextCookie = mergeCookies(cookie, res);
  const data = await res.json();
  if (!data || typeof data !== "object") {
    throw new Error("10minutemail invalid JSON");
  }
  return { data, cookie: nextCookie };
}

async function createGuerrillaSession() {
  const res = await fetch(
    "https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=en",
    {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`GuerrillaMail HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.email_addr || !data?.sid_token) {
    throw new Error("Không tạo được hộp thư tạm thời");
  }
  return {
    provider: "guerrillamail",
    cookie: "",
    email: data.email_addr,
    sidToken: data.sid_token,
    createdAt: Date.now(),
    lastMailList: [],
  };
}

async function createNewMailSession(senderId) {
  try {
    const { data, cookie } = await fetch10MinuteMailJson(
      "https://10minutemail.net/address.api.php?new=1"
    );
    if (!data.mail_get_mail || !cookie) {
      throw new Error("Missing 10minutemail address or session cookie");
    }
    const session = {
      provider: "10minutemail",
      cookie,
      email: data.mail_get_mail,
      sidToken: data.session_id || "",
      key: data.mail_get_key || "",
      timeLeft: data.mail_left_time ?? 600,
      createdAt: Date.now(),
      lastMailList: Array.isArray(data.mail_list) ? data.mail_list : [],
    };
    mailSessionCache.set(senderId, session);
    return session;
  } catch {
    const fallback = await createGuerrillaSession();
    mailSessionCache.set(senderId, fallback);
    return fallback;
  }
}

async function extendMailSession(senderId, existing) {
  if (!existing) {
    return createNewMailSession(senderId);
  }
  if (existing.provider === "10minutemail" && existing.cookie) {
    try {
      const moreRes = await fetch("https://10minutemail.net/more.html", {
        headers: { "User-Agent": USER_AGENT, Cookie: existing.cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const updatedCookie = mergeCookies(existing.cookie, moreRes);
      const { data, cookie } = await fetch10MinuteMailJson(
        "https://10minutemail.net/address.api.php",
        updatedCookie
      );
      const refreshed = {
        ...existing,
        cookie,
        email: data.mail_get_mail || existing.email,
        timeLeft: data.mail_left_time ?? 600,
        lastMailList: Array.isArray(data.mail_list) ? data.mail_list : existing.lastMailList,
      };
      mailSessionCache.set(senderId, refreshed);
      return refreshed;
    } catch {
      return createNewMailSession(senderId);
    }
  }

  mailSessionCache.set(senderId, { ...existing, createdAt: Date.now() });
  return existing;
}

async function checkInbox(senderId, existing) {
  let session = existing || (await createNewMailSession(senderId));

  if (session.provider === "10minutemail") {
    try {
      const { data, cookie } = await fetch10MinuteMailJson(
        "https://10minutemail.net/address.api.php",
        session.cookie
      );
      const mails = (Array.isArray(data.mail_list) ? data.mail_list : []).map((m) => ({
        id: String(m.mail_id || ""),
        from: String(m.from || "Không rõ"),
        subject: String(m.subject || "Không có tiêu đề"),
        time: String(m.datetime2 || m.datetime || ""),
      }));
      session = {
        ...session,
        cookie,
        email: data.mail_get_mail || session.email,
        timeLeft: data.mail_left_time ?? session.timeLeft,
        lastMailList: mails,
      };
      mailSessionCache.set(senderId, session);
      return { session, mails };
    } catch {
      session = await createGuerrillaSession();
      mailSessionCache.set(senderId, session);
    }
  }

  const res = await fetch(
    `https://api.guerrillamail.com/ajax.php?f=get_email_list&offset=0&sid_token=${encodeURIComponent(session.sidToken)}`,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`GuerrillaMail check HTTP ${res.status}`);
  const data = await res.json();
  const mails = (Array.isArray(data?.list) ? data.list : []).map((m) => ({
    id: String(m.mail_id || ""),
    from: String(m.mail_from || "Không rõ"),
    subject: String(m.mail_subject || "Không có tiêu đề"),
    time: String(m.mail_date || ""),
  }));
  session = { ...session, lastMailList: mails };
  mailSessionCache.set(senderId, session);
  return { session, mails };
}

async function readMailDetail(senderId, session, requestedId) {
  const { session: activeSession, mails } = await checkInbox(senderId, session);
  let targetId = String(requestedId || "").trim();

  if (!targetId && mails.length > 0) {
    targetId = mails[0].id;
  } else if (/^\d+$/.test(targetId)) {
    const idx = Number(targetId) - 1;
    if (idx >= 0 && idx < mails.length && mails[idx]?.id && mails[idx].id !== targetId) {
      const exactMatch = mails.some((m) => m.id === targetId);
      if (!exactMatch) targetId = mails[idx].id;
    }
  }

  if (!targetId) {
    return { session: activeSession, detail: null };
  }

  if (activeSession.provider === "10minutemail") {
    const { data, cookie } = await fetch10MinuteMailJson(
      `https://10minutemail.net/mail.api.php?mailid=${encodeURIComponent(targetId)}`,
      activeSession.cookie
    );
    mailSessionCache.set(senderId, { ...activeSession, cookie });
    const rawBody =
      data.plain ||
      (Array.isArray(data.html) ? data.html.join("\n") : data.html) ||
      data.body ||
      "";
    return {
      session: activeSession,
      detail: {
        id: targetId,
        from: String(data.from || "Không rõ"),
        to: String(data.to || activeSession.email),
        subject: String(data.subject || "Không có tiêu đề"),
        time: String(data.datetime2 || data.datetime || ""),
        body: stripHtmlToText(rawBody).slice(0, 2500) || "(Không có nội dung văn bản)",
      },
    };
  }

  const res = await fetch(
    `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(targetId)}&sid_token=${encodeURIComponent(activeSession.sidToken)}`,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`GuerrillaMail fetch HTTP ${res.status}`);
  const data = await res.json();
  return {
    session: activeSession,
    detail: {
      id: String(data.mail_id || targetId),
      from: String(data.mail_from || "Không rõ"),
      to: activeSession.email,
      subject: String(data.mail_subject || "Không có tiêu đề"),
      time: String(data.mail_date || ""),
      body: stripHtmlToText(data.mail_body || data.mail_excerpt || "").slice(0, 2500) || "(Trống)",
    },
  };
}

function buildHelpText(prefix, aliasCommand) {
  const cmd = `${prefix}${aliasCommand || "mail10p"}`;
  return (
    `📌 HƯỚNG DẪN MAIL 10 PHÚT:\n\n` +
    `• ${cmd} new → Tạo địa chỉ email tạm thời mới\n` +
    `• ${cmd} more → Gia hạn thêm 10 phút cho phiên hiện tại\n` +
    `• ${cmd} check → Kiểm tra danh sách hộp thư đến\n` +
    `• ${cmd} get [id] → Đọc chi tiết nội dung / mã OTP của thư`
  );
}

export async function handleMail10pCommand(api, message, aliasCommand = "mail10p") {
  const prefix = await getGlobalPrefix();
  const effectiveAlias = aliasCommand || "mail10p";
  const msgCtx = withSafeMessageType(message);
  const senderId = String(msgCtx?.data?.uidFrom || msgCtx?.threadId || "anon");

  if (!matchesMailCommand(msgCtx, prefix, effectiveAlias)) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      buildHelpText(prefix, effectiveAlias),
      false,
      60000,
      true
    );
  }

  const args = extractCleanArgs(msgCtx, prefix, effectiveAlias);
  if (args.length === 0) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      buildHelpText(prefix, effectiveAlias),
      true,
      60000,
      true
    );
  }

  const subCommand = args[0].toLowerCase();
  const existingSession = mailSessionCache.get(senderId) || null;

  try {
    if (subCommand === "new") {
      const session = await createNewMailSession(senderId);
      const msg =
        `📨 ĐÃ TẠO EMAIL TẠM THỜI MỚI\n\n` +
        `📧 Email: ${session.email}\n` +
        `🌐 Nguồn: ${session.provider}\n` +
        `⏳ Thời hạn: ${session.timeLeft ? `${session.timeLeft}s` : "15 phút"}\n\n` +
        `👉 Gửi mã OTP tới email trên rồi gõ ${prefix}${effectiveAlias} check hoặc ${prefix}${effectiveAlias} get để đọc thư.`;
      return sendMessageStateQuote(api, msgCtx, msg, true, 300000, true);
    }

    if (subCommand === "more") {
      const session = await extendMailSession(senderId, existingSession);
      const msg =
        `⏳ ĐÃ GIA HẠN EMAIL TẠM THỜI\n\n` +
        `📧 Email: ${session.email}\n` +
        `🌐 Nguồn: ${session.provider}\n` +
        `🕒 Thời gian còn lại: ${session.timeLeft ? `${session.timeLeft}s` : "15 phút"}`;
      return sendMessageStateQuote(api, msgCtx, msg, true, 300000, true);
    }

    if (subCommand === "check" || subCommand === "inbox") {
      if (!existingSession) {
        return sendMessageStateQuote(
          api,
          msgCtx,
          `⚠️ Bạn chưa có phiên email nào đang mở.\n👉 Gõ ${prefix}${effectiveAlias} new để tạo hộp thư trước!`,
          false,
          60000,
          true
        );
      }
      const { session, mails } = await checkInbox(senderId, existingSession);
      if (mails.length === 0) {
        return sendMessageStateQuote(
          api,
          msgCtx,
          `📭 Hộp thư ${session.email} hiện chưa có email mới.\n👉 Gõ ${prefix}${effectiveAlias} check lại sau vài giây.`,
          true,
          120000,
          true
        );
      }

      const lines = mails.slice(0, 6).map(
        (m, idx) =>
          `${idx + 1}. [ID: ${m.id}] ${m.subject}\n   📨 Từ: ${m.from}${m.time ? ` • ${m.time}` : ""}`
      );
      const msg =
        `📬 HỘP THƯ ĐẾN (${mails.length} thư)\n` +
        `📧 Email: ${session.email}\n\n` +
        `${lines.join("\n\n")}\n\n` +
        `👉 Đọc nội dung/OTP: ${prefix}${effectiveAlias} get ${mails[0].id}`;
      return sendMessageStateQuote(api, msgCtx, msg, true, 300000, true);
    }

    if (subCommand === "get" || subCommand === "read") {
      if (!existingSession) {
        return sendMessageStateQuote(
          api,
          msgCtx,
          `⚠️ Bạn chưa tạo email tạm thời.\n👉 Gõ ${prefix}${effectiveAlias} new trước khi đọc thư!`,
          false,
          60000,
          true
        );
      }

      const requestedId = args[1] || "";
      const { session, detail } = await readMailDetail(
        senderId,
        existingSession,
        requestedId
      );

      if (!detail) {
        return sendMessageStateQuote(
          api,
          msgCtx,
          `📧 Email hiện tại: ${session.email}\n📭 Chưa có thư nào để đọc nội dung.`,
          true,
          120000,
          true
        );
      }

      const msg =
        `📖 CHI TIẾT EMAIL [ID: ${detail.id}]\n\n` +
        `📧 Tới: ${detail.to}\n` +
        `📨 Từ: ${detail.from}\n` +
        `📝 Tiêu đề: ${detail.subject}\n` +
        `${detail.time ? `🕒 Lúc: ${detail.time}\n` : ""}\n` +
        `📄 Nội dung:\n${detail.body}`;
      return sendMessageStateQuote(api, msgCtx, msg, true, 300000, true);
    }

    if (subCommand === "list") {
      const domains = [
        "10minutemail.net (tự động cấp domain ngẫu nhiên)",
        "guerrillamail.com / sharklasers.com / grr.la (dự phòng tự động)",
      ];
      return sendMessageStateQuote(
        api,
        msgCtx,
        `📜 Hệ thống tên miền hỗ trợ:\n• ${domains.join("\n• ")}`,
        true,
        120000,
        true
      );
    }

    return sendMessageStateQuote(
      api,
      msgCtx,
      `⚠️ Lệnh con "${subCommand}" không hợp lệ.\n\n${buildHelpText(prefix, effectiveAlias)}`,
      false,
      60000,
      true
    );
  } catch (error) {
    return sendMessageFailed(
      api,
      msgCtx,
      `⚠️ Lỗi xử lý mail10p: ${error?.message || "Không thể kết nối máy chủ mail"}`,
      true
    );
  }
}
