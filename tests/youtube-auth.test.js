import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from 'node:os';

import { getYoutubeAuthOptions } from "../src/service-debug/api-crawl/youtube/youtube-auth.js";

test("returns no auth flags when YouTube cookie settings are empty", () => {
  assert.deepEqual(getYoutubeAuthOptions({}), {});
  assert.deepEqual(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FILE: "  " }), {});
  assert.deepEqual(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FROM_BROWSER: "  " }), {});
});

test("uses an absolute cookie file path when configured", () => {
  assert.deepEqual(
    getYoutubeAuthOptions({ YOUTUBE_COOKIES_FILE: "cookies/youtube.txt" }),
    { cookies: path.resolve("cookies/youtube.txt") },
  );
});

test("uses browser cookies when configured", () => {
  assert.deepEqual(
    getYoutubeAuthOptions({ YOUTUBE_COOKIES_FROM_BROWSER: "chrome:Default" }),
    { cookiesFromBrowser: "chrome:Default" },
  );
});

test('relative cookie configuration follows persistent bot data across releases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-auth-'));
  try {
    fs.mkdirSync(path.join(dir, 'state'));
    const cookie = path.join(dir, 'state', 'youtube.txt');
    fs.writeFileSync(cookie, '# Netscape HTTP Cookie File');
    assert.equal(getYoutubeAuthOptions({ YOUTUBE_COOKIES_FILE: 'mybot/state/youtube.txt', MYBOT_DATA_DIR: dir }).cookies, cookie);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("prefers an explicit cookie file over browser cookies", () => {
  const options = getYoutubeAuthOptions({
    YOUTUBE_COOKIES_FILE: "youtube-cookies.txt",
    YOUTUBE_COOKIES_FROM_BROWSER: "edge",
  });

  assert.deepEqual(options, { cookies: path.resolve("youtube-cookies.txt") });
});

test("uses the shared auth helper in metadata and download paths", () => {
  const runtimeSource = fs.readFileSync(
    path.resolve("src/service-debug/api-crawl/youtube/youtube-runtime.js"),
    "utf8",
  );
  const workerSource = fs.readFileSync(
    path.resolve("src/service-debug/api-crawl/youtube/youtube-download-worker.js"),
    "utf8",
  );

  assert.match(runtimeSource, /getYoutubeAuthOptions/);
  assert.match(runtimeSource, /jsRuntimes:\s*`deno:/);
  assert.match(workerSource, /buildYoutubeDownloadOptions/);
});

test("bot loads provider environment before importing the runtime", () => {
  const botSource = fs.readFileSync(path.resolve("bot.js"), "utf8");
  const bootstrapCall = botSource.indexOf("loadProviderEnvironment();");
  const runtimeImport = botSource.indexOf("await import('./index.js')");

  assert.notEqual(bootstrapCall, -1);
  assert.notEqual(runtimeImport, -1);
  assert.ok(bootstrapCall < runtimeImport);
});

test("enables yt-dlp JavaScript challenge solving for YouTube", () => {
  const runtimeSource = fs.readFileSync(
    path.resolve("src/service-debug/api-crawl/youtube/youtube-runtime.js"),
    "utf8",
  );
  const workerSource = fs.readFileSync(
    path.resolve("src/service-debug/api-crawl/youtube/youtube-download-worker.js"),
    "utf8",
  );

  assert.match(runtimeSource, /jsRuntimes:\s*`deno:/);
  assert.match(runtimeSource, /remoteComponents:\s*"ejs:github"/);
  assert.match(workerSource, /buildYoutubeDownloadOptions/);
});
