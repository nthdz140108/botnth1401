import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const readSource = (relativePath) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("youtube service source declares watch, short, and youtu.be normalization helpers", () => {
  const source = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");

  assert.match(source, /export const extractYoutubeId = \(url\) =>/);
  assert.match(source, /url\.includes\("\?v="\)/);
  assert.match(source, /youtu\\.be/);
  assert.match(source, /\/shorts\//);
  assert.match(source, /export const normalizeYoutubeUrl = \(url\) =>/);
  assert.match(source, /export const isYoutubeUrl = \(url\) => Boolean\(normalizeYoutubeUrl\(url\)\)/);
});

test("youtube autodownload workflow keeps metadata, cache, upload, and cleanup helpers wired", () => {
  const source = readSource("src/service-debug/api-crawl/download/youtube-autodownload-workflow.js");

  assert.match(source, /runYoutubeVideoInfo/);
  assert.match(source, /runYoutubeDownload/);
  assert.match(source, /getCachedMedia/);
  assert.match(source, /ensureNonEmptyFile/);
  assert.match(source, /ensureUploadResult/);
  assert.match(source, /cleanupYoutubeFiles\(state\.files\)/);
  assert.match(source, /cleanupYoutubeFiles\(\[jobDir\]\)/);
});
