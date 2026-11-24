import test from "node:test";
import assert from "node:assert/strict";
import { createRestartCoordinator } from "../src/utils/restart-coordinator.js";

test("shares one restart promise and starts only after stop", async () => {
  const events = [];
  let releaseStop;
  const stop = (context) => new Promise((resolve) => {
    events.push(["stop", context]);
    releaseStop = resolve;
  });
  const start = (context) => {
    events.push(["start", context]);
    return "new-process";
  };
  const coordinator = createRestartCoordinator({ stop, start, delayMs: 0 });
  const context = { pid: 10 };

  const first = coordinator.restart("manual", context);
  const second = coordinator.restart("manual", context);
  assert.strictEqual(first, second);
  assert.deepEqual(events, [["stop", context]]);

  releaseStop();
  assert.equal(await first, "new-process");
  assert.deepEqual(events, [["stop", context], ["start", context]]);
  assert.equal(coordinator.getState().phase, "running");
  assert.equal(coordinator.getState().inFlight, false);
});

test("returns to idle and propagates a start failure", async () => {
  const coordinator = createRestartCoordinator({
    stop: async () => {},
    start: async () => { throw new Error("start failed"); },
    delayMs: 0,
  });

  await assert.rejects(coordinator.restart(), /start failed/);
  assert.equal(coordinator.getState().phase, "idle");
  assert.equal(coordinator.getState().inFlight, false);
});

test("emits state transitions and supports a later restart", async () => {
  const transitions = [];
  const events = [];
  const coordinator = createRestartCoordinator({
    stop: async (context) => { events.push(["stop", context]); },
    start: async (context) => { events.push(["start", context]); return events.length; },
    delayMs: ({ reason, context }) => context.delayMs ?? (reason === "crash" ? 0 : 10),
    onStateChange: (state) => transitions.push(state),
  });

  const firstResult = await coordinator.restart("manual", { id: 1, delayMs: 0 });
  const secondResult = await coordinator.restart("crash", { id: 2 });

  assert.equal(firstResult, 2);
  assert.equal(secondResult, 4);
  assert.deepEqual(events, [
    ["stop", { id: 1, delayMs: 0 }],
    ["start", { id: 1, delayMs: 0 }],
    ["stop", { id: 2 }],
    ["start", { id: 2 }],
  ]);
  assert.deepEqual(transitions.map((state) => state.phase), [
    "stopping", "starting", "running", "stopping", "starting", "running",
  ]);
  assert.equal(transitions[0].reason, "manual");
  assert.deepEqual(transitions[0].context, { id: 1, delayMs: 0 });
});
