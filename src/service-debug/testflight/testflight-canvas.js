import { createCanvas, loadImage } from "canvas";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import { tempDir } from "../../utils/io-json.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";

function drawStatusBadge(ctx, text, x, y) {
  const safeText = String(text || "Không rõ").replace(/\s+/g, " ").trim();
  const statusText = safeText.toLowerCase();
  const isClosed =
    statusText.includes("đã đóng") ||
    statusText.includes("đóng") ||
    statusText.includes("đầy") ||
    statusText.includes("full") ||
    statusText.includes("gone");

  const badgeColor = isClosed ? "#dc3545" : "#28a745";

  ctx.font = "bold 16px BeVietnamPro, sans-serif";
  const textWidth = ctx.measureText(safeText).width;
  const badgeWidth = textWidth + 20;
  const badgeX = x - badgeWidth;

  ctx.fillStyle = badgeColor;
  ctx.beginPath();
  ctx.roundRect(badgeX, y, badgeWidth, 30, 15);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.fillText(safeText, x - 10, y + 15);
}

async function fetchAppIcon(iconUrl) {
  if (!iconUrl || typeof iconUrl !== "string") return null;
  try {
    const res = await fetch(iconUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await loadImage(buf);
  } catch {
    return null;
  }
}

export async function createTestflightImage(apps) {
  ensureCanvasFontsRegistered();

  const appsToDraw = (Array.isArray(apps) ? apps : []).slice(0, 10);
  const itemWidth = 720;
  const itemHeight = 120;
  const padding = 20;
  const iconSize = 80;

  const canvasWidth = itemWidth;
  const canvasHeight = Math.max(140, appsToDraw.length * itemHeight + padding);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 0, canvasHeight);
  gradient.addColorStop(0, "#1e293b");
  gradient.addColorStop(1, "#334155");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const icons = await Promise.all(appsToDraw.map((app) => fetchAppIcon(app?.icon)));

  for (let i = 0; i < appsToDraw.length; i++) {
    const app = appsToDraw[i] || {};
    const icon = icons[i];

    const xPos = padding;
    const yPos = padding / 2 + i * itemHeight;

    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.beginPath();
    ctx.roundRect(xPos, yPos, itemWidth - padding * 2, itemHeight - 10, 15);
    ctx.fill();

    const iconX = xPos + 15;
    const iconY = yPos + (itemHeight - 10 - iconSize) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(iconX, iconY, iconSize, iconSize, 15);
    ctx.clip();
    if (icon) {
      ctx.drawImage(icon, iconX, iconY, iconSize, iconSize);
    } else {
      ctx.fillStyle = "#64748b";
      ctx.fillRect(iconX, iconY, iconSize, iconSize);
    }
    ctx.restore();

    const textX = iconX + iconSize + 20;
    const availableTextWidth = itemWidth - textX - padding * 2 - 140;

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 22px BeVietnamPro, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    let appName = String(app.ten || "Unknown App").replace(/\s+/g, " ").trim();
    if (ctx.measureText(appName).width > availableTextWidth) {
      while (
        ctx.measureText(`${appName}...`).width > availableTextWidth &&
        appName.length > 0
      ) {
        appName = appName.slice(0, -1);
      }
      appName += "...";
    }
    ctx.fillText(appName, textX, iconY + 6);

    const category = String(app.the_loai || "").replace(/\s+/g, " ").trim();
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "16px BeVietnamPro, sans-serif";
    if (category) {
      ctx.fillText(category, textX, iconY + 36);
    }

    const thayDoi = String(app.thay_doi || "").replace(/\s+/g, " ").trim();
    if (thayDoi) {
      ctx.fillText(`🕒 ${thayDoi}`, textX, iconY + 60);
    }

    const badgeLabel =
      String(app.trang_thai || "").replace(/\s+/g, " ").trim() ||
      (app.testflight ? "Còn slot" : "Đã đóng");
    drawStatusBadge(ctx, badgeLabel, itemWidth - padding * 2 - 10, yPos + 15);
  }

  await fs.mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, `testflight_${crypto.randomUUID()}.png`);
  await fs.writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}
