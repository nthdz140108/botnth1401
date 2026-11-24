import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function readSource(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("ffmpeg and ffprobe runtime commands stay off the shell in downloader and anti-nude modules", () => {
  const downloaderSource = readSource("src/service-debug/api-crawl/download/aio-downlink.js");
  const hoangdevSource = readSource("src/service-debug/api-crawl/api-hoangdev/aio-downlink.js");
  const antiNudeSource = readSource("src/service-debug/anti-service/anti-nude/anti-nude.js");
  const sendVoiceSource = readSource("src/service-debug/chat-zalo/chat-special/send-voice/send-voice.js");

  for (const source of [downloaderSource, hoangdevSource]) {
    assert.doesNotMatch(source, /ffmpeg -i\s+"/);
    assert.doesNotMatch(source, /ffprobe -v error/);
    assert.doesNotMatch(source, /exec\s*\(\s*ffmpegCmd/);
    assert.doesNotMatch(source, /execSync\(\s*['"]ffmpeg -version['"]/);
  }

  assert.doesNotMatch(antiNudeSource, /execAsync\(\s*`ffmpeg/);
  assert.doesNotMatch(antiNudeSource, /execAsync\(\s*['"]ffmpeg/);
  assert.doesNotMatch(sendVoiceSource, /ffmpegCommand/);
  assert.doesNotMatch(sendVoiceSource, /execAsync\(\s*['"]ffmpeg/);
});
