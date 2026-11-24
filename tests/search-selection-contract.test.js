import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const readSource = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

const allProviders = [
  ["tiktok", "src/service-debug/api-crawl/tiktok/tiktok-service.js"],
  ["youtube", "src/service-debug/api-crawl/youtube/youtube-service.js"],
  ["capcut", "src/service-debug/api-crawl/capcut/capcut-service.js"],
  ["download", "src/service-debug/api-crawl/api-hoangdev/aio-downlink.js"],
  ["spotify", "src/service-debug/api-crawl/spotify/spotify-downlink.js"],
  ["zingmp3", "src/service-debug/api-crawl/music/zingmp3.js"],
  ["soundcloud", "src/service-debug/api-crawl/music/soundcloud.js"],
  ["nhaccuatui", "src/service-debug/api-crawl/music/nhaccuatui.js"],
  ["clipphot", "src/service-debug/servises/clipphot.vn.js"],
  ["LOL", "src/service-debug/servises/LOL.General.js"],
  ["LQM", "src/service-debug/servises/LQM-General.js"],
  ["truyensex", "src/service-debug/servises/truyensex.js"],
];

test("search selection contract: YouTube, TikTok, CapCut and AIO must not combine both openMediaSelection and setSelectionsMapData", () => {
  const capcutSrc = readSource("src/service-debug/api-crawl/capcut/capcut-service.js");
  const aioSrc = readSource("src/service-debug/api-crawl/api-hoangdev/aio-downlink.js");
  const youtubeSrc = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");
  const tiktokSrc = readSource("src/service-debug/api-crawl/tiktok/tiktok-service.js");

  for (const [name, src] of [
    ["CapCut", capcutSrc],
    ["AIO downlink", aioSrc],
    ["YouTube", youtubeSrc],
    ["TikTok", tiktokSrc],
  ]) {
    assert.equal(
      src.includes("openMediaSelection("),
      false,
      `${name} must not directly call openMediaSelection; delegate to setSelectionsMapData`
    );
  }
});

test("search selection contract: all providers supply complete prompt metadata to selection lifecycle", () => {
  for (const [name, filePath] of allProviders) {
    const src = readSource(filePath);

    if (name === "tiktok" || name === "youtube") {
      assert.match(
        src,
        /await\s+setSelectionsMapData\(/,
        `${name} must await setSelectionsMapData`
      );
      assert.match(
        src,
        /messageContext:\s*message/,
        `${name} must pass messageContext: message to setSelectionsMapData`
      );
      assert.match(
        src,
        /sentMessage:/,
        `${name} must pass sentMessage to setSelectionsMapData`
      );
    } else {
      // Must await setSelectionsMapData
      assert.match(
        src,
        /await\s+setSelectionsMapData\(/,
        `${name} must await setSelectionsMapData`
      );
      assert.match(
        src,
        /messageContext:\s*message/,
        `${name} must pass messageContext: message to setSelectionsMapData`
      );
      assert.match(
        src,
        /sentMessage:/,
        `${name} must pass sentMessage to setSelectionsMapData`
      );
    }
  }
});
