import test from "node:test";
import assert from "node:assert/strict";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { createLatencyTracker } from "../src/observability/latency-tracker.js";

test("heavy tasks do not block or increase latency of fast-text and control tasks", async () => {
  const broker = createWorkloadBroker({
    botId: "bot-iso",
    maxHeavyConcurrent: 1,
    maxBroadcastConcurrent: 1,
  });
  const tracker = createLatencyTracker();

  // 1. Submit heavy tasks that take 100ms each (accelerated heavy task)
  const heavyJob1 = broker.submitHeavy("video", {}, async () => {
    await new Promise((r) => setTimeout(r, 100));
    return "heavy1";
  });
  const heavyJob2 = broker.submitHeavy("video", {}, async () => {
    await new Promise((r) => setTimeout(r, 100));
    return "heavy2";
  });

  // 2. While heavy queue is saturated (1 running, 1 queued), execute 20 fast text commands and 5 control events
  const fastPromises = [];
  for (let i = 0; i < 20; i++) {
    const eventId = `fast-${i}`;
    tracker.begin(eventId, "message", "bot-iso", { commandClass: "fast-text" });
    const p = broker.runFast("help", async () => {
      tracker.mark(eventId, "handler_started");
      await new Promise((r) => setTimeout(r, 2)); // 2ms fast task
      tracker.finish(eventId, "ok");
      return `fast-${i}`;
    });
    fastPromises.push(p);
  }

  const controlPromises = [];
  for (let i = 0; i < 5; i++) {
    const eventId = `ctrl-${i}`;
    tracker.begin(eventId, "reaction", "bot-iso", { commandClass: "control" });
    const p = broker.runControl("reaction", async () => {
      tracker.mark(eventId, "handler_started");
      await new Promise((r) => setTimeout(r, 1));
      tracker.finish(eventId, "ok");
      return `ctrl-${i}`;
    });
    controlPromises.push(p);
  }

  // All fast and control tasks MUST resolve well before the heavy jobs complete!
  const fastResults = await Promise.all(fastPromises);
  const controlResults = await Promise.all(controlPromises);

  assert.equal(fastResults.length, 20);
  assert.equal(controlResults.length, 5);

  const snap = tracker.snapshot("bot-iso");
  assert.ok(snap.byClass["fast-text"].p95 < 20, `Fast-text p95 must be < 20ms, got ${snap.byClass["fast-text"].p95}`);
  assert.ok(snap.byClass["control"].p95 < 20, `Control p95 must be < 20ms, got ${snap.byClass["control"].p95}`);

  // Finally heavy jobs complete
  const [h1, h2] = await Promise.all([heavyJob1.promise, heavyJob2.promise]);
  assert.equal(h1, "heavy1");
  assert.equal(h2, "heavy2");

  await broker.shutdown();
});
