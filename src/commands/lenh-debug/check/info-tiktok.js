import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { tempDir } from "../../../utils/io-json.js";
import { removeMention } from "../../../utils/format-util.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "i4tiktok",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

const REQUEST_TIMEOUT_MS = 8000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTikTokInfoCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "i4tiktok").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export function normalizeTikTokUsername(rawInput) {
  let token = String(rawInput ?? "").trim().split(/\s+/)[0] || "";
  if (!token) return "";

  if (/^(?:https?:\/\/)?(?:[\w-]+\.)?tiktok\.com\//i.test(token)) {
    try {
      const normalized = /^https?:\/\//i.test(token) ? token : `https://${token}`;
      const u = new URL(normalized);
      const atSegment = u.pathname
        .split("/")
        .find((seg) => seg.startsWith("@") && seg.length > 1);
      if (atSegment) {
        token = atSegment;
      }
    } catch {}
  }

  return token.replace(/^@+/, "").trim();
}

function formatMetric(val) {
  if (val === undefined || val === null || val === "") return "N/A";
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString("vi-VN") : String(val);
}

async function fetchTikTokFromRehydration(username) {
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const res = await fetch(profileUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const html = await res.text();
  const $ = cheerio.load(html);

  const universalRaw = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__").html();
  if (universalRaw) {
    try {
      const parsed = JSON.parse(universalRaw);
      const userDetail = parsed?.["__DEFAULT_SCOPE__"]?.["webapp.user-detail"];
      if (userDetail?.userInfo?.user) {
        return {
          user: userDetail.userInfo.user,
          stats: userDetail.userInfo.stats || userDetail.userInfo.statsV2 || {},
        };
      }
    } catch {}
  }

  const sigiRaw = $("#SIGI_STATE").html();
  if (sigiRaw) {
    try {
      const parsed = JSON.parse(sigiRaw);
      const users = parsed?.UserModule?.users || {};
      const statsMap = parsed?.UserModule?.stats || {};
      const key = Object.keys(users).find(
        (k) => k.toLowerCase() === username.toLowerCase()
      );
      if (key && users[key]) {
        return {
          user: users[key],
          stats: statsMap[key] || {},
        };
      }
    } catch {}
  }

  return null;
}

async function fetchTikTokFromOEmbed(username) {
  const targetUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(oembedUrl, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const json = await res.json();
  if (!json || (!json.author_name && !json.title)) return null;

  return {
    user: {
      nickname: json.author_name || username,
      uniqueId: json.author_unique_id || username,
      id: "",
      signature: json.title || "",
      avatarLarger: json.thumbnail_url || "",
      verified: false,
      privateAccount: false,
    },
    stats: null,
  };
}

async function downloadAvatarToTemp(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Referer: "https://www.tiktok.com/" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Avatar HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("Empty avatar buffer");

  await fs.promises.mkdir(tempDir, { recursive: true });
  const avatarPath = path.join(tempDir, `tiktok_avatar_${crypto.randomUUID()}.jpg`);
  await fs.promises.writeFile(avatarPath, buffer);
  return avatarPath;
}

export async function handleI4tiktokCommand(api, message, aliasCommand = "i4tiktok") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "i4tiktok";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesTikTokInfoCommand(message, currentPrefix, effectiveAlias)) {
    return api.sendMessage(
      {
        msg: `❌ Lệnh không hợp lệ! Dùng: ${currentPrefix}${effectiveAlias} <username>`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const rawArg =
    extractCommandBody(message, currentPrefix, effectiveAlias) || getQuotedText(message);
  const tikTokUsername = normalizeTikTokUsername(rawArg);

  if (!tikTokUsername) {
    return api.sendMessage(
      {
        msg: `❌ Thiếu username! Dùng: ${currentPrefix}${effectiveAlias} <username>\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} @tiktok`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(tikTokUsername)) {
    return api.sendMessage(
      {
        msg: `❌ Username TikTok "${tikTokUsername}" không hợp lệ!`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  let avatarPath = null;
  try {
    let profile = await fetchTikTokFromRehydration(tikTokUsername).catch(() => null);
    if (!profile) {
      profile = await fetchTikTokFromOEmbed(tikTokUsername).catch(() => null);
    }

    if (!profile?.user) {
      return api.sendMessage(
        {
          msg: `❌ Không tìm thấy tài khoản TikTok "@${tikTokUsername}" hoặc tài khoản không tồn tại.`,
          ttl: 60000,
        },
        threadId,
        threadType
      );
    }

    const { user, stats } = profile;
    const avatarUrl = user.avatarLarger || user.avatarMedium || user.avatarThumb || "";
    if (avatarUrl) {
      avatarPath = await downloadAvatarToTemp(avatarUrl).catch(() => null);
    }

    const lines = [
      `🎥 THÔNG TIN TÀI KHOẢN TIKTOK`,
      ``,
      `✨ Tên hiển thị: ${user.nickname || tikTokUsername}`,
      `🆔 Username: @${user.uniqueId || tikTokUsername}`,
      user.id ? `🪪 ID: ${user.id}` : null,
      `📝 Tiểu sử: ${user.signature || "Không có"}`,
      `✅ Xác minh: ${user.verified ? "Đã xác minh ✅" : "Chưa xác minh ❌"}`,
      `🔒 Riêng tư: ${user.privateAccount ? "Có 🔒" : "Không 🔓"}`,
      `🔗 Link: https://www.tiktok.com/@${encodeURIComponent(user.uniqueId || tikTokUsername)}`,
    ].filter(Boolean);

    if (stats) {
      lines.push(
        ``,
        `📊 Thống kê:`,
        `👥 Follower: ${formatMetric(stats.followerCount)}`,
        `👣 Đang theo dõi: ${formatMetric(stats.followingCount)}`,
        `❤️ Lượt thích: ${formatMetric(stats.heartCount ?? stats.heart)}`,
        `🎬 Số video: ${formatMetric(stats.videoCount)}`,
        stats.diggCount !== undefined ? `👍 Đã thích: ${formatMetric(stats.diggCount)}` : null
      );
    }

    await api.sendMessage(
      {
        msg: lines.filter(Boolean).join("\n"),
        ...(avatarPath ? { attachments: [avatarPath] } : {}),
        ttl: 3600000,
      },
      threadId,
      threadType
    );
  } catch (err) {
    await api.sendMessage(
      {
        msg: `❌ Lỗi tra cứu TikTok: ${err?.message || "Không xác định"}`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  } finally {
    if (avatarPath) {
      await fs.promises.unlink(avatarPath).catch(() => {});
    }
  }
}
