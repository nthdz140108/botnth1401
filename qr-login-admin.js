import { authenticateZalo } from "./src/commands/mybot/Credentials/qr-login.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import sharp from "sharp";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { Zalo } from "./src/api-zalo/zalo.js";
import { selectLoginIdentity } from "./src/commands/mybot/System/login-identity.js";
import { getZaloCookiePayload, getZaloRuntimeConfig } from "./src/api-zalo/zalo-config.js";
import { openPathInDefaultApp } from "./src/platform/index.js";
import { printRuntimeFingerprint } from "./src/bootstrap.js";
import { getProjectRoot } from "./src/utils/env.js";
import { createAdminRecoveryChannel } from "./src/runtime/admin-recovery-channel.js";
import {
  isInteractiveRecoveryLaunch,
  presentAdminRecoveryQr,
} from "./src/runtime/admin-recovery-presentation.js";
import { openDesktopQrPopup } from "./src/runtime/admin-recovery-watcher.js";
import { installWindowsConsoleSafety } from "./src/runtime/windows-console-guard.js";

const PROJECT_ROOT = getProjectRoot();
const CONFIG_PATH = path.join(PROJECT_ROOT, "assets", "config.json");
const STATE_PATH = path.join(PROJECT_ROOT, "mybot", "state", "admin.json");
const COOKIE_DEAD_EXIT_CODE = 12;
const UID_MISMATCH_EXIT_CODE = 13;
const QR_CHANNEL_EXPIRY_MS = 90_000;

async function readJson(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function findBrowserExecutable() {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
        process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
        "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      ].filter(Boolean)
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ];

  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export async function printTerminalQr(filePath, base64Image) {
  try {
    let imgBuffer = null;
    if (base64Image) {
      const cleanBase64 = String(base64Image).replace(/^data:image\/\w+;base64,/, "");
      imgBuffer = Buffer.from(cleanBase64, "base64");
    } else if (filePath && fsSync.existsSync(filePath)) {
      imgBuffer = await fs.readFile(filePath);
    }
    if (!imgBuffer) return false;

    const { data, info } = await sharp(imgBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const qrResult = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    if (qrResult?.data) {
      const ascii = await QRCode.toString(qrResult.data, { type: "terminal", small: true });
      console.log("\n============================================================");
      console.log("  QUÉT MÃ QR DƯỚI ĐÂY BẰNG APP ZALO ĐỂ ĐĂNG NHẬP ADMIN");
      console.log("============================================================");
      console.log(ascii);
      console.log("============================================================\n");
      return true;
    }
  } catch (err) {
    // Terminal rendering is optional; ignore failures
  }
  return false;
}

export async function createQrHtml(filePath, base64Image) {
  const absPath = path.resolve(filePath);
  const fileUrl = pathToFileURL(absPath).href;
  const htmlPath = path.join(path.dirname(absPath), "qr-login-admin.html");
  const imgSrc = base64Image
    ? (base64Image.startsWith("data:") ? base64Image : `data:image/png;base64,${base64Image}`)
    : fileUrl;

  const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zalo Admin QR Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: rgba(30, 41, 59, 0.85);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 28px 36px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      max-width: 440px;
      width: 100%;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #38bdf8;
      margin-bottom: 8px;
    }
    p.subtitle {
      font-size: 13px;
      color: #94a3b8;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .qr-container {
      background: #ffffff;
      padding: 14px;
      border-radius: 16px;
      display: inline-block;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
      margin-bottom: 18px;
    }
    .qr-container img {
      width: 240px;
      height: 240px;
      display: block;
      object-fit: contain;
    }
    .instructions {
      background: rgba(15, 23, 42, 0.6);
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.6;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 14px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: #38bdf8;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.4); opacity: 0.4; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge"><span class="pulse-dot"></span> Admin Recovery</div>
    <h1>Đăng nhập Zalo Admin</h1>
    <p class="subtitle">Cookie admin hết hạn hoặc chưa đăng nhập. Quét mã QR để tiếp tục.</p>
    <div class="qr-container">
      <img src="${imgSrc}" alt="Zalo QR Code" />
    </div>
    <div class="instructions">
      📱 Mở app <b>Zalo</b> &gt; Chọn biểu tượng <b>Quét QR</b> &gt; Quét mã trên màn hình &gt; Nhấn <b>Đăng nhập</b>
    </div>
  </div>
</body>
</html>`;

  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, htmlContent, "utf8");
  return { htmlPath, htmlUrl: pathToFileURL(htmlPath).href };
}

async function openManagedQrWindow(filePath, base64Image) {
  // 1. Output QR in terminal first
  await printTerminalQr(filePath, base64Image);

  // 2. Resolve PNG bytes and open desktop popup (Chromium --app, Windows mshta.exe, or default viewer)
  let pngBuffer = null;
  if (base64Image) {
    const cleanBase64 = String(base64Image).replace(/^data:image\/\w+;base64,/, "");
    pngBuffer = Buffer.from(cleanBase64, "base64");
  } else if (filePath && fsSync.existsSync(filePath)) {
    pngBuffer = await fs.readFile(filePath);
  }

  if (pngBuffer && pngBuffer.length > 0) {
    const popup = await openDesktopQrPopup({
      projectRoot: PROJECT_ROOT,
      sessionId: activeRecoverySessionId || Date.now(),
      pngBuffer,
    });
    return {
      type: popup.kind,
      close: async () => {
        popup.close?.();
      },
    };
  }

  const { htmlPath } = await createQrHtml(filePath, base64Image);
  const absPath = path.resolve(filePath);
  try {
    openPathInDefaultApp(htmlPath, { windowsHide: false });
  } catch {
    openPathInDefaultApp(absPath, { windowsHide: false });
  }

  return {
    type: "default-app",
    close: async () => {}
  };
}

function isManagedRecoveryProcess(env = process.env) {
  return String(env?.BOT_MANAGED ?? "").toLowerCase() === "true";
}

let activeRecoveryChannel = null;
let activeRecoverySessionId = null;
let recoveryCleanupDone = false;

function getAdminRecoveryChannel() {
  if (!activeRecoveryChannel) {
    activeRecoveryChannel = createAdminRecoveryChannel({ projectRoot: PROJECT_ROOT });
  }
  return activeRecoveryChannel;
}

async function finalizeRecoverySession(finalState) {
  if (recoveryCleanupDone || !activeRecoverySessionId) return;
  recoveryCleanupDone = true;
  try {
    await getAdminRecoveryChannel().cleanup(activeRecoverySessionId, finalState);
  } catch {}
}

async function main() {
  installWindowsConsoleSafety();
  printRuntimeFingerprint({ entrypoint: "qr-login-admin.js", botName: "admin" });
  console.log("=== QR Login cho Admin Bot ===");
  console.log("Đang khởi tạo mã QR đăng nhập...");
  console.log("");

  const managed = isManagedRecoveryProcess();
  const interactive = isInteractiveRecoveryLaunch({ env: process.env, stdout: process.stdout, platform: process.platform });

  let qrHandle = null;
  const closeBrowser = async () => {
    if (qrHandle) {
      try {
        await qrHandle.close();
      } catch {}
      qrHandle = null;
    }
  };

  const onSignalExit = () => {
    // Synchronous best-effort: remove the published artifact so the dashboard
    // does not advertise a recovery that will never complete.
    finalizeRecoverySession("cancelled");
  };
  process.on("SIGINT", onSignalExit);
  process.on("SIGTERM", onSignalExit);

  const authResult = await authenticateZalo({
    onQrReady: async (filePath, data) => {
      await closeBrowser();
      try {
        const base64Image = data?.data?.image || "";
        const presentation = await presentAdminRecoveryQr({
          filePath,
          base64Image,
          channel: getAdminRecoveryChannel(),
          managed,
          expiresAt: new Date(Date.now() + QR_CHANNEL_EXPIRY_MS).toISOString(),
          ownerPid: process.pid,
          openWindow: managed || !interactive ? undefined : async () => {
            qrHandle = await openManagedQrWindow(filePath, base64Image);
            return qrHandle;
          },
        });
        activeRecoverySessionId = presentation.sessionId || activeRecoverySessionId;
        recoveryCleanupDone = false;
      } catch (err) {
        console.error(`[QR-ADMIN] Không thể publish QR vào recovery channel: ${err.message}`);
      }
    },
    onStatus: (status) => {
      if (!activeRecoverySessionId) return;
      if (status === "waiting_confirm" || status === "generating_qr") {
        const target = status === "waiting_confirm" ? "waiting_confirm" : "waiting_scan";
        getAdminRecoveryChannel()
          .transition(activeRecoverySessionId, target)
          .catch(() => {});
      }
    },
  });
  const { session, rawCookies, resultData } = authResult;

  try {
    if (!authResult.success || !session || !rawCookies || !resultData) {
      console.error("QR login thất bại hoặc bị hủy.");
      await closeBrowser();
      const terminalState = authResult.expired ? "expired" : authResult.cancelled ? "cancelled" : "failed";
      await finalizeRecoverySession(terminalState);
      process.exit(authResult.cancelled ? COOKIE_DEAD_EXIT_CODE : 1);
    }

    const credentials = {
      cookie: getZaloCookiePayload(rawCookies),
      imei: resultData.imei,
      userAgent: resultData.userAgent || getZaloRuntimeConfig().userAgent,
    };
    const zalo = new Zalo(credentials, { selfListen: true, checkUpdate: false });
    const api = await zalo.login();
    api.assertReady();
    const userInfo = typeof api.getUserInfo === "function" ? await api.getUserInfo(zalo.userId) : null;
    const identity = selectLoginIdentity({
      sdkUid: zalo.userId,
      userInfo,
      resultData,
      fallbackName: resultData.name || "Admin Bot",
      fallbackAvatar: resultData.avatar || "",
    });
    const actualUid = identity.uid;
    const botName = identity.displayName || "Admin Bot";
    const botAvatar = identity.avatar || "";
    const currentState = await readJson(STATE_PATH, {});
    const expectedUid = String(currentState.uid || "").trim();

    console.log(`[QR-ADMIN] SDK UID=${actualUid || "unknown"} | expected admin UID=${expectedUid || "none"}`);

    if (!actualUid) {
      console.error("[QR-ADMIN] Không xác định được UID sau QR login, dừng tiến trình.");
      throw new Error("Không xác định được UID admin từ Zalo SDK sau khi đăng nhập QR.");
    }

    if (expectedUid && actualUid && expectedUid !== actualUid) {
      console.error(`[QR-ADMIN] QR login trùng tài khoản admin. expected=${expectedUid}, actual=${actualUid}`);
      console.error("[QR-ADMIN] Dừng ở terminal thay vì chạy ẩn.");
      await closeBrowser();
      await finalizeRecoverySession("failed");
      process.exit(UID_MISMATCH_EXIT_CODE);
    }

    const config = await readJson(CONFIG_PATH, {});
    config.cookie = getZaloCookiePayload(rawCookies);
    config.imei = resultData.imei;
    config.name = botName;
    config.avatar = botAvatar;
    await writeJsonAtomic(CONFIG_PATH, config);

    const nextState = {
      ...currentState,
      uid: actualUid || expectedUid || currentState.uid,
      cookieDead: false,
      cookieDeadAt: null,
      cookieDeadReason: null,
      lastQrLoginAt: new Date().toISOString(),
    };
    delete nextState.pid;
    delete nextState.timestamp;
    await writeJsonAtomic(STATE_PATH, nextState);
    try {
      api.listener?.ws?.close?.();
    } catch {}

    await closeBrowser();
    await finalizeRecoverySession("success");
    console.log("");
    console.log("Đã cập nhật assets/config.json thành công!");
    console.log(`   UID: ${nextState.uid || "unknown"}`);
    console.log(`   Tên tài khoản: ${botName}`);
    process.exit(0);
  } catch (err) {
    await closeBrowser();
    await finalizeRecoverySession("failed");
    console.error("Lỗi:", err.message);
    process.exit(1);
  }
}

const isDirectCli = Boolean(
  process.argv[1] &&
  (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href ||
   path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
);

if (isDirectCli) {
  process.on("SIGINT", () => {
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    process.exit(1);
  });

  main().catch((err) => {
    console.error("Lỗi:", err.message);
    process.exit(1);
  });
}
