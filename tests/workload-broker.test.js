import test from "node:test";
import assert from "node:assert/strict";
import { createWorkloadBroker } from "../src/core/workload-broker.js";

test("workload broker runs fast, control, heavy, and broadcast tasks on distinct lanes", async () => {
  const broker = createWorkloadBroker({
    botId: "bot-test",
    maxHeavyConcurrent: 1,
    maxBroadcastConcurrent: 1,
  });

  // Fast task executes directly
  const fastResult = await broker.runFast("ping", async () => "pong");
  assert.equal(fastResult, "pong");

  // Control task executes on control lane
  const controlResult = await broker.runControl("undo", async () => "undone");
  assert.equal(controlResult, "undone");

  // Submit heavy job returns jobId and runs on heavy lane
  const { jobId, promise } = broker.submitHeavy("download", { url: "test" }, async (id, payload) => {
    return { id, url: payload.url, done: true };
  });
  assert.ok(jobId.startsWith("heavy-bot-test-"));
  const heavyRes = await promise;
  assert.equal(heavyRes.done, true);

  // Submit broadcast job runs on broadcast lane
  const { jobId: bId, promise: bPromise } = broker.submitBroadcast({ count: 10 }, async (id, payload) => {
    return { id, count: payload.count };
  });
  assert.ok(bId.startsWith("bcast-bot-test-"));
  const bRes = await bPromise;
  assert.equal(bRes.count, 10);

  const snap = broker.snapshot();
  assert.equal(snap.counters.fastRuns, 1);
  assert.equal(snap.counters.controlRuns, 1);
  assert.equal(snap.counters.heavyCompleted, 1);
  assert.equal(snap.counters.broadcastCompleted, 1);

  await broker.shutdown();
});
