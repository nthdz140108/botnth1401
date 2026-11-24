import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  checkReplySelectionsMapData,
  getSelectionsMapData,
  releaseSelectionsMapData,
  setSelectionsMapData,
} from "../src/service-debug/api-crawl/index.js";
import { consumeYoutubeSelection } from "../src/service-debug/api-crawl/youtube/youtube-service.js";
import { consumeTikTokSelection } from "../src/service-debug/api-crawl/tiktok/tiktok-service.js";
import { clearAllInteractionCountdowns } from "../src/utils/interaction-countdown.js";

const readSource = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

function createApi() {
  const reactions = [];
  const deleted = [];
  const sent = [];
  const undos = [];
  const warnings = [];
  const api = {
    reactions,
    deleted,
    sent,
    undos,
    warnings,
    async sendMessage(payload, threadId, type) {
      const res = { msgId: `msg-${Date.now()}-${sent.length}`, threadId, type, payload };
      sent.push(res);
      if (typeof payload?.msg === "string") warnings.push(payload.msg);
      return res;
    },
    async addReaction(icon, messages) {
      reactions.push({ icon, messages });
      return { success: true };
    },
    async deleteMessage(message, onlyMe) {
      deleted.push({ message, onlyMe });
      return { success: true };
    },
    async undoMessage(message) {
      undos.push(message);
      return { error_code: 0 };
    },
  };
  return api;
}

function createFakeScheduler(initialTime = 1000000) {
  let currentTime = initialTime;
  let nextTimerId = 1;
  const timers = new Map();

  const now = () => currentTime;

  const schedule = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay: delay ?? 1000, id });
    return id;
  };
  schedule.now = now;

  const cancelSchedule = (id) => {
    timers.delete(id);
  };

  const step = async () => {
    if (timers.size === 0) return false;
    const [id, entry] = timers.entries().next().value;
    timers.delete(id);
    currentTime += entry.delay || 1000;
    await entry.callback();
    return true;
  };

  const stepAll = async () => {
    let count = 0;
    while (timers.size > 0 && count < 2000) {
      await step();
      count += 1;
    }
  };

  return { schedule, cancelSchedule, step, stepAll, now, timers };
}

function createUserMessage(content, { uid = "u-free", threadId = "g-free" } = {}) {
  return {
    threadId,
    type: 1,
    data: { uidFrom: uid, dName: "Tester", content },
  };
}

const baseCollection = [
  { id: "m1", title: "one" },
  { id: "m2", title: "two" },
  { id: "m3", title: "three" },
];

async function registerSession({
  userId = "u-free",
  collection = baseCollection,
  scheduler,
  seconds = 60,
  onSelect,
  onExpire,
} = {}) {
  const api = createApi();
  const sentMessage = {
    message: [{ msgId: `prompt-${userId}`, cliMsgId: `cli-${userId}` }],
  };
  const messageContext = { threadId: "g-origin", type: 1, data: { uidFrom: userId } };
  await setSelectionsMapData(userId, {
    platform: "test",
    collection,
    api,
    sentMessage,
    messageContext,
    threadId: "g-origin",
    type: 1,
    seconds,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    now: scheduler.now,
    onSelect,
    onExpire,
  });
  return { api };
}

test.beforeEach(() => {
  clearAllInteractionCountdowns();
});

test.afterEach(() => {
  clearAllInteractionCountdowns();
});

// ---------------------------------------------------------------------------
// Contract registration
// ---------------------------------------------------------------------------

test("contract: youtube and tiktok register via setSelectionsMapData and never open their own openMediaSelection", () => {
  const ytSrc = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");
  const ttSrc = readSource("src/service-debug/api-crawl/tiktok/tiktok-service.js");

  assert.match(ytSrc, /await\s+setSelectionsMapData\(/, "youtube must register through setSelectionsMapData");
  assert.match(ttSrc, /await\s+setSelectionsMapData\(/, "tiktok must register through setSelectionsMapData");

  assert.equal(ytSrc.includes("openMediaSelection("), false, "youtube must not call openMediaSelection directly");
  assert.equal(ttSrc.includes("openMediaSelection("), false, "tiktok must not call openMediaSelection directly");
});

test("contract: youtube and tiktok expose a single shared consume function used by quote and free-form paths", () => {
  const ytSrc = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");
  const ttSrc = readSource("src/service-debug/api-crawl/tiktok/tiktok-service.js");

  assert.match(ytSrc, /export async function consumeYoutubeSelection\(/);
  assert.match(ttSrc, /export async function consumeTikTokSelection\(/);

  // Cả hai luồng (reply có quote và chọn số không quote) đều đi qua dispatcher
  // chung và dùng chung một hàm consume duy nhất của provider.
  assert.match(ytSrc, /checkReplySelectionsMapData\(api, message\)/);
  assert.match(ttSrc, /checkReplySelectionsMapData\(api, message\)/);
  const ytConsumeCalls = (ytSrc.match(/consumeYoutubeSelection\(/g) || []).length;
  const ttConsumeCalls = (ttSrc.match(/consumeTikTokSelection\(/g) || []).length;
  assert.ok(ytConsumeCalls >= 2, "youtube onSelect must route through the single shared consume function");
  assert.ok(ttConsumeCalls >= 2, "tiktok onSelect must route through the single shared consume function");
});

// ---------------------------------------------------------------------------
// Free-form routing through the generic selection map
// ---------------------------------------------------------------------------

test("free-form number without quote invokes provider onSelect and claims the session atomically", async () => {
  const scheduler = createFakeScheduler();
  const calls = [];
  await registerSession({
    userId: "u-claim-basic",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      calls.push({ media, index, modifier });
      const claimed = await claim();
      if (!claimed) return false;
      return true;
    },
  });

  const message = createUserMessage("2", { uid: "u-claim-basic" });
  const handled = await checkReplySelectionsMapData(createApi(), message);

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].media.id, "m2");
  assert.equal(calls[0].index, 1);
  assert.equal(getSelectionsMapData().has("u-claim-basic"), false);

  await scheduler.stepAll();
  await Promise.resolve();

  const record = getSelectionsMapData().get("u-claim-basic");
  assert.equal(record, undefined);
});

test("free-form '1 audio' passes the audio modifier to the provider callback", async () => {
  const scheduler = createFakeScheduler();
  const seen = [];
  await registerSession({
    userId: "u-modifier",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      seen.push(modifier);
      return await claim();
    },
  });

  await checkReplySelectionsMapData(createApi(), createUserMessage("1 audio", { uid: "u-modifier" }));

  assert.deepEqual(seen, ["audio"]);
});

test("non-numeric message does not consume the session and falls through to normal chat", async () => {
  const scheduler = createFakeScheduler();
  let invoked = false;
  await registerSession({
    userId: "u-text",
    scheduler,
    onSelect: async () => {
      invoked = true;
      return true;
    },
  });

  const handled = await checkReplySelectionsMapData(
    createApi(),
    createUserMessage("hello bot", { uid: "u-text" })
  );

  assert.equal(handled, false);
  assert.equal(invoked, false);
  assert.equal(getSelectionsMapData().has("u-text"), true);
});

test("index zero, negative and out-of-range numbers do not claim or consume the session", async () => {
  const scheduler = createFakeScheduler();
  let invoked = false;
  await registerSession({
    userId: "u-range",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      invoked = true;
      return await claim();
    },
  });

  for (const content of ["0", "-1", "99"]) {
    const handled = await checkReplySelectionsMapData(
      createApi(),
      createUserMessage(content, { uid: "u-range" })
    );
    assert.equal(handled, false, `"${content}" must fall through`);
  }

  assert.equal(invoked, false);
  assert.equal(getSelectionsMapData().has("u-range"), true);
});

test("quoted replies never route through the generic free-form map", async () => {
  const scheduler = createFakeScheduler();
  let invoked = false;
  await registerSession({
    userId: "u-quote-guard",
    scheduler,
    onSelect: async () => {
      invoked = true;
      return true;
    },
  });

  const quoted = createUserMessage("2", { uid: "u-quote-guard" });
  quoted.data.quote = { globalMsgId: "prompt-u-quote-guard", cliMsgId: "cli-x" };

  const handled = await checkReplySelectionsMapData(createApi(), quoted);
  assert.equal(handled, false);
  assert.equal(invoked, false);
});

test("latest search replaces the previous session of the same user", async () => {
  const scheduler = createFakeScheduler();
  const firstCalls = [];
  const secondCalls = [];

  await registerSession({
    userId: "u-replace",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      firstCalls.push(media);
      return await claim();
    },
  });
  await registerSession({
    userId: "u-replace",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      secondCalls.push(media);
      return await claim();
    },
  });

  const handled = await checkReplySelectionsMapData(
    createApi(),
    createUserMessage("1", { uid: "u-replace" })
  );

  assert.equal(handled, true);
  assert.equal(firstCalls.length, 0, "replaced session must not be consumable");
  assert.equal(secondCalls.length, 1);
  assert.equal(secondCalls[0].id, "m1");
});

test("free-form selection is keyed by sender across threads, not by thread", async () => {
  const scheduler = createFakeScheduler();
  const calls = [];
  await registerSession({
    userId: "u-cross",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      calls.push(message.threadId);
      return await claim();
    },
  });

  const handled = await checkReplySelectionsMapData(
    createApi(),
    createUserMessage("3", { uid: "u-cross", threadId: "g-other-thread" })
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, ["g-other-thread"]);
});

test("two concurrent valid selections claim atomically and only one consumes", async () => {
  const scheduler = createFakeScheduler();
  const outcomes = [];
  await registerSession({
    userId: "u-race",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      const claimed = await claim();
      outcomes.push(claimed);
      return claimed;
    },
  });

  const results = await Promise.all([
    checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-race" })),
    checkReplySelectionsMapData(createApi(), createUserMessage("2", { uid: "u-race" })),
  ]);

  assert.equal(outcomes.filter(Boolean).length, 1, "only one concurrent selection may win the claim");
  // Người thắng claim tiêu thụ tin nhắn; người thua trong lúc inFlight nhận
  // thông báo đang xử lý (cũng trả true vì tin nhắn đã được xử lý).
  assert.equal(results.every((r) => r === true), true);
  assert.equal(getSelectionsMapData().has("u-race"), false);
});

test("expired session is removed after TTL and cannot be consumed", async () => {
  const scheduler = createFakeScheduler();
  let expired = false;
  let invoked = false;
  await registerSession({
    userId: "u-ttl",
    scheduler,
    seconds: 60,
    onSelect: async () => {
      invoked = true;
      return true;
    },
    onExpire: async () => {
      expired = true;
    },
  });

  await scheduler.stepAll();

  assert.equal(expired, true);
  const handled = await checkReplySelectionsMapData(
    createApi(),
    createUserMessage("1", { uid: "u-ttl" })
  );
  assert.equal(handled, false);
  assert.equal(invoked, false);
});

test("claimed session survives past TTL and download/upload window may finish after 60s", async () => {
  const scheduler = createFakeScheduler();
  let expired = false;
  let sendCompleted = false;
  await registerSession({
    userId: "u-ttl-claim",
    scheduler,
    seconds: 60,
    onSelect: async (media, index, modifier, message, claim) => {
      const claimed = await claim();
      if (!claimed) return false;
      await scheduler.stepAll();
      sendCompleted = true;
      return true;
    },
    onExpire: async () => {
      expired = true;
    },
  });

  await checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-ttl-claim" }));

  assert.equal(sendCompleted, true, "selection flow must complete even when stepping past TTL");
  assert.equal(expired, false, "claimed sessions must not fire onExpire afterwards");
});

// ---------------------------------------------------------------------------
// YouTube consume behavior
// ---------------------------------------------------------------------------

const ytRecord = (overrides = {}) => ({
  userRequest: "u-yt",
  quotedMsgId: "yt-prompt-1",
  collection: baseCollection,
  ...overrides,
});

test("youtube consume enforces the 30 minute limit using duration in seconds for non-admins", async () => {
  const api = createApi();
  const claims = [];
  const sent = [];
  const overLimit = await consumeYoutubeSelection(api, createUserMessage("1", { uid: "u-yt-user" }), {
    video: { videoId: "v1", duration: 1900, url: "https://youtube.com/watch?v=v1" },
    qualityParam: "default",
    claim: async () => {
      claims.push(true);
      return true;
    },
    record: ytRecord(),
    sendMedia: async () => {
      sent.push(true);
      return true;
    },
  });

  assert.equal(overLimit.ok, false, "over-limit selection must not be a success");
  assert.equal(overLimit.claimed, false, "over-limit selection must not claim the session");
  assert.equal(sent.length, 0);
  assert.ok(api.warnings.join("\n").includes("30 phut"));

  const underLimit = await consumeYoutubeSelection(api, createUserMessage("1", { uid: "u-yt-user" }), {
    video: { videoId: "v2", duration: 1799, url: "https://youtube.com/watch?v=v2" },
    qualityParam: "default",
    claim: async () => {
      claims.push(true);
      return true;
    },
    record: ytRecord(),
    sendMedia: async () => {
      sent.push(true);
      return true;
    },
  });

  assert.equal(underLimit.ok, true, "under-limit selection must succeed after claiming once");
  assert.equal(claims.length, 1, "under-limit selection must claim exactly once");
  assert.equal(sent.length, 1);
});

test("youtube consume claims only after validation passes and cleans up both maps by session owner", async () => {
  const scheduler = createFakeScheduler();
  const sentQualities = [];
  const { api } = await registerSession({
    userId: "u-yt-owner",
    scheduler,
    collection: [{ id: "yt-1", duration: 120, videoId: "yt-1", title: "song" }],
    onSelect: async (media, index, modifier, message, claim) =>
      consumeYoutubeSelection(api, message, {
        video: media,
        qualityParam: modifier,
        claim,
        record: {
          userRequest: "u-yt-owner",
          quotedMsgId: "yt-owner-prompt",
          selectionSession: getSelectionsMapData().get("u-yt-owner")?.selectionSession,
        },
        sendMedia: async (apiArg, messageArg, videoArg, qualityParam) => {
          sentQualities.push(qualityParam);
          return true;
        },
      }),
  });

  const handled = await checkReplySelectionsMapData(
    api,
    createUserMessage("1 audio", { uid: "u-yt-owner", threadId: "g-other-thread" })
  );

  assert.equal(handled, true);
  assert.deepEqual(sentQualities, ["audio"]);
  assert.equal(
    getSelectionsMapData().has("u-yt-owner"),
    false,
    "generic map entry owned by the requester must be released"
  );
  assert.equal(api.undos.length, 1, "prompt must be recalled exactly once");
});

test("youtube public quote reply from another user releases the generic session of the original requester", async () => {
  const scheduler = createFakeScheduler();
  const userId = "u-yt-quote-owner";
  const collection = [{ id: "yt-q", duration: 60, videoId: "yt-q", title: "song" }];
  const { api } = await registerSession({ userId, scheduler, collection });

  const record = getSelectionsMapData().get(userId);
  assert.ok(record, "session must exist before consumption");

  const fanMessage = createUserMessage("1", { uid: "u-random-fan", threadId: "g-origin" });
  const claimResult = await record.selectionSession.claim(null, fanMessage);
  assert.equal(claimResult.ok, true);

  assert.equal(
    getSelectionsMapData().has(userId),
    true,
    "claim alone must not remove the entry until provider cleanup runs"
  );
  const released = releaseSelectionsMapData(record.userRequest, record.selectionSession);

  assert.equal(released, true);
  assert.equal(getSelectionsMapData().has(userId), false);
  assert.equal(api.undos.length, 1, "prompt recalled exactly once for the quoted consumption");
});

test("youtube consume classifies download/upload/send/unavailable/auth/runtime/timeout errors", async () => {
  const api = createApi();
  const failingSend = (error) => async () => {
    throw error;
  };

  const runConsume = (sendMediaFn) =>
    consumeYoutubeSelection(api, createUserMessage("1", { uid: "u-err" }), {
      video: { videoId: "v", duration: 60 },
      qualityParam: "default",
      claim: async () => true,
      record: ytRecord(),
      sendMedia: sendMediaFn,
    });

  const uploadErr = new Error("[youtube:upload] boom");
  uploadErr.stage = "upload";
  await runConsume(failingSend(uploadErr));
  assert.ok(api.warnings.some((w) => w.includes("Tai len video that bai")));

  const sendErr = new Error("[youtube:send] boom");
  sendErr.stage = "send";
  await runConsume(failingSend(sendErr));
  assert.ok(api.warnings.some((w) => w.includes("Khong the gui video sau khi tai len")));

  const unavailableErr = new Error("Video unavailable");
  await runConsume(failingSend(unavailableErr));
  assert.ok(api.warnings.some((w) => w.includes("khong kha dung")));

  const authErr = new Error("sign in to confirm you are not a bot, cookie needed");
  await runConsume(failingSend(authErr));
  assert.ok(api.warnings.some((w) => w.includes("cookie hoac dang nhap")));

  const runtimeErr = new Error("deno binary not found");
  await runConsume(failingSend(runtimeErr));
  assert.ok(api.warnings.some((w) => w.includes("runtime YouTube")));

  const timeoutErr = new Error("etimedout after 30000ms");
  await runConsume(failingSend(timeoutErr));
  assert.ok(api.warnings.some((w) => w.includes("qua thoi gian cho phep")));
});

test("youtube consume forwards supported modifiers default/audio/low/high/max to the sender", async () => {
  const api = createApi();
  const received = [];
  for (const modifier of ["default", "audio", "low", "high", "max", undefined]) {
    await consumeYoutubeSelection(api, createUserMessage(`1 ${modifier ?? ""}`.trim(), { uid: "u-q" }), {
      video: { videoId: "v", duration: 60 },
      qualityParam: modifier,
      claim: async () => true,
      record: ytRecord(),
      sendMedia: async (apiArg, message, video, qualityParam) => {
        received.push(qualityParam);
        return true;
      },
    });
  }
  assert.deepEqual(received, ["default", "audio", "low", "high", "max", "default"]);
});

test("youtube consume does not double-send when the claim was already taken", async () => {
  const api = createApi();
  const sent = [];
  const result = await consumeYoutubeSelection(api, createUserMessage("1", { uid: "u-loser" }), {
    video: { videoId: "v", duration: 60 },
    qualityParam: "default",
    claim: async () => false,
    record: ytRecord(),
    sendMedia: async () => {
      sent.push(true);
      return true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.claimed, false, "loser of the claim race must report unclaimed");
  assert.equal(sent.length, 0, "loser of the claim race must not send media");
});

// ---------------------------------------------------------------------------
// TikTok consume behavior
// ---------------------------------------------------------------------------

const ttVideo = {
  id: "tt-1",
  kind: "video",
  desc: "clip",
  author: { uniqueId: "a1", nickname: "A1" },
  video: { url: "https://cdn/video.mp4", cover: "https://cdn/cover.jpg", quality: "720p" },
  images: [],
  music: { url: "https://cdn/music.mp3", title: "sound" },
  stat: { playCount: 1 },
};

test("tiktok consume maps audio modifier and uses real video quality otherwise with 540p fallback", async () => {
  const api = createApi();
  const receivedTypes = [];

  await consumeTikTokSelection(api, createUserMessage("1 audio", { uid: "u-tt" }), {
    media: ttVideo,
    modifier: "audio",
    claim: async () => true,
    record: ytRecord(),
    sendMedia: async (apiArg, message, media, options) => {
      receivedTypes.push(options.typeVideo);
      return true;
    },
  });

  await consumeTikTokSelection(api, createUserMessage("1", { uid: "u-tt" }), {
    media: ttVideo,
    modifier: undefined,
    claim: async () => true,
    record: ytRecord(),
    sendMedia: async (apiArg, message, media, options) => {
      receivedTypes.push(options.typeVideo);
      return true;
    },
  });

  const slideshow = { ...ttVideo, id: "tt-slide", kind: "slideshow", video: null, images: [{ url: "https://cdn/i.jpg", extension: "jpg" }] };
  await consumeTikTokSelection(api, createUserMessage("2", { uid: "u-tt" }), {
    media: slideshow,
    modifier: undefined,
    claim: async () => true,
    record: ytRecord(),
    sendMedia: async (apiArg, message, media, options) => {
      receivedTypes.push(options.typeVideo);
      return true;
    },
  });

  assert.deepEqual(receivedTypes, ["audio", "720p", "540p"]);
});

test("tiktok consume claims then releases both maps using the session owner", async () => {
  const scheduler = createFakeScheduler();
  const events = [];
  const { api } = await registerSession({
    userId: "u-tt-owner",
    scheduler,
    collection: [ttVideo],
    onSelect: async (media, index, modifier, message, claim) => {
      events.push("validate");
      return consumeTikTokSelection(api, message, {
        media,
        modifier,
        claim,
        record: {
          userRequest: "u-tt-owner",
          quotedMsgId: "tt-owner-prompt",
          selectionSession: getSelectionsMapData().get("u-tt-owner")?.selectionSession,
        },
        sendMedia: async () => {
          events.push("send");
          return true;
        },
      });
    },
  });

  const handled = await checkReplySelectionsMapData(api, createUserMessage("1", { uid: "u-tt-owner" }));

  assert.equal(handled, true);
  assert.deepEqual(events, ["validate", "send"], "validation must run before sending");
  assert.equal(getSelectionsMapData().has("u-tt-owner"), false);
  assert.equal(api.undos.length, 1);
});

test("tiktok public quote reply from another user releases the generic session of the original requester", async () => {
  const scheduler = createFakeScheduler();
  const userId = "u-tt-quote-owner";
  const { api } = await registerSession({ userId, scheduler, collection: [ttVideo] });

  const record = getSelectionsMapData().get(userId);
  assert.ok(record);

  const fanMessage = createUserMessage("1 audio", { uid: "u-tiktok-fan", threadId: "g-origin" });
  const claimResult = await record.selectionSession.claim(null, fanMessage);
  assert.equal(claimResult.ok, true);

  const released = releaseSelectionsMapData(record.userRequest, record.selectionSession);
  assert.equal(released, true);
  assert.equal(getSelectionsMapData().has(userId), false);
  assert.equal(api.undos.length, 1);
});

test("tiktok consume does not double-send when losing the claim race", async () => {
  const api = createApi();
  const sent = [];
  const result = await consumeTikTokSelection(api, createUserMessage("1", { uid: "u-lost" }), {
    media: ttVideo,
    modifier: undefined,
    claim: async () => false,
    record: ytRecord(),
    sendMedia: async () => {
      sent.push(true);
      return true;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.claimed, false);
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// Captions tell users they can reply OR send the number directly
// ---------------------------------------------------------------------------

test("youtube search caption explains direct number sending without quote", () => {
  const src = readSource("src/service-debug/api-crawl/youtube/youtube-service.js");
  assert.match(src, /HOAC gui so thu tu|hoặc gửi số trực tiếp|gui so truc tiep/i);
});

test("tiktok search caption explains direct number sending without quote", () => {
  const src = readSource("src/service-debug/api-crawl/tiktok/tiktok-service.js");
  assert.match(src, /HOẶC gửi trực tiếp|hoặc gửi trực tiếp|HOAC gui truc tieP/i);
});
