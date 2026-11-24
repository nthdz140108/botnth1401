import { createCanvas, registerFont } from "canvas";
import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
import { resolveCanvasTempPath } from "./weather-render-path.js";
import { describeConcept, describeAqiLevel } from "./weather-provider.js";

// Đăng ký font chữ cho renderer (dùng chung font có sẵn của bot)
registerFont(path.join(getProjectRoot(), "assets", "fonts", "BeVietnamPro-Bold.ttf"), { family: "BeVietnamPro" });

export const WEATHER_CANVAS = Object.freeze({ width: 1240, height: 2048 });

// Bảng màu của concept
const CONCEPT_COLORS = {
  clear: { fill: "#ffd166", stroke: "#f5a623" },
  "partly-cloudy": { fill: "#f4a261", stroke: "#e76f51", cloud: "#ffffff" },
  cloudy: { fill: "#cbd5e1", stroke: "#94a3b8" },
  overcast: { fill: "#94a3b8", stroke: "#64748b" },
  fog: { fill: "#e2e8f0", stroke: "#cbd5e1" },
  drizzle: { fill: "#7dd3fc", stroke: "#38bdf8", droplet: "#0ea5e9" },
  rain: { fill: "#60a5fa", stroke: "#3b82f6", droplet: "#1d4ed8" },
  "heavy-rain": { fill: "#3b82f6", stroke: "#2563eb", droplet: "#1e3a8a" },
  showers: { fill: "#818cf8", stroke: "#6366f1", droplet: "#4338ca" },
  snow: { fill: "#e0f2fe", stroke: "#bae6fd", droplet: "#ffffff" },
  sleet: { fill: "#bae6fd", stroke: "#7dd3fc", droplet: "#e0f2fe" },
  hail: { fill: "#c7d2fe", stroke: "#a5b4fc", droplet: "#ffffff" },
  thunderstorm: { fill: "#6366f1", stroke: "#4f46e5", droplet: "#facc15", bolt: "#fde047" },
  unknown: { fill: "#e2e8f0", stroke: "#94a3b8" },
};

const CARD_RADIUS = 22;
const BODY_FONT = "BeVietnamPro";
const ACCENT_BLUE = "#38bdf8";
const ACCENT_TEAL = "#2dd4bf";
const ACCENT_GOLD = "#fbbf24";

function colorForConcept(concept, key) {
  const cfg = CONCEPT_COLORS[concept] || CONCEPT_COLORS.unknown;
  return cfg[key];
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawGlassCard(ctx, x, y, w, h, accent) {
  ctx.save();
  // Đổ bóng mềm
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  ctx.fillStyle = "rgba(16, 32, 66, 0.72)";
  ctx.fill();
  ctx.restore();

  // Viền glass
  ctx.save();
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  const borderGradient = ctx.createLinearGradient(x, y, x + w, y + h);
  borderGradient.addColorStop(0, accent || ACCENT_BLUE);
  borderGradient.addColorStop(1, "rgba(255, 255, 255, 0.12)");
  ctx.strokeStyle = borderGradient;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawConceptIcon(ctx, concept, cx, cy, size) {
  if (concept === "clear") {
    // Mặt trời
    const r = size * 0.32;
    ctx.save();
    ctx.translate(cx, cy);
    const rays = 8;
    for (let i = 0; i < rays; i++) {
      ctx.save();
      ctx.rotate((Math.PI * 2 * i) / rays);
      ctx.strokeStyle = colorForConcept(concept, "stroke");
      ctx.lineWidth = size * 0.05;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(r + size * 0.12, 0);
      ctx.lineTo(r + size * 0.28, 0);
      ctx.stroke();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r);
    g.addColorStop(0, "#fff7d6");
    g.addColorStop(1, colorForConcept(concept, "fill"));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (concept === "fog") {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = colorForConcept(concept, "stroke");
    ctx.lineWidth = size * 0.06;
    ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-size * 0.4, -size * 0.12 + i * size * 0.16);
      ctx.lineTo(size * 0.4, -size * 0.12 + i * size * 0.16);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(-size * 0.15, -size * 0.3, size * 0.18, Math.PI, 0);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const isThunder = concept === "thunderstorm";
  const isSnow = concept === "snow" || concept === "sleet" || concept === "hail";

  // Đám mây
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = colorForConcept(concept, "fill");
  ctx.strokeStyle = colorForConcept(concept, "stroke");
  ctx.lineWidth = size * 0.04;
  cloudPath(ctx, size, concept);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Giọt mưa
  if (!isSnow && !isThunder) {
    const dropColors = ["drizzle", "rain", "heavy-rain", "showers"];
    if (dropColors.includes(concept)) {
      drawDrops(ctx, cx, cy, size, colorForConcept(concept, "droplet"));
    }
  }
  // Bông tuyết
  if (isSnow) {
    drawSnowflake(ctx, cx, cy, size, colorForConcept(concept, "droplet"));
  }
  // Tia sét
  if (isThunder) {
    drawBolt(ctx, cx, cy, size, colorForConcept(concept, "bolt"));
  }
}

function cloudPath(ctx, size, concept) {
  ctx.beginPath();
  ctx.arc(-size * 0.28, -size * 0.05, size * 0.22, Math.PI * 0.9, Math.PI * 2.1);
  ctx.arc(0, -size * 0.28, size * 0.26, Math.PI, Math.PI * 2);
  ctx.arc(size * 0.26, -size * 0.05, size * 0.2, Math.PI * 1.1, Math.PI * 2.3);
  ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
  ctx.closePath();
}

function drawDrops(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(cx + i * size * 0.22, cy + size * 0.35, size * 0.06, size * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSnowflake(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.03;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * size * 0.22, cy + size * 0.2);
    ctx.lineTo(cx + i * size * 0.22, cy + size * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBolt(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx + size * 0.02, cy + size * 0.28);
  ctx.lineTo(cx - size * 0.16, cy + size * 0.52);
  ctx.lineTo(cx - size * 0.04, cy + size * 0.5);
  ctx.lineTo(cx - size * 0.12, cy + size * 0.72);
  ctx.lineTo(cx + size * 0.18, cy + size * 0.44);
  ctx.lineTo(cx + size * 0.05, cy + size * 0.44);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function wrapTitle(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line + (line ? " " : "") + word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Vẽ text tự co giãn vừa maxWidth (trả về cỡ chữ thực tế đã dùng)
function fitText(ctx, text, x, y, maxWidth, baseSize, weight = "bold") {
  let size = baseSize;
  ctx.font = `${weight} ${size}px ${BODY_FONT}`;
  while (size > 12 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${BODY_FONT}`;
  }
  ctx.fillText(text, x, y);
  return size;
}

function formatDayLabel(dateStr, index) {
  if (index === 0) return "Hôm nay";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return `Ngày ${index + 1}`;
  const names = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  return names[d.getDay()];
}

function formatTimeLabel(timeStr) {
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function fmt(n, suffix = "") {
  if (n == null || Number.isNaN(n)) return "--";
  return `${Math.round(n)}${suffix}`;
}

function maskTime(timeStr) {
  if (!timeStr) return "—";
  return String(timeStr).replace(/\s*(AM|PM)/i, "").trim();
}

// ── Render chính ────────────────────────────────────────────────────────────
export function renderWeatherImage(model, options = {}) {
  const width = options.width || WEATHER_CANVAS.width;
  const height = options.height || WEATHER_CANVAS.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const padX = 44;
  const contentW = width - padX * 2;

  // Nền navy gradient cố định
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, "#0b1026");
  bgGradient.addColorStop(0.5, "#0f1e3c");
  bgGradient.addColorStop(1, "#12304f");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Vệt sáng mềm phía trên
  const glow = ctx.createRadialGradient(width / 2, 120, 0, width / 2, 120, width * 0.9);
  glow.addColorStop(0, "rgba(56, 189, 248, 0.12)");
  glow.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  let y = 58;

  // ── Tiêu đề: địa điểm + ngày giờ cập nhật ──────────────────────────────────
  const titleText = model.location?.name
    ? `${model.location.name}${model.location.admin1 ? `, ${model.location.admin1}` : ""}${model.location.country ? `, ${model.location.country}` : ""}`
    : "Thời tiết";
  const nowText = `Cập nhật ${formatUpdateTime(model.updatedAt)}`;

  ctx.font = `bold 56px ${BODY_FONT}`;
  const titleMaxW = contentW - 80;
  const titleLines = wrapTitle(ctx, titleText, titleMaxW).slice(0, 2);
  const titleH = titleLines.length > 1 ? 196 : 170;
  drawGlassCard(ctx, padX, y, contentW, titleH, ACCENT_TEAL);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  const titleCenterY = y + titleH / 2 - (titleLines.length > 1 ? 22 : 14);
  if (titleLines.length === 1) {
    fitText(ctx, titleLines[0], width / 2, titleCenterY, titleMaxW, 56);
    ctx.font = `24px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText(nowText, width / 2, titleCenterY + 46);
  } else {
    fitText(ctx, titleLines[0], width / 2, titleCenterY - 26, titleMaxW, 48);
    fitText(ctx, titleLines[1], width / 2, titleCenterY + 26, titleMaxW, 48);
    ctx.font = `22px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText(nowText, width / 2, titleCenterY + 78);
  }
  y += titleH + 24;

  // ── Hiện tại: nhiệt độ lớn + mô tả + cảm giác + lưới chỉ số ────────────────
  const current = model.current || {};
  const tempText = fmt(current.temp, "°C");
  const descText = current.description || describeConcept(current.concept) || "Không xác định";
  const feelsText = current.feelsLike != null ? `Cảm giác như ${fmt(current.feelsLike, "°C")}` : "";

  const currentH = 380;
  const currentBox = { x: padX, y, w: contentW, h: currentH };
  drawGlassCard(ctx, currentBox.x, currentBox.y, currentBox.w, currentBox.h, ACCENT_BLUE);

  // Icon thời tiết trong huy hiệu tròn để không chạm chữ
  const iconCx = currentBox.x + 150;
  const iconCy = currentBox.y + 140;
  ctx.save();
  ctx.beginPath();
  ctx.arc(iconCx, iconCy, 104, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(56, 189, 248, 0.10)";
  ctx.fill();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  drawConceptIcon(ctx, current.concept || "unknown", iconCx, iconCy, 150);

  const textX = currentBox.x + 300;
  const textMaxW = currentBox.x + currentBox.w - 40 - textX;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  fitText(ctx, tempText, textX, currentBox.y + 108, textMaxW, 150);
  ctx.fillStyle = colorForConcept(current.concept || "unknown", "fill") || "#ffffff";
  fitText(ctx, descText, textX, currentBox.y + 186, textMaxW, 42);
  if (feelsText) {
    ctx.font = `30px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText(feelsText, textX, currentBox.y + 236);
  }

  // Divider tách phần nhiệt độ và lưới chỉ số
  ctx.strokeStyle = "rgba(159, 179, 209, 0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(currentBox.x + 30, currentBox.y + currentH - 118);
  ctx.lineTo(currentBox.x + currentBox.w - 30, currentBox.y + currentH - 118);
  ctx.stroke();

  // Lưới chỉ số phụ (độ ẩm, gió, mây, tầm nhìn)
  const detailMetrics = [
    ["Độ ẩm", current.humidity != null ? `${current.humidity}%` : "—"],
    ["Gió", current.windSpeed != null ? `${Math.round(current.windSpeed * 3.6)} km/h` : "—"],
    ["Mây", current.cloud != null ? `${current.cloud}%` : "—"],
    ["Tầm nhìn", current.visibilityKm != null ? `${current.visibilityKm} km` : "—"],
  ];
  const metricW = (contentW - 60) / detailMetrics.length;
  detailMetrics.forEach(([name, val], i) => {
    const mx = padX + 30 + metricW * i + metricW / 2;
    ctx.textAlign = "center";
    ctx.font = `24px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText(name, mx, currentBox.y + currentH - 78);
    ctx.font = `bold 30px ${BODY_FONT}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(val, mx, currentBox.y + currentH - 38);
  });
  y += currentH + 24;

  // ── 7 giờ tới ──────────────────────────────────────────────────────────────
  const hourly = model.hourly.slice(0, 7);
  const hourlyH = 260;
  drawGlassCard(ctx, padX, y, contentW, hourlyH, ACCENT_BLUE);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `bold 34px ${BODY_FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("7 GIỜ TỚI", padX + 30, y + 45);

  if (hourly.length === 0) {
    ctx.font = `30px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText("Chưa có dữ liệu", padX + 30, y + 160);
  } else {
    const itemW = (contentW - 60) / hourly.length;
    hourly.forEach((h, i) => {
      const cx = padX + 30 + itemW * i + itemW / 2;
      const cy = y + 155;
      ctx.textAlign = "center";
      ctx.font = `26px ${BODY_FONT}`;
      ctx.fillStyle = "#9fb3d1";
      ctx.fillText(formatTimeLabel(h.time), cx, cy - 66);
      drawConceptIcon(ctx, h.concept || "unknown", cx, cy, Math.min(52, itemW - 16));
      ctx.font = `bold 32px ${BODY_FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(fmt(h.temp, "°"), cx, cy + 62);
      if (h.precipProb != null) {
        ctx.font = `22px ${BODY_FONT}`;
        ctx.fillStyle = "#60a5fa";
        const precipText = `${Math.round(h.precipProb)}%`;
        const pw = ctx.measureText(precipText).width;
        ctx.beginPath();
        ctx.ellipse(cx - pw / 2 - 9, cy + 92, 4, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = "left";
        ctx.fillText(precipText, cx - pw / 2, cy + 92);
        ctx.textAlign = "center";
      }
    });
  }
  y += hourlyH + 24;

  // ── 6 ngày tới ────────────────────────────────────────────────────────────
  const daily = model.daily.slice(0, 6);
  const dailyH = 430;
  drawGlassCard(ctx, padX, y, contentW, dailyH, ACCENT_GOLD);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `bold 34px ${BODY_FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("6 NGÀY TỚI", padX + 30, y + 45);

  if (daily.length === 0) {
    ctx.font = `30px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText("Chưa có dữ liệu", padX + 30, y + 200);
  } else {
    const rowH = 62;
    const startY = y + 98;
    const labelW = 120;
    const iconCx = padX + 40 + labelW + 44;
    const minTextX = padX + contentW - 40;
    ctx.textAlign = "right";
    ctx.font = `bold 32px ${BODY_FONT}`;
    const minW = ctx.measureText(fmt(Math.min(...daily.map((d) => d.tempMin ?? -99)), "°")).width;
    const maxTextX = minTextX - minW - 26;
    const barX0 = iconCx + 56;
    const barX1 = maxTextX - ctx.measureText(fmt(Math.max(...daily.map((d) => d.tempMax ?? 99)), "°")).width - 26;
    const barW = Math.max(80, barX1 - barX0);
    const weekMin = Math.min(...daily.map((d) => d.tempMin ?? 99));
    const weekMax = Math.max(...daily.map((d) => d.tempMax ?? -99));
    const weekRange = Math.max(1, weekMax - weekMin);

    daily.forEach((d, i) => {
      const ry = startY + i * rowH;
      ctx.textAlign = "left";
      ctx.font = `bold 30px ${BODY_FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(formatDayLabel(d.date, i), padX + 40, ry);
      drawConceptIcon(ctx, d.concept || "unknown", iconCx, ry, 38);

      // Thanh nhiệt độ chung thang cả tuần
      if (d.tempMax != null && d.tempMin != null && weekMax > weekMin) {
        const lo = barX0 + ((d.tempMin - weekMin) / weekRange) * barW;
        const hi = barX0 + ((d.tempMax - weekMin) / weekRange) * barW;
        ctx.save();
        ctx.strokeStyle = "rgba(159, 179, 209, 0.22)";
        ctx.lineWidth = 8;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(barX0, ry);
        ctx.lineTo(barX0 + barW, ry);
        ctx.stroke();
        const g = ctx.createLinearGradient(barX0, 0, barX0 + barW, 0);
        g.addColorStop(0, "#38bdf8");
        g.addColorStop(1, "#fb923c");
        ctx.strokeStyle = g;
        ctx.beginPath();
        ctx.moveTo(lo, ry);
        ctx.lineTo(Math.max(lo + 8, hi), ry);
        ctx.stroke();
        ctx.restore();
      }

      ctx.textAlign = "right";
      ctx.font = `bold 32px ${BODY_FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(fmt(d.tempMax, "°"), maxTextX, ry);
      ctx.fillStyle = "#9fb3d1";
      ctx.fillText(fmt(d.tempMin, "°"), minTextX, ry);
    });
  }
  y += dailyH + 24;

  // ── AQI + Bình minh / hoàng hôn ───────────────────────────────────────────
  const aqi = model.airQuality;
  const astronomy = model.astronomy || {};
  const infoH = 340;
  drawGlassCard(ctx, padX, y, contentW, infoH, ACCENT_TEAL);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `bold 32px ${BODY_FONT}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("CHẤT LƯỢNG KHÔNG KHÍ", padX + 30, y + 48);

  if (!aqi) {
    ctx.font = `30px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText("Chưa có dữ liệu", padX + 30, y + 150);
  } else {
    const level = aqi.level || describeAqiLevel(aqi.usEpaIndex);
    const indexText = aqi.usEpaIndex != null ? String(aqi.usEpaIndex) : "—";
    const labelText = level.label || "Không xác định";

    // Badge chỉ số AQI + nhãn co giãn theo chỗ trống
    ctx.font = `bold 72px ${BODY_FONT}`;
    const indexW = ctx.measureText(indexText).width;
    const badgeX = padX + 40;
    const badgeW = Math.max(110, indexW + 44);
    roundRectPath(ctx, badgeX, y + 84, badgeW, 96, 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fill();
    ctx.strokeStyle = level.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.font = `bold 72px ${BODY_FONT}`;
    ctx.fillStyle = level.color;
    ctx.fillText(indexText, badgeX + badgeW / 2, y + 133);

    ctx.textAlign = "left";
    const labelMaxW = padX + contentW - 40 - (badgeX + badgeW + 24);
    ctx.fillStyle = level.color;
    fitText(ctx, labelText, badgeX + badgeW + 24, y + 133, labelMaxW, 34);

    // Pollutants
    const metrics = [
      ["PM2.5", aqi.pollutants?.pm25],
      ["PM10", aqi.pollutants?.pm10],
      ["O₃", aqi.pollutants?.o3],
      ["NO₂", aqi.pollutants?.no2],
      ["SO₂", aqi.pollutants?.so2],
      ["CO", aqi.pollutants?.co],
    ];
    const metricW = (contentW - 60) / metrics.length;
    metrics.forEach(([name, val], i) => {
      const mx = padX + 30 + metricW * i + metricW / 2;
      ctx.textAlign = "center";
      ctx.font = `24px ${BODY_FONT}`;
      ctx.fillStyle = "#9fb3d1";
      ctx.fillText(name, mx, y + 214);
      ctx.font = `bold 28px ${BODY_FONT}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(val != null ? String(val) : "—", mx, y + 248);
    });
  }

  // Divider
  ctx.strokeStyle = "rgba(159, 179, 209, 0.18)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX + 30, y + 274);
  ctx.lineTo(padX + contentW - 30, y + 274);
  ctx.stroke();

  // Bình minh / hoàng hôn: hai chip cân đối, không chồng nhau
  const sr = maskTime(astronomy.sunrise);
  const ss = maskTime(astronomy.sunset);
  const chipW = (contentW - 60 - 20) / 2;
  const chips = [
    { label: "Bình minh", value: sr, color: "#fbbf24" },
    { label: "Hoàng hôn", value: ss, color: "#fb923c" },
  ];
  chips.forEach((chip, i) => {
    const cx0 = padX + 30 + i * (chipW + 20);
    roundRectPath(ctx, cx0, y + 288, chipW, 36, 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.font = `24px ${BODY_FONT}`;
    ctx.fillStyle = "#9fb3d1";
    ctx.fillText(chip.label, cx0 + 18, y + 306);
    ctx.textAlign = "right";
    ctx.font = `bold 24px ${BODY_FONT}`;
    ctx.fillStyle = chip.color;
    ctx.fillText(chip.value || "—", cx0 + chipW - 18, y + 306);
  });
  y += infoH + 24;

  return { canvas, heightUsed: y };
}

function formatUpdateTime(iso) {
  if (!iso) return new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

// Viết PNG ra đĩa và trả về đường dẫn file tạm.
export async function createWeatherImageFile(model, options = {}) {
  const { canvas } = renderWeatherImage(model, options);
  const fileName = `weather_${Date.now()}.png`;
  const filePath = resolveCanvasTempPath(fileName);
  const fs = await import("node:fs");
  fs.writeFileSync(filePath, canvas.toBuffer());
  return filePath;
}
