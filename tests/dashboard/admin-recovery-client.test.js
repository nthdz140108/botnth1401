import test from "node:test";
import assert from "node:assert/strict";
import { createAdminRecoveryPoller } from "../../dashboard/src/components/admin-recovery-client.js";

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ACTIVE_A = {
  state: "waiting_scan",
  sessionId: "session-a",
  createdAt: "2026-08-31T00:00:00.000Z",
  expiresAt: "2026-08-31T00:01:30.000Z",
  qrImage: "data:image/png;base64,QUJD",
};

test("poller detects an idle-to-active transition and notifies with the active payload", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const sequence = [{ state: "idle" }, ACTIVE_A, ACTIVE_A, ACTIVE_A];
  let call = 0;
  const notifications = [];
  const poller = createAdminRecoveryPoller({
    request: async () => sequence[Math.min(call++, sequence.length - 1)],
    onChange: (data) => notifications.push(data),
  });
  poller.start();
  await flushEvents();
  t.mock.timers.tick(2000);
  await flushEvents();
  poller.stop();
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].state, "idle");
  assert.equal(notifications[1].sessionId, "session-a");
  assert.equal(notifications[1].state, "waiting_scan");
  assert.equal(notifications[1].qrImage, ACTIVE_A.qrImage);
});

test("poller does not send a duplicate notification for the same sessionId and state", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let call = 0;
  const notifications = [];
  const poller = createAdminRecoveryPoller({
    request: async () => {
      call += 1;
      return ACTIVE_A;
    },
    onChange: (data) => notifications.push(data),
  });
  poller.start();
  await flushEvents();
  t.mock.timers.tick(20000);
  await flushEvents();
  poller.stop();
  assert.ok(call >= 2, `expected repeated polls, got ${call}`);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].sessionId, "session-a");
});

test("poller notifies again when a replacement sessionId appears", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const replacement = { ...ACTIVE_A, sessionId: "session-b", qrImage: "data:image/png;base64,REUwMg==" };
  const sequence = [ACTIVE_A, ACTIVE_A, replacement];
  let call = 0;
  const notifications = [];
  const poller = createAdminRecoveryPoller({
    request: async () => sequence[Math.min(call++, sequence.length - 1)],
    onChange: (data) => notifications.push(data),
  });
  poller.start();
  await flushEvents();
  t.mock.timers.tick(2000);
  await flushEvents();
  t.mock.timers.tick(2000);
  await flushEvents();
  poller.stop();
  assert.deepEqual(notifications.map((entry) => entry.sessionId), ["session-a", "session-b"]);
  assert.equal(notifications[1].qrImage, replacement.qrImage);
});

test("poller polls immediately and then every two seconds by default", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let call = 0;
  const poller = createAdminRecoveryPoller({
    request: async () => {
      call += 1;
      return { state: "idle" };
    },
    onChange: () => {},
  });
  poller.start();
  await flushEvents();
  assert.equal(call, 1);
  t.mock.timers.tick(1999);
  await flushEvents();
  assert.equal(call, 1);
  t.mock.timers.tick(1);
  await flushEvents();
  assert.equal(call, 2);
  t.mock.timers.tick(2000);
  await flushEvents();
  assert.equal(call, 3);
  poller.stop();
});

test("poller honors a custom intervalMs", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let call = 0;
  const poller = createAdminRecoveryPoller({
    intervalMs: 500,
    request: async () => {
      call += 1;
      return { state: "idle" };
    },
    onChange: () => {},
  });
  poller.start();
  await flushEvents();
  t.mock.timers.tick(500);
  await flushEvents();
  assert.equal(call, 2);
  poller.stop();
});

test("stop() cleans up the timer so no further polls happen", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let call = 0;
  const poller = createAdminRecoveryPoller({
    request: async () => {
      call += 1;
      return { state: "idle" };
    },
    onChange: () => {},
  });
  poller.start();
  await flushEvents();
  poller.stop();
  t.mock.timers.tick(10000);
  await flushEvents();
  assert.equal(call, 1);
});

test("poller unwraps the authenticated { success, data } envelope before notifying", async () => {
  const notifications = [];
  const poller = createAdminRecoveryPoller({
    request: async () => ({ success: true, data: ACTIVE_A }),
    onChange: (data) => notifications.push(data),
  });
  poller.start();
  await flushEvents();
  poller.stop();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].sessionId, "session-a");
  assert.equal(notifications[0].qrImage, ACTIVE_A.qrImage);
});

test("poller keeps polling after a failed request", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let call = 0;
  const notifications = [];
  const poller = createAdminRecoveryPoller({
    request: async () => {
      call += 1;
      if (call === 1) {
        const error = new Error("AUTH_REQUIRED");
        error.status = 401;
        throw error;
      }
      return ACTIVE_A;
    },
    onChange: (data) => notifications.push(data),
  });
  poller.start();
  await flushEvents();
  t.mock.timers.tick(2000);
  await flushEvents();
  poller.stop();
  assert.equal(call, 2);
  assert.equal(notifications.length, 1);
});
