import fs from "node:fs/promises";
import process from "node:process";

const QR_CHANNEL_EXPIRY_MS = 90_000;

export function isInteractiveRecoveryLaunch({ env = process.env, stdout = process.stdout, platform = process.platform } = {}) {
  if (String(env?.BOT_MANAGED ?? "").toLowerCase() === "true") return false;
  return Boolean(stdout && stdout.isTTY);
}

function resolveQrImageBuffer({ filePath, base64Image }) {
  if (base64Image) {
    const cleanBase64 = String(base64Image).replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(cleanBase64, "base64");
  }
  if (filePath) {
    return fs.readFile(filePath);
  }
  return null;
}

export async function presentAdminRecoveryQr({
  filePath,
  base64Image,
  channel,
  managed,
  openWindow,
  expiresAt,
  ownerPid = process.pid,
  log = (message) => console.log(message),
} = {}) {
  if (!channel || typeof channel.publishQr !== "function") {
    return { sessionId: null, presentation: "none" };
  }

  const imageBuffer = await resolveQrImageBuffer({ filePath, base64Image });
  if (!Buffer.isBuffer(imageBuffer)) {
    return { sessionId: null, presentation: "none" };
  }

  const effectiveExpiresAt = expiresAt || new Date(Date.now() + QR_CHANNEL_EXPIRY_MS).toISOString();
  const published = await channel.publishQr({
    imageBuffer,
    expiresAt: effectiveExpiresAt,
    ownerPid,
  });
  const sessionId = published?.sessionId || null;

  if (sessionId && typeof log === "function") {
    const expiryText = published?.expiresAt || effectiveExpiresAt;
    log(`[QR-ADMIN] Recovery QR published: sessionId=${sessionId} | expiresAt=${expiryText} | dashboard: GET /api/system/admin-recovery (after login) | CLI: npm run admin:recovery:show`);
  }

  if (managed) {
    return { sessionId, presentation: "channel", published };
  }

  if (typeof openWindow === "function") {
    try {
      const window = await openWindow();
      if (window) {
        return { sessionId, presentation: "channel", published, window };
      }
    } catch (error) {
      // Popup is best-effort only: the published channel artifact keeps the
      // recovery visible, so a GUI failure must not fail authentication.
      if (typeof log === "function") {
        log(`[QR-ADMIN] Không thể mở cửa sổ QR GUI (${error?.message || error}). QR vẫn khả dụng qua recovery channel.`);
      }
    }
  }

  return { sessionId, presentation: "channel", published };
}

export default presentAdminRecoveryQr;
