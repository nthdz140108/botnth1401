import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { getGlobalPrefix } from "../service.js";
import { tempDir } from "../../utils/io-json.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

export const des = {
  name: "fb",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

const REQUEST_TIMEOUT_MS = 8000;

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesFbCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "fb").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export function parseFacebookTarget(rawInput) {
  const raw = String(rawInput ?? "").trim();
  if (!raw) return null;
  const token = raw.split(/\s+/)[0].trim();

  if (/^\d{1,24}$/.test(token)) {
    return {
      identifier: token,
      numericUid: token,
      profileUrl: `https://www.facebook.com/${token}`,
    };
  }

  if (/^(?:https?:\/\/)?(?:[\w-]+\.)?(?:facebook\.com|fb\.com)\//i.test(token)) {
    try {
      const normalized = /^https?:\/\//i.test(token) ? token : `https://${token}`;
      const parsed = new URL(normalized);
      const queryId = parsed.searchParams.get("id");
      if (queryId && /^\d+$/.test(queryId)) {
        return {
          identifier: queryId,
          numericUid: queryId,
          profileUrl: `https://www.facebook.com/profile.php?id=${queryId}`,
        };
      }
      const segments = parsed.pathname
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (segments[0]?.toLowerCase() === "people" && segments[2] && /^\d+$/.test(segments[2])) {
        return {
          identifier: segments[2],
          numericUid: segments[2],
          profileUrl: `https://www.facebook.com/profile.php?id=${segments[2]}`,
        };
      }
      const slug = segments[0] || "";
      if (slug && !["share", "watch", "reel", "photo", "permalink.php"].includes(slug.toLowerCase())) {
        return {
          identifier: slug,
          numericUid: /^\d+$/.test(slug) ? slug : "",
          profileUrl: `https://www.facebook.com/${encodeURIComponent(slug)}`,
        };
      }
      return {
        identifier: "",
        numericUid: "",
        profileUrl: parsed.toString(),
      };
    } catch {}
  }

  const cleanedHandle = token.replace(/^@+/, "");
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(cleanedHandle)) {
    return {
      identifier: cleanedHandle,
      numericUid: /^\d+$/.test(cleanedHandle) ? cleanedHandle : "",
      profileUrl: `https://www.facebook.com/${encodeURIComponent(cleanedHandle)}`,
    };
  }

  return null;
}

async function fetchGraphPictureInfo(identifier) {
  if (!identifier) return null;
  const url = `https://graph.facebook.com/${encodeURIComponent(identifier)}/picture?redirect=false&width=720&height=720`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.data?.url) {
      return {
        url: json.data.url,
        isSilhouette: Boolean(json.data.is_silhouette),
        width: json.data.width,
        height: json.data.height,
      };
    }
  } catch {}
  return null;
}

async function fetchOpenGraphProfile(profileUrl) {
  try {
    const res = await fetch(profileUrl, {
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const ogTitle =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").first().text().trim() ||
      "";
    const ogDescription =
      $('meta[property="og:description"]').attr("content")?.trim() ||
      $('meta[name="description"]').attr("content")?.trim() ||
      "";
    const ogUrl =
      $('meta[property="og:url"]').attr("content")?.trim() || res.url || profileUrl;
    const ogImage = $('meta[property="og:image"]').attr("content")?.trim() || "";

    const appLink =
      $('meta[property="al:android:url"]').attr("content") ||
      $('meta[property="al:ios:url"]').attr("content") ||
      "";
    const uidMatch = appLink.match(/fb:\/\/(?:profile|page)\/(\d+)/i);

    const cleanedTitle = ogTitle.replace(/\s*\|\s*Facebook\s*$/i, "").trim();
    const isGenericGate =
      !cleanedTitle ||
      /^(facebook|log in or sign up|đăng nhập facebook|log into facebook)$/i.test(cleanedTitle);

    return {
      name: isGenericGate ? "" : cleanedTitle,
      description: ogDescription,
      canonicalUrl: ogUrl,
      ogImage,
      detectedUid: uidMatch?.[1] || "",
    };
  } catch {
    return null;
  }
}

async function downloadAvatarToTemp(imageUrl) {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Avatar HTTP ${res.status}`);
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) {
    throw new Error("URL avatar không trả về định dạng ảnh");
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error("Dữ liệu ảnh rỗng");

  await fs.promises.mkdir(tempDir, { recursive: true });
  const avatarPath = path.join(tempDir, `fb_avatar_${crypto.randomUUID()}.jpg`);
  await fs.promises.writeFile(avatarPath, buffer);
  return avatarPath;
}

export async function handleFbCommand(api, message, aliasCommand = "fb") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "fb";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesFbCommand(message, currentPrefix, effectiveAlias)) {
    return api.sendMessage(
      {
        msg: `❌ Lệnh không hợp lệ! Dùng: ${currentPrefix}${effectiveAlias} <uid hoặc link Facebook>`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const rawArg =
    extractCommandBody(message, currentPrefix, effectiveAlias) || getQuotedText(message);
  if (!rawArg) {
    return api.sendMessage(
      {
        msg: `❌ Thiếu UID hoặc link Facebook!\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} 4`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const target = parseFacebookTarget(rawArg);
  if (!target) {
    return api.sendMessage(
      {
        msg: `❌ UID hoặc đường dẫn Facebook không hợp lệ!`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  let avatarPath = null;
  try {
    const [graphPic, ogInfo] = await Promise.all([
      fetchGraphPictureInfo(target.identifier),
      fetchOpenGraphProfile(target.profileUrl),
    ]);

    const resolvedUid = target.numericUid || ogInfo?.detectedUid || "";
    const extraGraphPic =
      !graphPic && resolvedUid && resolvedUid !== target.identifier
        ? await fetchGraphPictureInfo(resolvedUid)
        : null;
    const pictureInfo = graphPic || extraGraphPic;

    const canonicalUrl = ogInfo?.canonicalUrl || target.profileUrl;
    let username = "";
    try {
      const u = new URL(canonicalUrl);
      const seg = u.pathname.split("/").filter(Boolean)[0] || "";
      if (seg && seg !== "profile.php" && !/^\d+$/.test(seg)) {
        username = seg;
      }
    } catch {}

    const displayName =
      ogInfo?.name ||
      username ||
      (resolvedUid ? `Facebook User (${resolvedUid})` : target.identifier);

    if (!pictureInfo && !ogInfo?.name && !ogInfo?.ogImage) {
      return api.sendMessage(
        {
          msg: `❌ Không tìm thấy thông tin công khai cho tài khoản "${rawArg}".`,
          ttl: 60000,
        },
        threadId,
        threadType
      );
    }

    const avatarUrl =
      (pictureInfo && !pictureInfo.isSilhouette ? pictureInfo.url : "") ||
      ogInfo?.ogImage ||
      pictureInfo?.url ||
      "";

    if (avatarUrl) {
      avatarPath = await downloadAvatarToTemp(avatarUrl).catch(() => null);
    }

    const lines = [
      `📘 THÔNG TIN FACEBOOK`,
      ``,
      `👤 Tên hiển thị: ${displayName}`,
      resolvedUid ? `🆔 UID: ${resolvedUid}` : `🔎 Định danh: ${target.identifier}`,
      username ? `🔗 Username: @${username}` : null,
      `🌐 Liên kết: ${canonicalUrl}`,
      pictureInfo
        ? `🖼️ Ảnh đại diện: ${pictureInfo.isSilhouette ? "Mặc định" : `${pictureInfo.width || 720}x${pictureInfo.height || 720}`}`
        : null,
      ogInfo?.description ? `\n📝 Mô tả:\n${ogInfo.description}` : null,
    ].filter(Boolean);

    await api.sendMessage(
      {
        msg: lines.join("\n"),
        ...(avatarPath ? { attachments: [avatarPath] } : {}),
        ttl: 3600000,
      },
      threadId,
      threadType
    );
  } catch (err) {
    await api.sendMessage(
      {
        msg: `❌ Lỗi tra cứu Facebook: ${err?.message || "Không xác định"}`,
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
