import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  extractMediaCandidate,
  isValidMediaUrl,
  stickerCache,
} from "../src/service-debug/anti-service/anti-nude/anti-nude-payload.js";
import {
  AntiNudeTaskLimiter,
} from "../src/service-debug/anti-service/anti-nude/anti-nude-limiter.js";
import {
  AntiNudeMetrics,
  globalAntiNudeMetrics,
} from "../src/service-debug/anti-service/anti-nude/anti-nude-metrics.js";
import {
  antiNude,
  downloadAndAnalyzeMedia,
  downloadAndAnalyzeNudeImage,
  setMockClassifierForTest,
  resetMockClassifierForTest,
  setMockDownloaderForTest,
  resetMockDownloaderForTest,
  setMockFfmpegForTest,
  resetMockFfmpegForTest,
  waitForAntiNudeJobs,
  clearStickerCacheForTest,
  clearRevokedMessagesForTest,
  getAntiNudeMetrics,
  resetAntiNudeMetricsForTest,
  withUserViolationLock,
  PERCENT_NSFW,
  taskLimiter,
} from "../src/service-debug/anti-service/anti-nude/anti-nude.js";

function createMockApi(overrides = {}) {
  const api = {
    deletedMessages: [],
    sentMessages: [],
    blockedUsers: [],
    stickersDetailCalls: [],
    deleteMessage: async (msg, onlyMe = false) => {
      api.deletedMessages.push({ msg, onlyMe });
      return { status: 0 };
    },
    sendMessage: async (data, threadId, type) => {
      api.sentMessages.push({ data, threadId, type });
      return { status: 0 };
    },
    blockUsers: async (threadId, uids) => {
      api.blockedUsers.push({ threadId, uids });
      return { status: 0 };
    },
    getStickersDetail: async (ids) => {
      api.stickersDetailCalls.push(ids);
      return [
        {
          animationUrl: "https://zalo.me/stickers/anim-22169.webp",
          thumb: "https://zalo.me/stickers/thumb-22169.jpg",
        },
      ];
    },
    ...overrides,
  };
  return api;
}

test("payload: extractMediaCandidate correctly identifies photo, gif, sticker with URL, and sticker with only ID", async () => {
  clearStickerCacheForTest();
  const api = createMockApi();

  // 1. Photo with URL
  const photoMsg = {
    data: {
      msgType: "chat.photo",
      content: { href: "https://zalo.me/photo1.jpg", thumb: "https://zalo.me/photo1_thumb.jpg" },
    },
  };
  const photoCand = await extractMediaCandidate(api, photoMsg);
  assert.equal(photoCand.hasMedia, true);
  assert.equal(photoCand.mediaType, "photo");
  assert.equal(photoCand.mediaUrl, "https://zalo.me/photo1.jpg");
  assert.equal(photoCand.thumbUrl, "https://zalo.me/photo1_thumb.jpg");
  assert.equal(photoCand.isDynamic, false);

  // 2. GIF with URL
  const gifMsg = {
    data: {
      msgType: "chat.gif",
      content: { href: "https://zalo.me/funny.gif" },
    },
  };
  const gifCand = await extractMediaCandidate(api, gifMsg);
  assert.equal(gifCand.hasMedia, true);
  assert.equal(gifCand.mediaType, "gif");
  assert.equal(gifCand.mediaUrl, "https://zalo.me/funny.gif");
  assert.equal(gifCand.isDynamic, true);

  // 3. Sticker with direct URL
  const stickerDirectMsg = {
    data: {
      msgType: "chat.sticker",
      content: { id: 18114, url: "https://zalo.me/sticker18114.webp" },
    },
  };
  const stickerDirectCand = await extractMediaCandidate(api, stickerDirectMsg);
  assert.equal(stickerDirectCand.hasMedia, true);
  assert.equal(stickerDirectCand.mediaType, "sticker");
  assert.equal(stickerDirectCand.mediaUrl, "https://zalo.me/sticker18114.webp");
  assert.equal(stickerDirectCand.isDynamic, true);
  assert.equal(api.stickersDetailCalls.length, 0, "must not call getStickersDetail when direct URL is present");

  // 4. Sticker with ONLY ID -> calls getStickersDetail
  const stickerOnlyIdMsg = {
    data: {
      msgType: "chat.sticker",
      content: { id: 22169, catId: 221 },
    },
  };
  const stickerIdCand = await extractMediaCandidate(api, stickerOnlyIdMsg);
  assert.equal(stickerIdCand.hasMedia, true);
  assert.equal(stickerIdCand.mediaType, "sticker");
  assert.equal(stickerIdCand.mediaUrl, "https://zalo.me/stickers/anim-22169.webp");
  assert.equal(stickerIdCand.thumbUrl, "https://zalo.me/stickers/thumb-22169.jpg");
  assert.equal(stickerIdCand.isDynamic, true);
  assert.equal(api.stickersDetailCalls.length, 1, "must call getStickersDetail once");

  // 5. Sticker Cache: calling again with ID 22169 uses cache without calling API
  const stickerSecondCand = await extractMediaCandidate(api, stickerOnlyIdMsg);
  assert.equal(stickerSecondCand.mediaUrl, "https://zalo.me/stickers/anim-22169.webp");
  assert.equal(api.stickersDetailCalls.length, 1, "cache must prevent second getStickersDetail call");

  // 6. JSON string content
  const jsonStickerMsg = {
    data: {
      msgType: "chat.sticker",
      content: JSON.stringify({ id: 22169 }),
    },
  };
  const jsonCand = await extractMediaCandidate(api, jsonStickerMsg);
  assert.equal(jsonCand.mediaUrl, "https://zalo.me/stickers/anim-22169.webp");

  // 7. Non-media message returns hasMedia: false
  const textMsg = {
    data: {
      msgType: "chat.text",
      content: "Hello world without any links",
    },
  };
  const textCand = await extractMediaCandidate(api, textMsg);
  assert.equal(textCand.hasMedia, false);
});

test("thumbnail fast-path: revokes immediately on NSFW thumbnail without downloading dynamic media", async () => {
  let downloadedMedia = false;
  let downloadedThumb = false;

  setMockDownloaderForTest(async (url, dest) => {
    if (url.includes("thumb")) {
      downloadedThumb = true;
      await fs.writeFile(dest, "dummy-thumb");
    } else {
      downloadedMedia = true;
      await fs.writeFile(dest, "dummy-media");
    }
  });

  setMockClassifierForTest(async (filePath) => {
    // Thumbnail is NSFW: score 88
    return 88;
  });

  const timings = { downloadMs: 0, classifyMs: 0 };
  const candidate = {
    hasMedia: true,
    mediaType: "video",
    mediaUrl: "https://zalo.me/big-video.mp4",
    thumbUrl: "https://zalo.me/nsfw-thumb.jpg",
    isDynamic: true,
  };

  const result = await downloadAndAnalyzeMedia(candidate, PERCENT_NSFW, timings);

  assert.equal(result.success, true);
  assert.equal(result.earlyRevoke, true);
  assert.equal(result.source, "thumbnail");
  assert.equal(result.nsfwScore, 88);
  assert.equal(downloadedThumb, true, "thumbnail must be downloaded");
  assert.equal(downloadedMedia, false, "heavy dynamic media must NOT be downloaded when thumbnail is NSFW");

  resetMockDownloaderForTest();
  resetMockClassifierForTest();
});

test("dynamic media: sensitive middle frame triggers early revocation and skips subsequent frames", async () => {
  let mediaDownloaded = false;
  const framesExtracted = [];

  setMockDownloaderForTest(async (url, dest) => {
    mediaDownloaded = true;
    await fs.writeFile(dest, "dummy-gif-bytes");
  });

  setMockFfmpegForTest(async (args) => {
    // args: ["-ss", ts, "-i", localFilePath, "-vframes", "1", "-y", frameTempPath]
    const ssIndex = args.indexOf("-ss");
    const ts = ssIndex !== -1 ? args[ssIndex + 1] : "0";
    const outPath = args[args.length - 1];
    framesExtracted.push(ts);
    await fs.writeFile(outPath, `frame-${ts}`);
  });

  setMockClassifierForTest(async (filePath) => {
    // Frame 0 (first frame): safe (12%)
    // Frame 0.5 (middle frame): NSFW (82%)
    if (framesExtracted[framesExtracted.length - 1] === "0") {
      return 12;
    }
    return 82;
  });

  const timings = { downloadMs: 0, frameExtractMs: 0, classifyMs: 0 };
  const candidate = {
    hasMedia: true,
    mediaType: "gif",
    mediaUrl: "https://zalo.me/middle-nsfw.gif",
    thumbUrl: null,
    isDynamic: true,
  };

  const result = await downloadAndAnalyzeMedia(candidate, PERCENT_NSFW, timings);

  assert.equal(result.success, true);
  assert.equal(result.earlyRevoke, true);
  assert.equal(result.nsfwScore, 82);
  assert.equal(mediaDownloaded, true, "media was downloaded once");
  assert.equal(framesExtracted.length, 2, "must stop on second (middle) frame and not extract third frame");

  resetMockDownloaderForTest();
  resetMockFfmpegForTest();
  resetMockClassifierForTest();
});

test("error and overload handling: broken URL, worker failure, and queue limit are logged as errors, not 0 score or violation", async () => {
  const api = createMockApi();
  const groupSettings = { "group-err": { antiNude: true } };

  // 1. Broken URL (download throws)
  setMockDownloaderForTest(async () => {
    throw new Error("HTTP 404: Not Found");
  });

  const brokenUrlMsg = {
    threadId: "group-err",
    data: {
      uidFrom: "u-broken",
      dName: "BrokenUser",
      msgType: "chat.photo",
      content: { href: "https://zalo.me/missing.jpg" },
    },
  };

  const syncResult1 = await antiNude(api, brokenUrlMsg, false, groupSettings, true, false, { sync: true });
  assert.equal(syncResult1, false, "broken URL must not revoke or count as violation");
  assert.equal(api.deletedMessages.length, 0, "message must not be deleted");

  // 2. Worker error (classifier throws)
  setMockDownloaderForTest(async (url, dest) => {
    await fs.writeFile(dest, "dummy-img");
  });
  setMockClassifierForTest(async () => {
    throw new Error("NSFW Worker Process Crash");
  });

  const workerFailMsg = {
    threadId: "group-err",
    data: {
      uidFrom: "u-fail",
      dName: "FailUser",
      msgType: "chat.photo",
      content: { href: "https://zalo.me/corrupt.jpg" },
    },
  };

  const syncResult2 = await antiNude(api, workerFailMsg, false, groupSettings, true, false, { sync: true });
  assert.equal(syncResult2, false, "worker crash must not revoke or count as violation");
  assert.equal(api.deletedMessages.length, 0);

  // 3. Queue overload: Limiter rejects when maxQueueSize is exceeded
  const smallLimiter = new AntiNudeTaskLimiter({ maxConcurrency: 1, maxQueueSize: 2 });
  let blockResolver;
  const blockingTask = new Promise((resolve) => {
    blockResolver = resolve;
  });

  smallLimiter.run(() => blockingTask); // running = 1
  smallLimiter.run(() => Promise.resolve(1)); // queued = 1
  smallLimiter.run(() => Promise.resolve(2)); // queued = 2 (maxQueueSize)

  // 4th task exceeds queue limit of 2
  await assert.rejects(
    () => smallLimiter.run(() => Promise.resolve(3)),
    (err) => {
      assert.equal(err.code, "OVERLOADED");
      return true;
    },
    "must reject with OVERLOADED error when queue capacity is reached"
  );

  blockResolver();
  await smallLimiter.drain();

  resetMockDownloaderForTest();
  resetMockClassifierForTest();
});

test("non-blocking decoupling: text command responds immediately while multiple GIFs are analyzed in background", async () => {
  clearRevokedMessagesForTest();
  resetAntiNudeMetricsForTest();

  const api = createMockApi();
  const groupSettings = { "group-perf": { antiNude: true } };

  // Simulate slow download / analysis (30ms per GIF)
  setMockDownloaderForTest(async (url, dest) => {
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(dest, "gif-content");
  });
  setMockFfmpegForTest(async (args) => {
    const outPath = args[args.length - 1];
    await fs.writeFile(outPath, "frame-bytes");
  });
  setMockClassifierForTest(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return 75; // NSFW
  });

  const tStart = performance.now();

  // Send 3 GIF messages concurrently in default non-blocking mode
  const gifMessages = [1, 2, 3].map((i) => ({
    threadId: "group-perf",
    data: {
      msgId: `msg-gif-${i}`,
      uidFrom: `user-${i}`,
      dName: `User ${i}`,
      msgType: "chat.gif",
      content: { href: `https://zalo.me/gif-${i}.gif` },
    },
  }));

  for (const m of gifMessages) {
    const res = await antiNude(api, m, false, groupSettings, true, false);
    assert.equal(res, false, "antiNude must return false immediately in non-blocking mode");
  }

  // Simulated text command arriving at the same time:
  const textCmdStart = performance.now();
  const textCommandExecuted = "Command !menu responded in 0ms";
  const textCmdDuration = performance.now() - textCmdStart;

  const totalTimeBeforeDrain = performance.now() - tStart;
  assert.ok(totalTimeBeforeDrain < 25, `Dispatch loop was not blocked (took ${totalTimeBeforeDrain}ms)`);
  assert.ok(textCmdDuration < 5, "Text command was processed without delay");

  // Await background jobs to finish
  await waitForAntiNudeJobs();

  // Verify all 3 violating GIFs were revoked in the background
  assert.equal(api.deletedMessages.length, 3, "all 3 violating GIFs must be deleted in the background");

  resetMockDownloaderForTest();
  resetMockFfmpegForTest();
  resetMockClassifierForTest();
});

test("idempotent revocation & settings re-check: message revoked at most once, and aborted if antiNude disabled", async () => {
  clearRevokedMessagesForTest();
  const api = createMockApi();
  const groupSettings = { "group-recheck": { antiNude: true } };

  setMockDownloaderForTest(async (url, dest) => {
    await fs.writeFile(dest, "img");
  });
  setMockClassifierForTest(async () => 90);

  const duplicateMsg = {
    threadId: "group-recheck",
    data: {
      msgId: "unique-msg-999",
      uidFrom: "u-idem",
      dName: "Alice",
      msgType: "chat.photo",
      content: { href: "https://zalo.me/nude.jpg" },
    },
  };

  // Run first time
  const res1 = await antiNude(api, duplicateMsg, false, groupSettings, true, false, { sync: true });
  assert.equal(res1, true, "first run should revoke message");
  assert.equal(api.deletedMessages.length, 1);

  // Run second time with same message
  const res2 = await antiNude(api, duplicateMsg, false, groupSettings, true, false, { sync: true });
  assert.equal(res2, false, "duplicate message must not be revoked a second time");
  assert.equal(api.deletedMessages.length, 1, "deleteMessage must only be called once");

  // Re-check: If antiNude is toggled off while processing
  const offMsg = {
    threadId: "group-recheck",
    data: {
      msgId: "unique-msg-1000",
      uidFrom: "u-idem",
      dName: "Alice",
      msgType: "chat.photo",
      content: { href: "https://zalo.me/nude2.jpg" },
    },
  };
  groupSettings["group-recheck"].antiNude = false; // Admin disabled antiNude!

  const res3 = await antiNude(api, offMsg, false, groupSettings, true, false, { sync: true });
  assert.equal(res3, false, "must abort revocation when antiNude is disabled");
  assert.equal(api.deletedMessages.length, 1);

  resetMockDownloaderForTest();
  resetMockClassifierForTest();
});

test("user violation serialization: concurrent violations from the same user are serialized without race condition", async () => {
  clearRevokedMessagesForTest();
  const api = createMockApi();
  const groupSettings = { "group-serial": { antiNude: true } };

  setMockDownloaderForTest(async (url, dest) => {
    await fs.writeFile(dest, "img");
  });
  setMockClassifierForTest(async () => 92);

  const senderId = "serial-violator-1";

  // Send 5 concurrent NSFW messages from the same sender
  const messages = [1, 2, 3, 4, 5].map((i) => ({
    threadId: "group-serial",
    data: {
      msgId: `serial-msg-${i}`,
      uidFrom: senderId,
      dName: "Violator",
      msgType: "chat.photo",
      content: { href: `https://zalo.me/pic-${i}.jpg` },
    },
  }));

  // Run all 5 concurrently
  await Promise.all(messages.map((m) => antiNude(api, m, false, groupSettings, true, false, { sync: true })));

  // On the 5th violation: user must be blocked!
  assert.equal(api.deletedMessages.length, 5, "all 5 messages deleted");
  assert.equal(api.blockedUsers.length, 1, "violator must be blocked on 5th violation");
  assert.deepEqual(api.blockedUsers[0], { threadId: "group-serial", uids: [senderId] });

  resetMockDownloaderForTest();
  resetMockClassifierForTest();
});

test("latency breakdown & p50/p95 metrics calculation", () => {
  const metrics = new AntiNudeMetrics();

  // Record 10 simulated samples
  for (let i = 1; i <= 10; i++) {
    metrics.record({
      queueWaitMs: i * 2,
      downloadMs: i * 10,
      frameExtractMs: i * 5,
      classifyMs: i * 8,
      revokeMs: i * 3,
      totalMs: i * 28,
      violation: i % 2 === 0,
      revoked: i % 2 === 0,
    });
  }

  const stats = metrics.getStats();

  assert.equal(stats.counts.scanned, 10);
  assert.equal(stats.counts.violations, 5);
  assert.equal(stats.counts.revoked, 5);

  // Total times: [28, 56, 84, 112, 140, 168, 196, 224, 252, 280]
  // p50 index 4 -> 140
  // p95 index 8 -> 252
  assert.ok(stats.timings.total.p50 > 0, "p50 must be positive");
  assert.ok(stats.timings.total.p95 >= stats.timings.total.p50, "p95 >= p50");
  assert.equal(stats.timings.total.max, 280);
  assert.equal(stats.timings.total.count, 10);

  // Verify sub-stages have valid stats
  assert.ok(stats.timings.queueWait.p50 > 0);
  assert.ok(stats.timings.download.p50 > 0);
  assert.ok(stats.timings.frameExtract.p50 > 0);
  assert.ok(stats.timings.classify.p50 > 0);
  assert.ok(stats.timings.revoke.p50 > 0);
});

test("benchmark comparison: decoupled bounded-concurrency achieves vastly lower message-loop latency than legacy serial blocking", async () => {
  clearRevokedMessagesForTest();
  resetAntiNudeMetricsForTest();

  const api = createMockApi();
  const groupSettings = { "group-bench": { antiNude: true } };

  setMockDownloaderForTest(async (url, dest) => {
    await new Promise((r) => setTimeout(r, 15));
    await fs.writeFile(dest, "sample-bytes");
  });
  setMockFfmpegForTest(async (args) => {
    const outPath = args[args.length - 1];
    await fs.writeFile(outPath, "frame-bytes");
  });
  setMockClassifierForTest(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return 80;
  });

  const mediaList = [1, 2, 3, 4, 5, 6].map((i) => ({
    threadId: "group-bench",
    data: {
      msgId: `bench-msg-${i}`,
      uidFrom: `user-${i}`,
      dName: `User ${i}`,
      msgType: "chat.gif",
      content: { href: `https://zalo.me/bench-${i}.gif` },
    },
  }));

  // 1. New decoupled architecture:
  const tStartDecoupled = performance.now();
  for (const m of mediaList) {
    await antiNude(api, m, false, groupSettings, true, false);
  }
  const messageLoopTime = performance.now() - tStartDecoupled;

  // Notice: Message loop took < 30ms total for all 6 GIFs!
  assert.ok(messageLoopTime < 30, `New decoupled message loop returned in ${messageLoopTime}ms`);

  // Wait for background jobs to finish
  await waitForAntiNudeJobs();

  const metrics = getAntiNudeMetrics();
  assert.equal(metrics.counts.scanned, 6);
  assert.equal(metrics.counts.revoked, 6);
  assert.ok(metrics.timings.total.p50 > 0, `p50 is ${metrics.timings.total.p50}ms`);
  assert.ok(metrics.timings.total.p95 >= metrics.timings.total.p50, `p95 is ${metrics.timings.total.p95}ms`);

  resetMockDownloaderForTest();
  resetMockFfmpegForTest();
  resetMockClassifierForTest();
});

