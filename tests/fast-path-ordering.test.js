import test from "node:test";
import assert from "node:assert/strict";
import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { createStateClaimRegistry } from "../src/core/state-claim-registry.js";

test("two commands from different users in the same group execute concurrently without FIFO serialization", async () => {
  const executionOrder = [];
  const stateClaims = createStateClaimRegistry();

  const dispatcher = createFastPathDispatcher({
    api: {},
    botId: "bot-order",
    stateClaims,
    handlers: {
      message: async (api, message) => {
        const sender = message.data.uidFrom;
        executionOrder.push(`start:${sender}`);
        if (sender === "user-slow") {
          // Slow task
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else {
          // Fast task
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        executionOrder.push(`finish:${sender}`);
      },
    },
  });

  // Dispatch slow user first, then fast user immediately in the same thread
  const slowPromise = dispatcher.dispatchMessage({
    threadId: "same-group-1",
    data: { msgId: "m-slow", cliMsgId: "c-slow", uidFrom: "user-slow" },
  });

  const fastPromise = dispatcher.dispatchMessage({
    threadId: "same-group-1",
    data: { msgId: "m-fast", cliMsgId: "c-fast", uidFrom: "user-fast" },
  });

  await Promise.all([slowPromise, fastPromise]);

  // Fast user should finish BEFORE slow user even though slow was dispatched first!
  assert.deepEqual(executionOrder, [
    "start:user-slow",
    "start:user-fast",
    "finish:user-fast",
    "finish:user-slow",
  ]);
});

test("cooldown claim prevents duplicate command execution for the same sender", async () => {
  const stateClaims = createStateClaimRegistry({ ttlMs: 1000 });
  let executions = 0;

  const dispatcher = createFastPathDispatcher({
    api: {},
    botId: "bot-claim",
    stateClaims,
    handlers: {
      message: async (api, message) => {
        const key = `cooldown:${message.botId || "bot-claim"}:${message.data.uidFrom}:${message.data.cmd}`;
        if (!stateClaims.tryClaim(key, message.data.msgId)) {
          return; // Cooldown blocked
        }
        executions++;
      },
    },
  });

  await dispatcher.dispatchMessage({
    threadId: "group-1",
    data: { msgId: "cmd-1", cliMsgId: "cli-1", uidFrom: "user-1", cmd: "daily" },
  });

  await dispatcher.dispatchMessage({
    threadId: "group-1",
    data: { msgId: "cmd-2", cliMsgId: "cli-2", uidFrom: "user-1", cmd: "daily" },
  });

  assert.equal(executions, 1, "Second command within cooldown must not execute");
});

test("undo event is idempotent and only executed once", async () => {
  let undoRuns = 0;
  const dispatcher = createFastPathDispatcher({
    api: {},
    botId: "bot-undo",
    handlers: {
      undo: async () => {
        undoRuns++;
      },
    },
  });

  await dispatcher.dispatchUndo({ threadId: "group-1", data: { msgId: "undo-msg-1" } });
  await dispatcher.dispatchUndo({ threadId: "group-1", data: { msgId: "undo-msg-1" } });

  assert.equal(undoRuns, 1, "Duplicate undo must not run twice");
});
