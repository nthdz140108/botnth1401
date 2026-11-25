import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { tempDir } from "../../../utils/io-json.js";
import { removeMention } from "../../../utils/format-util.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCleanArgs,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "ff",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
  aliases: ["freefire", "thông tin freefire", "ff info", "xem ff", "uid ff"],
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesFfCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const aliasTokens = String(aliasCommand || "ff")
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(
    `^\\s*${escapeRegExp(prefix)}\\s*${aliasTokens}(?:[\\s_]+|$)`,
    "i"
  ).test(cleaned);
}

function normalizeFfPayload(json, ffUid, region) {
  if (!json || typeof json !== "object") return null;

  const root = json.data && typeof json.data === "object" ? json.data : json;
  const basic =
    root.basicInfo ||
    root.AccountInfo ||
    root.account_info ||
    (root.nickname || root.AccountName ? root : null);

  if (!basic || typeof basic !== "object") return null;
  const nickname =
    basic.nickname || basic.AccountName || basic.name || "";
  if (!nickname && !basic.level && !basic.AccountLevel) return null;

  const pet = root.petInfo || root.pet_info || {};
  const social = root.socialInfo || root.AccountProfileInfo || root.social_info || {};
  const guild = root.clanBasicInfo || root.GuildInfo || {};

  let gender = "Không rõ";
  const rawGender = String(social.gender || "").toUpperCase();
  if (rawGender.includes("FEMALE")) gender = "Nữ";
  else if (rawGender.includes("MALE")) gender = "Nam";

  return {
    name: nickname || "Không rõ",
    uid: String(basic.accountId || basic.uid || ffUid),
    region: String(basic.region || basic.AccountRegion || region).toUpperCase(),
    level: basic.level ?? basic.AccountLevel ?? "N/A",
    exp: basic.exp ?? basic.AccountEXP ?? 0,
    likes: basic.liked ?? basic.AccountLikes ?? 0,
    rankPoints: basic.rankingPoints ?? basic.BrRankPoint ?? "N/A",
    season: basic.seasonId ?? basic.AccountSeasonId ?? "N/A",
    badge: basic.badgeCnt ?? basic.badgeId ?? "N/A",
    version: basic.releaseVersion || "N/A",
    gender,
    signature: social.signature || "",
    guildName: guild.clanName || guild.GuildName || "",
    petName: pet.name || "Không có",
    petLevel: pet.level ?? "N/A",
    petSkin: pet.skinId ?? "N/A",
  };
}

function buildInfoEndpointUrls(ffUid, region) {
  const urls = [];
  const custom = String(process.env.FF_INFO_API_URL || "").trim();
  if (custom) {
    if (custom.includes("{uid}")) {
      urls.push(
        custom
          .replace(/\{uid\}/gi, encodeURIComponent(ffUid))
          .replace(/\{region\}/gi, encodeURIComponent(region))
      );
    } else {
      const sep = custom.includes("?") ? "&" : "?";
      urls.push(
        `${custom}${sep}uid=${encodeURIComponent(ffUid)}&region=${encodeURIComponent(region)}`
      );
    }
  }

  urls.push(
    `https://free-ff-api-src-5plp.onrender.com/api/v1/account?region=${encodeURIComponent(region)}&uid=${encodeURIComponent(ffUid)}`,
    `https://ff-api-info.vercel.app/api/v1/account?region=${encodeURIComponent(region)}&uid=${encodeURIComponent(ffUid)}`,
    `https://zrojectx-info-free-fire.vercel.app/player-info-zprojectx?uid=${encodeURIComponent(ffUid)}&region=${encodeURIComponent(region)}`
  );

  return urls;
}

async function fetchFfPlayerInfo(ffUid, region) {
  const endpoints = buildInfoEndpointUrls(ffUid, region);

  const settled = await Promise.allSettled(
    endpoints.map(async (url) => {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const parsed = normalizeFfPayload(json, ffUid, region);
      if (!parsed) throw new Error("Empty player payload");
      return parsed;
    })
  );

  for (const item of settled) {
    if (item.status === "fulfilled" && item.value) {
      return item.value;
    }
  }
  return null;
}

async function downloadOutfitCard(ffUid, region) {
  const customOutfit = String(process.env.FF_OUTFIT_API_URL || "").trim();
  const candidates = [
    customOutfit
      ? `${customOutfit}${customOutfit.includes("?") ? "&" : "?"}uid=${encodeURIComponent(ffUid)}&region=${encodeURIComponent(region)}`
      : "",
    `https://jnl-outfit-v4.vercel.app/outfit-image?uid=${encodeURIComponent(ffUid)}&region=${encodeURIComponent(region)}&key=Dev-JNL`,
  ].filter(Boolean);

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" },
        signal: AbortSignal.timeout(6500),
      });
      if (!res.ok) continue;
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("image/")) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 256) continue;

      await fs.promises.mkdir(tempDir, { recursive: true });
      const filePath = path.join(tempDir, `ff_${ffUid}_${crypto.randomUUID()}.png`);
      await fs.promises.writeFile(filePath, buffer);
      return filePath;
    } catch {}
  }
  return null;
}

export async function handleFfCommand(api, message, aliasCommand = "ff") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "ff";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesFfCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const args = extractCleanArgs(message, currentPrefix, effectiveAlias);
  if (args.length < 1 || args.length > 2) {
    return api.sendMessage(
      {
        msg: `❌ Sai cú pháp! Dùng: ${currentPrefix}${effectiveAlias} <UID> [region]\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} 12345678`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const ffUid = args[0].trim();
  const region = (args[1] || "vn").trim().toLowerCase();

  if (!/^\d{5,16}$/.test(ffUid)) {
    return api.sendMessage(
      {
        msg: `❌ UID Free Fire không hợp lệ (phải gồm 5–16 chữ số)!`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  let outfitPath = null;
  try {
    const [playerInfo, downloadedOutfit] = await Promise.all([
      fetchFfPlayerInfo(ffUid, region),
      downloadOutfitCard(ffUid, region),
    ]);
    outfitPath = downloadedOutfit;

    if (!playerInfo && !outfitPath) {
      return api.sendMessage(
        {
          msg:
            `⚠️ Hiện không lấy được dữ liệu cho UID Free Fire ${ffUid} (khu vực ${region.toUpperCase()}).\n` +
            `Nguyên nhân có thể do UID không tồn tại hoặc máy chủ tra cứu Free Fire công khai đang bảo trì.`,
          ttl: 60000,
        },
        threadId,
        threadType
      );
    }

    if (!playerInfo && outfitPath) {
      return await api.sendMessage(
        {
          attachments: [outfitPath],
          msg: `🎮 Thẻ trang phục Free Fire — UID: ${ffUid} (${region.toUpperCase()})`,
          ttl: 3600000,
        },
        threadId,
        threadType
      );
    }

    const lines = [
      `🎮 THÔNG TIN FREE FIRE`,
      ``,
      `👤 Người chơi:`,
      `➤ Tên: ${playerInfo.name}`,
      `➤ UID: ${playerInfo.uid}`,
      `➤ Khu vực: ${playerInfo.region}`,
      `➤ Level: ${playerInfo.level} (EXP: ${Number(playerInfo.exp).toLocaleString("vi-VN")})`,
      `➤ Lượt thích: ${Number(playerInfo.likes).toLocaleString("vi-VN")}`,
      `➤ Điểm Rank: ${playerInfo.rankPoints}`,
      `➤ Season: ${playerInfo.season}`,
      `➤ Giới tính: ${playerInfo.gender}`,
      playerInfo.guildName ? `➤ Quân đoàn: ${playerInfo.guildName}` : null,
      playerInfo.signature ? `➤ Tiểu sử: ${playerInfo.signature}` : null,
      ``,
      `🧸 Thú cưng:`,
      `➤ Tên: ${playerInfo.petName}`,
      `➤ Level: ${playerInfo.petLevel}`,
    ].filter(Boolean);

    return await api.sendMessage(
      {
        ...(outfitPath ? { attachments: [outfitPath] } : {}),
        msg: lines.join("\n"),
        ttl: 3600000,
      },
      threadId,
      threadType
    );
  } catch (e) {
    return api.sendMessage(
      {
        msg: `❌ Lỗi tra cứu Free Fire: ${e?.message || "Không xác định"}`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  } finally {
    if (outfitPath) {
      await fs.promises.unlink(outfitPath).catch(() => {});
    }
  }
}
