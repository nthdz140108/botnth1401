import test from "node:test";
import assert from "node:assert/strict";
import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { createLatencyTracker } from "../src/observability/latency-tracker.js";

test("fast-path dispatcher executes messages, undos, reactions and group events non-blockingly", async () => {
  const called = [];
  const latencyTracker = createLatencyTracker();

  const dispatcher = createFastPathDispatcher({
    api: { id: "test-api" },
    botId: "bot-test",
    handlers: {
      message: async (api, msg) => {
        called.push({ type: "message", msgId: msg.data.msgId });
      },
      group_event: async (api, ev) => {
        called.push({ type: "group_event", groupId: ev.groupId });
      },
      undo: async (api, undo) => {
        called.push({ type: "undo", msgId: undo.data.msgId });
      },
      reaction: async (api, react) => {
        called.push({ type: "reaction", msgId: react.data.msgId });
      },
    },
    latencyTracker,
  });

  await dispatcher.dispatchMessage({ threadId: "t1", data: { msgId: "m1", cliMsgId: "c1" } });
  await dispatcher.dispatchGroupEvent({ groupId: "g1" });
  await dispatcher.dispatchUndo({ threadId: "t1", data: { msgId: "u1" } });
  await dispatcher.dispatchReaction({ threadId: "t1", data: { msgId: "r1", uidFrom: "user-1", reactType: "like" } });

  assert.equal(called.length, 4);
  assert.equal(called[0].msgId, "m1");
  assert.equal(called[1].groupId, "g1");
  assert.equal(called[2].msgId, "u1");
  assert.equal(called[3].msgId, "r1");

  // Deduplication check: re-dispatching same message cliMsgId is dropped
  await dispatcher.dispatchMessage({ threadId: "t1", data: { msgId: "m1", cliMsgId: "c1" } });
  assert.equal(called.length, 4, "Duplicate message should be dropped");
  assert.equal(dispatcher.stats().dedupeDropCount, 1);
});
