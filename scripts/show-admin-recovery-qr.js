import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import jsQR from "jsqr";
import QRCode from "qrcode";

import { createAdminRecoveryChannel } from "../src/runtime/admin-recovery-channel.js";
import { openPathInDefaultApp } from "../src/platform/index.js";

const EXIT_OK = 0;
const EXIT_NO_ACTIVE_OR_EXPIRED = 2;
const EXIT_QR_UNREADABLE = 3;

export async function renderQrAscii(pngBuffer) {
  try {
    const { data, info } = await sharp(pngBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
    if (!decoded?.data) return null;
    return QRCode.toString(decoded.data, { type: "utf8" });
  } catch {
    return null;
  }
}

export async function main({
  projectRoot = path.resolve(fileURLToPath(import.meta.url), "..", ".."),
  stdout = process.stdout,
  open = (target) => openPathInDefaultApp(target, { windowsHide: false }),
  argv = process.argv.slice(2),
  now = () => Date.now(),
} = {}) {
  const write = (text) => stdout.write(text);
  const channel = createAdminRecoveryChannel({ projectRoot, now });
  const active = await channel.readActive();
  const finish = (exitCode) => ({ exitCode });

  if (!active) {
    // A channel pinned to the epoch treats any manifest as active; null there
    // means no artifact exists at all (idle), non-null means it exists but is
    // expired relative to the real clock.
    const epochChannel = createAdminRecoveryChannel({ projectRoot, now: () => 0 });
    const stale = await epochChannel.readActive();
    if (stale) {
      write(`[ADMIN-RECOVERY] Phiên khôi phục admin ĐÃ HẾT HẠN (hạn quét: ${stale.expiresAt}).\n`);
      write("[ADMIN-RECOVERY] Chờ producer xuất bản phiên mới hoặc kiểm tra dashboard http://localhost:4173.\n");
      return finish(EXIT_NO_ACTIVE_OR_EXPIRED);
    }
    write("[ADMIN-RECOVERY] Không có phiên khôi phục admin nào đang hoạt động (active.json không tồn tại).\n");
    write("[ADMIN-RECOVERY] Khi admin cần quét QR lại, dashboard sẽ tự mở modal; hoặc chạy lại recovery từ bot.\n");
    return finish(EXIT_NO_ACTIVE_OR_EXPIRED);
  }

  const pngBuffer = await channel.readQr(active.sessionId);
  if (!pngBuffer) {
    write(`[ADMIN-RECOVERY] Không đọc được tệp QR của phiên ${active.sessionId} (qr.png không tồn tại hoặc lỗi I/O).\n`);
    write("[ADMIN-RECOVERY] Phiên vẫn còn trong manifest nhưng ảnh QR đã mất - hãy đợi producer xuất bản lại.\n");
    return finish(EXIT_QR_UNREADABLE);
  }

  write(`[ADMIN-RECOVERY] Phiên khôi phục admin: ${active.sessionId} (trạng thái: ${active.state})\n`);
  write(`[ADMIN-RECOVERY] Hạn quét (expiresAt): ${active.expiresAt}\n`);

  const ascii = await renderQrAscii(pngBuffer);
  if (!ascii) {
    write("[ADMIN-RECOVERY] Không hiển thị QR ASCII được - dùng cờ --open để mở ảnh QR gốc.\n");
    return finish(EXIT_QR_UNREADABLE);
  }
  write(ascii);

  if (argv.includes("--open")) {
    const tempPngPath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "admin-recovery-qr-")),
      `admin-recovery-qr-${active.sessionId}.png`
    );
    await fs.writeFile(tempPngPath, pngBuffer);
    let opened = false;
    try {
      opened = (await open(tempPngPath, { windowsHide: false })) !== false;
    } catch {
      opened = false;
    }
    if (opened) {
      write(`[ADMIN-RECOVERY] Đã mở ảnh QR trong ứng dụng mặc định: ${tempPngPath}\n`);
    } else {
      write(`[ADMIN-RECOVERY] Không mở được ứng dụng mặc định; ảnh QR tạm thời tại: ${tempPngPath}\n`);
    }
  } else {
    write("[ADMIN-RECOVERY] Mẹo: chạy 'npm run admin:recovery:show -- --open' để mở ảnh QR trong phiên RDP.\n");
  }

  return finish(EXIT_OK);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { exitCode } = await main();
  process.exitCode = exitCode;
}

export default main;
