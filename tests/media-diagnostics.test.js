import test from "node:test";
import assert from "node:assert/strict";
import { isFfmpegMissingError } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/encode.js";
import { isToolMissingError } from "../src/service-debug/chat-zalo/chat-special/send-video/video-media-prepare.js";
import {
  handleVideoCommand,
  sendLocalVideoWithFallback,
  VideoSourceEmptyError,
  VideoToolMissingError,
} from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";
import { redactSecret } from "../scripts/diagnose-vps.js";
import { execFileSync } from "node:child_process";

test("isFfmpegMissingError recognizes exit code 3221225785 and 0xC0000139 (Windows Server 2012 R2)", () => {
  // Numeric exit code
  assert.equal(isFfmpegMissingError({ code: 3221225785 }), true);
  assert.equal(isFfmpegMissingError({ status: 3221225785 }), true);
  assert.equal(isFfmpegMissingError({ exitCode: 3221225785 }), true);

  // String exit code / message
  assert.equal(isFfmpegMissingError({ message: "Command failed with code 3221225785" }), true);
  assert.equal(isFfmpegMissingError({ message: "STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)" }), true);
  assert.equal(isFfmpegMissingError({ code: "0xC0000139" }), true);
  assert.equal(isFfmpegMissingError({ code: "ENTRYPOINT_NOT_FOUND" }), true);

  // Standard missing binary
  assert.equal(isFfmpegMissingError({ code: "ENOENT" }), true);

  // Non-missing / normal errors
  assert.equal(isFfmpegMissingError(new Error("Invalid frame")), false);
  assert.equal(isFfmpegMissingError(null), false);
});

test("isToolMissingError recognizes entry point crash 3221225785 in video prepare tools", () => {
  assert.equal(isToolMissingError({ code: 3221225785 }), true);
  assert.equal(isToolMissingError({ status: 3221225785 }), true);
  assert.equal(isToolMissingError({ message: "3221225785: Entry point not found" }), true);
  assert.equal(isToolMissingError({ message: "0xC0000139" }), true);
  assert.equal(isToolMissingError({ code: "ENOENT" }), true);
  assert.equal(isToolMissingError(new Error("Corrupted stream")), false);
});

test("handleVideoCommand detects empty local pool and notifies user with pool path", async () => {
  const sentMessages = [];
  const fakeApi = {
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ msg: payload.msg, threadId, type });
      return { ok: true };
    },
  };

  const message = { threadId: "t-video-diag", type: 1, data: { content: "vdgirl" } };

  // When checkout has 0 mp4 files in video/vdgirl:
  await handleVideoCommand(fakeApi, message, "girl");

  assert.ok(sentMessages.length >= 1, "Should send empty source notification");
  const msg = sentMessages[0].msg;
  assert.ok(
    msg.includes("trống") || msg.includes("thiếu") || msg.includes("bổ sung file .mp4"),
    `Expected empty message hint, got: ${msg}`
  );
  assert.ok(msg.includes("vdgirl"), `Should specify the pool source name, got: ${msg}`);
});

test("sendLocalVideoWithFallback distinguishes tool-missing (0xC0000139) vs video-upload vs delivery errors", async () => {
  const fakeApi = {
    uploadAttachment: async () => {
      throw new Error("ETIMEDOUT: Connection reset by peer");
    },
    sendVideo: async () => {
      throw new Error("400 Bad Request - Invalid thread");
    },
  };

  const message = { threadId: "t-fallback-diag", type: 1 };
  const videoFiles = ["C:/test/sample.mp4"];

  // 1. Tool missing with 3221225785 / 0xC0000139
  const toolResultRef = { stopReason: "", lastError: null };
  const mockPrepareFailingWith0xC0000139 = async () => {
    const err = new Error("Command failed with exit code 3221225785");
    err.code = 3221225785;
    throw err;
  };

  const success1 = await sendLocalVideoWithFallback({
    api: fakeApi,
    message,
    videoFiles,
    pool: "vdgirl",
    prepareMedia: mockPrepareFailingWith0xC0000139,
    resultRef: toolResultRef,
  });

  assert.equal(success1, false);
  assert.equal(toolResultRef.stopReason, "tool-missing");
  assert.ok(toolResultRef.lastError instanceof VideoToolMissingError);

  // 2. Upload failure (network / Zalo endpoint rejection)
  const uploadResultRef = { stopReason: "", lastError: null };
  const mockPrepareSuccess = async (file) => ({
    videoPath: file,
    thumbnailPath: "C:/test/sample.jpg",
    metadata: {
      duration: 15,
      width: 720,
      height: 1280,
      fileSize: 102400,
    },
  });

  const success2 = await sendLocalVideoWithFallback({
    api: fakeApi,
    message,
    videoFiles,
    pool: "vdgirl",
    prepareMedia: mockPrepareSuccess,
    resultRef: uploadResultRef,
  });

  assert.equal(success2, false);
  assert.equal(uploadResultRef.stopReason, "video-upload");
  assert.ok(uploadResultRef.lastError.message.includes("ETIMEDOUT"));

  // 3. Delivery failure (after successful upload, Zalo sendVideo rejects)
  const deliveryResultRef = { stopReason: "", lastError: null };
  const fakeApiUploadOk = {
    uploadAttachment: async () => [{ fileUrl: "https://zalo.example/uploaded.mp4" }],
    sendVideo: async () => {
      throw new Error("Zalo rejected video delivery (code 1004)");
    },
  };

  const success3 = await sendLocalVideoWithFallback({
    api: fakeApiUploadOk,
    message,
    videoFiles,
    pool: "vdgirl",
    prepareMedia: mockPrepareSuccess,
    resultRef: deliveryResultRef,
  });

  assert.equal(success3, false);
  assert.equal(deliveryResultRef.stopReason, "delivery");
  assert.ok(deliveryResultRef.lastError.message.includes("1004"));
});

test("diagnose-vps redactSecret properly masks sensitive tokens, cookies, and keys", () => {
  // Empty / missing
  assert.equal(redactSecret(null), "(không có)");
  assert.equal(redactSecret(""), "(không có)");
  assert.equal(redactSecret(undefined), "(không có)");

  // Short secret (< 8 chars)
  assert.equal(redactSecret("abc"), "***");
  assert.equal(redactSecret("secret"), "s***t (6 ký tự)");

  // Long secret
  const apiKey = "hoangdev_live_9876543210abcdef";
  const masked = redactSecret(apiKey);
  assert.ok(!masked.includes("9876543210"));
  assert.ok(masked.startsWith("hoa"));
  assert.ok(masked.includes(`(${apiKey.length} ký tự)`));

  // Cookie
  const cookie = "zpw_sek=AbCdEfGhIjKlMnOpQrStUvWxYz; _ga=123";
  const maskedCookie = redactSecret(cookie);
  assert.ok(!maskedCookie.includes("AbCdEfGhIjKlMnOpQrStUvWxYz"));
  assert.ok(maskedCookie.includes("***"));
});

test("diagnose-vps script executes cleanly with zero exit code", () => {
  const stdout = execFileSync(process.execPath, ["scripts/diagnose-vps.js"], {
    encoding: "utf-8",
    env: { ...process.env, TIKTOK_SEARCH_API_KEY: "secret-test-key-12345678" },
  });

  assert.ok(stdout.includes("BÁO CÁO CHẨN ĐOÁN HỆ THỐNG VPS"));
  assert.ok(stdout.includes("HỆ ĐIỀU HÀNH & RUNTIME"));
  assert.ok(stdout.includes("CÔNG CỤ XỬ LÝ MEDIA"));
  assert.ok(stdout.includes("KHO NGUỒN VIDEO LOCAL"));
  assert.ok(stdout.includes("CẤU HÌNH API TIKTOK"));
  assert.ok(stdout.includes("HỆ THỐNG ANTIUNDO & MESSAGE CACHE"));
  assert.ok(stdout.includes("KIỂM TRA THƯ VIỆN NATIVE (CANVAS)"));

  // Secrets must NOT leak in output
  assert.ok(!stdout.includes("secret-test-key-12345678"));
  assert.ok(stdout.includes("secr***5678"));
});
