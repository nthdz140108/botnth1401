import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  RESTART_EXIT_CODE,
  writeRestartRequest,
  readRestartRequest,
  consumeRestartRequest,
  markRestartRequestNotified,
} from "../src/utils/restart-request.js";
import { requestRestartForBot, restartSelf } from "../src/utils/util.js";
import { setRuntimeInstanceDescriptor, resolveLaunchDescriptor } from "../src/core/runtime-instance.js";

test("RESTART_EXIT_CODE is standardized to 10", () => {
  assert.equal(RESTART_EXIT_CODE, 10);
});

test("writeRestartRequest generates requestId, botKey, requestedAt and status=requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rs-test-"));
  try {
    const req = writeRestartRequest("bot_child_1", {
      threadId: "g_123",
      type: 1,
    }, root);

    assert.equal(req.uid, "bot_child_1");
    assert.equal(req.botKey, "bot_child_1");
    assert.ok(req.requestId.startsWith("rs-bot_child_1-"));
    assert.equal(req.status, "requested");
    assert.ok(req.requestedAt);

    const saved = readRestartRequest("bot_child_1", root);
    assert.deepEqual(saved, req);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("consumeRestartRequest consumes request within 30 seconds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rs-test-"));
  try {
    writeRestartRequest("bot_child_2", {
      threadId: "g_456",
      type: 1,
      requestedAt: new Date().toISOString(),
    }, root);

    const consumed = consumeRestartRequest("bot_child_2", root, { maxAgeMs: 30000 });
    assert.ok(consumed);
    assert.equal(consumed.status, "consumed");
    assert.ok(consumed.consumedAt);

    // Reading again returns the consumed status
    const reread = readRestartRequest("bot_child_2", root);
    assert.equal(reread.status, "consumed");

    // Consuming again returns null because status is already consumed
    const reConsumed = consumeRestartRequest("bot_child_2", root, { maxAgeMs: 30000 });
    assert.equal(reConsumed, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("consumeRestartRequest rejects stale request (>30s) and marks status=failed/stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rs-test-"));
  try {
    const staleTime = new Date(Date.now() - 35000).toISOString(); // 35 seconds ago
    writeRestartRequest("bot_child_stale", {
      threadId: "g_789",
      type: 1,
      requestedAt: staleTime,
    }, root);

    const consumed = consumeRestartRequest("bot_child_stale", root, { maxAgeMs: 30000 });
    assert.equal(consumed, null);

    const record = readRestartRequest("bot_child_stale", root);
    assert.equal(record.status, "failed");
    assert.equal(record.reason, "stale");
    assert.ok(record.failedAt);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("restartSelf on child bot requests restart and exits with RESTART_EXIT_CODE=10", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rs-test-"));
  try {
    const childDesc = resolveLaunchDescriptor({
      kind: "child",
      botKey: "child_bot_rs",
      projectRoot: root,
    });
    setRuntimeInstanceDescriptor(childDesc);

    let recordedExitCode = null;
    const sentMessages = [];
    const mockApi = {
      sendMessage: (payload, threadId, type) => {
        sentMessages.push({ payload, threadId, type });
      },
    };

    restartSelf(
      mockApi,
      { threadId: "group-rs", type: 1 },
      "rs",
      {
        root,
        scheduleExit: (fn, delay) => {
          // Override process.exit for test
          const origExit = process.exit;
          process.exit = (code) => {
            recordedExitCode = code;
          };
          try {
            fn();
          } finally {
            process.exit = origExit;
          }
        },
      }
    );

    assert.equal(recordedExitCode, 10);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].payload.msg, /đang khởi động lại/);

    const req = readRestartRequest("child_bot_rs", root);
    assert.ok(req);
    assert.equal(req.status, "requested");
    assert.equal(req.threadId, "group-rs");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
