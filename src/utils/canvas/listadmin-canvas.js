import { createCanvas, loadImage } from "canvas";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";
import { createCanvasTempPath } from "./temp-path.js";

const CFG = {
  W: 1200,
  M: 24,
  HEAD: 110,
  COL_HEAD: 52,
  PAD: 16,
  CARD: 78,
  GAP: 12,
};

const rr = (ctx, x, y, w, h, r = 12) => {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.closePath();
};

const txt = (ctx, s, x, y, o = {}) => {
  ctx.font = o.font || "16px Arial";
  ctx.fillStyle = o.fill || "#fff";
  ctx.textAlign = o.align || "left";
  ctx.textBaseline = o.base || "alphabetic";
  ctx.fillText(s ?? "", x, y);
};

const ell = (ctx, s, maxW) => {
  s = String(s || "").trim();
  if (!s) return "";
  if (ctx.measureText(s).width <= maxW) return s;
  while (s && ctx.measureText(`${s}…`).width > maxW) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
};

async function fetchImageToBuffer(src) {
  if (!src) return null;
  if (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://"))) {
    try {
      const resp = await axios.get(src, {
        responseType: "arraybuffer",
        timeout: 6000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      const buffer = Buffer.from(resp.data);
      try {
        return await sharp(buffer).png().toBuffer();
      } catch {
        return buffer;
      }
    } catch {
      return null;
    }
  }
  if (typeof src === "string" && fsSync.existsSync(src)) {
    try {
      const fileBuffer = await fs.readFile(src);
      try {
        return await sharp(fileBuffer).png().toBuffer();
      } catch {
        return fileBuffer;
      }
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(src)) {
    try {
      return await sharp(src).png().toBuffer();
    } catch {
      return src;
    }
  }
  return null;
}

const safeImg = async (src) => {
  if (!src) return null;
  try {
    const buf = await fetchImageToBuffer(src);
    if (buf) {
      return await loadImage(buf);
    }
    return await loadImage(src);
  } catch {
    return null;
  }
};

const normList = (list = []) =>
  list.map((a, i) => ({
    id: a.id ?? String(i + 1),
    name: a.name ?? a.zaloName ?? a.displayName ?? `#${i + 1}`,
    role: a.role ?? "",
    avatar: a.avatar ?? a.avatarUrl ?? a.avatar_url ?? a.photo ?? null,
  }));

const colHeight = (n) =>
  n
    ? CFG.COL_HEAD + CFG.PAD * 2 + n * CFG.CARD + (n - 1) * CFG.GAP
    : CFG.COL_HEAD + CFG.PAD * 2 + 110;

const drawCard = (ctx, x, y, w, i, color, img, name, role) => {
  // Card background
  rr(ctx, x, y, w, CFG.CARD, 12);
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Index number pill
  const numX = x + 10;
  const box = 30;
  const numY = y + (CFG.CARD - box) / 2;
  rr(ctx, numX, numY, box, box, 8);
  ctx.fillStyle = color;
  ctx.fill();
  txt(ctx, String(i + 1), numX + box / 2, numY + box / 2 + 1, {
    align: "center",
    base: "middle",
    font: "bold 15px Arial",
    fill: "#ffffff",
  });

  // Avatar
  const A = 52;
  const ax = numX + box + 12;
  const ay = y + (CFG.CARD - A) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(ax + A / 2, ay + A / 2, A / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (img) {
    ctx.drawImage(img, ax, ay, A, A);
  } else {
    // Fallback letter avatar
    ctx.fillStyle = color;
    ctx.fillRect(ax, ay, A, A);
    const initialLetter = String(name || "?").trim().charAt(0).toUpperCase() || "?";
    txt(ctx, initialLetter, ax + A / 2, ay + A / 2 + 1, {
      align: "center",
      base: "middle",
      font: "bold 24px Arial",
      fill: "#ffffff",
    });
  }
  ctx.restore();

  // Avatar border outline
  ctx.beginPath();
  ctx.arc(ax + A / 2, ay + A / 2, A / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Text details (Name & Role)
  const tx = ax + A + 12;
  const maxW = w - (tx - x) - 14;

  ctx.font = "bold 16px Arial";
  txt(ctx, ell(ctx, name, maxW), tx, y + 30, {
    font: "bold 16px Arial",
    fill: "#f8fafc",
  });

  ctx.font = "13px Arial";
  txt(ctx, ell(ctx, role, maxW), tx, y + 54, {
    font: "13px Arial",
    fill: "#94a3b8",
  });
};

const drawColumn = async (ctx, x, y, w, color, title, data) => {
  // Column header
  rr(ctx, x, y, w, CFG.COL_HEAD, 10);
  ctx.fillStyle = color;
  ctx.fill();

  txt(ctx, `${title} (${data.length})`, x + 16, y + CFG.COL_HEAD / 2 + 1, {
    base: "middle",
    font: "bold 16px Arial",
    fill: "#ffffff",
  });

  const bodyY = y + CFG.COL_HEAD + CFG.PAD;
  if (!data.length) {
    rr(ctx, x, bodyY, w, 100, 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.stroke();

    txt(ctx, "Chưa có quản trị viên", x + w / 2, bodyY + 50, {
      align: "center",
      base: "middle",
      font: "14px Arial",
      fill: "#64748b",
    });
    return;
  }

  const imgs = await Promise.all(data.map((d) => safeImg(d.avatar)));
  data.forEach((d, i) =>
    drawCard(
      ctx,
      x,
      bodyY + i * (CFG.CARD + CFG.GAP),
      w,
      i,
      color,
      imgs[i],
      d.name,
      d.role
    )
  );
};

export async function createAdminListImage({ highAdmins = [], botAdmins = [], groupAdmins = [] } = {}) {
  const columns = [
    { data: normList(highAdmins).slice(0, 50), color: "#ef4444", title: "Quản trị Tối cao" },
    { data: normList(botAdmins).slice(0, 50), color: "#f59e0b", title: "Quản trị Bot đa-nhóm" },
    { data: normList(groupAdmins).slice(0, 50), color: "#3b82f6", title: "Quản trị Nhóm" },
  ];

  const bodyH = Math.max(...columns.map((c) => colHeight(c.data.length)));
  const H = CFG.M + CFG.HEAD + 16 + bodyH + CFG.M;
  const canvas = createCanvas(CFG.W, H);
  const ctx = canvas.getContext("2d");

  // Deep dark background
  ctx.fillStyle = "#0c101c";
  ctx.fillRect(0, 0, CFG.W, H);

  // Subtle gradient highlight
  const bgGrad = ctx.createLinearGradient(0, 0, CFG.W, H);
  bgGrad.addColorStop(0, "rgba(59, 130, 246, 0.05)");
  bgGrad.addColorStop(0.5, "rgba(15, 23, 42, 0)");
  bgGrad.addColorStop(1, "rgba(239, 68, 68, 0.04)");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, CFG.W, H);

  // Main title
  txt(ctx, "Danh Sách Quản Trị Viên", CFG.W / 2, 58, {
    align: "center",
    font: "bold 32px Arial",
    fill: "#ffffff",
  });
  txt(ctx, "Bot Management System", CFG.W / 2, 88, {
    align: "center",
    font: "15px Arial",
    fill: "#94a3b8",
  });

  const gap = 16;
  const colW = (CFG.W - CFG.M * 2 - gap * 2) / 3;
  const y = CFG.M + CFG.HEAD + 16;

  for (let i = 0; i < columns.length; i++) {
    await drawColumn(ctx, CFG.M + i * (colW + gap), y, colW, columns[i].color, columns[i].title, columns[i].data);
  }

  await fs.mkdir(path.resolve("./assets/temp"), { recursive: true });
  const filePath = createCanvasTempPath(`admin_list_${Date.now()}.png`);
  await fs.writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}
