import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("youtube download worker uses shared auth options and local timeout handling", () => {
  const source = readSource("src/service-debug/api-crawl/youtube/youtube-download-worker.js");

  assert.match(source, /getYoutubeDlpOptions/);
  assert.match(source, /getYoutubeDlpOptions\(\{ env: process\.env \}\)/);
  assert.match(source, /download worker timeout after/);
  assert.match(source, /mergeOutputFormat: "mp4"/);
});
