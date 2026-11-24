import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import os from "os";
import { createCanvasTempPath } from "./temp-path.js";
import { getRandomGradient } from "./color.js";
import { normalizeBotInfo } from "../../service-debug/info-service/bot-details-utils.js";

function isValidUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

function drawBox(ctx, x, y, w, h, title) {
  const boxGradient = ctx.createLinearGradient(x, y, x, y + h);
  boxGradient.addColorStop(0, "rgba(0, 0, 0, 0.55)");
  boxGradient.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  ctx.fillStyle = boxGradient;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, 16);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
  ctx.stroke();

  if (title) {
    const titleGradient = ctx.createLinearGradient(x, y, x + w, y);
    titleGradient.addColorStop(0, "#4ECB71");
    titleGradient.addColorStop(1, "#1E90FF");
    ctx.fillStyle = titleGradient;
    ctx.font = "bold 36px BeVietnamPro";
    ctx.textAlign = "center";
    ctx.fillText(String(title), x + w / 2, y + 45);
  }
}

function drawVerticalDivider(ctx, x, y, h) {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + 60);
  ctx.lineTo(x, y + h - 60);
  ctx.stroke();
}

function measureTextWidth(ctx, text, font) {
  ctx.font = font;
  return ctx.measureText(String(text ?? "")).width;
}

function drawDefaultThumbnail(ctx, x, y, size) {
  ctx.fillStyle = "#fff3cd";
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#dc3545";
  ctx.lineWidth = 3;
  const padding = size * 0.25;

  ctx.beginPath();
  ctx.moveTo(x + padding, y + padding);
  ctx.lineTo(x + size - padding, y + size - padding);
  ctx.moveTo(x + size - padding, y + padding);
  ctx.lineTo(x + padding, y + size - padding);
  ctx.stroke();
}

function formatTimeDifference(startDate, endDate) {
  const diffMs = Math.abs(endDate - startDate);
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) {
    const remainingHours = diffHours % 24;
    return `${diffDays} ngày ${remainingHours} giờ`;
  } else if (diffHours > 0) {
    const remainingMinutes = diffMinutes % 60;
    return `${diffHours} giờ ${remainingMinutes} phút`;
  } else if (diffMinutes > 0) {
    const remainingSeconds = diffSeconds % 60;
    return `${diffMinutes} phút ${remainingSeconds} giây`;
  } else {
    return `${diffSeconds} giây`;
  }
}

export async function createNqduanBotDetailImage(
  botInfoInput,
  uptimeInput,
  botStatsInput,
  onConfigsInput,
  offConfigsInput
) {
  const botInfo = normalizeBotInfo(botInfoInput);
  const uptime = uptimeInput || "0 giây";
  const botStats = botStatsInput || {};
  const onConfigs = Array.isArray(onConfigsInput) ? onConfigsInput : [];
  const offConfigs = Array.isArray(offConfigsInput) ? offConfigsInput : [];

  const now = new Date();
  const createdAt = botInfo.createdAt instanceof Date ? botInfo.createdAt : new Date(botInfo.createdAt || now);

  const statusIcons = {
    running: "Đang hoạt động",
    stopped: "Đã dừng",
    trialExpired: "Hết thời gian dùng thử",
    expired: "Đã hết hạn",
    stopping: "Đang bảo trì",
    rejected: "Vô Hiệu Hóa",
  };

  let timeRemaining = "Vĩnh viễn";
  if (botInfo.expiryAt && botInfo.expiryAt !== "-1") {
    const expiryDate = new Date(botInfo.expiryAt);
    if (!isNaN(expiryDate.getTime())) {
      if (expiryDate > now) {
        timeRemaining = formatTimeDifference(now, expiryDate);
      } else {
        timeRemaining = "Đã hết hạn";
      }
    }
  }

  const botFields = [
    { label: "👤 ID Owner:", value: botInfo.name || "Unknown" },
    { label: "📱 Tên Bot:", value: botInfo.displayName || botInfo.name || "Bot" },
    { label: "🟢 Trạng thái:", value: statusIcons[botInfo.status] || botInfo.status || "Đang hoạt động" },
    { label: "🌐 Web Port:", value: botInfo.webPort || "Không có" },
    { label: "🗄️ Database:", value: botInfo.database || "Không có" },
    { label: "🔄 Thời gian chạy:", value: uptime },
    { label: "⏳ Thời hạn còn:", value: timeRemaining },
  ];

  const registrationFields = [
    {
      label: "📅 Ngày tạo:",
      value: createdAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
    },
    { label: "👤 Người tạo:", value: botInfo.createdBy || "Admin" },
    { label: "👮 Quản trị viên:", value: "Thanh Hung" },
    { label: "💻 Hệ điều hành:", value: botStats.os || os.type() },
    { label: "⚡ CPU Usage:", value: botStats.cpu || "N/A" },
    { label: "📈 RAM Usage:", value: botStats.ram || "N/A" },
    { label: "💽 Disk Usage:", value: botStats.disk || "N/A" },
  ];

  const technicalFields = [
    { label: "⚙️ Trạng thái bot:", value: botInfo.status === "running" ? "Hoạt động tốt" : (botInfo.status || "Unknown") },
    { label: "🔢 Phiên bản bot:", value: botStats.version || "Unknown" },
    { label: "🖥️ CPU Model:", value: botStats.cpuModel || "Unknown" },
    {
      label: "⚒️ Cập nhật cuối:",
      value: botInfo.lastUpdated
        ? new Date(botInfo.lastUpdated).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
        : "Chưa cập nhật",
    },
  ];

  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext("2d");

  let maxLeftWidth = 0;
  [botFields, registrationFields, technicalFields].forEach((fields) => {
    fields.forEach((f) => {
      const textWidth = measureTextWidth(tempCtx, `${f.label} ${f.value}`, "bold 28px BeVietnamPro");
      maxLeftWidth = Math.max(maxLeftWidth, textWidth);
    });
  });

  const leftColumnWidth = Math.max(650, maxLeftWidth + 120);

  let rightColumnWidth = 0;
  let hasConfigs = onConfigs.length > 0 || offConfigs.length > 0;
  let maxConfigWidth = 0;
  if (hasConfigs) {
    const configItemsForMeasure = onConfigs.length > 0 && offConfigs.length > 0 ? [...onConfigs, ...offConfigs] : onConfigs.length > 0 ? onConfigs : offConfigs;
    configItemsForMeasure.forEach(line => {
      const textWidth = measureTextWidth(tempCtx, `${line}: ✅`, "bold 22px BeVietnamPro");
      maxConfigWidth = Math.max(maxConfigWidth, textWidth);
    });
    rightColumnWidth = onConfigs.length > 0 && offConfigs.length > 0 ? Math.max(650, maxConfigWidth * 2 + 180) : Math.max(450, maxConfigWidth + 120);
  }

  const width = hasConfigs ? leftColumnWidth + rightColumnWidth + 120 : leftColumnWidth + 120;

  const headerH = 220;
  const headerY = 30;
  const botBoxHeight = botFields.length * 50 + 100;
  const regBoxHeight = registrationFields.length * 50 + 100;
  const techBoxHeight = technicalFields.length * 50 + 100;

  const maxConfigItems = onConfigs.length > 0 && offConfigs.length > 0 ? Math.max(onConfigs.length, offConfigs.length) : onConfigs.length > 0 ? onConfigs.length : offConfigs.length;
  const cfgBoxHeight = onConfigs.length > 0 && offConfigs.length > 0 ? maxConfigItems * 40 + 130 : maxConfigItems * 55 + 140;

  const leftColumnHeight = botBoxHeight + regBoxHeight + techBoxHeight + 90;
  const rightColumnHeight = hasConfigs ? cfgBoxHeight + 60 : 0;
  const height = headerY + headerH + 30 + Math.max(leftColumnHeight, rightColumnHeight) + 90;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, "#0F2027");
  bg.addColorStop(0.5, "#203A43");
  bg.addColorStop(1, "#2C5364");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const metallicGradient = ctx.createLinearGradient(0, 0, width, height);
  metallicGradient.addColorStop(0, "rgba(255,255,255,0.05)");
  metallicGradient.addColorStop(0.5, "rgba(255,255,255,0.1)");
  metallicGradient.addColorStop(1, "rgba(255,255,255,0.05)");
  ctx.fillStyle = metallicGradient;
  ctx.fillRect(0, 0, width, height);

  drawBox(ctx, 60, headerY, width - 120, headerH, "Thông Tin Chi Tiết Bot");

  let avatarImage = null;
  if (botInfo.avatar && isValidUrl(botInfo.avatar)) {
    try {
      avatarImage = await loadImage(botInfo.avatar);
    } catch {
      avatarImage = null;
    }
  }

  const size = 140;
  const cx = 150;
  const cy = headerY + headerH / 2;
  const grad = ctx.createLinearGradient(
    cx - size / 2,
    cy - size / 2,
    cx + size / 2,
    cy + size / 2
  );
  grad.addColorStop(0, "#4ECB71");
  grad.addColorStop(1, "#1E90FF");
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2 + 8, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2, true);
  ctx.clip();
  if (avatarImage) {
    ctx.drawImage(avatarImage, cx - size / 2, cy - size / 2, size, size);
  } else {
    drawDefaultThumbnail(ctx, cx - size / 2, cy - size / 2, size);
  }
  ctx.restore();

  const isRunning = botInfo.status === "running";
  const isRejected = botInfo.status === "rejected";
  const dotSize = 28;
  const dotX = cx + size / 2 - dotSize / 2;
  const dotY = cy + size / 2 - dotSize / 2;
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotSize / 2, 0, Math.PI * 2);
  ctx.fillStyle = isRunning ? "#00FF00" : isRejected ? "#FF0000" : "#808080";
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
  ctx.font = "bold 36px BeVietnamPro";
  ctx.fillText(String(botInfo.displayName || botInfo.name || "Bot"), 260, headerY + 100);
  ctx.font = "bold 26px BeVietnamPro";
  ctx.fillText("Developer: </>Thanh Hung", 260, headerY + 140);
  ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
  ctx.fillText("Uptime: " + uptime, 260, headerY + 180);

  const leftColumnX = 60;

  const botBoxY = headerY + headerH + 30;
  drawBox(ctx, leftColumnX, botBoxY, leftColumnWidth, botBoxHeight, "Thông Tin Bot");
  let yBot = botBoxY + 100;
  const lineHeight = 50;
  botFields.forEach((f) => {
    ctx.textAlign = "left";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillText(f.label, leftColumnX + 40, yBot);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, yBot);
    yBot += lineHeight;
  });

  const regBoxY = botBoxY + botBoxHeight + 30;
  drawBox(ctx, leftColumnX, regBoxY, leftColumnWidth, regBoxHeight, "Thông Tin Đăng Ký & Hệ Thống");
  let yReg = regBoxY + 100;
  registrationFields.forEach((f) => {
    ctx.textAlign = "left";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillText(f.label, leftColumnX + 40, yReg);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, yReg);
    yReg += lineHeight;
  });

  const techBoxY = regBoxY + regBoxHeight + 30;
  drawBox(ctx, leftColumnX, techBoxY, leftColumnWidth, techBoxHeight, "Trạng Thái Kỹ Thuật");
  let yTech = techBoxY + 100;
  technicalFields.forEach((f) => {
    ctx.textAlign = "left";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillText(f.label, leftColumnX + 40, yTech);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, yTech);
    yTech += lineHeight;
  });

  if (hasConfigs) {
    const rightColumnX = leftColumnX + leftColumnWidth + 30;
    const configY = botBoxY;
    drawBox(ctx, rightColumnX, configY, rightColumnWidth, cfgBoxHeight, "Group Configs");

    const leftColX = rightColumnX + 40;
    const rightColX = rightColumnX + rightColumnWidth / 2 + 40;
    if (onConfigs.length > 0 && offConfigs.length > 0) {
      const dividerX = rightColumnX + rightColumnWidth / 2;
      drawVerticalDivider(ctx, dividerX, configY, cfgBoxHeight);
    }

    let yOff = configY + 80;
    if (offConfigs.length > 0) {
      ctx.fillStyle = "#FF6B6B";
      ctx.font = onConfigs.length === 0 ? "bold 30px BeVietnamPro" : "bold 26px BeVietnamPro";
      ctx.textAlign = "left";
      ctx.fillText("Đang tắt:", leftColX, yOff);
      yOff += 40;
      ctx.font = onConfigs.length === 0 ? "bold 26px BeVietnamPro" : "bold 22px BeVietnamPro";
      offConfigs.forEach((line) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(line), leftColX, yOff);
        yOff += 40;
      });
    }

    let yOn = configY + 80;
    if (onConfigs.length > 0) {
      ctx.fillStyle = "#4ECB71";
      ctx.font = "bold 26px BeVietnamPro";
      ctx.textAlign = "left";
      const titleX = offConfigs.length === 0 ? rightColumnX + rightColumnWidth / 2 : rightColX;
      ctx.fillText("Đang bật:", titleX, yOn);
      yOn += 40;
      ctx.font = "bold 22px BeVietnamPro";
      onConfigs.forEach((line) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(line), titleX, yOn);
        yOn += 40;
      });
    }
  }

  const filePath = createCanvasTempPath(`bot_detail_nqduan_${Date.now()}.png`);
  const out = fs.createWriteStream(filePath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(filePath));
    out.on("error", reject);
  });
}
