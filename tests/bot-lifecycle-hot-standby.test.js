import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { ConfigStore } from "../src/dashboard/config-store.js";
import { createBotActionService } from "../src/dashboard/bot-action-service.js";
import { NodeBridgeService } from "../src/dashboard/node-bridge-service.js";
import { createListenerRuntimeState, resetListenerRuntimeState } from "../src/runtime/listener-state.js";
import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { SendTaskSchedulerManager } from "../src/service-debug/scheduler/sendtask-scheduler-manager.js";
import { createRuntimeStatusResolver } from "../src/dashboard/runtime-status-resolver.js";
import { getBotLockInfo } from "../src/runtime/bot-lock.js";

async function createTestWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-lifecycle-test-"));
  for (const dir of [
    "mybot/bots",
    "mybot/state",
    "mybot/credentials",
    "mybot/overrides",
    "mybot/config",
    "mybot/data",
    "logs/backups",
    ".runtime/locks",
  ]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }

  await fs.writeFile(
    path.join(root, "mybot/mybots.json"),
    JSON.stringify({
      admin: { name: "admin", displayName: "Admin Bot", status: "running", webPort: 3100 },
      bot1: { name: "bot1", displayName: "Sub Bot 1", status: "running", webPort: 3101 },
      bot2: { name: "bot2", displayName: "Sub Bot 2", status: "stopped", webPort: 3102 },
      deadBot: { name: "deadBot", displayName: "Dead Bot", status: "running", webPort: 3103, cookieDead: true },
    }, null, 2)
  );

  await fs.writeFile(
    path.join(root, "mybot/bots/bot1.json"),
    JSON.stringify({ name: "bot1", webPort: 3101, configFilePath: "mybot/credentials/bot1.json" })
  );
  await fs.writeFile(
    path.join(root, "mybot/state/bot1.json"),
    JSON.stringify({ status: "running", pid: "11111", connected: true })
  );
  await fs.writeFile(
    path.join(root, "mybot/credentials/bot1.json"),
    JSON.stringify({ cookie: { zpsid: "valid_cookie_123" } })
  );

  await fs.writeFile(
    path.join(root, "mybot/bots/bot2.json"),
    JSON.stringify({ name: "bot2", webPort: 3102, configFilePath: "mybot/credentials/bot2.json" })
  );
  await fs.writeFile(
    path.join(root, "mybot/state/bot2.json"),
    JSON.stringify({ status: "stopped" })
  );
  await fs.writeFile(
    path.join(root, "mybot/credentials/bot2.json"),
    JSON.stringify({ cookie: { zpsid: "valid_cookie_456" } })
  );

  await fs.writeFile(
    path.join(root, "mybot/bots/deadBot.json"),
    JSON.stringify({ name: "deadBot", webPort: 3103, configFilePath: "mybot/credentials/deadBot.json" })
  );
  await fs.writeFile(
    path.join(root, "mybot/state/deadBot.json"),
    JSON.stringify({ status: "running", pid: "33333", cookieDead: true })
  );
  await fs.writeFile(
    path.join(root, "mybot/credentials/deadBot.json"),
    JSON.stringify({ cookie: {} })
  );

  return root;
}

function makeHmacHeaders(secret, body = "", timestamp = Date.now(), requestId = crypto.randomUUID()) {
  const payload = `${timestamp}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-internal-signature": sig,
    "x-internal-timestamp": String(timestamp),
    "x-request-id": requestId,
  };
}

// ---------------------------------------------------------------------------
// TEST 1: Single Lock Ownership & No Double Lock
// ---------------------------------------------------------------------------
test("lifecycle: single lock ownership in bot-action-service and no double lock in bridge", async () => {
  const root = await createTestWorkspace();
  try {
    const registry = new BotRegistry({ root, portProbe: async () => false });
    const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });

    let lockActiveDuringAction = false;
    const pm2Adapter = {
      status: async () => ({ running: true, status: "online" }),
      start: async (id) => {
        const info = await getBotLockInfo(id, { root });
        if (info) lockActiveDuringAction = true;
        return { success: true, pid: 12345 };
      },
      stop: async () => ({ success: true }),
      restart: async () => ({ success: true }),
      delete: async () => ({ success: true, verifiedAbsent: true, ownershipVerified: true }),
    };

    const actionService = createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter,
    });

    const bridge = new NodeBridgeService({
      root,
      port: 0,
      host: "127.0.0.1",
      secret: "test-secret-12345",
    });
    bridge.actions = actionService;
    bridge.registry = registry;

    const port = await bridge.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const body = JSON.stringify({ action: "start" });
      const res = await fetch(`${baseUrl}/bridge/bots/bot1/action`, {
        method: "POST",
        headers: makeHmacHeaders("test-secret-12345", body),
        body,
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.data.botId, "bot1");
      assert.equal(data.data.action, "start");
      assert.ok(data.data.operationId, "Returns structured operationId");
      assert.ok(lockActiveDuringAction, "Lock was acquired by bot-action-service");

      // Verify lock file is released after action finishes
      const lockAfter = await getBotLockInfo("bot1", { root });
      assert.equal(lockAfter, null, "Lock released after action completes");
    } finally {
      await bridge.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// TEST 2: Structured Operation Phases & Idempotency
// ---------------------------------------------------------------------------
test("lifecycle: operations return operationId and transitions; duplicate call returns same operation", async () => {
  const root = await createTestWorkspace();
  try {
    const registry = new BotRegistry({ root, portProbe: async () => false });
    const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });

    let unblock;
    const holdAction = new Promise((resolve) => { unblock = resolve; });
    let startCalls = 0;

    const pm2Adapter = {
      status: async () => ({ running: true, status: "online" }),
      start: async () => {
        startCalls++;
        await holdAction;
        return { success: true, pid: 2222 };
      },
      stop: async () => ({ success: true }),
      restart: async () => ({ success: true }),
      delete: async () => ({ success: true, verifiedAbsent: true, ownershipVerified: true }),
    };

    const service = createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter,
    });

    // 1. Launch first operation
    const op1Promise = service.start("bot2");

    // Check active operation immediately
    const activeOp = service.getActiveOperation("bot2");
    assert.ok(activeOp);
    assert.equal(activeOp.botId, "bot2");
    assert.equal(activeOp.action, "start");
    assert.ok(activeOp.operationId.startsWith("op_start_bot2_"));
    assert.ok(["accepted", "connecting"].includes(activeOp.phase));

    // 2. Launch duplicate call on same bot while op1 is still in flight -> must be idempotent
    const op2Promise = service.start("bot2");
    assert.strictEqual(op1Promise, op2Promise, "Duplicate call on same bot returns identical Promise");

    // 3. Different bot ("bot1") can operate concurrently without contention
    const opBot1Promise = service.restart("bot1");
    assert.notStrictEqual(op1Promise, opBot1Promise, "Different bot operates independently");

    // Unblock held action
    unblock();

    const [res1, res2, resBot1] = await Promise.all([op1Promise, op2Promise, opBot1Promise]);
    assert.equal(res1.operationId, res2.operationId, "Both callers receive identical operationId");
    assert.equal(res1.status, "starting");
    assert.equal(res1.phase, "connecting");
    assert.equal(startCalls, 1, "Underlying PM2 start was called exactly once");

    assert.equal(resBot1.botId, "bot1");
    assert.equal(resBot1.action, "restart");
    assert.ok(resBot1.operationId.startsWith("op_restart_bot1_"));

    // Check operation history retrieval
    const retrieved = service.getOperation(res1.operationId);
    assert.ok(retrieved);
    assert.equal(retrieved.operationId, res1.operationId);
    assert.equal(retrieved.phase, "connecting");
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// TEST 3: Never treat PM2 'online' as Zalo ready
// ---------------------------------------------------------------------------
test("lifecycle: PM2 online does not equal Zalo ready; running requires real listener readiness", async () => {
  const root = await createTestWorkspace();
  try {
    const resolver = createRuntimeStatusResolver({
      root,
      testMode: false,
      pm2: {
        getProcessStatus: async () => ({
          available: true,
          status: "online",
          pid: 9999,
          pm2Id: 1,
          uptime: 5000,
          restartCount: 0,
        }),
      },
      portProbe: async () => true, // port is open
      identityFetcher: async () => ({
        kind: "child",
        botKey: "bot1",
        liveZaloUid: "bot1_live_uid",
        listenerConnected: false, // Zalo WS listener is NOT connected
        listenerState: "retrying",
      }),
    });

    const statusObj = await resolver.resolveBot({
      id: "bot1",
      enabled: true,
      port: 3101,
      webHost: "127.0.0.1",
    });

    // Despite PM2 reporting 'online', bot status is 'listener-disconnected'
    assert.equal(statusObj.status, "listener-disconnected");
    assert.equal(statusObj.connected, false, "Bot is NOT marked connected before real WS readiness");

    // Now simulate real WS handshake completion
    const readyResolver = createRuntimeStatusResolver({
      root,
      testMode: false,
      pm2: {
        getProcessStatus: async () => ({
          available: true,
          status: "online",
          pid: 9999,
          pm2Id: 1,
          uptime: 6000,
          restartCount: 0,
        }),
      },
      portProbe: async () => true,
      identityFetcher: async () => ({
        kind: "child",
        botKey: "bot1",
        liveZaloUid: "bot1_live_uid",
        listenerConnected: true, // Zalo WS handshake complete!
        listenerState: "connected",
      }),
    });

    const readyStatus = await readyResolver.resolveBot({
      id: "bot1",
      enabled: true,
      port: 3101,
      webHost: "127.0.0.1",
    });

    assert.equal(readyStatus.status, "running");
    assert.equal(readyStatus.connected, true);
    assert.equal(readyStatus.readiness.status, "ready");
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// TEST 4: Listener State Standby Transitions
// ---------------------------------------------------------------------------
test("hot-standby: listener-state recognizes standby and hot_standby", () => {
  const state = createListenerRuntimeState();
  assert.equal(state.getSnapshot().listenerState, "starting");
  assert.equal(state.isStandby(), false);

  state.markStandby("hot_standby_requested");
  const snap = state.getSnapshot();
  assert.equal(snap.listenerState, "standby");
  assert.equal(snap.listenerConnected, false);
  assert.equal(snap.listenerLastError, "hot_standby_requested");
  assert.equal(state.isStandby(), true);

  // Resume transition
  state.markStarting();
  assert.equal(state.getSnapshot().listenerState, "starting");
  assert.equal(state.isStandby(), false);

  state.markConnected();
  assert.equal(state.getSnapshot().listenerState, "connected");
  assert.equal(state.getSnapshot().listenerConnected, true);
});

// ---------------------------------------------------------------------------
// TEST 5: Workload Broker Standby & Drain
// ---------------------------------------------------------------------------
test("hot-standby: workload broker pauses queues, drains in-flight tasks, and rejects new tasks", async () => {
  const broker = createWorkloadBroker({ botId: "test-bot" });

  let taskStarted = false;
  let taskFinished = false;

  // Run a background task
  broker.runFast("test", async () => {
    taskStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
    taskFinished = true;
    return "done";
  });

  // Enter standby
  broker.pause();
  assert.equal(broker.isPaused, true);

  // New task must be rejected in standby
  await assert.rejects(
    () => broker.runFast("new-task", async () => "ok"),
    { code: "BOT_STANDBY" }
  );

  // Drain should await the in-flight task
  const drainRes = await broker.drain(1000);
  assert.equal(drainRes.drained, true);
  assert.equal(taskStarted, true);
  assert.equal(taskFinished, true);

  // Resume broker
  broker.resume();
  assert.equal(broker.isPaused, false);

  // Now new task succeeds
  const afterResume = await broker.runFast("resume-task", async () => "resumed_ok");
  assert.equal(afterResume, "resumed_ok");

  await broker.shutdown();
});

// ---------------------------------------------------------------------------
// TEST 6: Reconnect Coordinator Pause & Resume
// ---------------------------------------------------------------------------
test("hot-standby: reconnect-coordinator cancels timers on pause and prevents reconnection", async () => {
  let reconnectAttempts = 0;
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [20, 50],
    onReconnect: async () => {
      reconnectAttempts++;
    },
  });

  // Schedule a reconnect
  coordinator.schedule("network_lost");
  assert.equal(coordinator.stats().pendingTimer, true);

  // Pause on entering standby
  coordinator.pause();
  assert.equal(coordinator.stats().pendingTimer, false, "Pending timer cancelled on pause");
  assert.equal(coordinator.isPaused, true);

  // Attempts to schedule during standby must be rejected
  const scheduled = coordinator.schedule("heartbeat_fail");
  assert.equal(scheduled, false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reconnectAttempts, 0, "No reconnect attempts fired during standby");

  // Resume coordinator
  coordinator.resume();
  assert.equal(coordinator.isPaused, false);

  coordinator.dispose();
});

// ---------------------------------------------------------------------------
// TEST 7: SendTask Scheduler Pause & Resume 1x
// ---------------------------------------------------------------------------
test("hot-standby: scheduler manager pauses jobs and resumes exactly once without duplicates", async () => {
  let scheduledCount = 0;
  let cancelledCount = 0;

  const manager = new SendTaskSchedulerManager({
    scheduleJob: (cron, tz, task) => {
      scheduledCount++;
      return { cancel: () => { cancelledCount++; }, nextInvocation: () => new Date() };
    },
    cancelJob: (handle) => {
      handle?.cancel?.();
    },
  });

  const schedules = [
    { id: "job1", cron: "0 8 * * *", enabled: true, kind: "zingmp3" },
    { id: "job2", cron: "0 12 * * *", enabled: true, kind: "video" },
  ];

  await manager.sync(schedules);
  assert.equal(manager.handles.size, 2);
  assert.equal(scheduledCount, 2);

  // Pause on standby
  manager.pause();
  assert.equal(manager.paused, true);
  assert.equal(manager.handles.size, 0, "All job handles cleared on pause");
  assert.equal(cancelledCount, 2, "All active jobs cancelled on pause");

  // Resume from standby
  const resumeResult = await manager.resume();
  assert.equal(manager.paused, false);
  assert.equal(manager.handles.size, 2, "Schedules restored");
  assert.equal(resumeResult.scheduled, 2);
  assert.equal(scheduledCount, 4);

  // Consecutive resume call is idempotent and schedules nothing new (unchanged)
  const secondResume = await manager.resume();
  assert.equal(secondResume.scheduled, 0);
  assert.equal(secondResume.unchanged, 2);
  assert.equal(scheduledCount, 4, "No duplicate schedules registered");
});

// ---------------------------------------------------------------------------
// TEST 8: Full Bot Action Service Standby & Resume with RAM Telemetry
// ---------------------------------------------------------------------------
test("hot-standby: service.standby and service.resume flow with RAM measurement and bridge routing", async () => {
  const root = await createTestWorkspace();
  try {
    const registry = new BotRegistry({ root, portProbe: async () => false });
    const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });

    let standbyCalled = false;
    let resumeCalled = false;

    const mockBridgeCaller = async ({ pathname }) => {
      if (pathname === "/internal/runtime/standby") {
        standbyCalled = true;
        return {
          status: "standby",
          memory: { rssBytes: 52428800, heapUsedBytes: 25165824, rssMb: 50.0, heapUsedMb: 24.0, standby: true },
        };
      }
      if (pathname === "/internal/runtime/resume") {
        resumeCalled = true;
        return {
          status: "ws_ready",
          generation: 1,
          keyExchanged: true,
          memory: { rssBytes: 62914560, heapUsedBytes: 31457280, rssMb: 60.0, heapUsedMb: 30.0, standby: false },
        };
      }
      return {};
    };

    const pm2Adapter = {
      status: async () => ({ running: true, status: "online" }),
      start: async () => ({ success: true }),
      stop: async () => ({ success: true }),
      restart: async () => ({ success: true }),
    };

    const service = createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter,
      internalBridgeCaller: mockBridgeCaller,
    });

    // 1. Enter Hot Standby
    const standbyRes = await service.standby("bot1");
    assert.equal(standbyRes.action, "standby");
    assert.equal(standbyRes.status, "standby");
    assert.equal(standbyRes.phase, "standby");
    assert.ok(standbyRes.operationId);
    assert.ok(standbyCalled);
    assert.ok(standbyRes.memory.rssBytes > 0, "RAM is reported in hot-standby");
    assert.equal(standbyRes.memory.standby, true);

    // 2. Resume from Hot Standby
    const resumeRes = await service.resume("bot1");
    assert.equal(resumeRes.action, "resume");
    assert.equal(resumeRes.status, "ws_ready");
    assert.equal(resumeRes.phase, "ws_ready");
    assert.ok(resumeRes.operationId);
    assert.ok(resumeCalled);
    assert.equal(resumeRes.keyExchanged, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// TEST 9: Fallbacks: Dead Node Process & Expired Cookie
// ---------------------------------------------------------------------------
test("hot-standby: fallbacks trigger cleanly on dead process or dead cookie", async () => {
  const root = await createTestWorkspace();
  try {
    const registry = new BotRegistry({ root, portProbe: async () => false });
    const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });

    // Bot with offline PM2 process
    const pm2Offline = {
      status: async (id) => ({ running: id !== "bot2", status: id === "bot2" ? "stopped" : "online" }),
      start: async () => ({ success: true }),
      stop: async () => ({ success: true }),
      restart: async () => ({ success: true }),
    };

    const service = createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter: pm2Offline,
    });

    // Case 1: Node process is dead when resume() called -> NODE_PROCESS_DEAD with COLD_START_REQUIRED
    await assert.rejects(
      () => service.resume("bot2"),
      (err) => {
        assert.equal(err.code, "NODE_PROCESS_DEAD");
        assert.equal(err.fallback, "COLD_START_REQUIRED");
        return true;
      }
    );

    // Case 2: Cookie expired / dead -> COOKIE_EXPIRED with QR_LOGIN_REQUIRED
    await assert.rejects(
      () => service.resume("deadBot"),
      (err) => {
        assert.equal(err.code, "COOKIE_EXPIRED");
        assert.equal(err.fallback, "QR_LOGIN_REQUIRED");
        return true;
      }
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
