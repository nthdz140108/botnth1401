import test from "node:test";
import assert from "node:assert/strict";
import { startQrLoginCountdown } from "../src/utils/qr-login-countdown.js";

test("startQrLoginCountdown enforces local 90s countdown and message recall on expiry", async () => {
  let recalledMessage = null;
  let expiredTriggered = false;

  const mockApi = {
    undoMessage: async (msg) => {
      recalledMessage = msg;
      return true;
    },
    addReaction: async () => true,
  };

  let virtualTime = 0;
  const scheduledTimers = new Map();
  let nextTimerId = 1;

  const fakeSchedule = (cb, delay) => {
    const id = nextTimerId++;
    scheduledTimers.set(id, { cb, triggerTime: virtualTime + delay });
    return id;
  };
  const fakeCancel = (id) => {
    scheduledTimers.delete(id);
  };
  fakeSchedule.now = () => virtualTime;

  const qrPrompt = {
    message: { msgId: "qr-test-prompt-1", cliMsgId: "qr-test-cli-1" },
    threadId: "test-thread-123",
    type: 1,
  };

  const lifecycle = startQrLoginCountdown({
    api: mockApi,
    message: qrPrompt,
    messageContext: { threadId: "test-thread-123", type: 1 },
    seconds: 90,
    schedule: fakeSchedule,
    cancelSchedule: fakeCancel,
    now: () => virtualTime,
    onExpire: async () => {
      expiredTriggered = true;
    },
  });

  assert.equal(lifecycle.remaining, 90);
  assert.equal(lifecycle.isExpired, false);

  // Fast-forward to 90 seconds
  for (let s = 1; s <= 91; s++) {
    virtualTime += 1000;
    for (const [id, timer] of Array.from(scheduledTimers.entries())) {
      if (timer.triggerTime <= virtualTime) {
        scheduledTimers.delete(id);
        await timer.cb();
      }
    }
  }

  assert.equal(lifecycle.isExpired, true);
  assert.equal(expiredTriggered, true);
  assert.ok(recalledMessage, "QR prompt message must be undone on expiry");
  assert.equal(recalledMessage.threadId, "test-thread-123");
});

test("startQrLoginCountdown success releases timer and recalls QR message promptly", async () => {
  let recalledMessage = null;
  let successTriggered = false;

  const mockApi = {
    undoMessage: async (msg) => {
      recalledMessage = msg;
      return true;
    },
    addReaction: async () => true,
  };

  const qrPrompt = {
    message: { msgId: "qr-test-success-1", cliMsgId: "qr-test-cli-success" },
    threadId: "thread-success",
    type: 1,
  };

  const lifecycle = startQrLoginCountdown({
    api: mockApi,
    message: qrPrompt,
    messageContext: { threadId: "thread-success", type: 1 },
    seconds: 90,
    onSuccess: async () => {
      successTriggered = true;
    },
  });

  await lifecycle.success();

  assert.equal(lifecycle.isSucceeded, true);
  assert.equal(successTriggered, true);
  assert.ok(recalledMessage, "QR prompt must be undone upon login success");
});
