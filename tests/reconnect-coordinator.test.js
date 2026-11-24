import test from "node:test";
import assert from "node:assert/strict";
import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";

test("reconnect coordinator schedules backoff with jitter and notifies success", async () => {
  let reconnectCalls = 0;
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [20, 50, 100],
    jitterRatio: 0.1,
    onReconnect: async () => {
      reconnectCalls++;
    },
  });

  assert.equal(coordinator.stats().attempts, 0);
  const scheduled = coordinator.schedule("test-close");
  assert.equal(scheduled, true);
  assert.equal(coordinator.schedule("duplicate-close"), false);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reconnectCalls, 1);
  assert.equal(coordinator.stats().totalReconnects, 1);

  coordinator.notifySuccess();
  assert.equal(coordinator.stats().attempts, 0);
  coordinator.dispose();
});

test("failed reconnect attempt increments attempts and reschedules next tier", async () => {
  let attempts = 0;
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [10, 20, 40],
    jitterRatio: 0,
    onReconnect: async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("Network still down");
      }
    },
  });

  coordinator.schedule("socket-error");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(attempts >= 2, `Should attempt at least 2 times, got ${attempts}`);
  coordinator.dispose();
});

test("reset clears all pending timers and attempts", () => {
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [5000],
    onReconnect: async () => {},
  });

  coordinator.schedule("closed");
  assert.equal(coordinator.stats().pendingTimer, true);
  coordinator.reset();
  assert.equal(coordinator.stats().pendingTimer, false);
  assert.equal(coordinator.stats().attempts, 0);
  coordinator.dispose();
});
