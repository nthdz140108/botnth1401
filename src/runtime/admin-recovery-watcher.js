import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import jsQR from "jsqr";
import QRCode from "qrcode";

import { createAdminRecoveryChannel } from "./admin-recovery-channel.js";
import { isLegacyWindowsConsole } from "./windows-console-guard.js";
import { openPathInDefaultApp } from "../platform/index.js";

function findChromiumBrowserExecutable() {
  if (process.platform !== "win32") return null;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function findMshtaExecutable() {
  if (process.platform !== "win32") return null;
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(sysRoot, "System32", "mshta.exe");
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return null;
}

async function renderTerminalAsciiQr(pngBuffer) {
  try {
    const { data, info } = await sharp(pngBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    if (!decoded?.data) return null;
    return await QRCode.toString(decoded.data, { type: "terminal", small: true });
  } catch {
    return null;
  }
}

function buildQrPopupMarkup({ imgSrc, fallbackImgSrc = "", isHta = false }) {
  const htaTag = isHta
    ? `<hta:application id="ZaloAdminQR" applicationname="ZaloAdminQR" border="dialog" maximizebutton="no" minimizebutton="yes" scroll="auto" singleinstance="yes" windowstate="normal" />`
    : "";
  const resizeScript = isHta
    ? `<script>try { window.resizeTo(500, 680); window.moveTo(Math.max(0, Math.floor((screen.availWidth - 500) / 2)), Math.max(0, Math.floor((screen.availHeight - 680) / 2))); window.focus(); } catch (e) {}</script>`
    : "";
  const onErrorAttr = fallbackImgSrc
    ? ` onerror="this.onerror=null;this.src='${fallbackImgSrc}';"`
    : "";

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Zalo Admin QR Recovery</title>
  ${htaTag}
  <meta http-equiv="X-UA-Compatible" content="${isHta ? "IE=9" : "IE=edge"}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      padding: 20px;
      text-align: center;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 18px;
      padding: 24px 26px;
      max-width: 420px;
      width: 100%;
      margin: 0 auto;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 999px;
      background: #0ea5e9;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #38bdf8;
      margin-bottom: 8px;
    }
    p.subtitle {
      font-size: 13px;
      color: #cbd5e1;
      margin-bottom: 16px;
      line-height: 1.45;
    }
    .qr-box {
      background: #ffffff;
      padding: 14px;
      border-radius: 14px;
      display: inline-block;
      margin-bottom: 16px;
    }
    .qr-box img {
      width: 240px;
      height: 240px;
      display: block;
      border: 0;
    }
    .guide {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 12px;
      font-size: 13px;
      color: #e2e8f0;
      line-height: 1.55;
    }
  </style>
  ${resizeScript}
</head>
<body>
  <div class="card">
    <div class="badge">ADMIN RECOVERY</div>
    <h1>Đăng Nhập Zalo Admin</h1>
    <p class="subtitle">Chưa có cookie hoặc phiên đăng nhập hết hạn. Quét mã QR bên dưới để tự động chạy bot.</p>
    <div class="qr-box">
      <img src="${imgSrc}"${onErrorAttr} alt="Zalo Admin QR" />
    </div>
    <div class="guide">
      Mở ứng dụng <b>Zalo</b> trên điện thoại &gt; Chọn <b>Quét mã QR</b> &gt; Quét mã này và bấm <b>Đăng nhập</b>.<br/>
      (Cửa sổ sẽ tự đóng sau khi đăng nhập thành công)
    </div>
  </div>
</body>
</html>`;
}

export async function openDesktopQrPopup({ projectRoot, sessionId, pngBuffer }) {
  const popupDir = path.join(projectRoot, ".runtime", "temp", "admin-qr-popup");
  await fsPromises.mkdir(popupDir, { recursive: true });

  const safeSession = String(sessionId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, "_");
  const pngPath = path.join(popupDir, `qr-${safeSession}.png`);
  await fsPromises.writeFile(pngPath, pngBuffer);

  // 1. Chromium-based browser (--app mode) if installed
  const browserExe = findChromiumBrowserExecutable();
  if (browserExe) {
    try {
      const htmlPath = path.join(popupDir, `qr-${safeSession}.html`);
      const base64Src = `data:image/png;base64,${pngBuffer.toString("base64")}`;
      await fsPromises.writeFile(htmlPath, buildQrPopupMarkup({ imgSrc: base64Src, isHta: false }), "utf8");
      const child = spawn(browserExe, [`--app=${pathToFileURL(htmlPath).href}`, "--window-size=480,670"], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", () => {});
      child.unref?.();
      return {
        kind: "chromium-app",
        close: () => {
          try { child.kill(); } catch {}
        },
      };
    } catch {}
  }

  // 2. Native Windows Server 2012 R2+ HTA popup (mshta.exe — built into Windows, bypasses IE ESC!)
  const mshtaExe = findMshtaExecutable();
  if (mshtaExe) {
    try {
      const htaPath = path.join(popupDir, `qr-${safeSession}.hta`);
      const fileImgUrl = pathToFileURL(pngPath).href;
      const base64Src = `data:image/png;base64,${pngBuffer.toString("base64")}`;
      await fsPromises.writeFile(
        htaPath,
        buildQrPopupMarkup({ imgSrc: fileImgUrl, fallbackImgSrc: base64Src, isHta: true }),
        "utf8"
      );
      const child = spawn(mshtaExe, [htaPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      let spawnFailed = false;
      child.on("error", () => {
        spawnFailed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!spawnFailed && child.exitCode === null) {
        child.unref?.();
        return {
          kind: "mshta",
          close: () => {
            try {
              if (child.pid) {
                const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                  stdio: "ignore",
                  windowsHide: true,
                });
                killer.on("error", () => {});
                killer.unref?.();
              }
            } catch {}
          },
        };
      }
    } catch {}
  }

  // 3. Fallback: open PNG in default image viewer
  try {
    openPathInDefaultApp(pngPath, { windowsHide: false });
  } catch {}
  return {
    kind: "default-viewer",
    close: () => {},
  };
}

/**
 * Watches `.runtime/admin-recovery/active.json` from an interactive foreground
 * console (such as `run.bat` -> `reconcile-and-monitor.js`) and automatically
 * pops up the desktop QR window + prints terminal ASCII QR whenever the PM2
 * `admin` process requests QR recovery.
 */
export function startInteractiveAdminRecoveryWatcher({
  projectRoot,
  pollIntervalMs = 1000,
  channel = null,
  onShowQr = null,
  log = (msg) => console.log(msg),
} = {}) {
  const recoveryChannel = channel || createAdminRecoveryChannel({ projectRoot });
  let lastShownSessionId = null;
  let activePopup = null;
  let polling = false;
  let stopped = false;

  const closeActivePopup = () => {
    if (activePopup) {
      try { activePopup.close?.(); } catch {}
      activePopup = null;
    }
  };

  const showQrImpl = onShowQr || (async ({ sessionId, expiresAt, pngBuffer }) => {
    const ascii = isLegacyWindowsConsole() ? null : await renderTerminalAsciiQr(pngBuffer);
    log("");
    log("============================================================");
    log("  [ADMIN RECOVERY] CAN QUET MA QR ZALO DE DANG NHAP BOT ADMIN");
    log("============================================================");
    if (ascii) {
      log(ascii);
    }
    log(`  Phien QR : ${sessionId}`);
    log(`  Het han  : ${expiresAt}`);
    log("  Web UI   : http://localhost:4173 (tai khoan trong .runtime\\dashboard-credentials.txt)");
    log("  -> Dang tu dong bat cua so ma QR tren man hinh VPS...");
    log("============================================================");
    log("");
    return openDesktopQrPopup({ projectRoot, sessionId, pngBuffer });
  });

  const tick = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const active = await recoveryChannel.readActive();
      if (!active || !active.sessionId) {
        if (lastShownSessionId !== null) {
          closeActivePopup();
          lastShownSessionId = null;
        }
        return;
      }

      if (active.sessionId === lastShownSessionId) {
        return;
      }

      const pngBuffer = await recoveryChannel.readQr(active.sessionId);
      if (!pngBuffer || pngBuffer.length === 0) {
        return;
      }

      closeActivePopup();
      lastShownSessionId = active.sessionId;
      activePopup = await showQrImpl({
        sessionId: active.sessionId,
        state: active.state,
        expiresAt: active.expiresAt,
        pngBuffer,
      });
    } catch {
      // Watcher is best-effort and must never crash reconcile/monitor
    } finally {
      polling = false;
    }
  };

  // Trigger an immediate check plus periodic background poll
  void tick();
  const timer = setInterval(tick, pollIntervalMs);
  timer.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
      closeActivePopup();
    },
  };
}

export default startInteractiveAdminRecoveryWatcher;
