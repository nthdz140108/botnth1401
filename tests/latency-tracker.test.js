import test from "node:test";
import assert from "node:assert/strict";
import { createLatencyTracker, REQUIRED_PHASES } from "../src/observability/latency-tracker.js";

test("latency tracker records all required phases and computes percentiles", () => {
  let simulatedTime = 1000;
  const tracker = createLatencyTracker({ clock: () => simulatedTime });

  const eventId = "evt-123";
  tracker.begin(eventId, "message", "bot-1", { commandClass: "fast-text" });

  for (const phase of REQUIRED_PHASES.slice(1, -1)) {
    simulatedTime += 10;
    tracker.mark(eventId, phase);
  }

  simulatedTime += 20;
  const result = tracker.finish(eventId, "ok");

  assert.ok(result);
  assert.equal(result.eventId, "evt-123");
  assert.equal(result.botId, "bot-1");
  assert.equal(result.kind, "message");
  assert.equal(result.commandClass, "fast-text");
  assert.ok(result.totalDurationMs >= 80);

  const snapshot = tracker.snapshot("bot-1");
  assert.ok(snapshot);
  assert.equal(snapshot.botId, "bot-1");
  assert.equal(snapshot.total.count, 1);
  assert.ok(snapshot.total.p50 >= 80);
  assert.ok(snapshot.byKind.message);
  assert.ok(snapshot.byClass["fast-text"]);
  assert.ok(snapshot.byPhase["ws_received->preflight_started"]);
});

test("latency tracker aggregates per-bot isolation", () => {
  let simulatedTime = 1000;
  const tracker = createLatencyTracker({ clock: () => simulatedTime });

  // Bot A: fast task (10ms)
  tracker.begin("a1", "message", "bot-a", { commandClass: "fast-text" });
  simulatedTime += 10;
  tracker.finish("a1");

  // Bot B: heavy task (500ms)
  tracker.begin("b1", "message", "bot-b", { commandClass: "media" });
  simulatedTime += 500;
  tracker.finish("b1");

  const snapA = tracker.snapshot("bot-a");
  const snapB = tracker.snapshot("bot-b");

  assert.equal(snapA.total.p95, 10);
  assert.equal(snapB.total.p95, 500);

  const globalSnap = tracker.snapshot();
  assert.equal(globalSnap.global.count, 2);
  assert.ok(globalSnap.bots["bot-a"]);
  assert.ok(globalSnap.bots["bot-b"]);
});
