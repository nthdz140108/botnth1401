import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import sharp from "sharp";

import { appContext } from "../../api-zalo/context.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { getBotId, getInstanceKind, getProjectRoot } from "../../utils/env.js";
import { isMainBotAdmin } from "../../utils/io-json.js";
import { resolveInstanceAuthorization } from "../../utils/instance-authorization.js";
import { withTempFile } from "../../utils/temp-lease-manager.js";
import { removeMention } from "../../utils/format-util.js";
import * as enhanceImageModule from "../../service-debug/chat-zalo/chat-special/send-sticker/enhance-image.js";
import {
  sendMessageCompleteRequest,
  sendMessageStateQuote,
  sendMessageWarningRequest,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import {
  extractCleanArgs,
  extractCommandBody,
  getQuoteData,
  safeThreadType,
} from "../shared/command-input-utils.js";

const MAX_REPEAT = 20;
const FRIEND_REQUEST_DELAY_MS = 600;
const FRIENDS_PER_PAGE = 50;

const FALLBACK_SENDUSER_LINES = [
  "Xin chào, đây là thông điệp mẫu.",
  "Bot đang gửi tin nhắn theo yêu cầu.",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeId(value) {
  const str = String(value ?? "").trim();
  return /^\d+_\d+$/.test(str) ? str.split("_")[0] : str;
}

function isVnPhoneNumber(token) {
  const cleaned = String(token ?? "").trim().replace(/[\s.-]/g, "");
  return /^(?:\+84|84|0)(?:3|5|7|8|9)\d{8}$/.test(cleaned);
}

function getMentions(message) {
  const mentions = message?.data?.mentions;
  const rawContent = typeof message?.data?.content === "string" ? message.data.content : "";
  const rawList = Array.isArray(mentions)
    ? mentions
    : mentions && typeof mentions === "object"
      ? Object.values(mentions)
      : [];

  return rawList
    .filter((item) => item && typeof item === "object" && (item.uid || item.id))
    .map((item) => {
      const uid = normalizeId(item.uid ?? item.id);
      let label = item.dName || item.name || "";
      if (!label && typeof item.pos === "number" && typeof item.len === "number" && rawContent) {
        label = rawContent.slice(item.pos, item.pos + item.len).replace(/^@+/, "").trim();
      }
      return {
        uid,
        dName: label || uid,
      };
    });
}

function getReplyMention(message) {
  const quote = getQuoteData(message);
  if (!quote || typeof quote !== "object") return null;
  const uid = normalizeId(quote.uidFrom ?? quote.ownerId ?? quote.senderId ?? quote.fromD ?? quote.uid);
  if (!uid) return null;
  return {
    uid,
    dName: quote.fromD || quote.dName || "Người dùng",
  };
}

function collectResolvedTargets(message, rawTokens = []) {
  const seen = new Set();
  const list = [];
  const pushTarget = (uid, dName) => {
    const cleanUid = normalizeId(uid);
    if (!cleanUid || seen.has(cleanUid)) return;
    seen.add(cleanUid);
    list.push({ uid: cleanUid, dName: dName || cleanUid });
  };

  for (const m of getMentions(message)) {
    pushTarget(m.uid, m.dName);
  }
  const reply = getReplyMention(message);
  if (reply) {
    pushTarget(reply.uid, reply.dName);
  }

  const tokens = Array.isArray(rawTokens)
    ? rawTokens
    : typeof rawTokens === "string"
      ? rawTokens.trim().split(/\s+/).filter(Boolean)
      : [];

  for (const tok of tokens) {
    const cleaned = String(tok ?? "").trim().replace(/^@+/, "");
    if (/^\d{6,24}$/.test(cleaned)) {
      pushTarget(cleaned, cleaned);
    }
  }

  return list;
}

function extractUrlFromQuoteAttach(quote) {
  if (!quote?.attach) return "";
  if (typeof quote.attach === "object") {
    const candidate =
      quote.attach.hdUrl ||
      quote.attach.oriUrl ||
      quote.attach.href ||
      quote.attach.normalUrl ||
      quote.attach.fileUrl ||
      quote.attach.thumbUrl ||
      "";
    return String(candidate).replace(/\\\//g, "/").trim();
  }
  if (typeof quote.attach === "string") {
    try {
      const parsed = JSON.parse(quote.attach);
      const candidate =
        parsed?.hdUrl ||
        parsed?.oriUrl ||
        parsed?.href ||
        parsed?.normalUrl ||
        parsed?.fileUrl ||
        parsed?.thumbUrl ||
        "";
      return String(candidate).replace(/\\\//g, "/").trim();
    } catch {
      const match = quote.attach.replace(/\\\//g, "/").match(/https?:\/\/[^\s"'<>]+/i);
      return match ? match[0] : "";
    }
  }
  return "";
}

async function readSendUserLines() {
  const filePath = path.join(getProjectRoot(), "src", "commands", "bot-manager", "data", "noidung.txt");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines.slice(0, MAX_REPEAT) : [...FALLBACK_SENDUSER_LINES];
  } catch {
    return [...FALLBACK_SENDUSER_LINES];
  }
}

async function sendText(api, message, text, ttl = 30000) {
  await api.sendMessage({ msg: text, ttl }, message.threadId, safeThreadType(message));
}

async function fetchWaitingFriendRequests(api) {
  let requests = [];
  if (typeof api?.getPendingFriendRequests === "function") {
    try {
      const res = await api.getPendingFriendRequests();
      requests = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    } catch {
      requests = [];
    }
  }
  if (requests.length === 0 && typeof api?.getFriendRequests === "function") {
    try {
      const res = await api.getFriendRequests();
      requests = Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res?.recommItems)
          ? res.recommItems
          : Array.isArray(res)
            ? res
            : [];
    } catch {
      requests = [];
    }
  }
  return requests;
}

export async function handleSendMessageToMentioned(api, message, aliasCommand = "senduser") {
  const prefix = getGlobalPrefix();
  const body = extractCommandBody(message, prefix, aliasCommand);
  const pipeParts = body ? body.split("|").map((part) => part.trim()) : [];

  const targetTokens = (pipeParts[0] || "").split(/\s+/).filter(Boolean);
  const targets = collectResolvedTargets(message, targetTokens);

  if (targets.length === 0 || pipeParts.length < 2) {
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `Sai cú pháp! Vui lòng dùng:\n` +
          `• ${prefix}${aliasCommand} <@mention | UID> | <nội dung> | [delay_ms (500-10000)] | [số_lần (1-${MAX_REPEAT})]\n` +
          `• Hoặc dùng nội dung mẫu: ${prefix}${aliasCommand} <@mention | UID> | <delay_ms> | <số_lần>`,
      },
      20000
    );
    return true;
  }

  let lines = [];
  let rawDelay = 1000;
  let rawRepeat = 1;

  const isLegacyNumericMode =
    pipeParts.length === 3 && /^\d+$/.test(pipeParts[1]) && /^\d+$/.test(pipeParts[2]);

  if (isLegacyNumericMode) {
    lines = await readSendUserLines();
    rawDelay = Number.parseInt(pipeParts[1], 10);
    rawRepeat = Number.parseInt(pipeParts[2], 10);
  } else {
    const customText = pipeParts[1] || "";
    lines = customText ? [customText] : await readSendUserLines();
    rawDelay = pipeParts[2] !== undefined ? Number.parseInt(pipeParts[2], 10) : 1000;
    rawRepeat = pipeParts[3] !== undefined ? Number.parseInt(pipeParts[3], 10) : 1;
  }

  const delayMs = Math.min(Math.max(Number.isFinite(rawDelay) ? rawDelay : 1000, 500), 10000);
  const repeatCount = Math.min(Math.max(Number.isFinite(rawRepeat) ? rawRepeat : 1, 1), MAX_REPEAT);

  await sendMessageCompleteRequest(
    api,
    message,
    {
      caption: `Đang gửi tin nhắn riêng đến ${targets.map((item) => item.dName).join(", ")}...`,
    },
    30000
  );

  let sentCount = 0;
  let failedCount = 0;

  for (let index = 0; index < repeatCount; index += 1) {
    for (const target of targets) {
      for (const line of lines) {
        try {
          await api.sendMessage({ msg: line, ttl: 5000000 }, target.uid, MessageType.DirectMessage);
          sentCount += 1;
        } catch {
          failedCount += 1;
        }
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
  }

  await sendMessageCompleteRequest(
    api,
    message,
    {
      caption: `Đã hoàn thành gửi tin nhắn đến ${targets.map((item) => item.dName).join(", ")}: Thành công ${sentCount}${failedCount > 0 ? `, Thất bại ${failedCount}` : ""}.`,
    },
    30000
  );
  return true;
}

export async function handleSendFriendRequest(api, message, aliasCommand = "addfriend") {
  const prefix = getGlobalPrefix();
  const msgType = safeThreadType(message);
  const senderId = message?.data?.uidFrom;
  const senderName = message?.data?.dName || "Người dùng";

  const body = extractCommandBody(message, prefix, aliasCommand);
  let targetSegment = body;
  let explicitGreeting = "";

  if (body.includes("|")) {
    const [left, ...rest] = body.split("|");
    targetSegment = left.trim();
    explicitGreeting = rest.join("|").trim();
  }

  const rawTokens = targetSegment.split(/\s+/).filter(Boolean);
  const phoneTokens = [];
  const uidTokens = [];
  const greetingWords = [];

  for (const tok of rawTokens) {
    const cleanTok = tok.replace(/^@+/, "");
    if (isVnPhoneNumber(cleanTok)) {
      phoneTokens.push(cleanTok);
    } else if (/^\d{6,24}$/.test(cleanTok)) {
      uidTokens.push(cleanTok);
    } else {
      greetingWords.push(tok);
    }
  }

  const greeting = (explicitGreeting || greetingWords.join(" ").trim() || "Xin chào, mình muốn kết bạn với bạn nhé!").slice(0, 150);
  const targets = collectResolvedTargets(message, uidTokens);
  const failedList = [];

  for (const phone of phoneTokens) {
    try {
      if (typeof api?.findUser !== "function") {
        failedList.push(`${phone} (API chưa hỗ trợ tìm qua SĐT)`);
        continue;
      }
      const found = await api.findUser(phone);
      const foundUid = normalizeId(found?.uid || found?.user_id || found?.userId || found?.id);
      const foundName = found?.zalo_name || found?.display_name || found?.zaloName || found?.displayName || phone;
      if (!foundUid) {
        failedList.push(`${phone} (Không tìm thấy tài khoản Zalo)`);
      } else if (!targets.some((t) => t.uid === foundUid)) {
        targets.push({ uid: foundUid, dName: `${foundName} (${phone})` });
      }
    } catch (err) {
      failedList.push(`${phone} (${err?.message || "Không tìm thấy SĐT"})`);
    }
  }

  if (targets.length === 0 && failedList.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Cách dùng lệnh kết bạn:\n• ${prefix}${aliasCommand} <@mention | reply | UID | SĐT> [lời nhắn]\n• Ví dụ: ${prefix}${aliasCommand} 0912345678 Xin chào bạn!`,
      false,
      60000
    );
    return true;
  }

  await sendMessageStateQuote(api, message, "Đang gửi lời mời kết bạn...", true, 10000);
  const successList = [];

  for (let i = 0; i < targets.length; i++) {
    const mention = targets[i];
    try {
      await api.sendFriendRequest(normalizeId(mention.uid), greeting, "vi");
      successList.push(mention.dName || mention.uid);
    } catch (error) {
      failedList.push(`${mention.dName || mention.uid} (${error.message})`);
    }
    if (i + 1 < targets.length) {
      await sleep(FRIEND_REQUEST_DELAY_MS);
    }
  }

  const isGroup = msgType === MessageType.GroupMessage;
  const header = isGroup && senderId ? `(@${senderName}) Kết quả gửi lời mời kết bạn:` : `Kết quả gửi lời mời kết bạn:`;
  const payload = {
    msg: [
      header,
      successList.length > 0 ? `✅ Thành công: ${successList.join(", ")}` : null,
      failedList.length > 0 ? `❌ Thất bại: ${failedList.join(", ")}` : null,
    ].filter(Boolean).join("\n"),
    ...(isGroup && senderId ? { mentions: [{ uid: senderId, pos: 1, len: senderName.length + 1 }] } : {}),
    ttl: 120000,
  };

  await api.sendMessage(payload, message.threadId, msgType);
  return true;
}

export async function handleUndoFriendRequest(api, message, aliasCommand = "undofriend") {
  const prefix = getGlobalPrefix();
  const msgType = safeThreadType(message);
  const cleanArgs = extractCleanArgs(message, prefix, aliasCommand);
  const targets = collectResolvedTargets(message, cleanArgs);

  if (targets.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Cách dùng thu hồi lời mời kết bạn:\n${prefix}${aliasCommand} <@mention | reply | UID>`,
      false,
      60000
    );
    return true;
  }

  await sendMessageStateQuote(api, message, "Đang thu hồi lời mời kết bạn...", true, 10000);
  const successList = [];
  const failedList = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    try {
      await api.undoFriendRequest(normalizeId(target.uid));
      successList.push(target.dName || target.uid);
    } catch (error) {
      failedList.push(`${target.dName || target.uid} (${error.message})`);
    }
    if (i + 1 < targets.length) {
      await sleep(400);
    }
  }

  await api.sendMessage(
    {
      msg: [
        "Kết quả thu hồi lời mời kết bạn:",
        successList.length > 0 ? `✅ Thành công: ${successList.join(", ")}` : null,
        failedList.length > 0 ? `❌ Thất bại: ${failedList.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      ttl: 120000,
    },
    message.threadId,
    msgType
  );
  return true;
}

export async function handleRejectFriendRequest(api, message, aliasCommand = "rejectfriend") {
  const prefix = getGlobalPrefix();
  const msgType = safeThreadType(message);
  const senderId = message?.data?.uidFrom;
  const senderName = message?.data?.dName || "Người dùng";
  const cleanArgs = extractCleanArgs(message, prefix, aliasCommand);

  let targets = [];
  if (String(cleanArgs[0] || "").toLowerCase() === "all") {
    const pending = await fetchWaitingFriendRequests(api);
    targets = pending
      .map((item) => ({
        uid: normalizeId(item?.userId || item?.uid || item?.id),
        dName: item?.displayName || item?.zaloName || item?.dName || item?.userId || "Người dùng",
      }))
      .filter((t) => Boolean(t.uid));
    if (targets.length === 0) {
      await sendMessageStateQuote(api, message, "Hiện không có lời mời kết bạn nào đang chờ để từ chối.", true, 60000);
      return true;
    }
  } else {
    targets = collectResolvedTargets(message, cleanArgs);
  }

  if (targets.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Cách dùng lệnh từ chối lời mời kết bạn:\n• ${prefix}${aliasCommand} <@mention | reply | UID>\n• ${prefix}${aliasCommand} all`,
      false,
      60000
    );
    return true;
  }

  await sendMessageStateQuote(api, message, "Đang từ chối lời mời kết bạn...", true, 10000);
  const successList = [];
  const failedList = [];

  for (let i = 0; i < targets.length; i++) {
    const mention = targets[i];
    try {
      await api.rejectFriendRequest(normalizeId(mention.uid));
      successList.push(mention.dName || mention.uid);
    } catch (error) {
      failedList.push(`${mention.dName || mention.uid} (${error.message})`);
    }
    if (i + 1 < targets.length) {
      await sleep(400);
    }
  }

  const isGroup = msgType === MessageType.GroupMessage;
  const header = isGroup && senderId ? `(@${senderName}) Kết quả từ chối lời mời kết bạn:` : `Kết quả từ chối lời mời kết bạn:`;
  await api.sendMessage(
    {
      msg: [
        header,
        successList.length > 0 ? `✅ Đã từ chối: ${successList.join(", ")}` : null,
        failedList.length > 0 ? `❌ Không thể từ chối: ${failedList.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
      ...(isGroup && senderId ? { mentions: [{ uid: senderId, pos: 1, len: senderName.length + 1 }] } : {}),
      ttl: 120000,
    },
    message.threadId,
    msgType
  );
  return true;
}

export async function handleRemoveFriend(api, message, aliasCommand = "removefriend") {
  const prefix = getGlobalPrefix();
  const msgType = safeThreadType(message);
  const senderId = normalizeId(message?.data?.uidFrom);
  const senderName = message?.data?.dName || "Người dùng";
  const cleanArgs = extractCleanArgs(message, prefix, aliasCommand);
  let targets = collectResolvedTargets(message, cleanArgs);

  if (
    targets.length === 0 &&
    msgType === MessageType.DirectMessage &&
    message?.threadId &&
    normalizeId(message.threadId) !== senderId &&
    /^\d+$/.test(normalizeId(message.threadId))
  ) {
    const dmUid = normalizeId(message.threadId);
    targets = [{ uid: dmUid, dName: dmUid }];
  }

  if (targets.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Vui lòng @mention, reply tin nhắn hoặc nhập UID người bạn muốn hủy kết bạn:\n${prefix}${aliasCommand} <@mention | reply | UID>`,
      false,
      120000
    );
    return true;
  }

  const successfulRemovals = [];
  const failedRemovals = [];
  for (const mention of targets) {
    try {
      await api.removeFriend(normalizeId(mention.uid));
      successfulRemovals.push({
        uid: normalizeId(mention.uid),
        dName: mention.dName || mention.uid,
      });
    } catch (error) {
      failedRemovals.push(`${mention.dName || mention.uid} (${error.message})`);
    }
  }

  if (successfulRemovals.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Không thể hủy kết bạn: ${failedRemovals.join(", ") || "Không tìm thấy bạn bè phù hợp."}`,
      false,
      120000
    );
    return true;
  }

  const isGroup = msgType === MessageType.GroupMessage;
  if (!isGroup) {
    await api.sendMessage(
      {
        msg:
          `✅ Đã hủy kết bạn với: ${successfulRemovals.map((u) => `${u.dName} (${u.uid})`).join(", ")}` +
          (failedRemovals.length > 0 ? `\n❌ Thất bại: ${failedRemovals.join(", ")}` : ""),
        ttl: 360000,
      },
      message.threadId,
      msgType
    );
    return true;
  }

  const mentionData = senderId ? [{ uid: senderId, pos: 1, len: senderName.length + 1 }] : [];
  let mentionText = senderId ? `(@${senderName}) Đã hủy kết bạn với: ` : `Đã hủy kết bạn với: `;
  let currentPos = mentionText.length;
  for (const mention of successfulRemovals) {
    const displayName = mention.dName || mention.uid;
    mentionText += `(@${displayName}) `;
    mentionData.push({
      uid: mention.uid,
      pos: currentPos + 1,
      len: displayName.length + 1,
    });
    currentPos += displayName.length + 4;
  }
  if (failedRemovals.length > 0) {
    mentionText += `\n❌ Thất bại: ${failedRemovals.join(", ")}`;
  }

  await api.sendMessage(
    {
      msg: mentionText.trim(),
      ...(mentionData.length > 0 ? { mentions: mentionData } : {}),
      ttl: 360000,
    },
    message.threadId,
    msgType
  );
  return true;
}

export async function handleDsBanBe(api, message, aliasCommand = "listfriend") {
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  const prefix = getGlobalPrefix();
  const rawQuery = extractCommandBody(message, prefix, aliasCommand).trim();

  try {
    await api.sendMessage({ msg: "Đang tải danh sách bạn bè...", ttl: 15000 }, threadId, msgType);
    const result = await api.getAllFriends(30000, 1);
    const allFriends = Array.isArray(result)
      ? result
      : Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.data?.data)
          ? result.data.data
          : Array.isArray(result?.data?.friends)
            ? result.data.friends
            : [];

    if (allFriends.length === 0) {
      await api.sendMessage({ msg: "Hiện chưa có bạn bè nào trong danh sách!", ttl: 30000 }, threadId, msgType);
      return true;
    }

    let page = 1;
    let keyword = "";
    if (rawQuery) {
      if (/^\d+$/.test(rawQuery)) {
        page = Math.max(1, Number.parseInt(rawQuery, 10));
      } else {
        const tokens = rawQuery.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2 && /^\d{1,4}$/.test(tokens[tokens.length - 1])) {
          page = Math.max(1, Number.parseInt(tokens.pop(), 10));
        }
        keyword = tokens.join(" ").trim().toLowerCase();
      }
    }

    const filtered = keyword
      ? allFriends.filter((f) => {
          const name = String(f?.displayName || f?.zaloName || f?.dName || "").toLowerCase();
          const uid = String(f?.userId || f?.uid || f?.id || "").toLowerCase();
          return name.includes(keyword) || uid.includes(keyword);
        })
      : allFriends;

    if (filtered.length === 0) {
      await api.sendMessage(
        { msg: `Không tìm thấy bạn bè nào khớp với từ khóa "${keyword}".`, ttl: 60000 },
        threadId,
        msgType
      );
      return true;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / FRIENDS_PER_PAGE));
    const safePage = Math.min(page, totalPages);
    const startIdx = (safePage - 1) * FRIENDS_PER_PAGE;
    const slice = filtered.slice(startIdx, startIdx + FRIENDS_PER_PAGE);

    const names = slice.map((friend, idx) => {
      const name = String(friend?.displayName || friend?.zaloName || friend?.dName || "Người dùng Zalo").trim();
      const uid = normalizeId(friend?.userId || friend?.uid || friend?.id);
      return `${startIdx + idx + 1}. ${name}${uid ? ` (${uid})` : ""}`;
    });

    const header = keyword
      ? `📋 Kết quả tìm bạn bè "${keyword}" (${filtered.length}/${allFriends.length} người):`
      : `📋 Danh sách bạn bè (${allFriends.length} người):`;
    const footer = totalPages > 1
      ? `\n\n📄 Trang ${safePage}/${totalPages} — Dùng ${prefix}${aliasCommand}${keyword ? ` ${keyword}` : ""} <trang> để xem tiếp.`
      : "";

    await api.sendMessage(
      { msg: `${header}\n${names.join("\n")}${footer}`, ttl: 300000 },
      threadId,
      msgType
    );
    return true;
  } catch (error) {
    await api.sendMessage({ msg: `Lỗi tải danh sách bạn bè: ${error.message}`, ttl: 30000 }, threadId, msgType);
    return true;
  }
}

export async function handleAddFriendAll(api, message, aliasCommand = "addfriendall") {
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  const prefix = getGlobalPrefix();
  const customGreeting = (
    extractCommandBody(message, prefix, aliasCommand) || "Chào bạn, kết bạn với mình nhé!"
  ).slice(0, 150);

  try {
    const groupInfo = await api.getGroupInfo?.(threadId);
    const gridInfo = groupInfo?.gridInfoMap?.[threadId] || groupInfo;
    const rawMembers = Array.isArray(gridInfo?.memVerList)
      ? gridInfo.memVerList.map((m) => String(m).replace(/_\d+$/, ""))
      : Array.isArray(gridInfo?.memberIds)
        ? gridInfo.memberIds.map(String)
        : [];
    const selfUid = normalizeId(getBotId() || appContext?.uid);

    const friendIds = new Set();
    try {
      const friendsRes = await api.getAllFriends?.(30000, 1);
      const friendsList = Array.isArray(friendsRes)
        ? friendsRes
        : Array.isArray(friendsRes?.data)
          ? friendsRes.data
          : Array.isArray(friendsRes?.data?.friends)
            ? friendsRes.data.friends
            : [];
      for (const f of friendsList) {
        const fid = normalizeId(f?.userId || f?.uid || f?.id);
        if (fid) friendIds.add(fid);
      }
    } catch {}

    const candidates = [...new Set(rawMembers.map((m) => String(m ?? "").trim()).filter(Boolean))]
      .filter((uid) => uid !== selfUid && !friendIds.has(uid))
      .slice(0, MAX_REPEAT);

    if (candidates.length === 0) {
      await sendMessageStateQuote(
        api,
        message,
        "Không có thành viên mới nào cần gửi lời mời kết bạn trong nhóm này.",
        false,
        60000
      );
      return true;
    }

    await sendMessageStateQuote(
      api,
      message,
      `Đang gửi lời mời kết bạn tới ${candidates.length} thành viên (tối đa ${MAX_REPEAT}/lần)...`,
      true,
      20000
    );

    let successCount = 0;
    let failCount = 0;
    let stoppedReason = "";

    for (let idx = 0; idx < candidates.length; idx++) {
      const uid = candidates[idx];
      try {
        await api.sendFriendRequest(uid, customGreeting, "vi");
        successCount += 1;
      } catch (error) {
        failCount += 1;
        const errMsg = String(error?.message || "");
        const errCode = Number(error?.code);
        if (
          [222, 312, 313, 429].includes(errCode) ||
          /giới hạn|limit|quá số lượng|tạm khóa|spam/i.test(errMsg)
        ) {
          stoppedReason = errMsg || "Zalo báo đạt giới hạn gửi lời mời kết bạn";
          break;
        }
      }
      if (idx + 1 < candidates.length) {
        await sleep(FRIEND_REQUEST_DELAY_MS);
      }
    }

    const summary = [
      `Kết quả ${aliasCommand}: Thành công ${successCount}/${candidates.length}${failCount > 0 ? ` (Thất bại: ${failCount})` : ""}.`,
      stoppedReason ? `⚠️ Đã dừng sớm để bảo vệ tài khoản: ${stoppedReason}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await api.sendMessage(
      {
        msg: summary,
        ttl: 120000,
      },
      threadId,
      msgType
    );
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể gửi lời mời kết bạn hàng loạt: ${error.message}`, false, 60000);
    return true;
  }
}

export async function handleFriendWaitingList(api, message) {
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  try {
    const requests = await fetchWaitingFriendRequests(api);

    if (requests.length === 0) {
      await sendMessageStateQuote(api, message, "Hiện không có lời mời kết bạn nào đang chờ duyệt.", true, 60000);
      return true;
    }

    const lines = requests.slice(0, 40).map((item, idx) => {
      const info = item?.dataInfo || item || {};
      const uid = info?.userId || info?.uid || info?.id || "unknown";
      const name = info?.displayName || info?.zaloName || info?.dName || info?.name || "Người dùng";
      const note = info?.recommInfo?.message ? ` - "${info.recommInfo.message}"` : "";
      return `${idx + 1}. ${name} (${uid})${note}`;
    });

    await api.sendMessage(
      {
        msg: `📋 Danh sách lời mời kết bạn đang chờ (${requests.length}):\n${lines.join("\n")}`,
        ttl: 300000,
      },
      threadId,
      msgType
    );
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể tải danh sách lời mời đang chờ: ${error.message}`, false, 60000);
    return true;
  }
}

export async function spamCallInGroup(api, message, aliasCommand = "call") {
  const prefix = getGlobalPrefix();
  const body = extractCommandBody(message, prefix, aliasCommand);
  const pipeParts = body.split("|").map((p) => p.trim());
  const targetTokens = (pipeParts[0] || "").split(/\s+/).filter(Boolean);
  const targets = collectResolvedTargets(message, targetTokens);

  if (targets.length === 0) {
    await sendMessageStateQuote(
      api,
      message,
      `Cách dùng:\n${prefix}${aliasCommand} <@mention | reply | UID> [| số_lần(1-${MAX_REPEAT})]`,
      false,
      60000
    );
    return true;
  }

  if (typeof api?.sendCallVoice !== "function") {
    await sendMessageStateQuote(
      api,
      message,
      "Phiên Zalo hiện tại chưa hỗ trợ tính năng gọi thoại (voice_call).",
      false,
      60000
    );
    return true;
  }

  const parsedCount = pipeParts.length > 1 ? Number.parseInt(pipeParts[1], 10) : 1;
  const repeatCount = Math.min(Math.max(Number.isFinite(parsedCount) ? parsedCount : 1, 1), MAX_REPEAT);

  const targetUid = normalizeId(targets[0].uid);
  const targetLabel = targets[0].dName || targetUid;
  await sendMessageStateQuote(api, message, `Đang gọi điện tới ${targetLabel} (${repeatCount} lần)...`, true, 15000);

  let okCalls = 0;
  let failedCalls = 0;
  let lastErrorMsg = "";

  for (let i = 0; i < repeatCount; i += 1) {
    try {
      await api.sendCallVoice(targetUid);
      okCalls += 1;
    } catch (error) {
      failedCalls += 1;
      lastErrorMsg = error?.message || String(error);
      if (/unavailable|not supported|không hỗ trợ/i.test(lastErrorMsg)) {
        await sendMessageStateQuote(
          api,
          message,
          `Tính năng gọi thoại hiện không khả dụng trên phiên Zalo này (${lastErrorMsg}).`,
          false,
          60000
        );
        return true;
      }
    }
    if (i + 1 < repeatCount) {
      await sleep(1500);
    }
  }

  const resultMsg =
    okCalls > 0
      ? `Đã kích hoạt ${okCalls}/${repeatCount} cuộc gọi tới ${targetLabel}${failedCalls > 0 ? ` (Thất bại: ${failedCalls})` : ""}.`
      : `Không thể gọi tới ${targetLabel}${lastErrorMsg ? `: ${lastErrorMsg}` : "."}`;
  await sendText(api, message, resultMsg, 30000);
  return true;
}

async function localUpscaleTo4K(fileUrl, outputPath) {
  const imageResponse = await axios.get(fileUrl, {
    responseType: "arraybuffer",
    timeout: 25000,
    maxContentLength: 25 * 1024 * 1024,
  });
  const inputBuffer = Buffer.from(imageResponse.data);
  const meta = await sharp(inputBuffer).metadata();
  const origW = Number(meta.width) || 1080;
  const origH = Number(meta.height) || 1080;
  const targetLongEdge = Math.min(3840, Math.max(origW, origH) * 2);
  const scale = targetLongEdge / Math.max(1, Math.max(origW, origH));
  const newW = Math.max(1, Math.round(origW * scale));
  const newH = Math.max(1, Math.round(origH * scale));

  await sharp(inputBuffer)
    .rotate()
    .resize(newW, newH, {
      kernel: sharp.kernel.lanczos3,
      fit: "inside",
      withoutEnlargement: false,
    })
    .median(1)
    .sharpen({ sigma: 1.2, m1: 1.0, m2: 2.5 })
    .png({ compressionLevel: 6 })
    .toFile(outputPath);

  return outputPath;
}

export async function handle4KImage(api, message, aliasCommand = "4k") {
  const threadId = message.threadId;
  const msgType = safeThreadType(message);
  const quote = getQuoteData(message);
  const senderName = message?.data?.dName || "Người dùng";
  const senderId = message?.data?.uidFrom;
  const prefix = getGlobalPrefix();

  const argUrl = extractCleanArgs(message, prefix, aliasCommand).find((t) => /^https?:\/\//i.test(t)) || "";
  const fileUrl = extractUrlFromQuoteAttach(quote) || argUrl;

  if (!fileUrl) {
    await sendMessageStateQuote(
      api,
      message,
      "Vui lòng reply vào một tin nhắn chứa ảnh (hoặc kèm link ảnh) để nâng cấp độ nét 4K!",
      false,
      30000
    );
    return true;
  }

  try {
    await withTempFile(
      ".png",
      async (enhancedImagePath) => {
        let finalPath = enhancedImagePath;
        let externalPathToClean = null;
        try {
          if (typeof enhanceImageModule?.upscaleImageTo4KFile === "function") {
            const returned = await enhanceImageModule.upscaleImageTo4KFile(fileUrl, enhancedImagePath);
            if (typeof returned === "string" && returned && path.resolve(returned) !== path.resolve(enhancedImagePath)) {
              finalPath = returned;
              externalPathToClean = returned;
            }
          } else {
            await localUpscaleTo4K(fileUrl, enhancedImagePath);
          }

          const isGroup = msgType === MessageType.GroupMessage;
          await api.sendMessage(
            {
              msg: isGroup && senderId ? `@${senderName}\n✨ Ảnh 4K sắc nét của bạn đây!` : `✨ Ảnh 4K sắc nét của bạn đây!`,
              ...(isGroup && senderId ? { mentions: [{ uid: senderId, pos: 0, len: senderName.length + 1 }] } : {}),
              attachments: [finalPath],
              ttl: 5000000,
            },
            threadId,
            msgType
          );
        } finally {
          if (externalPathToClean) {
            await fs.unlink(externalPathToClean).catch(() => {});
          }
        }
      },
      { ttlMs: 120000, prefix: "4k-enhance" }
    );
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Không thể nâng cấp ảnh 4K: ${error.message}`, false, 30000);
    return true;
  }
}

export async function handleDownloadData(api, message, aliasCommand = "datavideo", authorizationSnapshot = null) {
  const prefix = getGlobalPrefix();
  const senderId = String(message?.data?.uidFrom || "");
  const effectiveAuth =
    authorizationSnapshot ||
    resolveInstanceAuthorization({
      senderId,
      threadId: message?.threadId || "",
      instanceUid: String(getBotId() || appContext?.uid || "admin"),
      instanceKind: getInstanceKind(),
    });
  const isAdminUser = Boolean(isMainBotAdmin(senderId) || effectiveAuth?.isAdminLevelHigh);

  const body = extractCommandBody(message, prefix, aliasCommand);
  const args = body ? body.split("|") : [""];
  const firstPart = (args[0] || "").trim();
  const firstPartLower = firstPart.toLowerCase();
  const saveFolder = path.join(getProjectRoot(), "src", "service-debug", "chat-zalo", "chat-special", "data-send");

  const quote = getQuoteData(message);
  const explicitUrl = (args[1] || "").trim();
  const fileUrl = explicitUrl || extractUrlFromQuoteAttach(quote);

  const sanitizeTxtFileName = (raw) => {
    const base = path.basename(String(raw || "").trim());
    if (!base) return "";
    return base.endsWith(".txt") ? base : `${base}.txt`;
  };

  if ((firstPartLower === "list" || firstPartLower === "show") && !explicitUrl) {
    try {
      const files = (await fs.readdir(saveFolder)).filter((f) => f.endsWith(".txt"));
      await sendMessageCompleteRequest(api, message, {
        caption: `📂 Danh sách kho link (${files.length} file):\n${files.map((f) => `• ${f}`).join("\n") || "Chưa có file nào."}`,
      });
      return true;
    } catch (error) {
      await sendMessageWarningRequest(api, message, { caption: `Không thể đọc thư mục kho link: ${error.message}` });
      return true;
    }
  }

  if (firstPartLower.startsWith("list ")) {
    const fileName = sanitizeTxtFileName(firstPart.substring(5));
    const savePath = path.join(saveFolder, fileName);
    try {
      const contentFile = await fs.readFile(savePath, "utf8");
      const lines = contentFile.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      await sendMessageCompleteRequest(
        api,
        message,
        { caption: `📄 File '${fileName}' chứa tổng cộng ${lines.length} link.` },
        60000
      );
      return true;
    } catch {
      await sendMessageWarningRequest(api, message, { caption: `Không tìm thấy file '${fileName}'.` });
      return true;
    }
  }

  if (firstPartLower.startsWith("show ")) {
    if (!isAdminUser) {
      await sendMessageWarningRequest(api, message, { caption: "Chỉ Quản trị viên cấp cao mới được xem chi tiết link!" }, 30000);
      return true;
    }

    const fileName = sanitizeTxtFileName(firstPart.substring(5));
    const savePath = path.join(saveFolder, fileName);
    try {
      const contentFile = await fs.readFile(savePath, "utf8");
      const lines = contentFile.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const sample = lines.slice(0, 20).map((link, idx) => `${idx + 1}. ${link}`).join("\n");
      const caption = lines.length > 0
        ? `📋 File '${fileName}' có tổng cộng ${lines.length} link (hiển thị ${Math.min(20, lines.length)} link mẫu):\n${sample}`
        : `📋 File '${fileName}' hiện đang trống (0 link).`;
      await sendMessageCompleteRequest(api, message, { caption }, 90000);
      return true;
    } catch {
      await sendMessageWarningRequest(api, message, { caption: `Không tìm thấy file '${fileName}'.` });
      return true;
    }
  }

  if (firstPartLower.startsWith("add ") || firstPartLower.startsWith("remove ")) {
    const spaceIdx = firstPart.indexOf(" ");
    const action = firstPart.slice(0, spaceIdx).toLowerCase();
    const rawFileName = firstPart.slice(spaceIdx + 1).trim();
    const fileName = sanitizeTxtFileName(rawFileName);
    const savePath = path.join(saveFolder, fileName);

    if (!isAdminUser) {
      const label = action === "add" ? "tạo" : "xóa";
      await sendMessageWarningRequest(api, message, { caption: `Chỉ Quản trị viên cấp cao mới được phép ${label} file!` }, 30000);
      return true;
    }

    if (!fileName) {
      await sendMessageWarningRequest(api, message, { caption: `Vui lòng cung cấp tên file sau '${action}'.` }, 30000);
      return true;
    }

    await fs.mkdir(saveFolder, { recursive: true });
    if (action === "add") {
      try {
        await fs.access(savePath);
        await sendMessageWarningRequest(api, message, { caption: `File '${fileName}' đã tồn tại.` }, 20000);
        return true;
      } catch {
        await fs.writeFile(savePath, "", "utf8");
        await sendMessageCompleteRequest(api, message, { caption: `Đã tạo file '${fileName}' thành công.` }, 20000);
        return true;
      }
    }

    if (action === "remove") {
      if (fileUrl) {
        try {
          const contentFile = await fs.readFile(savePath, "utf8");
          const lines = contentFile.split(/\r?\n/).filter(Boolean);
          const updated = lines.filter((line) => line.trim() !== fileUrl.trim());
          if (updated.length === lines.length) {
            await sendMessageWarningRequest(api, message, { caption: `Link không tồn tại trong file '${fileName}'.` });
            return true;
          }
          await fs.writeFile(savePath, updated.length > 0 ? `${updated.join("\n")}\n` : "", "utf8");
          await sendMessageCompleteRequest(api, message, { caption: `Đã xóa link khỏi file '${fileName}'.` }, 20000);
          return true;
        } catch {
          await sendMessageWarningRequest(api, message, { caption: `Không tìm thấy file '${fileName}' để xóa link.` });
          return true;
        }
      }

      try {
        await fs.unlink(savePath);
        await sendMessageCompleteRequest(api, message, { caption: `Đã xóa file '${fileName}' thành công.` }, 20000);
      } catch {
        await sendMessageWarningRequest(api, message, { caption: `Không tìm thấy file '${fileName}' để xóa.` });
      }
      return true;
    }
  }

  if (!isAdminUser) {
    await sendMessageWarningRequest(api, message, { caption: "Chỉ Quản trị viên cấp cao mới được phép cập nhật kho dữ liệu video!" }, 30000);
    return true;
  }

  if (!fileUrl) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption:
          `Sai cú pháp! Vui lòng dùng:\n` +
          `• ${prefix}${aliasCommand} list — Xem danh sách file\n` +
          `• ${prefix}${aliasCommand} show <tên_file> — Xem tổng số & 20 link mẫu\n` +
          `• ${prefix}${aliasCommand} <tên_file> | <link> (hoặc reply media) — Lưu link\n` +
          `• ${prefix}${aliasCommand} add/remove <tên_file> [| <link>]`,
      },
      30000
    );
    return true;
  }

  const fileName = sanitizeTxtFileName(firstPart || "data");
  const filePath = path.join(saveFolder, fileName);
  try {
    await fs.mkdir(saveFolder, { recursive: true });
    await fs.appendFile(filePath, `${fileUrl}\n`, "utf8");
    await sendMessageStateQuote(api, message, `Đã lưu link vào: ${fileName}`, true, 30000);
    return true;
  } catch (error) {
    await sendMessageStateQuote(api, message, `Đã xảy ra lỗi khi lưu link: ${error.message}`, false, 30000);
    return true;
  }
}
