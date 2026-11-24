import test from "node:test";
import assert from "node:assert/strict";
import {
  QR_LOGIN_TIMEOUT_MS,
  QR_LOGIN_EXPIRY_REASON,
  isQrLoginExpiredSignal,
} from "../src/utils/qr-login-expiry.js";
import {
  startQrLoginCountdown,
  buildQrCountdownReaction,
} from "../src/utils/qr-login-countdown.js";
import {
  waitingScan,
  waitingConfirm,
  classifyQrScanResponse,
} from "../src/commands/mybot/Credentials/qr-login.js";
import { QrSessionManager } from "../src/dashboard/qr-session.js";

function createMockApi() {
  const reactions = [];
  const requests = [];
  const deletes = [];
  const undos = [];
  return {
    reactions,
    requests,
    deletes,
    undos,
    async addReaction(iconOrOps, messages) {
      const ops = Array.isArray(iconOrOps)
        ? iconOrOps
        : [{ icon: iconOrOps, messages }];
      if (ops.length === 0) throw new Error("No reactions to apply");
      const recorded = ops.map((op) => {
        const list = Array.isArray(op.messages) ? op.messages : [op.messages];
        return {
          icon: op.icon,
          count: list.length,
          msgId: list[0]?.data?.msgId,
          threadId: list[0]?.threadId,
          type: list[0]?.type,
        };
      });
      reactions.push(...recorded);
      requests.push(recorded);
      return { success: true };
    },
    async undoMessage(message) {
      undos.push({ message });
      return { success: true };
    },
    async deleteMessage(message, onlyMe) {
      deletes.push({ message, onlyMe });
      return { success: true };
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
    timers.set(id, { callback, delay: delay !== undefined ? delay : 1000, id });
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
    currentTime += (entry.delay !== undefined ? entry.delay : 1000);
    await entry.callback();
    return true;
  };

  const stepAll = async (maxSteps = 200) => {
    let count = 0;
    while (timers.size > 0 && count < maxSteps) {
      await step();
      count += 1;
    }
    return count;
  };

  return { schedule, cancelSchedule, step, stepAll, now, timers };
}

test("buildQrCountdownReaction builds standard CLOCK reaction identifier", () => {
  const r = buildQrCountdownReaction(90);
  assert.equal(r, "CLOCK");
});

test("startQrLoginCountdown ticks full sequence 90 -> 0", async () => {
  const scheduler = createFakeScheduler();
  const ticks = [];
  let expired = false;

  const lifecycle = startQrLoginCountdown({
    seconds: 90,
    onTick: (rem) => ticks.push(rem),
    onExpire: () => {
      expired = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  assert.equal(lifecycle.remaining, 90);

  // Run all 91 ticks (90 down to 0)
  await scheduler.stepAll(200);

  assert.equal(ticks.length, 91);
  assert.equal(ticks[0], 90);
  assert.equal(ticks[90], 0);
  assert.deepEqual(ticks, Array.from({ length: 91 }, (_, i) => 90 - i));
  assert.equal(expired, true);
  assert.equal(lifecycle.isExpired, true);
});

test("startQrLoginCountdown emits reactions and recalls QR message upon expiry", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "thread-qr",
    data: { msgId: "qr-msg-1", cliMsgId: "qr-cli-1" },
  };

  let expired = false;
  let cleanedUp = false;

  const lifecycle = startQrLoginCountdown({
    api,
    message,
    seconds: 3,
    onExpire: async () => {
      expired = true;
    },
    onCleanup: async () => {
      cleanedUp = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  // t=0: initial tick sends 🕑 x 3
  await scheduler.step();
  assert.equal(api.reactions.length, 1);
  assert.deepEqual(api.reactions[0], {
    icon: "CLOCK",
    count: 3,
    msgId: "qr-msg-1",
    threadId: "thread-qr",
    type: 1,
  });

  // t=1: UNDO x 3, CLOCK x 2
  await scheduler.step();

  // t=2: UNDO x 2, CLOCK x 1
  await scheduler.step();

  // t=3: remaining hits 0 -> UNDO x 1, expire, undoMessage
  await scheduler.step();

  assert.deepEqual(
    api.reactions.map(({ icon, count }) => [icon, count]),
    [
      ["CLOCK", 3],
      ["UNDO", 3], ["CLOCK", 2],
      ["UNDO", 2], ["CLOCK", 1],
      ["UNDO", 1],
    ]
  );

  assert.equal(expired, true);
  assert.equal(cleanedUp, true);
  assert.equal(lifecycle.isExpired, true);
  assert.equal(api.undos.length, 1);
  assert.equal(api.undos[0].message.data.msgId, "qr-msg-1");
  assert.equal(api.deletes.length, 0);
  assert.equal(isQrLoginExpiredSignal(lifecycle.signal), true);
});

test("startQrLoginCountdown uses messageContext to complement sent QR response without threadId/type", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();

  // QR response only has attachment[0] or message without threadId/type
  const qrSentResponse = {
    attachment: [{ photoId: "qr-photo-999", clientId: "qr-client-999" }],
  };
  const originalMessageContext = {
    threadId: "thread-qr-group-777",
    type: 1,
    data: { uidFrom: "requester-888" },
  };

  const lifecycle = startQrLoginCountdown({
    api,
    message: qrSentResponse,
    messageContext: originalMessageContext,
    seconds: 2,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  // t=0
  await scheduler.step();
  assert.equal(api.reactions.length, 1);
  assert.equal(api.reactions[0].threadId, "thread-qr-group-777");
  assert.equal(api.reactions[0].type, 1);
  assert.equal(api.reactions[0].msgId, "qr-photo-999");
  assert.equal(api.reactions[0].count, 2);

  // Step to expiry
  await scheduler.stepAll();
  assert.equal(lifecycle.isExpired, true);
  assert.equal(api.undos.length, 1);
  assert.equal(api.undos[0].message.threadId, "thread-qr-group-777");
  assert.equal(api.deletes.length, 0);
});

test("startQrLoginCountdown success before deadline stops countdown and recalls QR message", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "thread-qr",
    data: { msgId: "qr-msg-success", cliMsgId: "qr-cli-success" },
  };

  let expired = false;
  let succeeded = false;
  let cleanedUp = false;

  const lifecycle = startQrLoginCountdown({
    api,
    message,
    seconds: 90,
    onExpire: () => {
      expired = true;
    },
    onSuccess: () => {
      succeeded = true;
    },
    onCleanup: () => {
      cleanedUp = true;
    },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  // t=0 initial tick sends frame 90 as ONE request (CLOCK 50 + CLOCK 40)
  await scheduler.step();
  assert.equal(api.reactions.length, 2);
  assert.equal(api.reactions[0].count, 50);
  assert.equal(api.reactions[1].count, 40);
  assert.equal(api.requests.length, 1);
  assert.deepEqual(
    api.requests[0].map(({ icon, count }) => [icon, count]),
    [["CLOCK", 50], ["CLOCK", 40]]
  );

  // t=1 step once: still ONE request packing UNDO 50 + 40 then CLOCK 50 + 39
  await scheduler.step();
  assert.equal(api.requests.length, 2);
  const transitionOps = api.requests[1];
  assert.deepEqual(
    transitionOps.map(({ icon, count }) => [icon, count]),
    [["UNDO", 50], ["UNDO", 40], ["CLOCK", 50], ["CLOCK", 39]]
  );
  for (const op of transitionOps) {
    assert.ok(op.count <= 50);
  }
  assert.deepEqual(
    api.reactions.map(({ icon, count }) => [icon, count]),
    [
      ["CLOCK", 50], ["CLOCK", 40],
      ["UNDO", 50], ["UNDO", 40],
      ["CLOCK", 50], ["CLOCK", 39],
    ]
  );

  // User completes scan and confirm before deadline (89 reactions undone in ONE request: 50 + 39)
  await lifecycle.success();

  assert.equal(api.requests.length, 3);
  const cleanupRequest = api.requests[2];
  assert.deepEqual(
    cleanupRequest.map(({ icon, count }) => [icon, count]),
    [["UNDO", 50], ["UNDO", 39]]
  );
  assert.ok(cleanupRequest.every(({ icon }) => icon === "UNDO"));

  assert.equal(succeeded, true);
  assert.equal(expired, false);
  assert.equal(cleanedUp, true);
  assert.equal(lifecycle.isSucceeded, true);
  assert.equal(api.undos.length, 1);
  assert.equal(api.undos[0].message.data.msgId, "qr-msg-success");
  assert.equal(api.deletes.length, 0);

  // Stepping remaining timers should do nothing
  await scheduler.stepAll(200);
  assert.equal(expired, false);
});

test("startQrLoginCountdown isolates reaction and recall errors without throwing and deduplicates logs", async () => {
  const failingApi = {
    async addReaction() {
      throw new Error("Reaction network failure");
    },
    async undoMessage() {
      throw new Error("Undo network failure");
    },
  };
  const scheduler = createFakeScheduler();
  const message = {
    type: 1,
    threadId: "thread-qr",
    data: { msgId: "qr-msg-err", cliMsgId: "qr-cli-err" },
  };

  const errorLogs = [];
  const originalError = console.error;
  console.error = (msg) => errorLogs.push(msg);

  try {
    let expired = false;
    const lifecycle = startQrLoginCountdown({
      api: failingApi,
      message,
      seconds: 2,
      onExpire: () => {
        expired = true;
      },
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    // Should run to completion without throwing
    await scheduler.stepAll(10);
    assert.equal(expired, true);
    assert.equal(lifecycle.isExpired, true);

    // Verify deduplication of reaction error logs
    const reactionLogs = errorLogs.filter((l) =>
      typeof l === "string" && l.includes("reaction batch") && l.includes("Reaction network failure")
    );
    assert.equal(reactionLogs.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("waitingScan continues past 10 attempts and Zalo 'QR expired' responses when deadline is set", async () => {
  let attemptCount = 0;
  const expiresAt = Date.now() + 90000;
  const controller = new AbortController();

  const fakeSession = {
    headers: {},
    fetchWithCookies: async () => {
      attemptCount++;
      // First 12 attempts return Zalo "QR expired" or "Chưa quét"
      if (attemptCount <= 12) {
        return {
          ok: true,
          json: async () => ({ error_message: "QR code expired", data: { data: "not_scanned" } }),
        };
      }
      // Attempt 13 succeeds before deadline
      return {
        ok: true,
        json: async () => ({ error_code: 0, data: { status: "scanned" } }),
      };
    },
  };

  const result = await waitingScan("code-123", fakeSession, controller.signal, {
    expiresAt,
    retryDelayMs: 0,
  });

  assert.equal(attemptCount, 13);
  assert.equal(result, true);
});

test("waitingConfirm continues past 10 attempts and Zalo 'QR expired' responses when deadline is set", async () => {
  let confirmAttempts = 0;
  const expiresAt = Date.now() + 90000;
  const controller = new AbortController();

  const fakeSession = {
    headers: {},
    fetchWithCookies: async (url) => {
      if (String(url).includes("waiting-confirm")) {
        confirmAttempts++;
        if (confirmAttempts <= 11) {
          return {
            ok: true,
            json: async () => ({ error_message: "QR code expired", error_code: -1 }),
          };
        }
        return {
          ok: true,
          json: async () => ({ error_code: 0 }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    },
  };

  const [data, rawCookies, meta] = await waitingConfirm("code-123", fakeSession, {
    signal: controller.signal,
    expiresAt,
    retryDelayMs: 0,
  });

  assert.equal(confirmAttempts, 12);
  assert.ok(data);
  assert.ok(rawCookies);
  assert.equal(meta, undefined);
});

test("waitingConfirm discards completion arriving at or after deadline", async () => {
  const expiresAt = Date.now() - 1; // already expired
  const controller = new AbortController();
  let expiredCallbackCalled = false;

  const fakeSession = {
    headers: {},
    fetchWithCookies: async () => ({
      ok: true,
      json: async () => ({ error_code: 0 }),
    }),
  };

  const [data, rawCookies, meta] = await waitingConfirm("code-123", fakeSession, {
    signal: controller.signal,
    expiresAt,
    onExpired: () => {
      expiredCallbackCalled = true;
    },
  });

  assert.equal(data, null);
  assert.equal(rawCookies, null);
  assert.equal(meta?.expired, true);
  assert.equal(expiredCallbackCalled, true);
});

test("QrSessionManager 90s deadline transitions to expired, clears qrImage, and blocks late writeCredential", async () => {
  const credentialWrites = [];
  let currentTime = 1000;
  const now = () => currentTime;

  const manager = new QrSessionManager({
    now,
    timeoutMs: QR_LOGIN_TIMEOUT_MS,
    initSession: async () => ({ sessionData: true }),
    verifyClient: async (s) => s,
    generateQr: async () => ["qr-code-90", { sessionData: true }],
    readQr: async () => "data:image/png;base64,mockqr",
    waitScan: async (_code, _session, signal) => {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    },
    waitConfirm: async () => [{ imei: "imei-1", cookie: {} }, { cookies: [] }],
    writeCredential: async (id, val) => credentialWrites.push([id, val]),
  });

  assert.equal(manager.timeoutMs, 90000);

  const started = await manager.start("bot-deadline");
  assert.equal(started.state, "waiting_scan");
  assert.equal(started.qrImage, "data:image/png;base64,mockqr");
  assert.equal(started.expiresAt, 1000 + 90000);
  assert.equal(started.remainingMs, 90000);

  // Fast forward past 90s deadline
  currentTime += 90001;

  // Trigger deadline expiration
  const sessionEntry = manager.sessions.get("bot-deadline");
  manager.expire(sessionEntry, "QR login expired");

  const expiredState = manager.get("bot-deadline");
  assert.equal(expiredState.state, "expired");
  assert.equal(expiredState.qrImage, null);
  assert.equal(credentialWrites.length, 0);
});

test("classifyQrScanResponse classifies real log responses accurately", () => {
  // Real log waiting response: error_code 8, data null, error_message "Thành công" -> WAITING
  assert.equal(
    classifyQrScanResponse({ error_code: "8", error_message: "Thành công", data: null }),
    "waiting"
  );
  assert.equal(
    classifyQrScanResponse({ error_code: 8, data: null }),
    "waiting"
  );

  // Real log scanned response: error_code 0 with chatUid / display_name
  assert.equal(
    classifyQrScanResponse({
      error_code: "0",
      error_message: "Thành công",
      data: { chatUid: "123456789", display_name: "Test User", avatar: "https://zalo.me/avatar.jpg" },
    }),
    "scanned"
  );

  // Compatibility scanned response
  assert.equal(
    classifyQrScanResponse({ error_code: 0, data: { status: "scanned" } }),
    "scanned"
  );

  // Not scanned payload
  assert.equal(
    classifyQrScanResponse({ error_code: 0, data: { data: "not_scanned" } }),
    "waiting"
  );

  // Expired response from server before local deadline -> still waiting
  assert.equal(
    classifyQrScanResponse({ error_code: -1003, error_message: "QR code expired" }),
    "waiting"
  );
});

test("waitingScan correctly handles real log response sequence (error_code 8 -> scanned)", async () => {
  let attemptCount = 0;
  const expiresAt = Date.now() + 90000;
  const controller = new AbortController();

  const realLogSession = {
    headers: {},
    fetchWithCookies: async () => {
      attemptCount++;
      // First 4 attempts return real log WAITING response
      if (attemptCount <= 4) {
        return {
          ok: true,
          json: async () => ({ error_code: "8", error_message: "Thành công", data: null }),
        };
      }
      // Attempt 5 returns real log SCANNED response
      return {
        ok: true,
        json: async () => ({
          error_code: "0",
          error_message: "Thành công",
          data: { chatUid: "99887766", display_name: "Phone User" },
        }),
      };
    },
  };

  const result = await waitingScan("code-real-log", realLogSession, controller.signal, {
    expiresAt,
    retryDelayMs: 0,
  });

  assert.equal(attemptCount, 5);
  assert.equal(result, true);
});

test("startQrLoginCountdown recalls QR prompt using enriched outbound cliMsgId", async () => {
  const api = createMockApi();
  const scheduler = createFakeScheduler();

  // Enriched send receipt from Task 2 (server returned msgId, enriched with request clientId)
  const qrSentReceipt = {
    message: null,
    attachment: [{
      msgId: "qr-server-msg-12345",
      cliMsgId: "qr-client-id-67890",
      clientId: "qr-client-id-67890",
    }],
    link: null,
  };
  const messageContext = {
    threadId: "thread-qr-test",
    type: 1,
    data: { uidFrom: "admin-uid" },
  };

  const lifecycle = startQrLoginCountdown({
    api,
    message: qrSentReceipt,
    messageContext,
    seconds: 90,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    now: scheduler.now,
  });

  await scheduler.stepAll();

  assert.equal(api.undos.length, 1);
  assert.equal(api.undos[0].message.data.msgId, "qr-server-msg-12345");
  assert.equal(api.undos[0].message.data.cliMsgId, "qr-client-id-67890");
  assert.notEqual(api.undos[0].message.data.cliMsgId, api.undos[0].message.data.msgId);
});

test("startQrLoginCountdown renders milestone frames (90, 60, 51, 50, 49, 1) in single requests and cancels with one UNDO request", async () => {
  const milestones = [90, 60, 51, 50, 49, 1];

  for (const seconds of milestones) {
    const api = createMockApi();
    const scheduler = createFakeScheduler();
    const message = {
      type: 1,
      threadId: `thread-qr-ms-${seconds}`,
      data: { msgId: `qrm-${seconds}`, cliMsgId: `qrc-${seconds}` },
    };

    const lifecycle = startQrLoginCountdown({
      api,
      message,
      seconds,
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    await scheduler.step();

    // Initial frame: exactly ONE request, ops <= 50, total == seconds
    assert.equal(api.requests.length, 1, `${seconds}s initial frame must be one request`);
    const initialOps = api.requests[0];
    const expectedOpCount = Math.ceil(seconds / 50);
    assert.equal(initialOps.length, expectedOpCount);
    let frameTotal = 0;
    for (const op of initialOps) {
      assert.ok(op.count <= 50, `op must not exceed 50 targets (got ${op.count})`);
      assert.equal(op.icon, "CLOCK");
      assert.equal(op.threadId, `thread-qr-ms-${seconds}`);
      frameTotal += op.count;
    }
    assert.equal(frameTotal, seconds);

    // Cancel: cleanup packs all UNDOs into ONE final request, then recalls the QR prompt
    await lifecycle.cancel("test-cancel");

    assert.equal(lifecycle.isCancelled, true);
    assert.equal(api.requests.length, 2, `${seconds}s cancel must emit exactly one extra request`);
    const cleanupRequest = api.requests[1];
    assert.ok(cleanupRequest.every((op) => op.icon === "UNDO"));
    let undoneTotal = 0;
    for (const op of cleanupRequest) {
      assert.ok(op.count <= 50);
      undoneTotal += op.count;
    }
    assert.equal(undoneTotal, seconds);

    assert.equal(api.undos.length, 1);
    assert.equal(api.undos[0].message.data.msgId, `qrm-${seconds}`);
    assert.equal(api.deletes.length, 0);

    // Further ticks are inert after cancellation
    await scheduler.stepAll(200);
    assert.equal(api.requests.length, 2);
  }
});


