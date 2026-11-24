import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

test("native-process-pool: recycleAll and close reject in-flight tasks instead of hanging", async () => {
  const { createNativeProcessPool } = await import("../../src/core/native-process-pool.js");
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pool-recycle-"));
  const workerScript = path.join(tmpDir, "slow-worker.js");
  await fsp.writeFile(
    workerScript,
    `process.on("message", (msg) => {
      if (msg?.type === "fast") {
        process.send({ taskId: msg.taskId, success: true, result: { echoed: msg.data } });
      }
      // "hang" intentionally never replies until recycled/closed
    });\n`,
    "utf8"
  );

  const pool = createNativeProcessPool({
    entrypoint: workerScript,
    maxProcesses: 1,
    initialProcesses: 0,
    onDemand: true,
    taskTimeoutMs: 60_000,
  });

  try {
    const fastRes = await pool.run("fast", { ok: 1 });
    assert.deepEqual(fastRes, { echoed: { ok: 1 } });

    const inFlight = pool.run("hang", {});
    const expectRecycled = assert.rejects(inFlight, /recycled|exited|closed/i);
    await new Promise((r) => setTimeout(r, 150));
    await pool.recycleAll();
    await expectRecycled;

    const inFlight2 = pool.run("hang", {});
    const expectClosed = assert.rejects(inFlight2, /closed|exited/i);
    await new Promise((r) => setTimeout(r, 150));
    await pool.close();
    await expectClosed;
  } finally {
    await pool.close().catch(() => {});
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("runContinuousPrune clears timer immediately when hooks complete", async () => {
  const { runContinuousPrune } = await import("../../src/runtime/memory-pressure-listener.js");
  const started = Date.now();
  const res = await runContinuousPrune({
    timeoutMs: 30_000,
    hooks: [async () => {}],
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `Expected <2000ms, got ${elapsed}ms`);
  assert.deepEqual(res.hookErrors, []);
});

test("fast-path-dispatcher preserves numeric Zalo Message.type and deduplicates reactions by rType", async () => {
  const { createFastPathDispatcher } = await import("../../src/core/fast-path-dispatcher.js");
  const receivedMessages = [];
  const receivedReactions = [];
  const activeEvents = new Set();

  const fakeTracker = {
    begin(id) { activeEvents.add(id); },
    mark() {},
    finish(id) { activeEvents.delete(id); },
  };

  const dispatcher = createFastPathDispatcher({
    botId: "test-bot",
    latencyTracker: fakeTracker,
    messageStore: { update() {} },
    handlers: {
      message: async (_api, msg) => { receivedMessages.push(msg); },
      reaction: async (_api, react) => { receivedReactions.push(react); },
    },
  });

  const rawZaloMsg = {
    type: 1, // GroupMessage numeric enum
    threadId: "group-123",
    data: { cliMsgId: "cli-1", msgId: "msg-1", content: "xin chao" },
  };

  await dispatcher.dispatch(rawZaloMsg);
  await dispatcher.dispatch(rawZaloMsg); // duplicate must drop cleanly without leaking activeEvents

  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].threadId, "group-123");
  assert.equal(receivedMessages[0].type, 1);
  assert.equal(activeEvents.size, 0, "Deduplicated messages must not leak active latency tracker entries");

  // Two distinct reaction icons on the same msgId must BOTH be dispatched
  await dispatcher.dispatchReaction({
    threadId: "group-123",
    data: { msgId: "msg-1", uidFrom: "u1", content: { rType: 3 } },
  });
  await dispatcher.dispatchReaction({
    threadId: "group-123",
    data: { msgId: "msg-1", uidFrom: "u1", content: { rType: 5 } },
  });
  await dispatcher.dispatchReaction({
    threadId: "group-123",
    data: { msgId: "msg-1", uidFrom: "u1", content: { rType: 5 } },
  });

  assert.equal(receivedReactions.length, 2);
});

test("ImageBufferCache returns Node Buffer to all concurrent in-flight callers", async () => {
  const { ImageBufferCache } = await import("../../src/utils/image-buffer-cache.js");
  const cache = new ImageBufferCache({ maxBytes: 1024 * 1024, ttlMs: 60_000 });
  cache.downloadBuffer = async () => {
    await new Promise((r) => setTimeout(r, 40));
    return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  };

  try {
    const [b1, b2] = await Promise.all([
      cache.getBuffer("https://example.com/a.png"),
      cache.getBuffer("https://example.com/a.png"),
    ]);
    assert.ok(Buffer.isBuffer(b1), "First caller must get Buffer");
    assert.ok(Buffer.isBuffer(b2), "Concurrent caller must get Buffer (not ArrayBuffer)");
    assert.deepEqual(b1, b2);
  } finally {
    clearInterval(cache.cleanupInterval);
  }
});

test("withMyBotsTransaction locks via proper-lockfile ESM and leaves zero .tmp files", async () => {
  const { withMyBotsTransaction } = await import("../../src/commands/mybot/Manager/qr-provisioning-registry.js");
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mybot-txn-"));

  try {
    await Promise.all([
      withMyBotsTransaction({ root: tmpRoot }, async (txn) => {
        txn.reserveProvisionedBot({ uid: "10001", displayName: "Bot One", ownerUid: "owner-1" });
        await new Promise((r) => setTimeout(r, 30));
        txn.finalizeProvisionedBot("10001", { status: "stopped" });
      }),
      withMyBotsTransaction({ root: tmpRoot }, async (txn) => {
        txn.reserveProvisionedBot({ uid: "10002", displayName: "Bot Two", ownerUid: "owner-1" });
        await new Promise((r) => setTimeout(r, 30));
        txn.finalizeProvisionedBot("10002", { status: "stopped" });
      }),
    ]);

    const mybotDir = path.join(tmpRoot, "mybot");
    const files = await fsp.readdir(mybotDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp-"));
    assert.equal(tmpFiles.length, 0, "No .tmp files should remain");

    const registry = JSON.parse(await fsp.readFile(path.join(mybotDir, "mybots.json"), "utf8"));
    assert.ok(registry["10001"], "Bot 10001 must exist");
    assert.ok(registry["10002"], "Bot 10002 must exist");
    assert.notEqual(registry["10001"].webPort, registry["10002"].webPort, "Ports must not collide");
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("Weekly trial quota enforces 1 trial/week per owner while allowing unlimited paid Mini Bots", async () => {
  const { activatePendingTrial } = await import("../../src/commands/mybot/System/mybot-trial.js");
  const { hasOwnerUsedTrialThisWeek } = await import("../../src/commands/mybot/System/expiry-classifier.js");
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mybot-weekly-quota-"));
  const registryPath = path.join(tmpRoot, "mybot", "mybots.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  const week1Now = Date.UTC(2026, 10, 2, 10, 0, 0); // Monday
  const week2Now = week1Now + 8 * 24 * 3600 * 1000; // Next week
  const paidFuture = new Date(week1Now + 30 * 24 * 3600 * 1000).toISOString();

  try {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        "bot-free-1": { name: "bot-free-1", ownerUid: "owner-A", status: "stopped", trialStatus: "pending", expiryAt: null },
        "bot-free-2": { name: "bot-free-2", ownerUid: "owner-A", status: "stopped", trialStatus: "pending", expiryAt: null },
        "bot-paid-3": { name: "bot-paid-3", ownerUid: "owner-A", status: "stopped", trialStatus: "pending", expiryAt: paidFuture },
      }, null, 2),
      "utf8"
    );

    // 1st free trial in week 1 succeeds
    const b1 = await activatePendingTrial("bot-free-1", {
      registryPath,
      root: tmpRoot,
      ownerUid: "owner-A",
      enforceQuota: true,
      now: week1Now,
    });
    assert.equal(b1.status, "running");
    assert.equal(hasOwnerUsedTrialThisWeek("owner-A", { root: tmpRoot, now: week1Now }), true);
    assert.equal(hasOwnerUsedTrialThisWeek("owner-A", { root: tmpRoot, now: week2Now }), false, "Next Bangkok week must reset eligibility");

    // 2nd free trial in SAME week is blocked
    await assert.rejects(
      activatePendingTrial("bot-free-2", {
        registryPath,
        root: tmpRoot,
        ownerUid: "owner-A",
        enforceQuota: true,
        now: week1Now + 1000,
      }),
      (err) => err?.code === "TRIAL_QUOTA_EXHAUSTED"
    );

    // Paid bot for SAME owner runs concurrently without consuming or failing trial quota
    const b3 = await activatePendingTrial("bot-paid-3", {
      registryPath,
      root: tmpRoot,
      ownerUid: "owner-A",
      enforceQuota: true,
      now: week1Now + 2000,
    });
    assert.equal(b3.status, "running");
    assert.equal(b3.expiryAt, paidFuture, "Paid expiry must never be overwritten by 1h trial");

    // Next week: owner-A gets a fresh 1-hour free trial on bot-free-2
    const b2NextWeek = await activatePendingTrial("bot-free-2", {
      registryPath,
      root: tmpRoot,
      ownerUid: "owner-A",
      enforceQuota: true,
      now: week2Now,
    });
    assert.equal(b2NextWeek.status, "running");
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("runtime-dependencies includes .runtime/bin sandboxed ffmpeg and ffprobe candidates", async () => {
  const { getFfmpegExecutableSync, getFfprobeExecutableSync } = await import("../../src/utils/runtime-dependencies.js");
  let capturedFfmpegCandidates = [];
  let capturedFfprobeCandidates = [];
  getFfmpegExecutableSync({
    probe: (candidates) => {
      capturedFfmpegCandidates = Array.isArray(candidates) ? candidates : [candidates];
      return null;
    },
  });
  getFfprobeExecutableSync({
    probe: (candidates) => {
      capturedFfprobeCandidates = Array.isArray(candidates) ? candidates : [candidates];
      return null;
    },
  });
  const expectedDir = path.join(projectRoot, ".runtime", "bin");
  assert.ok(capturedFfmpegCandidates.some((c) => String(c).startsWith(expectedDir)), "ffmpeg candidates must include .runtime/bin");
  assert.ok(capturedFfprobeCandidates.some((c) => String(c).startsWith(expectedDir)), "ffprobe candidates must include .runtime/bin");
});
