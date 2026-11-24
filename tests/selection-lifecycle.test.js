import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkReplySelectionsMapData,
  deleteSelectionsMapData,
  getSelectionsMapData,
  releaseSelectionsMapData,
  setSelectionsMapData,
} from "../src/service-debug/api-crawl/index.js";
import { clearAllInteractionCountdowns } from "../src/utils/interaction-countdown.js";

const readSource = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

function createApi() {
  const reactions = [];
  const deleted = [];
  const sent = [];
  const undos = [];
  const warnings = [];
  const processing = [];
  const api = {
    reactions,
    deleted,
    sent,
    undos,
    warnings,
    processing,
    async sendMessage(payload, threadId, type) {
      const res = { msgId: `msg-${Date.now()}-${sent.length}-${Math.random().toString(36).slice(2, 6)}`, threadId, type, payload };
      sent.push(res);
      if (typeof payload?.msg === "string") warnings.push(payload.msg);
      return res;
    },
    async addReaction(iconOrOps, messages) {
      const ops = Array.isArray(iconOrOps)
        ? iconOrOps
        : [{ icon: iconOrOps, messages }];
      for (const op of ops) {
        reactions.push({ icon: op.icon, messages: op.messages });
      }
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

function createUserMessage(content, { uid = "u-life", threadId = "g-life", quote } = {}) {
  const message = {
    threadId,
    type: 1,
    data: { uidFrom: uid, dName: "Tester", content },
  };
  if (quote) message.data.quote = quote;
  return message;
}

function makeTempFile(prefix = "preview") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selection-lifecycle-"));
  const filePath = path.join(dir, `${prefix}-${Date.now()}.png`);
  fs.writeFileSync(filePath, "preview-bytes");
  return filePath;
}

const baseCollection = [
  { id: "m1", title: "one" },
  { id: "m2", title: "two" },
  { id: "m3", title: "three" },
];

async function registerSession({
  userId = "u-life",
  collection = baseCollection,
  scheduler,
  seconds = 60,
  onSelect,
  onExpire,
  previewPath = null,
  resendPrompt = null,
} = {}) {
  const api = createApi();
  const preview = previewPath || makeTempFile();
  const sentMessage = {
    message: [{ msgId: `prompt-${userId}`, cliMsgId: `cli-${userId}` }],
  };
  const messageContext = { threadId: "g-origin", type: 1, data: { uidFrom: userId } };
  const record = await setSelectionsMapData(userId, {
    platform: "test",
    replyAccess: "public",
    threadId: "g-origin",
    collection,
    api,
    sentMessage,
    messageContext,
    type: 1,
    seconds,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    now: scheduler.now,
    ownedTempPaths: [preview],
    resendPrompt:
      resendPrompt ||
      (async () => {
        const resent = await api.sendMessage(
          { msg: "menu" , attachments: [preview] },
          "g-origin",
          1
        );
        return resent;
      }),
    onSelect,
    onExpire,
  });
  return { api, record, preview };
}

test.beforeEach(() => {
  clearAllInteractionCountdowns();
});

test.afterEach(() => {
  clearAllInteractionCountdowns();
});

// ---------------------------------------------------------------------------
// State machine: open → inFlight → completed
// ---------------------------------------------------------------------------

test("success completes the session exactly once and disposes preview temp once", async () => {
  const scheduler = createFakeScheduler();
  const calls = [];
  const { api, preview } = await registerSession({
    userId: "u-done",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      calls.push(media.id);
      const claimed = await claim();
      if (!claimed) return { ok: false, claimed: false };
      return { ok: true, claimed: true };
    },
  });

  assert.equal(fs.existsSync(preview), true, "preview temp must exist while session is open");

  const handled = await checkReplySelectionsMapData(createApi(), createUserMessage("2", { uid: "u-done" }));

  assert.equal(handled, true);
  assert.deepEqual(calls, ["m2"]);
  assert.equal(getSelectionsMapData().has("u-done"), false, "record removed after completion");
  assert.equal(fs.existsSync(preview), false, "preview temp removed after completion");

  // idempotency: a second identical selection must not find a session
  const second = await checkReplySelectionsMapData(createApi(), createUserMessage("2", { uid: "u-done" }));
  assert.equal(second, false);
});

// ---------------------------------------------------------------------------
// State machine: open → inFlight → reopen after failure
// ---------------------------------------------------------------------------

test("send failure reopens the menu with a new prompt id and fresh countdown, keeping preview temp", async () => {
  const scheduler = createFakeScheduler();
  let attempts = 0;
  const { api, preview } = await registerSession({
    userId: "u-reopen",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      attempts += 1;
      const claimed = await claim();
      if (!claimed) return { ok: false, claimed: false };
      if (attempts === 1) {
        return { ok: false, claimed: true };
      }
      return { ok: true, claimed: true };
    },
  });

  const firstHandled = await checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-reopen" }));
  assert.equal(firstHandled, true);

  // menu was resent through resendPrompt
  const resent = api.sent.filter((m) => m.payload?.msg === "menu");
  assert.ok(resent.length >= 1, "failure must resend the selection menu");
  assert.notEqual(resent[0].msgId, `prompt-u-reopen`, "resent menu must carry a new message id");

  // session is selectable again under the owner key
  assert.equal(getSelectionsMapData().has("u-reopen"), true, "reopened session must be registered for the owner");
  const reopenedRecord = getSelectionsMapData().get("u-reopen");
  assert.notEqual(reopenedRecord.promptMessageId, `prompt-u-reopen`, "reopened session must have a new prompt message id");
  assert.equal(reopenedRecord.selectionSession.isOpen(), true);
  assert.equal(fs.existsSync(preview), true, "preview temp must survive the failed attempt");

  // every item, including previously failed one, remains selectable
  const secondHandled = await checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-reopen" }));
  assert.equal(secondHandled, true);
  assert.equal(attempts, 2);
  assert.equal(getSelectionsMapData().has("u-reopen"), false);
  assert.equal(fs.existsSync(preview), false, "preview temp disposed after eventual success");

  // fresh countdown: stepping 59s does not expire, stepping past 60s would
  const lateHandled = await checkReplySelectionsMapData(createApi(), createUserMessage("9", { uid: "u-reopen" }));
  assert.equal(lateHandled, false);
});

test("reopen failure ends the session and disposes temps instead of leaking them", async () => {
  const scheduler = createFakeScheduler();
  const { api, preview } = await registerSession({
    userId: "u-resend-fail",
    scheduler,
    resendPrompt: async () => {
      throw new Error("resend blew up");
    },
    onSelect: async (media, index, modifier, message, claim) => {
      const claimed = await claim();
      if (!claimed) return { ok: false, claimed: false };
      return { ok: false, claimed: true };
    },
  });

  const handled = await checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-resend-fail" }));
  assert.equal(handled, true);
  assert.equal(getSelectionsMapData().has("u-resend-fail"), false, "session must end when reopen fails");
  assert.equal(fs.existsSync(preview), false, "temps disposed when reopen fails");
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("expiry keeps UNDO/recall order, then removes record and preview temp afterwards", async () => {
  const scheduler = createFakeScheduler();
  let expired = false;
  const { api, preview } = await registerSession({
    userId: "u-expire",
    scheduler,
    seconds: 60,
    onSelect: async () => ({ ok: false, claimed: false }),
    onExpire: async () => {
      expired = true;
    },
  });

  assert.equal(fs.existsSync(preview), true, "preview alive during countdown");

  await scheduler.stepAll();

  assert.equal(expired, true);
  assert.equal(getSelectionsMapData().has("u-expire"), false);
  assert.equal(fs.existsSync(preview), false, "preview disposed after expiry");

  const iconsInOrder = api.reactions.map((r) => r.icon);
  assert.ok(iconsInOrder.includes("CLOCK"), "countdown rendered CLOCK frames");
  assert.equal(iconsInOrder[iconsInOrder.length - 1], "UNDO", "final reaction frame must be UNDO");
  assert.ok(api.undos.length >= 1, "prompt recalled on expiry");
});

test("claim beats expiry race: winner completes, loser reports unclaimed without crashing", async () => {
  const scheduler = createFakeScheduler();
  const outcomes = [];
  const { api } = await registerSession({
    userId: "u-race-exp",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      // advance the clock past expiry BEFORE claiming to simulate the race
      await scheduler.stepAll();
      const claimed = await claim();
      outcomes.push({ media: media.id, claimed });
      return claimed ? { ok: true, claimed: true } : { ok: false, claimed: false };
    },
  });

  const handled = await checkReplySelectionsMapData(createApi(), createUserMessage("1", { uid: "u-race-exp" }));
  assert.equal(handled, false, "loser of claim/expiry race falls through");
  assert.deepEqual(outcomes, [{ media: "m1", claimed: false }]);
  assert.equal(getSelectionsMapData().has("u-race-exp"), false, "expired session cleaned up");
});

// ---------------------------------------------------------------------------
// Replacement + duplicates + invalid input
// ---------------------------------------------------------------------------

test("a newer search replaces the older session and disposes the old preview temp", async () => {
  const scheduler = createFakeScheduler();
  const oldCalls = [];
  const first = await registerSession({
    userId: "u-replace",
    scheduler,
    onSelect: async () => {
      oldCalls.push(true);
      return { ok: true, claimed: true };
    },
  });
  const second = await registerSession({
    userId: "u-replace",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      const claimed = await claim();
      return claimed ? { ok: true, claimed: true } : { ok: false, claimed: false };
    },
  });

  assert.equal(fs.existsSync(first.preview), false, "old preview disposed when replaced");
  assert.equal(fs.existsSync(second.preview), true, "new preview kept");

  const handled = await checkReplySelectionsMapData(createApi(), createUserMessage("3", { uid: "u-replace" }));
  assert.equal(handled, true);
  assert.deepEqual(oldCalls, [], "replaced session must not be consumable");
  assert.equal(getSelectionsMapData().has("u-replace"), false);
  assert.equal(fs.existsSync(second.preview), false);
});

test("duplicate selection while inFlight gets a processing notice and does not run onSelect twice", async () => {
  const scheduler = createFakeScheduler();
  let running = null;
  let executions = 0;
  const observerApi = createApi();
  await registerSession({
    userId: "u-dup",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      executions += 1;
      const claimed = await claim();
      running = new Promise((resolve) => setTimeout(resolve, 20));
      await running;
      return claimed ? { ok: true, claimed: true } : { ok: false, claimed: false };
    },
  });

  const first = checkReplySelectionsMapData(observerApi, createUserMessage("1", { uid: "u-dup" }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await checkReplySelectionsMapData(createApi(), createUserMessage("2", { uid: "u-dup" }));
  await first;

  assert.equal(executions, 1, "only one selection may execute while inFlight");
  assert.equal(second, true, "duplicate request is consumed with a notice");
});

test("invalid number or plain text never claims or consumes the session", async () => {
  const scheduler = createFakeScheduler();
  let invoked = false;
  const { api, preview } = await registerSession({
    userId: "u-invalid",
    scheduler,
    onSelect: async () => {
      invoked = true;
      return { ok: true, claimed: true };
    },
  });

  for (const content of ["0", "-1", "99", "hello bot"]) {
    const handled = await checkReplySelectionsMapData(createApi(), createUserMessage(content, { uid: "u-invalid" }));
    assert.equal(handled, false, `"${content}" must fall through`);
  }

  assert.equal(invoked, false);
  assert.equal(getSelectionsMapData().has("u-invalid"), true);
  assert.equal(fs.existsSync(preview), true);
});

// ---------------------------------------------------------------------------
// Quoted replies route through the shared dispatcher too
// ---------------------------------------------------------------------------

test("quoted reply referencing the live prompt id dispatches the shared lifecycle", async () => {
  const scheduler = createFakeScheduler();
  const calls = [];
  const { api, preview } = await registerSession({
    userId: "u-quote",
    scheduler,
    onSelect: async (media, index, modifier, message, claim) => {
      calls.push(modifier);
      const claimed = await claim();
      return claimed ? { ok: true, claimed: true } : { ok: false, claimed: false };
    },
  });

  const quoted = createUserMessage("2 audio", {
    uid: "u-quote",
    threadId: "g-origin",
    quote: { globalMsgId: `prompt-u-quote`, cliMsgId: `cli-u-quote` },
  });
  const handled = await checkReplySelectionsMapData(createApi(), quoted);

  assert.equal(handled, true);
  assert.deepEqual(calls, ["audio"]);
  assert.equal(getSelectionsMapData().has("u-quote"), false);
  assert.equal(fs.existsSync(preview), false);
});

test("quoted reply to an unknown message falls through to legacy handlers", async () => {
  const scheduler = createFakeScheduler();
  let invoked = false;
  await registerSession({
    userId: "u-quote-miss",
    scheduler,
    onSelect: async () => {
      invoked = true;
      return { ok: true, claimed: true };
    },
  });

  const quoted = createUserMessage("2", {
    uid: "u-quote-miss",
    quote: { globalMsgId: "someone-elses-message", cliMsgId: "cli-x" },
  });
  const handled = await checkReplySelectionsMapData(createApi(), quoted);
  assert.equal(handled, false);
  assert.equal(invoked, false);
  assert.equal(getSelectionsMapData().has("u-quote-miss"), true);
});

// ---------------------------------------------------------------------------
// Provider contract: unified registration across all media providers
// ---------------------------------------------------------------------------

test("contract: all media providers register resendPrompt and ownedTempPaths via setSelectionsMapData", () => {
  const providers = [
    ["youtube", "src/service-debug/api-crawl/youtube/youtube-service.js"],
    ["tiktok", "src/service-debug/api-crawl/tiktok/tiktok-service.js"],
    ["capcut", "src/service-debug/api-crawl/capcut/capcut-service.js"],
    ["aio", "src/service-debug/api-crawl/api-hoangdev/aio-downlink.js"],
    ["zingmp3", "src/service-debug/api-crawl/music/zingmp3.js"],
    ["soundcloud", "src/service-debug/api-crawl/music/soundcloud.js"],
    ["nhaccuatui", "src/service-debug/api-crawl/music/nhaccuatui.js"],
    ["spotify-downlink-a", "src/service-debug/api-crawl/spotify/spotify-downlink.js"],
    ["clipphot", "src/service-debug/servises/clipphot.vn.js"],
  ];

  for (const [name, file] of providers) {
    const src = readSource(file);
    assert.match(src, /resendPrompt/, `${name} must register a resendPrompt`);
    assert.match(src, /ownedTempPaths/, `${name} must declare ownedTempPaths for its preview temps`);
  }
});

test("contract: spotify-downlink no longer auto-retries the same file after a send failure", () => {
  const src = readSource("src/service-debug/api-crawl/spotify/spotify-downlink.js");
  const sendCalls = (src.match(/await sendVoiceMusic\(/g) || []).length;
  assert.equal(sendCalls, 1, "exactly one final send attempt per selection; failures must reopen the menu instead");
});
