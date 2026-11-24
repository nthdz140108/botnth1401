import test from "node:test";
import assert from "node:assert/strict";

import { buildYoutubeProcessingCaption, buildYoutubeVideoCaption, ensureUploadResult, runYoutubeMetadata } from "../src/service-debug/api-crawl/youtube/youtube-core.js";

test("runYoutubeMetadata executes youtube-dl-exec with runtime hints and timeout", async () => {
  const calls = [];
  const executor = async (url, flags, options) => {
    calls.push({ url, flags, options });
    return {
      id: "abc123",
      title: "Sample title",
      webpage_url: url,
      duration: 42,
    };
  };

  const result = await runYoutubeMetadata("https://youtube.test/watch?v=abc123", 4321, executor);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://youtube.test/watch?v=abc123");
  assert.equal(calls[0].options.timeout, 4321);
  assert.equal(calls[0].flags.dumpSingleJson, true);
  assert.equal(calls[0].flags.noCallHome, undefined);
  assert.equal(calls[0].flags.youtubeSkipDashManifest, undefined);
  assert.match(calls[0].flags.jsRuntimes, /^node:/);
  assert.equal(calls[0].flags.remoteComponents, "ejs:github");
  assert.equal(result.webpage_url, calls[0].url);
});

test("runYoutubeMetadata normalizes executor failures as metadata errors", async () => {
  const executor = async () => {
    throw new Error("spawn ETIMEDOUT");
  };

  await assert.rejects(
    () => runYoutubeMetadata("https://youtube.test/watch?v=abc123", 1000, executor),
    (error) => {
      assert.match(error.message, /^\[youtube:metadata\] spawn ETIMEDOUT/);
      assert.equal(error.stage, "metadata");
      return true;
    },
  );
});

test("ensureUploadResult accepts a compatible URL and classifies missing URLs as upload failures", () => {
  assert.equal(ensureUploadResult([{ normalUrl: "https://cdn.example/video.mp4" }]), "https://cdn.example/video.mp4");

  assert.throws(
    () => ensureUploadResult([{ fileUrl: "" }]),
    (error) => error.stage === "upload" && /missing usable video URL/.test(error.message),
  );
});

test("YouTube caption helpers use Vietnamese labels and retain the requested English footer", () => {
  assert.equal(buildYoutubeProcessingCaption("720p"), "**Chờ bé lấy video một chút, xong bé gọi cho hay!**\n📊 **Chất lượng:** 720p");
  assert.equal(
    buildYoutubeVideoCaption({
      senderName: "Thanh Hung",
      title: "CHILLIES - mascara / lyrics",
      channelName: "TPT Music For Life",
      viewCount: "93751",
      publishedTime: "20250627",
      qualityText: "720p",
    }),
    "[ Thanh Hung ]\n🎵 Tiêu Đề: CHILLIES - mascara / lyrics\n📺 Kênh: TPT Music For Life\n👀 Lượt Xem: 93751\n📅 Ngày Đăng: 20250627\n[ Watch More On Youtube ]",
  );
});
