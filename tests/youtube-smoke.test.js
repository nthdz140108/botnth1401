import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  runYoutubeVideoInfo,
  runYoutubeDownload,
  ensureNonEmptyFile,
  cleanupYoutubeFiles,
} from "../src/service-debug/api-crawl/youtube/youtube-core.js";

test("smoke: public YouTube video metadata and download succeed when enabled", { skip: process.env.YOUTUBE_SMOKE !== "1" }, async () => {
  const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const info = await runYoutubeVideoInfo(url, 30000);

  assert.equal(info.videoId, "jNQXAC9IVRw");
  assert.ok(info.title);
  assert.equal(info.url, url);

  const filePath = await runYoutubeDownload(
    url,
    "temp/smoke-test.mp4",
    "bestvideo[height<=360][vcodec^=avc1]+bestaudio/best[height<=360][vcodec^=avc1]",
    180000,
  );
  try {
    ensureNonEmptyFile(filePath);
    assert.equal(fs.existsSync(filePath), true);
  } finally {
    await cleanupYoutubeFiles([filePath]);
  }
});
