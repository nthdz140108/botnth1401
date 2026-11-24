import test from "node:test";
import assert from "node:assert/strict";
import {
  startInteractionCountdown,
  completeInteractionCountdown,
  cancelInteractionCountdown,
  showCooldownClock,
  normalizeMessageReference,
  isValidReactionTarget,
  clearAllInteractionCountdowns,
  hasInteractionCountdown,
  createDownloadProgress,
  openMediaSelection,
  buildCountdownReaction,
  replaceCountdownReactionFrame,
  recallBotMessage,
  extractMessageId,
} from "../src/utils/interaction-countdown.js";
import { ReactionMap } from "../src/api-zalo/models/Reaction.js";
import { MessageType } from "../src/api-zalo/models/Message.js";

function createMockApi() {
  const reactionCalls = [];
  const reactionRequests = [];
  const deleteCalls = [];
  const undoCalls = [];

  return {
    reactionCalls,
    reactionRequests,
    deleteCalls,
    undoCalls,
    async addReaction(iconOrOps, messages) {
      const ops = Array.isArray(iconOrOps)
        ? iconOrOps
        : [{ icon: iconOrOps, messages }];
      if (ops.length === 0) throw new Error("No reactions to apply");
      const recordedOps = ops.map((op) => {
        const msgs = Array.isArray(op.messages) ? op.messages : [op.messages];
        const isGroup = msgs[0]?.type === MessageType.GroupMessage;
        const isCustom = op.icon && typeof op.icon === "object";
        const rIcon = isCustom ? op.icon.icon : (ReactionMap[op.icon]?.text ?? op.icon);
        const rType = isCustom ? op.icon.rType : (ReactionMap[op.icon]?.rType ?? 0);
        return {
          icon: op.icon,
          rIcon,
          rType,
          count: msgs.length,
          threadId: msgs[0]?.threadId,
          type: msgs[0]?.type,
          isGroup,
          firstMsgId: msgs[0]?.data?.msgId || msgs[0]?.msgId,
          firstCliMsgId: msgs[0]?.data?.cliMsgId || msgs[0]?.cliMsgId,
          rMsg: msgs.map((m) => ({
            gMsgID: parseInt(m.data?.msgId || m.msgId),
            cMsgID: parseInt(m.data?.cliMsgId || m.cliMsgId || m.data?.msgId),
            msgType: parseInt(m.type),
          })),
        };
      });
      reactionCalls.push(...recordedOps);
      reactionRequests.push(recordedOps);
      return { icon: ops.length === 1 ? ops[0].icon : recordedOps.map((o) => o.icon) };
    },
    async undoMessage(message) {
      undoCalls.push({ message });
      return { status: 0 };
    },
    async deleteMessage(message, onlyMe) {
      deleteCalls.push({ message, onlyMe });
      return { status: 0 };
    },
  };
}

function createFakeScheduler(initialTime = 1000000) {
  const timers = new Map();
  let timerSeq = 0;
  let currentTime = initialTime;

  const now = () => currentTime;

  const schedule = (callback, delay) => {
    const id = ++timerSeq;
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
    currentTime += (entry.delay || 1000);
    await entry.callback();
    return true;
  };

  const stepAll = async () => {
    let count = 0;
    while (timers.size > 0 && count < 1000) {
      await step();
      count += 1;
    }
  };

  return { schedule, cancelSchedule, step, stepAll, now, timers };
}

test.beforeEach(() => {
  clearAllInteractionCountdowns();
});

test("normalizes various message structures correctly", () => {
  const msg1 = {
    type: 1,
    threadId: "thread-123",
    data: { msgId: "1001", cliMsgId: "2001", uidFrom: "user-1" },
  };
  const norm1 = normalizeMessageReference(msg1);
  assert.equal(norm1.type, 1);
  assert.equal(norm1.threadId, "thread-123");
  assert.equal(norm1.data.msgId, "1001");
  assert.equal(norm1.data.cliMsgId, "2001");

  const sendResponse = {
    message: [{ msgId: "3001", cliMsgId: "4001" }],
  };
  const norm2 = normalizeMessageReference(sendResponse, "thread-456", 1, "bot-1");
  assert.equal(norm2.type, 1);
  assert.equal(norm2.threadId, "thread-456");
  assert.equal(norm2.data.msgId, "3001");
  assert.equal(norm2.data.cliMsgId, "4001");
  assert.equal(norm2.data.uidFrom, "bot-1");
});

test("normalizes attachment response without losing globalMsgId or cliMsgId", () => {
  const sent = {
    message: null,
    attachment: [{
      msgId: "local-attachment-11",
      globalMsgId: "global-attachment-22",
      cliMsgId: "client-attachment-33",
    }],
    link: null,
  };
  const context = {
    threadId: "group-selection-44",
    type: 1,
    data: { uidFrom: "requester-55" },
  };

  const ref = normalizeMessageReference(sent, context);
  assert.equal(ref.threadId, "group-selection-44");
  assert.equal(ref.type, 1);
  assert.equal(ref.data.msgId, "local-attachment-11");
  assert.equal(ref.data.globalMsgId, "global-attachment-22");
  assert.equal(ref.data.cliMsgId, "client-attachment-33");
});

test("normalizeMessageReference does not fabricate cliMsgId from msgId when cliMsgId is missing", () => {
  const ref = normalizeMessageReference(
    { attachment: [{ msgId: "server-only-1" }] },
    { threadId: "direct-1", type: 0 }
  );
  assert.equal(ref.data.msgId, "server-only-1");
  assert.equal(ref.data.cliMsgId, "");
});

test("normalizes message reference with context when response lacks threadId and type", () => {
  const botSendResponse = {
    message: { msgId: "99001", cliMsgId: "99002" },
    attachment: [],
    link: null,
  };
  const messageContext = {
    threadId: "group-target-777",
    type: 1,
    data: { uidFrom: "user-sender-555" },
  };

  const norm = normalizeMessageReference(botSendResponse, messageContext);
  assert.equal(norm.threadId, "group-target-777");
  assert.equal(norm.type, 1);
  assert.equal(norm.data.msgId, "99001");
  assert.equal(norm.data.cliMsgId, "99002");
  assert.equal(norm.data.uidFrom, "user-sender-555");
  assert.equal(isValidReactionTarget(norm), true);
});

test("normalizes attachment-only and link response with context", () => {
  // Case: attachment response without root msgId/type/threadId
  const attachmentResponse = {
    message: null,
    attachment: [{ photoId: "photo-888999", clientId: "client-111222" }],
    link: null,
  };
  const directContext = {
    threadId: "direct-user-123",
    type: 0,
    uidFrom: "direct-user-123",
  };
  const normAttach = normalizeMessageReference(attachmentResponse, directContext);
  assert.equal(normAttach.threadId, "direct-user-123");
  assert.equal(normAttach.type, 0);
  assert.equal(normAttach.data.msgId, "photo-888999");
  assert.equal(normAttach.data.cliMsgId, "client-111222");
  assert.equal(isValidReactionTarget(normAttach), true);

  // Case: link response
  const linkResponse = {
    message: null,
    attachment: [],
    link: { data: { msgId: "link-555444", cliMsgId: "link-cli-333" } },
  };
  const groupContext = {
    threadId: "group-456",
    type: 1,
  };
  const normLink = normalizeMessageReference(linkResponse, groupContext);
  assert.equal(normLink.threadId, "group-456");
  assert.equal(normLink.type, 1);
  assert.equal(normLink.data.msgId, "link-555444");
  assert.equal(normLink.data.cliMsgId, "link-cli-333");
  assert.equal(isValidReactionTarget(normLink), true);
});

test("reaction payload verifies standard reaction 'CLOCK', group endpoint routing and batch count", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();

  // Response without threadId/type, complemented by group messageContext
  const botResponse = {
    message: [{ msgId: "123456", cliMsgId: "654321" }],
  };
  const messageContext = {
    threadId: "group-chat-room-1",
    type: 1,
    data: { uidFrom: "requester-user-1" },
  };

  startInteractionCountdown({
    key: "countdown-payload-check",
    api,
    message: botResponse,
    messageContext,
    seconds: 3,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  // Initial reaction call check: 3 standard reactions 'CLOCK'
  assert.equal(api.reactionCalls.length, 1);
  const initialReaction = api.reactionCalls[0];
  assert.equal(initialReaction.icon, "CLOCK");
  assert.equal(initialReaction.rIcon, "🕑");
  assert.equal(initialReaction.rType, 55);
  assert.equal(initialReaction.type, 1);
  assert.equal(initialReaction.threadId, "group-chat-room-1");
  assert.equal(initialReaction.isGroup, true);
  assert.equal(initialReaction.count, 3);
  assert.equal(initialReaction.rMsg.length, 3);
  assert.deepEqual(initialReaction.rMsg[0], { gMsgID: 123456, cMsgID: 654321, msgType: 1 });

  // Tick 1: ONE request carrying UNDO x 3 then CLOCK x 2
  await scheduler.step();
  assert.equal(api.reactionCalls.length, 3);
  assert.equal(api.reactionCalls[1].icon, "UNDO");
  assert.equal(api.reactionCalls[1].count, 3);
  assert.equal(api.reactionCalls[2].icon, "CLOCK");
  assert.equal(api.reactionCalls[2].count, 2);

  assert.equal(api.reactionRequests.length, 2);
  assert.equal(api.reactionRequests[0].length, 1);
  assert.deepEqual(
    api.reactionRequests[1].map(({ icon, count }) => [icon, count]),
    [["UNDO", 3], ["CLOCK", 2]]
  );
});

test("counts down sequence N -> ... -> 1 -> 0 with matching 🕑, UNDO per tick and recalls via undoMessage", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "msg-1", cliMsgId: "cli-1" },
  };

  let expired = false;
  startInteractionCountdown({
    key: "test-countdown-1",
    api,
    message,
    seconds: 3,
    deleteOnExpire: true,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  // Step all 3 seconds to expiry
  await scheduler.stepAll();

  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
    [
      { icon: "CLOCK", count: 3 },
      { icon: "UNDO", count: 3 },
      { icon: "CLOCK", count: 2 },
      { icon: "UNDO", count: 2 },
      { icon: "CLOCK", count: 1 },
      { icon: "UNDO", count: 1 },
    ]
  );

  // Verify expiry called and prompt recalled via undoMessage (NOT deleteMessage)
  assert.equal(expired, true);
  assert.equal(api.undoCalls.length, 1);
  assert.equal(api.undoCalls[0].message.data.msgId, "msg-1");
  assert.equal(api.deleteCalls.length, 0);
  assert.equal(hasInteractionCountdown("test-countdown-1"), false);
});

test("completeInteractionCountdown stops timer, undoes remaining active reactions, and prevents late expire", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "msg-1", cliMsgId: "cli-1" },
  };

  let expired = false;
  startInteractionCountdown({
    key: "test-complete-1",
    api,
    message,
    seconds: 5,
    deleteOnExpire: true,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();
  assert.equal(api.reactionCalls.length, 1);
  assert.equal(api.reactionCalls[0].icon, "CLOCK");
  assert.equal(api.reactionCalls[0].count, 5);

  // User replies validly after 1 tick
  await scheduler.step();
  // 1 tick elapsed: UNDO x 5, CLOCK x 4
  assert.equal(api.reactionCalls.length, 3);
  assert.equal(api.reactionCalls[1].icon, "UNDO");
  assert.equal(api.reactionCalls[1].count, 5);
  assert.equal(api.reactionCalls[2].icon, "CLOCK");
  assert.equal(api.reactionCalls[2].count, 4);

  // User completes interaction
  await completeInteractionCountdown("test-complete-1");

  // Verify UNDO was sent to remove remaining 4 reactions
  assert.equal(api.reactionCalls.length, 4);
  const lastReaction = api.reactionCalls[api.reactionCalls.length - 1];
  assert.equal(lastReaction.icon, "UNDO");
  assert.equal(lastReaction.count, 4);

  // Run any remaining timers if any
  await scheduler.stepAll();
  assert.equal(expired, false);
  assert.equal(api.undoCalls.length, 0);
  assert.equal(api.deleteCalls.length, 0);
  assert.equal(hasInteractionCountdown("test-complete-1"), false);
});

test("skips invalid reaction target without calling addReaction, logs warning once, and expires normally", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();

  // Invalid message target: missing msgId and cliMsgId
  const invalidMessage = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "", cliMsgId: "" },
  };

  const warnedLogs = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnedLogs.push(msg);

  try {
    let expired = false;
    startInteractionCountdown({
      key: "test-invalid-target",
      api,
      message: invalidMessage,
      seconds: 2,
      onExpire: async () => {
        expired = true;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    await Promise.resolve();
    // Step all ticks
    await scheduler.stepAll();

    // No reaction calls should have been made
    assert.equal(api.reactionCalls.length, 0);
    // Warning logged exactly once
    assert.equal(warnedLogs.length, 1);
    assert.match(warnedLogs[0], /Invalid reaction target/);
    // Expired normally
    assert.equal(expired, true);
  } finally {
    console.warn = originalWarn;
  }
});

test("failed reaction requests do not record confirmedReactions and do not spam error logs", async () => {
  let addReactionCallCount = 0;
  const failingApi = {
    async addReaction() {
      addReactionCallCount++;
      throw new Error("Temporary Zalo reaction 500 error");
    },
    async undoMessage() {
      return { status: 0 };
    },
  };
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-fail",
    data: { msgId: "fail-msg-1", cliMsgId: "fail-cli-1" },
  };

  const errorLogs = [];
  const originalError = console.error;
  console.error = (msg) => errorLogs.push(msg);

  try {
    let expired = false;
    startInteractionCountdown({
      key: "test-fail-dedup",
      api: failingApi,
      message,
      seconds: 3,
      onExpire: async () => {
        expired = true;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    await Promise.resolve();
    assert.equal(addReactionCallCount, 1);

    // Step 1: retries adding
    await scheduler.step();
    assert.equal(addReactionCallCount, 2);

    // Step 2: retries adding
    await scheduler.step();
    assert.equal(addReactionCallCount, 3);

    // Step 3: expires
    await scheduler.step();
    assert.equal(expired, true);

    const reactionErrorLogs = errorLogs.filter((l) =>
      typeof l === "string" && l.includes("reaction batch") && l.includes("Temporary Zalo reaction 500 error")
    );
    assert.equal(reactionErrorLogs.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("replacing session with the same key cancels old session and prevents late expiry", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message1 = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "msg-1", cliMsgId: "cli-1" },
  };
  const message2 = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "msg-2", cliMsgId: "cli-2" },
  };

  let oldExpired = false;
  let newExpired = false;

  startInteractionCountdown({
    key: "same-key",
    api,
    message: message1,
    seconds: 5,
    onExpire: async () => {
      oldExpired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  // Replace session
  startInteractionCountdown({
    key: "same-key",
    api,
    message: message2,
    seconds: 2,
    onExpire: async () => {
      newExpired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();
  await scheduler.stepAll();

  assert.equal(oldExpired, false, "old session should not expire");
  assert.equal(newExpired, true, "new session should expire");
});

test("showCooldownClock sends 🕑 <sec> immediately and renders decreasing frames per second", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "cmd-msg", cliMsgId: "cmd-cli" },
  };

  showCooldownClock({
    api,
    message,
    remainingMs: 3000,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  assert.equal(api.reactionCalls.length, 1);
  assert.equal(api.reactionCalls[0].icon, "CLOCK");
  assert.equal(api.reactionCalls[0].rIcon, "🕑");
  assert.equal(api.reactionCalls[0].count, 3);
  assert.equal(api.reactionCalls[0].firstMsgId, "cmd-msg");

  // Step 1: UNDO 3, CLOCK 2
  await scheduler.step();
  // Step 2: UNDO 2, CLOCK 1
  await scheduler.step();
  // Step 3: UNDO 1 (deadline reached)
  await scheduler.step();

  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
    [
      { icon: "CLOCK", count: 3 },
      { icon: "UNDO", count: 3 },
      { icon: "CLOCK", count: 2 },
      { icon: "UNDO", count: 2 },
      { icon: "CLOCK", count: 1 },
      { icon: "UNDO", count: 1 },
    ]
  );
});

test("delayed tick skips stale frame numbers and expires at authoritative deadline", async () => {
  const api = createMockApi();
  let currentTime = 1000000;
  const timers = new Map();
  let timerSeq = 0;
  const now = () => currentTime;
  const schedule = (cb, delay) => {
    const id = ++timerSeq;
    timers.set(id, { cb, delay: delay ?? 1000 });
    return id;
  };
  schedule.now = now;
  const cancelSchedule = (id) => timers.delete(id);

  const message = {
    type: 1,
    threadId: "t-delay",
    data: { msgId: "delay-msg-1", cliMsgId: "delay-cli-1" },
  };

  let expired = false;
  startInteractionCountdown({
    key: "test-delayed-tick",
    api,
    message,
    seconds: 5,
    onExpire: async () => {
      expired = true;
    },
    schedule,
    cancelSchedule,
    now,
  });

  await Promise.resolve();
  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
    [{ icon: "CLOCK", count: 5 }]
  );

  // Advance time by 2500ms before firing the scheduled tick
  currentTime += 2500;
  const [tId, entry] = timers.entries().next().value;
  timers.delete(tId);
  await entry.cb();

  // Next rendered frame is 3, not 4! (UNDO 5, CLOCK 3)
  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
    [
      { icon: "CLOCK", count: 5 },
      { icon: "UNDO", count: 5 },
      { icon: "CLOCK", count: 3 },
    ]
  );

  // Step 1000ms: currentTime = 1003500, remaining = 2 -> (UNDO 3, CLOCK 2)
  currentTime += 1000;
  const [tId2, entry2] = timers.entries().next().value;
  timers.delete(tId2);
  await entry2.cb();

  // Step 1000ms: currentTime = 1004500, remaining = 1 -> (UNDO 2, CLOCK 1)
  currentTime += 1000;
  const [tId3, entry3] = timers.entries().next().value;
  timers.delete(tId3);
  await entry3.cb();

  // Step 1000ms: currentTime = 1005500, remaining = 0 -> (UNDO 1)
  currentTime += 1000;
  const [tId4, entry4] = timers.entries().next().value;
  timers.delete(tId4);
  await entry4.cb();

  assert.equal(expired, true);
  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => ({ icon, count })),
    [
      { icon: "CLOCK", count: 5 },
      { icon: "UNDO", count: 5 },
      { icon: "CLOCK", count: 3 },
      { icon: "UNDO", count: 3 },
      { icon: "CLOCK", count: 2 },
      { icon: "UNDO", count: 2 },
      { icon: "CLOCK", count: 1 },
      { icon: "UNDO", count: 1 },
    ]
  );
});

test("90-second countdown: 50 + 40 frame then ONE-request transition UNDO 50+40 -> CLOCK 50+39", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-90",
    data: { msgId: "msg-90", cliMsgId: "cli-90" },
  };

  startInteractionCountdown({
    key: "test-90s-batch",
    api,
    message,
    seconds: 90,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  // Step 1 tick
  await scheduler.step();

  assert.deepEqual(
    api.reactionCalls.map(({ icon, count }) => [icon, count]),
    [
      ["CLOCK", 50], ["CLOCK", 40],
      ["UNDO", 50], ["UNDO", 40],
      ["CLOCK", 50], ["CLOCK", 39],
    ]
  );

  // Initial frame 90: ONE request, two CLOCK ops
  assert.equal(api.reactionRequests.length, 2);
  assert.deepEqual(
    api.reactionRequests[0].map(({ icon, count, rMsg }) => [icon, count, rMsg.length]),
    [["CLOCK", 50, 50], ["CLOCK", 40, 40]]
  );

  // Transition 90 -> 89: still ONE request, four ordered ops, each rMsg <= 50
  const transitionOps = api.reactionRequests[1];
  assert.equal(transitionOps.length, 4);
  assert.deepEqual(
    transitionOps.map(({ icon, count }) => [icon, count]),
    [["UNDO", 50], ["UNDO", 40], ["CLOCK", 50], ["CLOCK", 39]]
  );
  for (const op of transitionOps) {
    assert.ok(op.count <= 50, `each operation must not exceed 50 targets (got ${op.count})`);
    assert.equal(op.rMsg.length, op.count);
    assert.equal(op.rType, op.icon === "UNDO" ? -1 : 55);
  }
});

test("errors during addReaction or undoMessage do not block cleanup or expiry", async () => {
  const api = {
    async addReaction() {
      throw new Error("Network timeout adding reaction");
    },
    async undoMessage() {
      throw new Error("API error undoing message");
    },
  };
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "t-1",
    data: { msgId: "err-msg", cliMsgId: "err-cli" },
  };

  let expired = false;
  startInteractionCountdown({
    key: "test-err-1",
    api,
    message,
    seconds: 2,
    deleteOnExpire: true,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await scheduler.stepAll();
  assert.equal(expired, true);
  assert.equal(hasInteractionCountdown("test-err-1"), false);
});

test("createDownloadProgress sends processing message and complete() undoes message idempotently", async () => {
  const api = createMockApi();
  const incomingMsg = {
    type: 1,
    threadId: "t-progress",
    data: { msgId: "in-101", cliMsgId: "cli-101", uidFrom: "user-99" },
  };

  let sendCalls = [];
  const sendProcessingFn = async (apiRef, msg, payload, ttl) => {
    sendCalls.push({ msg, payload, ttl });
    return {
      message: [{ msgId: "prog-msg-1", cliMsgId: "prog-cli-1" }],
    };
  };

  const progress = await createDownloadProgress({
    api,
    message: incomingMsg,
    caption: "Chờ bé lấy video một chút...",
    ttl: 8000,
    sendProcessingFn,
  });

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].payload.caption, "Chờ bé lấy video một chút...");
  assert.equal(sendCalls[0].ttl, 8000);

  // Complete first time -> recalls processing message via undoMessage
  const del1 = await progress.complete();
  assert.equal(del1, true);
  assert.equal(api.undoCalls.length, 1);
  assert.equal(api.undoCalls[0].message.data.msgId, "prog-msg-1");
  assert.equal(api.deleteCalls.length, 0);

  // Complete second time -> idempotent, no second undo call
  const del2 = await progress.complete();
  assert.equal(del2, false);
  assert.equal(api.undoCalls.length, 1);
});

test("createDownloadProgress safely handles deletion/recall errors without throwing", async () => {
  const api = {
    async undoMessage() {
      throw new Error("Message already recalled or network down");
    },
  };
  const incomingMsg = {
    type: 1,
    threadId: "t-progress",
    data: { msgId: "in-101", cliMsgId: "cli-101", uidFrom: "user-99" },
  };

  const sendProcessingFn = async () => ({
    message: [{ msgId: "prog-msg-err", cliMsgId: "prog-cli-err" }],
  });

  const progress = await createDownloadProgress({
    api,
    message: incomingMsg,
    caption: "Downloading...",
    sendProcessingFn,
  });

  // Should not throw
  const result = await progress.complete();
  assert.equal(result, false);
});

test("openMediaSelection creates 60s countdown, claim() stops countdown and undoes prompt immediately", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const promptMessage = {
    type: 1,
    threadId: "t-selection",
    data: { msgId: "prompt-1", cliMsgId: "prompt-cli-1", uidFrom: "bot-1" },
  };

  let expired = false;
  const session = openMediaSelection({
    key: "media-select-1",
    api,
    prompt: promptMessage,
    seconds: 60,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await new Promise((r) => setImmediate(r));

  assert.equal(session.isOpen(), true);
  assert.equal(session.isClaimed(), false);
  assert.equal(session.isExpired(), false);

  // Initial reaction tick happens (60s countdown split into 50 + 10, ONE request)
  assert.equal(api.reactionRequests.length, 1);
  assert.equal(api.reactionCalls.length, 2);
  assert.equal(api.reactionCalls[0].icon, "CLOCK");
  assert.equal(api.reactionCalls[0].count, 50);
  assert.equal(api.reactionCalls[1].count, 10);

  // Claim when valid reply received
  let claimHandled = false;
  const claimResult = await session.claim(async () => {
    claimHandled = true;
  });

  assert.equal(claimResult.ok, true);
  assert.equal(claimHandled, true);
  assert.equal(session.isOpen(), false);
  assert.equal(session.isClaimed(), true);

  // Countdown timer stopped, reaction undone (UNDO 50 + 10), prompt recalled via undoMessage
  const undoCalls = api.reactionCalls.filter((c) => c.icon === "UNDO");
  const totalUndone = undoCalls.reduce((sum, c) => sum + c.count, 0);
  assert.equal(totalUndone, 60);

  assert.equal(api.undoCalls.length, 1);
  assert.equal(api.undoCalls[0].message.data.msgId, "prompt-1");
  assert.equal(api.deleteCalls.length, 0);

  // Ensure ticking further doesn't trigger onExpire
  await scheduler.stepAll();
  assert.equal(expired, false);

  // Subsequent claim is no-op
  const secondClaim = await session.claim();
  assert.equal(secondClaim.ok, false);
});

test("openMediaSelection with messageContext properly populates missing threadId/type in prompt response", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();

  // Prompt response only has message.msgId
  const promptResponse = {
    message: { msgId: "prompt-resp-99", cliMsgId: "prompt-cli-99" },
  };
  const originalUserMessage = {
    threadId: "media-group-555",
    type: 1,
    data: { uidFrom: "user-req-1" },
  };

  let expired = false;
  const session = openMediaSelection({
    key: "media-select-ctx",
    api,
    prompt: promptResponse,
    messageContext: originalUserMessage,
    seconds: 2,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();

  assert.equal(api.reactionCalls.length, 1);
  assert.equal(api.reactionCalls[0].threadId, "media-group-555");
  assert.equal(api.reactionCalls[0].type, 1);
  assert.equal(api.reactionCalls[0].firstMsgId, "prompt-resp-99");
  assert.equal(api.reactionCalls[0].firstCliMsgId, "prompt-cli-99");

  // Step to expiry
  await scheduler.stepAll();
  assert.equal(expired, true);
  assert.equal(api.undoCalls.length, 1);
  assert.equal(api.undoCalls[0].message.threadId, "media-group-555");
  assert.equal(api.deleteCalls.length, 0);
});

test("openMediaSelection onExpire triggers after full duration if not claimed", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const promptMessage = {
    type: 1,
    threadId: "t-selection",
    data: { msgId: "prompt-2", cliMsgId: "prompt-cli-2", uidFrom: "bot-1" },
  };

  let expired = false;
  const session = openMediaSelection({
    key: "media-select-2",
    api,
    prompt: promptMessage,
    seconds: 3,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  await Promise.resolve();
  assert.equal(session.isOpen(), true);

  // Step all 3 seconds
  await scheduler.stepAll();

  assert.equal(expired, true);
  assert.equal(session.isOpen(), false);
  assert.equal(session.isExpired(), true);

  assert.equal(api.undoCalls.length, 1);
  assert.equal(api.undoCalls[0].message.threadId, "t-selection");
  assert.equal(api.undoCalls[0].message.type, 1);
  assert.equal(api.undoCalls[0].message.data.msgId, "prompt-2");
  assert.equal(api.deleteCalls.length, 0);

  // Claim on expired session fails
  const claimAfterExpire = await session.claim();
  assert.equal(claimAfterExpire.ok, false);
});

test("openMediaSelection handles expiry-versus-claim race atomically", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const promptMessage = {
    type: 1,
    threadId: "t-selection-race",
    data: { msgId: "prompt-race-1", cliMsgId: "prompt-cli-race-1", uidFrom: "bot-1" },
  };
  const replyMessage = {
    threadId: "t-selection-race",
    type: 1,
    data: { msgId: "reply-1", cliMsgId: "reply-cli-1", quote: promptMessage.data },
  };

  let expired = false;
  const session = openMediaSelection({
    key: "media-select-race",
    api,
    prompt: promptMessage,
    seconds: 1,
    onExpire: async () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  const expiryRun = scheduler.step();
  const claimRun = session.claim(null, replyMessage);
  const [, claimResult] = await Promise.all([expiryRun, claimRun]);

  assert.equal(api.undoCalls.length, 1);
  assert.equal(
    session.isExpired() || session.isClaimed(),
    true
  );
  assert.equal(session.isExpired() && session.isClaimed(), false);
  assert.ok(claimResult.ok || claimResult.reason === "expired");
});

test("countdown milestones 90, 60, 51, 50, 49, 1 render single-request frames with ops <= 50 and clean up once", async () => {
  const milestones = [90, 60, 51, 50, 49, 1];

  for (const seconds of milestones) {
    const api = createMockApi();
    const scheduler = createFakeScheduler();
    const message = {
      type: 1,
      threadId: "t-batch",
      data: { msgId: `msg-${seconds}`, cliMsgId: `cli-${seconds}` },
    };

    let expired = false;
    startInteractionCountdown({
      key: `batch-${seconds}`,
      api,
      message,
      seconds,
      onExpire: async () => {
        expired = true;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    await new Promise((r) => setImmediate(r));

    // Initial frame: exactly ONE request split into ceil(seconds / 50) ops
    const expectedOpCount = Math.ceil(seconds / 50);
    assert.equal(api.reactionRequests.length, 1, `${seconds}s should produce one initial request`);
    const initialOps = api.reactionRequests[0];
    assert.equal(initialOps.length, expectedOpCount);
    let totalInitialReactions = 0;
    for (const op of initialOps) {
      assert.ok(op.count <= 50, `Each operation must not exceed 50 targets (got ${op.count})`);
      assert.equal(op.icon, "CLOCK");
      assert.equal(op.rMsg.length, op.count);
      totalInitialReactions += op.count;
    }
    assert.equal(totalInitialReactions, seconds);

    if (seconds > 1) {
      await scheduler.step();
      assert.equal(api.reactionRequests.length, 2, `${seconds}s transition must be ONE request`);
      const transitionOps = api.reactionRequests[1];
      const undoTotal = transitionOps.filter((o) => o.icon === "UNDO").reduce((s, o) => s + o.count, 0);
      const clockTotal = transitionOps.filter((o) => o.icon === "CLOCK").reduce((s, o) => s + o.count, 0);
      assert.equal(undoTotal, seconds);
      assert.equal(clockTotal, seconds - 1);
      for (const op of transitionOps) {
        assert.ok(op.count <= 50);
        assert.equal(op.rMsg.length, op.count);
      }
    }

    // Run to expiry (frame -> 0): final request is UNDO-only
    await scheduler.stepAll();
    assert.equal(expired, true);
    assert.equal(hasInteractionCountdown(`batch-${seconds}`), false);

    const lastRequest = api.reactionRequests[api.reactionRequests.length - 1];
    assert.ok(lastRequest.every((op) => op.icon === "UNDO"));
    assert.equal(lastRequest.reduce((s, o) => s + o.count, 0), 1);
  }

  // Milestone 0: a zero-second countdown never touches the reaction transport
  const zeroApi = createMockApi();
  startInteractionCountdown({
    key: "batch-0",
    api: zeroApi,
    message: { type: 1, threadId: "t-0", data: { msgId: "msg-0", cliMsgId: "cli-0" } },
    seconds: 0,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(zeroApi.reactionRequests.length, 0);
});

test("normalizeMessageReference prioritizes sent message msgId over quote.msgId", () => {
  // Response from sendMessage containing both own msgId and quote msgId
  const botSendResponse = {
    message: [{ msgId: "bot-sent-12345", cliMsgId: "bot-cli-67890" }],
    data: {
      msgId: "bot-sent-12345",
      cliMsgId: "bot-cli-67890",
      quote: {
        msgId: "user-quote-99999",
        globalMsgId: "user-quote-99999",
        cliMsgId: "user-quote-cli-99999",
      },
    },
  };
  const context = {
    threadId: "room-abc",
    type: 1,
  };

  const norm = normalizeMessageReference(botSendResponse, context);
  assert.equal(norm.data.msgId, "bot-sent-12345");
  assert.equal(norm.data.cliMsgId, "bot-cli-67890");

  const extractedId = extractMessageId(botSendResponse);
  assert.equal(extractedId, "bot-sent-12345");
});

test("replaceCountdownReactionFrame replaces complete visible frames with strict ordering", async () => {
  const api = createMockApi();
  const messageRef = {
    type: 1,
    threadId: "t-frame",
    data: { msgId: "m1", cliMsgId: "c1" },
  };

  // 0 -> 3: applies CLOCK 3 in ONE request
  api.reactionCalls.length = 0;
  api.reactionRequests.length = 0;
  const res0to3 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 0, nextCount: 3 });
  assert.equal(res0to3, 3);
  assert.equal(api.reactionRequests.length, 1);
  assert.deepEqual(
    api.reactionCalls.map((c) => [c.icon, c.count]),
    [["CLOCK", 3]]
  );

  // 3 -> 2: ONE request with UNDO 3, then CLOCK 2
  api.reactionCalls.length = 0;
  api.reactionRequests.length = 0;
  const res3to2 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 3, nextCount: 2 });
  assert.equal(res3to2, 2);
  assert.equal(api.reactionRequests.length, 1);
  assert.deepEqual(
    api.reactionCalls.map((c) => [c.icon, c.count]),
    [["UNDO", 3], ["CLOCK", 2]]
  );

  // 1 -> 0: ONE request with UNDO 1
  api.reactionCalls.length = 0;
  api.reactionRequests.length = 0;
  const res1to0 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 1, nextCount: 0 });
  assert.equal(res1to0, 0);
  assert.equal(api.reactionRequests.length, 1);
  assert.deepEqual(
    api.reactionCalls.map((c) => [c.icon, c.count]),
    [["UNDO", 1]]
  );

  // 2 -> 2: no calls
  api.reactionCalls.length = 0;
  api.reactionRequests.length = 0;
  const res2to2 = await replaceCountdownReactionFrame({ api, messageRef, renderedCount: 2, nextCount: 2 });
  assert.equal(res2to2, 2);
  assert.deepEqual(api.reactionCalls, []);
  assert.deepEqual(api.reactionRequests, []);
});

test("replaceCountdownReactionFrame packs failures atomically without exposing partial frames", async () => {
  const messageRef = {
    type: 1,
    threadId: "t-fail",
    data: { msgId: "m1", cliMsgId: "c1" },
  };

  // 1. Payload rejected by transport: nothing applied, current renderedCount retained
  const rejectedPayloads = [];
  const rejectingApi = {
    async addReaction(ops) {
      rejectedPayloads.push(ops);
      throw new Error("Zalo rejected reaction payload");
    },
  };
  const resUndoFail = await replaceCountdownReactionFrame({
    api: rejectingApi,
    messageRef,
    renderedCount: 3,
    nextCount: 2,
  });
  assert.equal(resUndoFail, 3, "rejected payload should retain current renderedCount");
  assert.equal(rejectedPayloads.length, 1);
  assert.deepEqual(
    rejectedPayloads[0].map(({ icon, messages }) => [icon, messages.length]),
    [["UNDO", 3], ["CLOCK", 2]],
    "single rejected payload must contain UNDO before CLOCK"
  );

  // 2. Fresh apply failure keeps renderedCount 0 while still emitting one packed request
  const resFailApply = await replaceCountdownReactionFrame({
    api: rejectingApi,
    messageRef,
    renderedCount: 0,
    nextCount: 90,
    maxBatchSize: 50,
  });
  assert.equal(resFailApply, 0);
  assert.equal(rejectedPayloads.length, 2);
  assert.deepEqual(
    rejectedPayloads[1].map(({ icon, messages }) => [icon, messages.length]),
    [["CLOCK", 50], ["CLOCK", 40]]
  );

  // 3. Retry from partial frame 50 -> 89 packs UNDO 50 + CLOCK 50 + CLOCK 39 into ONE request
  const retryRequests = [];
  const retryApi = {
    async addReaction(ops) {
      retryRequests.push(ops);
      return { success: true };
    },
  };
  const resRetry = await replaceCountdownReactionFrame({
    api: retryApi,
    messageRef,
    renderedCount: 50,
    nextCount: 89,
    maxBatchSize: 50,
  });
  assert.equal(resRetry, 89);
  assert.equal(retryRequests.length, 1);
  assert.deepEqual(
    retryRequests[0].map(({ icon, messages }) => [icon, messages.length]),
    [["UNDO", 50], ["CLOCK", 50], ["CLOCK", 39]]
  );
  for (const op of retryRequests[0]) {
    assert.ok(op.messages.length <= 50);
  }
});

test("openMediaSelection claim ignores unquoted user reply and cleans up stored bot prompt reference", async () => {
  const undos = [];
  const api = {
    addReaction: async () => ({ success: true }),
    undoMessage: async (msg) => {
      undos.push(msg);
      return { error_code: 0 };
    },
  };
  const prompt = {
    attachment: [{ msgId: "bot-prompt-msg-1", cliMsgId: "bot-prompt-cli-1" }],
  };
  const messageContext = {
    threadId: "group-sel-100",
    type: 1,
    data: { uidFrom: "user-100" },
  };
  const unquotedUserReply = {
    threadId: "group-sel-100",
    type: 1,
    data: {
      msgId: "user-reply-msg-2",
      cliMsgId: "user-reply-cli-2",
      uidFrom: "user-100",
    },
  };

  const selection = openMediaSelection({
    key: "test-claim-bot-identity",
    api,
    prompt,
    messageContext,
    seconds: 60,
  });

  await selection.claim(async () => ({ selected: true }), unquotedUserReply);

  assert.equal(undos.length, 1);
  assert.equal(undos[0].data.msgId, "bot-prompt-msg-1");
  assert.equal(undos[0].data.cliMsgId, "bot-prompt-cli-1");
  assert.notEqual(undos[0].data.msgId, "user-reply-msg-2");
  assert.notEqual(undos[0].data.cliMsgId, "user-reply-cli-2");
});
