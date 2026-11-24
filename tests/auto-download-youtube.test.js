import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runYoutubeAutoDownloadWorkflow } from "../src/service-debug/api-crawl/download/youtube-autodownload-workflow.js";

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("YouTube autodownload owns its single confirmation reaction", () => {
  const autoDownload = readSource("src/service-debug/api-crawl/download/auto-download.js");
  const workflow = readSource("src/service-debug/api-crawl/download/youtube-autodownload-workflow.js");

  const youtubeBranch = autoDownload.slice(autoDownload.indexOf("const youtubeUrl"), autoDownload.indexOf("const commandName"));
  assert.ok(youtubeBranch.indexOf("return await handleYouTubeAutoDownload") < youtubeBranch.indexOf("sendReactionConfirmReceive"));
  assert.match(workflow, /await sendReaction\(api, message\)/);
});

test("autodownload requires a normalized upload URL before its uploaded-video send", () => {
  const source = readSource("src/service-debug/api-crawl/download/youtube-autodownload-workflow.js");

  assert.match(source, /mediaUrl = ensureUploadResult\(await api\.uploadAttachment/);
  assert.match(source, /alreadyUploaded: true/);
  assert.match(source, /error\?\.stage === "upload"/);
  assert.match(source, /cleanupYoutubeFiles\(\[jobDir\]\)/);
});

test("autodownload sends only after a valid upload and cleans up its job directory", async () => {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-autodownload-"));
  const calls = [];
  const api = {
    uploadAttachment: async () => {
      assert.equal(calls.includes("send"), false);
      calls.push("upload");
      return [{ normalUrl: "https://cdn.example/video.mp4" }];
    },
    sendVideo: async (payload) => calls.push(payload),
  };
  const result = await runYoutubeAutoDownloadWorkflow(api, { threadId: "group", type: 1, data: { dName: "Lan", uidFrom: "u1" } }, "https://youtu.be/id", "u1", "Lan", {
    jobDir,
    sendReaction: async () => calls.push("reaction"),
    sendProcessing: async () => calls.push("processing"),
    getYoutubeVideoInfo: async () => ({
      videoId: "id",
      title: "CHILLIES - mascara / lyrics",
      channelName: "TPT Music For Life",
      viewCount: "93751",
      publishedTime: "20250627",
      url: "https://youtu.be/id",
      thumbnail: "https://img.example/video.jpg",
    }),
    getCachedMedia: async () => null,
    setCacheData: async () => {},
    downloadYoutubeVideo: async (_url, target) => fs.writeFile(target, "video"),
    getDurationVideo: async () => 10,
  });

  assert.equal(result, true);
  assert.equal(calls.filter((call) => call === "reaction").length, 1);
  assert.equal(calls.at(-1).videoUrl, "https://cdn.example/video.mp4");
  assert.equal(calls.at(-1).videoAlreadyUploaded, true);
  assert.equal(calls.at(-1).message.text, `[ Lan ]\n🎵 Tiêu Đề: CHILLIES - mascara / lyrics\n📺 Kênh: TPT Music For Life\n👀 Lượt Xem: 93751\n📅 Ngày Đăng: 20250627\n[ Watch More On Youtube ]`);
  await assert.rejects(() => fs.access(jobDir));
});

test("TikTok autodownload reacts before requesting video data", () => {
  const source = readSource("src/service-debug/api-crawl/download/auto-download.js");
  const tiktokStart = source.lastIndexOf("const tiktokUrl");
  const tiktokBranch = source.slice(tiktokStart, source.indexOf("const youtubeUrl", tiktokStart));

  assert.ok(tiktokBranch.indexOf("sendReactionConfirmReceive") < tiktokBranch.indexOf("getDataDownloadVideo"));
});

test("autodownload reports an upload-stage failure, skips sending, and cleans up", async () => {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "youtube-autodownload-"));
  const warnings = [];
  const api = { uploadAttachment: async () => [{}], sendVideo: async () => assert.fail("sendVideo must not run") };
  const result = await runYoutubeAutoDownloadWorkflow(api, { threadId: "group", type: 1, data: { dName: "Lan", uidFrom: "u1" } }, "https://youtu.be/id", "u1", "Lan", {
    jobDir,
    sendReaction: async () => {},
    sendProcessing: async () => {},
    sendWarning: async (_api, _message, payload) => warnings.push(payload.caption),
    getYoutubeVideoInfo: async () => ({ videoId: "id", title: "Video", url: "https://youtu.be/id" }),
    getCachedMedia: async () => null,
    downloadYoutubeVideo: async (_url, target) => fs.writeFile(target, "video"),
  });

  assert.equal(result, false);
  assert.match(warnings[0], /Tải lên video thất bại|Tai len video that bai/i);
  await assert.rejects(() => fs.access(jobDir));
});
