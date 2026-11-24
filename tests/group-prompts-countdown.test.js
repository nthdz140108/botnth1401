import test from "node:test";
import assert from "node:assert/strict";

import {
  handleReactionConfirmJoinGroup,
} from "../src/commands/bot-manager/remote-action-group.js";
import {
  handleReactionConfirmAutoJoin,
} from "../src/service-debug/anti-service/auto-join.js";
import {
  claimSelectionsMapData,
  setSelectionsMapData,
  deleteSelectionsMapData,
  getSelectionsMapData,
} from "../src/service-debug/api-crawl/index.js";
import {
  clearAllInteractionCountdowns,
} from "../src/utils/interaction-countdown.js";

function createApi() {
  const reactions = [];
  const deleted = [];
  const sent = [];
  const undos = [];
  return {
    reactions,
    deleted,
    sent,
    undos,
    async sendMessage(payload, threadId, type) {
      const res = { msgId: `msg-${Date.now()}`, threadId, type, payload };
      sent.push(res);
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

test.afterEach(() => {
  clearAllInteractionCountdowns();
});

test("selections map expires and recalls prompt via undoMessage", async () => {
  const api = createApi();
  const scheduler = createFakeScheduler();
  const sentMessage = {
    attachment: [{ msgId: "attach-sel-1", cliMsgId: "cli-sel-1" }],
  };
  const messageContext = {
    threadId: "group-selection-1",
    type: 1,
    data: { uidFrom: "u1" },
  };

  let customExpired = false;
  await setSelectionsMapData("u1", {
    platform: "youtube",
    collection: [{ id: "vid-1" }],
    api,
    sentMessage,
    messageContext,
    seconds: 2,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    now: scheduler.now,
    onExpire: async () => {
      customExpired = true;
    },
  });

  assert.equal(getSelectionsMapData().has("u1"), true);

  await scheduler.stepAll();

  assert.equal(getSelectionsMapData().has("u1"), false);
  assert.equal(customExpired, true);
  assert.equal(api.undos.length, 1);
  assert.equal(api.undos[0].threadId, "group-selection-1");
  assert.equal(api.undos[0].type, 1);
  assert.equal(api.deleted.length, 0);
});

test("rejects incomplete selection registrations without api, sentMessage, or messageContext", async () => {
  await assert.rejects(
    setSelectionsMapData("u-missing", {
      platform: "youtube",
      collection: [{ id: "video-1" }],
    }),
    /requires api, sentMessage, and messageContext/
  );
});

test("claiming a generic selection stops timer and recalls prompt exactly once", async () => {
  const api = createApi();
  const scheduler = createFakeScheduler();
  const sentMessage = {
    message: [{ msgId: "claim-sel-1", cliMsgId: "cli-claim-1" }],
  };
  const messageContext = {
    threadId: "group-claim-1",
    type: 1,
    data: { uidFrom: "u-claim" },
  };
  const replyMessage = {
    threadId: "group-claim-1",
    type: 1,
    data: { uidFrom: "u-claim", msgId: "reply-1" },
  };

  let expiredCalled = false;
  await setSelectionsMapData("u-claim", {
    platform: "youtube",
    collection: [{ id: "vid-claim" }],
    api,
    sentMessage,
    messageContext,
    seconds: 2,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    now: scheduler.now,
    onExpire: async () => {
      expiredCalled = true;
    },
  });

  const claimed = await claimSelectionsMapData("u-claim", replyMessage);
  assert.equal(claimed, true);
  // Claim giữ nguyên record để lần gửi thất bại còn có thể mở lại bảng;
  // việc xóa record thuộc về các bước chuyển trạng thái cuối (completed/expired).
  assert.equal(getSelectionsMapData().has("u-claim"), true);
  assert.equal(api.undos.length, 1);

  await scheduler.stepAll();
  assert.equal(expiredCalled, false);
});

test("handleReactionConfirmJoinGroup returns false for non-matching reaction", async () => {
  const api = createApi();
  const res = await handleReactionConfirmJoinGroup(api, {
    data: { content: { rType: 99 } },
  });
  assert.equal(res, false);
});

test("handleReactionConfirmAutoJoin returns false for non-matching reaction", async () => {
  const api = createApi();
  const res = await handleReactionConfirmAutoJoin(api, {
    data: { content: { rType: 99 } },
  });
  assert.equal(res, false);
});

test.after(() => {
  setImmediate(() => process.exit(0));
});
