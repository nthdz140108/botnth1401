import { createCanvas, loadImage } from "canvas";
import fs from "fs/promises";
import path from "path";
import axios from "axios";
import { getUserInfoData } from "../../service-debug/info-service/user-info-data.js";
import { formatBotExpiryDisplay } from "./System/mybot-display.js";
import { tempDir } from "../../utils/io-json.js";
import { acquireTempLease } from "../../utils/temp-lease-manager.js";

export async function fetchImageBuffer(url) {
  if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    return Buffer.from(response.data);
  } catch {
    return null;
  }
}

function drawDefaultThumbnail(ctx, x, y, size, displayName = "") {
  ctx.save();
  const radius = size / 2;
  const centerX = x + radius;
  const centerY = y + radius;

  // Background circle
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
  const grad = ctx.createLinearGradient(x, y, x + size, y + size);
  grad.addColorStop(0, "#34495e");
  grad.addColorStop(1, "#1a252f");
  ctx.fillStyle = grad;
  ctx.fill();

  // Initial letter
  const name = String(displayName || "Bot").trim();
  const letter = (name.charAt(0) || "B").toUpperCase();
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.floor(size * 0.45)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, centerX, centerY + 1);

  ctx.restore();
}

function formatTimeRemaining(expiryDate, now, isRejected, rejecter, isPermanent) {
  if (isRejected) {
    return `Vô Hiệu Hóa Bởi ${rejecter || "Admin"}`;
  }
  if (isPermanent) {
    return "Vĩnh Viễn";
  }
  const diffMs = expiryDate - now;
  if (diffMs <= 0) return "Hết Hạn";

  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffMonths / 12);

  if (diffYears >= 1) {
    const remainingMonths = diffMonths % 12;
    return remainingMonths > 0 ? `${diffYears} năm ${remainingMonths} tháng` : `${diffYears} năm`;
  } else if (diffMonths >= 1) {
    const remainingDays = diffDays % 30;
    return remainingDays > 0 ? `${diffMonths} tháng ${remainingDays} ngày` : `${diffMonths} tháng`;
  } else if (diffDays >= 1) {
    const remainingHours = diffHours % 24;
    return remainingHours > 0 ? `${diffDays} ngày ${remainingHours} giờ` : `${diffDays} ngày`;
  } else if (diffHours >= 1) {
    const remainingMinutes = diffMinutes % 60;
    return remainingMinutes > 0 ? `${diffHours} giờ ${remainingMinutes} phút` : `${diffHours} giờ`;
  } else if (diffMinutes >= 1) {
    const remainingSeconds = diffSeconds % 60;
    return remainingSeconds > 0 ? `${diffMinutes} phút ${remainingSeconds} giây` : `${diffMinutes} phút`;
  } else {
    return `${diffSeconds} giây`;
  }
}

export async function resolveBotAvatarImage(bot, api) {
  // 1. Registry/Profile avatar (avatar field, rawRecord, or profile)
  const candidates = [
    bot?.avatar,
    bot?.rawRecord?.avatar,
    bot?.profile?.avatar,
    bot?.rawRecord?.photo,
    bot?.photo,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "string" && candidate.startsWith("http")) {
      try {
        const buffer = await fetchImageBuffer(candidate);
        if (buffer) {
          return await loadImage(buffer);
        }
      } catch {}
    }
  }

  // 2. Profile Zalo (using real UID, not "admin")
  const targetUid = String(bot?.uid || "").trim();
  if (targetUid && targetUid.toLowerCase() !== "admin" && api) {
    try {
      const userInfo = await getUserInfoData(api, targetUid);
      if (userInfo && userInfo.avatar) {
        const buffer = await fetchImageBuffer(userInfo.avatar);
        if (buffer) {
          return await loadImage(buffer);
        }
      }
    } catch {}
  }

  return null;
}

export function resolveBotBadge(bot) {
  const isRejected = bot?.status === "rejected" || bot?.runtimeState?.status === "rejected" || bot?.profile?.status === "rejected" || bot?.rawRecord?.status === "rejected";
  const isDisabled = bot?.enabled === false || bot?.profile?.enabled === false || bot?.rawRecord?.enabled === false;
  if (isRejected || isDisabled) {
    const text = "Vô hiệu hóa";
    return {
      text,
      label: text,
      color: "#F87171",
      bg: "rgba(239, 68, 68, 0.25)",
      border: "#EF4444",
      dot: "#EF4444",
    };
  }

  if (bot?.runtimeState?.probeError) {
    const text = "Không xác định runtime";
    return {
      text,
      label: text,
      color: "#C084FC",
      bg: "rgba(192, 132, 252, 0.25)",
      border: "#A855F7",
      dot: "#A855F7",
    };
  }

  // Expiry check
  const now = Date.now();
  const expiryDate = bot?.expiryAt && bot?.expiryAt !== "-1" ? new Date(bot.expiryAt).getTime() : null;
  const isExpired = bot?.status === "expired" || bot?.runtimeState?.status === "expired" || bot?.trialStatus === "expired" || (expiryDate && !isNaN(expiryDate) && expiryDate <= now);
  if (isExpired) {
    const text = "Hết hạn";
    return {
      text,
      label: text,
      color: "#FBBF24",
      bg: "rgba(245, 158, 11, 0.25)",
      border: "#F59E0B",
      dot: "#F59E0B",
    };
  }

  const rt = bot?.runtimeState;

  // Pseudo-running: PM2 online (running: true) but listener/readiness check failed (ready: false) -> "Lỗi"
  if (rt && rt.running === true && rt.ready === false) {
    const text = "Lỗi";
    return {
      text,
      label: text,
      color: "#FB7185",
      bg: "rgba(244, 63, 94, 0.25)",
      border: "#F43F5E",
      dot: "#F43F5E",
    };
  }

  // Runtime probe status: Only "Đang chạy" when PM2 online AND ready === true
  const isReadyRunning = rt ? (rt.ready === true && (rt.status === "running" || rt.running === true)) : (bot?.status === "running" && bot?.ready === true);
  if (isReadyRunning) {
    const text = "Đang chạy";
    return {
      text,
      label: text,
      color: "#34D399",
      bg: "rgba(16, 185, 129, 0.25)",
      border: "#10B981",
      dot: "#10B981",
    };
  }

  if (rt?.status === "starting" || bot?.status === "starting") {
    const text = "Đang khởi tạo";
    return {
      text,
      label: text,
      color: "#60A5FA",
      bg: "rgba(59, 130, 246, 0.25)",
      border: "#3B82F6",
      dot: "#3B82F6",
    };
  }

  if (rt?.status === "error") {
    const text = "Lỗi";
    return {
      text,
      label: text,
      color: "#FB7185",
      bg: "rgba(244, 63, 94, 0.25)",
      border: "#F43F5E",
      dot: "#F43F5E",
    };
  }

  const isPending = bot?.trialStatus === "pending" || bot?.status === "pending" || rt?.status === "pending" || bot?.status === "unstarted" || bot?.status === "provisioning";
  if (isPending) {
    const text = "Chưa chạy";
    return {
      text,
      label: text,
      color: "#94A3B8",
      bg: "rgba(148, 163, 184, 0.25)",
      border: "#94A3B8",
      dot: "#94A3B8",
    };
  }

  const text = "Đã dừng";
  return {
    text,
    label: text,
    color: "#CBD5E1",
    bg: "rgba(100, 116, 139, 0.25)",
    border: "#64748B",
    dot: "#64748B",
  };
}

export async function createBotListImage(bots = [], api = null) {
  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = "bold 18px sans-serif";

  const maxNameWidth = bots.reduce((maxWidth, bot) => {
    const displayName = bot.displayName || bot.name || "Bot";
    const name = displayName.length > 36 ? displayName.slice(0, 36) + "..." : displayName;
    const nameWidth = tempCtx.measureText(name).width;
    return nameWidth > maxWidth ? nameWidth : maxWidth;
  }, 0);

  const maxTimeWidth = bots.reduce((maxWidth, bot) => {
    const timeText = formatTimeRemaining(new Date(bot.expiryAt), new Date(), bot.status === "rejected", bot.rejecter, bot.expiryAt === "-1");
    const timeWidth = tempCtx.measureText(timeText).width;
    return timeWidth > maxWidth ? timeWidth : maxWidth;
  }, 0);

  const thumbnailSize = 60;
  const padding = 12;
  const numberWidth = 35;
  const separatorWidth = 10;
  const extraPadding = padding * 4;
  const width = thumbnailSize + separatorWidth + maxNameWidth + maxTimeWidth + numberWidth + extraPadding;
  const finalWidth = Math.max(550, Math.min(width, 1000));
  const headerHeight = 60;
  const cardHeight = 88;
  const height = Math.max(130, bots.length * cardHeight + 20 + headerHeight);

  const canvas = createCanvas(finalWidth, height);
  const ctx = canvas.getContext("2d");

  try {
    const thumbnailPromises = bots.map((bot) => resolveBotAvatarImage(bot, api).catch(() => null));
    const thumbnails = await Promise.all(thumbnailPromises);

    // Background
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, finalWidth, height);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.8)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0.9)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, finalWidth, height);

    let yPos = padding;

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("DANH SÁCH BOT", finalWidth / 2, yPos + 20);
    yPos += headerHeight;

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const displayName = bot.displayName || bot.name || `Bot #${i + 1}`;
      const badge = resolveBotBadge(bot);

      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      ctx.beginPath();
      ctx.roundRect(padding, yPos, finalWidth - padding * 2 - numberWidth - separatorWidth, cardHeight - 8, 8);
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      const thumbX = padding * 2;
      const thumbY = yPos + (cardHeight - thumbnailSize) / 2 - 2;
      const radius = thumbnailSize / 2;
      ctx.arc(thumbX + radius, thumbY + radius, radius + 1, 0, Math.PI * 2);
      const thumbGrad = ctx.createLinearGradient(thumbX, thumbY, thumbX + thumbnailSize, thumbY + thumbnailSize);
      thumbGrad.addColorStop(0, "rgba(255, 255, 255, 0.5)");
      thumbGrad.addColorStop(0.5, "rgba(255, 255, 255, 0.2)");
      thumbGrad.addColorStop(1, "rgba(255, 255, 255, 0.5)");
      ctx.fillStyle = thumbGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(thumbX + radius, thumbY + radius, radius - 1, 0, Math.PI * 2);
      ctx.clip();

      if (thumbnails[i]) {
        ctx.drawImage(thumbnails[i], thumbX, thumbY, thumbnailSize, thumbnailSize);
      } else {
        drawDefaultThumbnail(ctx, thumbX, thumbY, thumbnailSize, displayName);
      }
      ctx.restore();

      // Status indicator dot on avatar border
      const dotSize = 14;
      const dotX = thumbX + thumbnailSize - dotSize / 2;
      const dotY = thumbY + thumbnailSize - dotSize / 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = badge.dot;
      ctx.fill();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
      ctx.fillRect(thumbX + thumbnailSize + padding, yPos + 10, 2, cardHeight - 24);
      ctx.restore();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const textX = thumbX + thumbnailSize + padding * 2;

      // Line 1: Bot name
      ctx.font = "bold 17px sans-serif";
      ctx.fillStyle = "#ffffff";
      const maxName = finalWidth - textX - padding * 3 - maxTimeWidth - numberWidth - separatorWidth;
      let name = displayName;
      if (ctx.measureText(name).width > maxName) {
        while (ctx.measureText(name + "...").width > maxName && name.length > 0) {
          name = name.slice(0, -1);
        }
        name += "...";
      }
      ctx.fillText(name, textX, yPos + 8);

      // Line 2: Status badge pill
      ctx.save();
      ctx.font = "bold 11px sans-serif";
      const badgeText = badge.text;
      const badgeTextWidth = ctx.measureText(badgeText).width;
      const badgeWidth = badgeTextWidth + 14;
      const badgeHeight = 18;
      const badgeY = yPos + 32;

      ctx.beginPath();
      ctx.roundRect(textX, badgeY, badgeWidth, badgeHeight, 4);
      ctx.fillStyle = badge.bg;
      ctx.fill();
      ctx.strokeStyle = badge.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = badge.color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(badgeText, textX + badgeWidth / 2, badgeY + badgeHeight / 2 + 1);
      ctx.restore();

      // Line 3: Expiry / Time status
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = "13px sans-serif";
      ctx.fillStyle = "#aaaaaa";
      const timeText = formatBotExpiryDisplay(bot);
      ctx.fillText(timeText, textX, yPos + 56);

      // Index box
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
      ctx.beginPath();
      ctx.roundRect(finalWidth - padding - numberWidth, yPos, numberWidth, cardHeight - 8, [0, 8, 8, 0]);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 22px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${i + 1}`, finalWidth - padding - numberWidth / 2, yPos + cardHeight / 2 - 4);

      yPos += cardHeight;
    }

    await fs.mkdir(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `bot_list_${Date.now()}.png`);
    acquireTempLease(filePath, 120000, "mybot-list-canvas");
    await fs.writeFile(filePath, canvas.toBuffer("image/png"));
    return filePath;
  } catch (error) {
    throw error;
  }
}