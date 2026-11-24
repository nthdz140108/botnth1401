import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  getYoutubeRuntimeOptions,
  resolveYoutubeDenoBinary,
  runYoutubeDlp,
  normalizeYoutubeVideoInfo,
  runYoutubeVideoInfo,
  classifyYoutubeError,
} from "../src/service-debug/api-crawl/youtube/youtube-core.js";

test("resolveYoutubeDenoBinary resolves the configured Deno executable", () => {
  const result = resolveYoutubeDenoBinary({ binaryPath: process.execPath });

  assert.ok(result);
  assert.ok(path.isAbsolute(result));
  assert.match(result, /node(\.exe)?$/i);
  assert.equal(fs.existsSync(result), true);
});

test("resolveYoutubeDenoBinary can resolve an injected binary path", () => {
  const result = resolveYoutubeDenoBinary({
    platform: "win32",
    binaryPath: process.execPath,
  });

  assert.ok(path.isAbsolute(result));
  assert.match(result, /node(\.exe)?$/i);
});

test("resolveYoutubeDenoBinary throws a clear error when the binary is missing", () => {
  const originalExistsSync = fs.existsSync;
  fs.existsSync = () => false;

  try {
    assert.throws(
      () => resolveYoutubeDenoBinary({ binaryPath: path.resolve("missing-node.exe") }),
      /JS runtime binary not found/,
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }
});

test("getYoutubeRuntimeOptions returns an explicit Deno runtime and remote components", () => {
  const options = getYoutubeRuntimeOptions({ binaryPath: process.execPath });

  assert.match(options.jsRuntimes, /^deno:/);
  assert.ok(path.isAbsolute(options.jsRuntimes.slice("deno:".length)));
  assert.equal(options.remoteComponents, "ejs:github");
});

test("runYoutubeDlp calls the executor as a function and returns parsed metadata", async () => {
  const calls = [];
  const executor = async (url, flags, options) => {
    calls.push({ url, flags, options });
    return {
      id: "abc123",
      title: "Sample title",
      webpage_url: url,
      duration: 42,
      thumbnail: "https://img.test/thumb.jpg",
      channel: "Sample channel",
      channel_id: "chan-1",
    };
  };

  const result = await runYoutubeDlp(
    "https://www.youtube.com/watch?v=abc123",
    { dumpSingleJson: true },
    1234,
    "metadata",
    executor,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(calls[0].options.timeout, 1234);
  assert.equal(result.id, "abc123");
  assert.equal(result.webpage_url, "https://www.youtube.com/watch?v=abc123");
});

test("normalizeYoutubeVideoInfo maps yt-dlp fields into the shared metadata model", () => {
  const info = normalizeYoutubeVideoInfo({
    id: "jNQXAC9IVRw",
    title: "Me at the zoo",
    url: "https://www.youtube.com/watch?v=wrong",
    webpage_url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    duration: 193,
    thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    channel: "jawed",
    channel_id: "UC4QobU6STFB0P71PMvOGN5A",
  });

  assert.deepEqual(info, {
    videoId: "jNQXAC9IVRw",
    title: "Me at the zoo",
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    duration: 193,
    thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    channelName: "jawed",
    channelId: "UC4QobU6STFB0P71PMvOGN5A",
    description: "",
    viewCount: null,
    likeCount: null,
    commentCount: null,
    publishedTime: "",
    categories: [],
    tags: [],
    isLive: false,
  });
});

test("runYoutubeVideoInfo returns normalized metadata from the executor response", async () => {
  const executor = async () => ({
    id: "abc123",
    title: "Normalized title",
    webpage_url: "https://www.youtube.com/watch?v=abc123",
    duration: 99,
    thumbnail: "https://img.test/thumb.jpg",
    channel: "Channel name",
  });

  const info = await runYoutubeVideoInfo("https://www.youtube.com/watch?v=abc123", 5000, executor);

  assert.equal(info.videoId, "abc123");
  assert.equal(info.url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(info.title, "Normalized title");
});

test("classifyYoutubeError categorizes stage-specific failures", () => {
  assert.equal(classifyYoutubeError(new Error("Video unavailable: private")), "unavailable");
  assert.equal(classifyYoutubeError(new Error("Please sign in")), "auth");
  assert.equal(classifyYoutubeError(new Error("spawn ETIMEDOUT")), "timeout");
  assert.equal(classifyYoutubeError(new Error("deno not found")), "runtime");
  assert.equal(classifyYoutubeError(new Error("something else")), "generic");
});
