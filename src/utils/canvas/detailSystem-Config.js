import crypto from "node:crypto";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import os from "os";
import fsPromises from "fs/promises";
import si from "systeminformation";
import { createCanvasTempPath } from "./temp-path.js";
import { ensureCanvasFontsRegistered } from "./register-fonts.js";
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
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#38bdf8";
  ctx.font = `bold ${Math.floor(size * 0.4)}px BeVietnamPro`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BOT", x + size / 2, y + size / 2);
}

function formatUptime(seconds) {
  let sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(sec / (24 * 60 * 60));
  sec %= 24 * 60 * 60;
  const hours = Math.floor(sec / (60 * 60));
  sec %= 60 * 60;
  const minutes = Math.floor(sec / 60);
  const remainingSec = Math.floor(sec % 60);

  const parts = [];
  if (days > 0) parts.push(`${days} ngày`);
  if (hours > 0) parts.push(`${hours} giờ`);
  if (minutes > 0) parts.push(`${minutes} phút`);
  if (remainingSec > 0 || parts.length === 0) parts.push(`${remainingSec} giây`);

  return parts.join(", ");
}

async function getWindowsVersion() {
  try {
    const osInfo = await si.osInfo();
    return `${osInfo?.distro || "Windows"} ${osInfo?.release || os.release()}`;
  } catch {
    return os.release() || "Unknown";
  }
}

async function getCpuTemp() {
  try {
    const temps = await si.cpuTemperature();
    return temps?.main ? `${temps.main.toFixed(1)}°C` : "N/A";
  } catch {
    return "N/A";
  }
}

async function getDiskMetrics() {
  try {
    const disks = await si.fsSize();
    if (Array.isArray(disks) && disks.length > 0) {
      const mainDisk = disks.find(d => d.mount === "C:" || d.mount === "/") || disks[0];
      const usedGB = (((mainDisk.used ?? (mainDisk.size - mainDisk.available))) / (1024 * 1024 * 1024)).toFixed(1);
      const totalGB = (mainDisk.size / (1024 * 1024 * 1024)).toFixed(1);
      const freeGB = (mainDisk.available / (1024 * 1024 * 1024)).toFixed(1);
      return {
        usage: `${usedGB} GB / ${totalGB} GB (Free ${freeGB} GB)`,
        total: `${totalGB} GB`,
      };
    }
    return { usage: "N/A", total: "N/A" };
  } catch {
    return { usage: "N/A", total: "N/A" };
  }
}

async function getNetworkUsage() {
  try {
    if (os.platform() === "win32") {
      const stats = await si.networkStats();
      if (Array.isArray(stats) && stats.length > 0) {
        const totalRx = stats.reduce((sum, iface) => sum + (iface.rx_bytes || 0), 0) / (1024 * 1024);
        const totalTx = stats.reduce((sum, iface) => sum + (iface.tx_bytes || 0), 0) / (1024 * 1024);
        return `Rx: ${totalRx.toFixed(2)} MB, Tx: ${totalTx.toFixed(2)} MB`;
      }
      return "Rx: 0.00 MB, Tx: 0.00 MB";
    } else {
      const data = await fsPromises.readFile("/proc/net/dev", "utf8");
      const lines = data.split("\n").slice(2);
      let rxBytes = 0;
      let txBytes = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("lo:")) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 10) continue;
        rxBytes += parseInt(parts[1], 10);
        txBytes += parseInt(parts[9], 10);
      }
      const rxMB = (rxBytes / (1024 * 1024)).toFixed(2);
      const txMB = (txBytes / (1024 * 1024)).toFixed(2);
      return `Rx: ${rxMB} MB, Tx: ${txMB} MB`;
    }
  } catch {
    return "N/A";
  }
}

async function getLoadAverage() {
  try {
    if (os.platform() === "win32") {
      const load = await si.currentLoad();
      return typeof load?.currentLoad === "number" ? load.currentLoad.toFixed(2) : "0.00";
    } else {
      return os.loadavg().map(l => l.toFixed(2)).join(", ");
    }
  } catch {
    return "N/A";
  }
}

async function getRunningProcesses() {
  try {
    const processes = await si.processes();
    if (processes && typeof processes.all !== "undefined") {
      return String(processes.all);
    }
    if (os.platform() !== "win32") {
      try {
        const dirs = await fsPromises.readdir("/proc");
        return dirs.filter(dir => /^\d+$/.test(dir)).length.toString();
      } catch {
        return "N/A";
      }
    }
    return "N/A";
  } catch {
    return "N/A";
  }
}

async function getTerminal() {
  try {
    if (os.platform() === "win32") {
      return process.env.ComSpec || "cmd.exe";
    }
    return process.env.SHELL || "/bin/sh";
  } catch {
    return "Unknown";
  }
}

export async function createBotInfoImage(botInfoInput, uptimeInput, botStatsInput, onConfigsInput, offConfigsInput) {
  ensureCanvasFontsRegistered();
  const botInfo = normalizeBotInfo(botInfoInput);
  const uptime = uptimeInput || formatUptime(process.uptime());
  const botStats = botStatsInput || {};
  const onConfigs = Array.isArray(onConfigsInput) ? onConfigsInput : [];
  const offConfigs = Array.isArray(offConfigsInput) ? offConfigsInput : [];

  let width = 1400;
  let height = 0;

  const kernelVersion = os.release() || "Unknown";
  const hostname = os.hostname() || "localhost";

  const [loadAverage, runningProcesses, osVersion, diskMetrics, networkUsage, terminal] = await Promise.all([
    getLoadAverage(),
    getRunningProcesses(),
    getWindowsVersion().catch(() => "Unknown"),
    getDiskMetrics(),
    botStats.network ? Promise.resolve(botStats.network) : getNetworkUsage(),
    getTerminal(),
  ]);

  const totalMemory = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  const freeMemory = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  const diskTotal = diskMetrics.total;

  const cpus = os.cpus() || [];
  const cpuCount = cpus.length || 1;
  const cpuModel = cpus[0]?.model || "Unknown";

  const systemFields = [
    { label: "🔢 Phiên bản:", value: botStats.version || "Unknown" },
    { label: "💾 Bộ nhớ bot:", value: botStats.memoryUsage || "Unknown" },
    { label: "💻 Hệ điều hành:", value: botStats.os || os.type() },
    { label: "📀 OS Version:", value: osVersion },
    { label: "🖥️ CPU Model:", value: botStats.cpuModel || cpuModel },
    { label: "🔢 CPU Count:", value: String(cpuCount) },
    { label: "⚡ CPU Usage:", value: botStats.cpu || "N/A" },
    { label: "🔢 Up Time OS:", value: botStats.uptimeOS || formatUptime(os.uptime()) },
    { label: "💿 Total Memory:", value: totalMemory },
  ];

  const resourceFields = [
    { label: "🌡️ CPU Temp:", value: botStats.cpuTemp || "36°C" },
    { label: "📈 RAM Usage:", value: botStats.ram || `${((os.totalmem() - os.freemem()) / (1024 * 1024 * 1024)).toFixed(2)} GB / ${totalMemory}` },
    { label: "💿 Free Memory:", value: freeMemory },
    { label: "💽 Disk Usage:", value: botStats.disk || diskMetrics.usage },
    { label: "💽 Disk Total:", value: diskTotal },
    { label: "🌐 Network:", value: botStats.network || networkUsage },
    { label: "📊 Load Average:", value: loadAverage },
  ];

  const networkFields = [
    { label: "🔄 Processes:", value: runningProcesses },
    { label: "🏠 Hostname:", value: hostname },
    { label: "🛠️ Kernel:", value: kernelVersion },
    { label: "🖴 Terminal:", value: terminal },
  ];

  const tempCanvas = createCanvas(1, 1);
  const tempCtx = tempCanvas.getContext("2d");

  let maxLeftWidth = 0;
  [systemFields, resourceFields, networkFields].forEach(fields => {
    fields.forEach(f => {
      const textWidth = measureTextWidth(tempCtx, `${f.label} ${f.value}`, "bold 28px BeVietnamPro");
      maxLeftWidth = Math.max(maxLeftWidth, textWidth);
    });
  });

  const leftColumnWidth = Math.max(500, maxLeftWidth + 120);

  let maxConfigWidth = 0;
  const configItemsForMeasure = onConfigs.length > 0 && offConfigs.length > 0 ? [...onConfigs, ...offConfigs] : onConfigs.length > 0 ? onConfigs : offConfigs;
  configItemsForMeasure.forEach(line => {
    const textWidth = measureTextWidth(tempCtx, `${line}: ✅`, "bold 22px BeVietnamPro");
    maxConfigWidth = Math.max(maxConfigWidth, textWidth);
  });

  const rightColumnWidth = onConfigs.length > 0 && offConfigs.length > 0 ? Math.max(650, maxConfigWidth * 2 + 180) : Math.max(450, maxConfigWidth + 120);
  width = leftColumnWidth + rightColumnWidth + 120;

  const headerH = 220;
  const headerY = 30;
  const sysBoxHeight = systemFields.length * 50 + 100;
  const resBoxHeight = resourceFields.length * 50 + 160;
  const netBoxHeight = networkFields.length * 50 + 100;

  const maxConfigItems = onConfigs.length > 0 && offConfigs.length > 0 ? Math.max(onConfigs.length, offConfigs.length) : onConfigs.length > 0 ? onConfigs.length : offConfigs.length;
  const cfgBoxHeight = onConfigs.length > 0 && offConfigs.length > 0 ? maxConfigItems * 40 + 130 : maxConfigItems * 55 + 140;

  const leftColumnHeight = sysBoxHeight + resBoxHeight + netBoxHeight + 90;
  const rightColumnHeight = cfgBoxHeight + 60;
  height = Math.max(headerY + headerH + 30 + leftColumnHeight, headerY + headerH + 30 + rightColumnHeight) + 90;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  let avatarLoaded = null;
  if (botInfo && isValidUrl(botInfo.avatar)) {
    try {
      avatarLoaded = await loadImage(botInfo.avatar);
    } catch {
      avatarLoaded = null;
    }
  }

  if (avatarLoaded) {
    try {
      ctx.globalAlpha = 0.7;
      ctx.drawImage(avatarLoaded, 0, 0, width, height);
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, width, height);
    } catch {
      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, "#0F2027");
      bg.addColorStop(0.5, "#203A43");
      bg.addColorStop(1, "#2C5364");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
    }
  } else {
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#0F2027");
    bg.addColorStop(0.5, "#203A43");
    bg.addColorStop(1, "#2C5364");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }

  const metallicGradient = ctx.createLinearGradient(0, 0, width, height);
  metallicGradient.addColorStop(0, "rgba(255,255,255,0.05)");
  metallicGradient.addColorStop(0.5, "rgba(255,255,255,0.1)");
  metallicGradient.addColorStop(1, "rgba(255,255,255,0.05)");
  ctx.fillStyle = metallicGradient;
  ctx.fillRect(0, 0, width, height);

  drawBox(ctx, 60, headerY, width - 120, headerH, "Bot Overview");

  const size = 140;
  const cx = 150;
  const cy = headerY + headerH / 2;
  const grad = ctx.createLinearGradient(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2);
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
  ctx.closePath();
  ctx.clip();
  if (avatarLoaded) {
    ctx.drawImage(avatarLoaded, cx - size / 2, cy - size / 2, size, size);
  } else {
    drawDefaultThumbnail(ctx, cx - size / 2, cy - size / 2, size);
  }
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
  ctx.font = "bold 48px BeVietnamPro";
  ctx.fillText(String(botInfo.displayName || botInfo.name || "Bot"), 300, headerY + 100);
  ctx.font = "bold 28px BeVietnamPro";
  ctx.fillText("Developer: </>Thanh Hung", 300, headerY + 140);
  ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
  ctx.fillText("Thời gian hoạt động: " + uptime, 300, headerY + 180);

  const leftColumnX = 60;

  const sysBoxY = headerY + headerH + 30;
  drawBox(ctx, leftColumnX, sysBoxY, leftColumnWidth, sysBoxHeight, "System Info");
  let ySys = sysBoxY + 100;
  const lineHeight = 50;
  systemFields.forEach(f => {
    ctx.textAlign = "left";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillText(f.label, leftColumnX + 40, ySys);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, ySys);
    ySys += lineHeight;
  });

  const resBoxY = sysBoxY + sysBoxHeight + 30;
  drawBox(ctx, leftColumnX, resBoxY, leftColumnWidth, resBoxHeight, "Resource Usage");
  let yRes = resBoxY + 90;
  resourceFields.forEach(f => {
    ctx.textAlign = "left";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.fillText(f.label, leftColumnX + 40, yRes);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, yRes);
    let percent = null;
    if (f.label.includes("CPU") && String(f.value).includes("%")) {
      percent = parseFloat(String(f.value).replace("%", "").trim());
    } else if (f.label.includes("RAM") && String(f.value).match(/(\d+(\.\d+)?)/g)) {
      const nums = String(f.value).match(/(\d+(\.\d+)?)/g).map(Number);
      if (nums.length >= 2 && nums[1] > 0) percent = (nums[0] / nums[1]) * 100;
    } else if (f.label.includes("Disk") && String(f.value).match(/(\d+(\.\d+)?)/g)) {
      const nums = String(f.value).match(/(\d+(\.\d+)?)/g).map(Number);
      if (nums.length >= 2 && nums[1] > 0) percent = (nums[0] / nums[1]) * 100;
    }

    if (percent !== null && !isNaN(percent)) {
      const barX = leftColumnX + 40;
      const barY = yRes + 10;
      const barW = leftColumnWidth - 80;
      const barH = 16;
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.fillRect(barX, barY, barW, barH);
      const barGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
      barGrad.addColorStop(0, "#4ECB71");
      barGrad.addColorStop(1, "#1E90FF");
      ctx.fillStyle = barGrad;
      const fillW = Math.max(0, Math.min(barW, (percent / 100) * barW));
      ctx.fillRect(barX, barY, fillW, barH);

      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 2;
      ctx.strokeRect(barX, barY, barW, barH);

      yRes += 30;
    }

    yRes += lineHeight;
  });

  const netBoxY = resBoxY + resBoxHeight + 30;
  drawBox(ctx, leftColumnX, netBoxY, leftColumnWidth, netBoxHeight, "Network Info");
  let yNet = netBoxY + 100;
  networkFields.forEach(f => {
    ctx.textAlign = "left";
    ctx.fillStyle = getRandomGradient ? getRandomGradient(ctx, leftColumnWidth) : "#ffffff";
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillText(f.label, leftColumnX + 40, yNet);
    ctx.textAlign = "right";
    ctx.fillText(String(f.value), leftColumnX + leftColumnWidth - 40, yNet);
    yNet += lineHeight;
  });

  const rightColumnX = leftColumnX + leftColumnWidth + 30;
  const configY = sysBoxY;
  if (onConfigs.length > 0 || offConfigs.length > 0) {
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
      offConfigs.forEach(line => {
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`${line}`, leftColX, yOff);
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
      onConfigs.forEach(line => {
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`${line}`, titleX, yOn);
        yOn += 40;
      });
    }
  }

  const filePath = createCanvasTempPath(`bot_info_${crypto.randomUUID()}.png`);
  const out = fs.createWriteStream(filePath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(filePath));
    out.on("error", reject);
  });
}

export async function clearImagePath(pathFile) {
  if (!pathFile) return;
  try {
    await fsPromises.unlink(pathFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Error deleting file:", error);
    }
  }
}
