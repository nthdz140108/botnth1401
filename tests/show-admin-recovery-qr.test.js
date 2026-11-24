import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import jsQR from "jsqr";

import { createAdminRecoveryChannel } from "../src/runtime/admin-recovery-channel.js";
import { main as runCli, renderQrAscii } from "../scripts/show-admin-recovery-qr.js";

const BLOCK_CHARS = new Set(["\u2588", "\u2580", "\u2584"]);
const QUIET_ZONE_MODULES = 4;

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function createCaptureStdout() {
  const chunks = [];
  return {
    chunks,
    write(text) {
      chunks.push(String(text));
    },
    text() {
      return chunks.join("");
    },
  };
}

function createOpenSpy() {
  const calls = [];
  const open = (target, options) => {
    calls.push({ target: String(target), options: { ...options } });
    return true;
  };
  open.calls = calls;
  return open;
}

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "admin-recovery-cli-"));
}

async function publishQrFixture(channel, payload, expiresAt) {
  const pngBuffer = await QRCode.toBuffer(payload);
  const published = await channel.publishQr({
    imageBuffer: pngBuffer,
    expiresAt: expiresAt || new Date(Date.now() + 90_000).toISOString(),
    ownerPid: process.pid,
  });
  return { published, pngBuffer };
}

// Renders the CLI's ASCII QR art back to a raw bitmap (white quiet zone included)
// and decodes it with jsQR. Returns the decoded payload or null.
function decodeAsciiQrToPayload(asciiArt) {
  const lines = stripAnsi(asciiArt).split("\n").map((line) => line.replace(/\r/g, ""));
  const isBlockLine = (line) => [...line].some((ch) => BLOCK_CHARS.has(ch));
  const content = lines.filter(isBlockLine);
  if (content.length === 0) return null;

  const widths = new Set(content.map((line) => [...line].length));
  assert.equal(widths.size, 1, "every ASCII QR content line must have the same width");

  let minX = Infinity;
  let maxX = -1;
  for (const line of content) {
    [...line].forEach((ch, i) => {
      if (BLOCK_CHARS.has(ch)) {
        if (i < minX) minX = i;
        if (i > maxX) maxX = i;
      }
    });
  }
  const gridWidth = maxX - minX + 1;
  const gridHeight = content.length * 2;
  assert.ok(gridWidth >= 21 && gridHeight >= 21, "ASCII QR grid must be at least 21x21 modules");

  const stride = gridWidth + QUIET_ZONE_MODULES * 2;
  const totalHeight = gridHeight + QUIET_ZONE_MODULES * 2;
  const px = new Uint8ClampedArray(stride * totalHeight * 4).fill(255);
  for (let y = 0; y < gridHeight; y++) {
    const chars = [...content[Math.floor(y / 2)]];
    for (let x = 0; x < gridWidth; x++) {
      const ch = chars[minX + x] || " ";
      const dark = y % 2 === 0
        ? (ch === "\u2588" || ch === "\u2580")
        : (ch === "\u2588" || ch === "\u2584");
      if (!dark) continue;
      const offset = ((y + QUIET_ZONE_MODULES) * stride + (x + QUIET_ZONE_MODULES)) * 4;
      px[offset] = 0;
      px[offset + 1] = 0;
      px[offset + 2] = 0;
      px[offset + 3] = 255;
    }
  }
  const result = jsQR(px, stride, totalHeight);
  return result ? result.data : null;
}

test("renderQrAscii decodes a QR PNG buffer into decodable terminal ASCII art", async () => {
  const payload = "https://id.zalo.me/account/authen/qr?code=render-qr-ascii-0001";
  const pngBuffer = await QRCode.toBuffer(payload);

  const ascii = await renderQrAscii(pngBuffer);
  assert.ok(typeof ascii === "string" && ascii.length > 0, "renderQrAscii must return ASCII art");
  assert.ok([...ascii].some((ch) => BLOCK_CHARS.has(ch)), "ASCII art must contain block characters");
  assert.equal(decodeAsciiQrToPayload(ascii), payload);
});

test("renderQrAscii returns null for a buffer that is not a QR PNG", async () => {
  assert.equal(await renderQrAscii(Buffer.from("definitely not a png")), null);
  assert.equal(await renderQrAscii(Buffer.alloc(0)), null);
});

test("idle channel: exits 2 with a clear message and never opens the default app", async () => {
  const tempRoot = await createTempRoot();
  const stdout = createCaptureStdout();
  const open = createOpenSpy();

  const result = await runCli({ projectRoot: tempRoot, stdout, open, argv: [] });

  assert.equal(result.exitCode, 2);
  assert.equal(open.calls.length, 0, "idle run must not open anything");
  assert.match(stdout.text(), /không có phiên khôi phục admin/i);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("active session: prints decodable ASCII QR plus session id and expiry", async () => {
  const tempRoot = await createTempRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const payload = "https://id.zalo.me/account/authen/qr?code=cli-active-session-0001";
  const { published } = await publishQrFixture(channel, payload);
  const stdout = createCaptureStdout();
  const open = createOpenSpy();

  const result = await runCli({ projectRoot: tempRoot, stdout, open, argv: [] });

  assert.equal(result.exitCode, 0);
  assert.equal(open.calls.length, 0, "without --open the default app must never be opened");
  const text = stripAnsi(stdout.text());
  assert.ok(text.includes(published.sessionId), "output must include the session id");
  assert.ok(text.includes(published.expiresAt), "output must include the expiry timestamp");
  assert.equal(
    decodeAsciiQrToPayload(stdout.text()),
    payload,
    "printed ASCII QR must decode back to the published QR payload"
  );
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("--open: opens the QR PNG file exactly once with windowsHide false", async () => {
  const tempRoot = await createTempRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const payload = "https://id.zalo.me/account/authen/qr?code=cli-open-flag-0002";
  const { published, pngBuffer } = await publishQrFixture(channel, payload);
  const stdout = createCaptureStdout();
  const open = createOpenSpy();

  const result = await runCli({ projectRoot: tempRoot, stdout, open, argv: ["--open"] });

  assert.equal(result.exitCode, 0);
  assert.equal(open.calls.length, 1, "--open must invoke the open function exactly once");
  const { target, options } = open.calls[0];
  assert.equal(options.windowsHide, false, "open must be called with windowsHide: false");
  assert.ok(target.endsWith(".png"), "open must receive the QR PNG file path");
  assert.ok(target.includes(published.sessionId), "opened file must belong to the active session");
  assert.ok(fsSync.existsSync(target), "opened QR file must exist on disk");
  const saved = await fs.readFile(target);
  assert.equal(saved.equals(pngBuffer), true, "opened file must contain the published QR PNG bytes");
  await fs.rm(target, { force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("expired session: exits 2, explains expiry, and never opens anything", async () => {
  const tempRoot = await createTempRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const payload = "https://id.zalo.me/account/authen/qr?code=cli-expired-session-0003";
  await publishQrFixture(channel, payload, new Date(Date.now() + 60_000).toISOString());
  const stdout = createCaptureStdout();
  const open = createOpenSpy();

  const result = await runCli({
    projectRoot: tempRoot,
    stdout,
    open,
    argv: ["--open"],
    now: () => Date.now() + 91_000,
  });

  assert.equal(result.exitCode, 2);
  assert.equal(open.calls.length, 0, "expired session must never open the default app");
  assert.match(stdout.text(), /hết hạn|expired/i);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("missing QR PNG file: exits 3, explains the problem, and never opens anything", async () => {
  const tempRoot = await createTempRoot();
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const payload = "https://id.zalo.me/account/authen/qr?code=cli-missing-png-0004";
  const { published } = await publishQrFixture(channel, payload);
  await fs.rm(path.join(tempRoot, ".runtime", "admin-recovery", "sessions", published.sessionId, "qr.png"));
  const stdout = createCaptureStdout();
  const open = createOpenSpy();

  const result = await runCli({ projectRoot: tempRoot, stdout, open, argv: ["--open"] });

  assert.equal(result.exitCode, 3);
  assert.equal(open.calls.length, 0, "missing PNG must never open the default app");
  assert.match(stdout.text(), /không đọc được|QR/i);
  await fs.rm(tempRoot, { recursive: true, force: true });
});
