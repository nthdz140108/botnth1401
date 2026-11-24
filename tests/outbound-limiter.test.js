import test from "node:test";
import assert from "node:assert/strict";

import {
  createTransportLimiter,
  wrapWithLimiter,
  __isDeliveryRejection,
} from "../src/api-zalo/transport-limiter.js";
import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";

test("outbound limiter caps concurrency and spacing", async () => {
  const { limiter } = createTransportLimiter({ maxConcurrent: 2, minTime: 30 });
  let running = 0;
  let maxRunning = 0;
  const jobs = [];
  for (let i = 0; i < 8; i += 1) {
    jobs.push(
      limiter.schedule(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      })
    );
  }
  await Promise.all(jobs);
  assert.ok(maxRunning <= 2, `max running ${maxRunning} exceeded 2`);
});

test("wrapWithLimiter wraps send APIs per api instance and preserves results", async () => {
  const api = {};
  let calls = 0;
  api.sendMessage = async (msg, id) => {
    calls += 1;
    return { ok: true, msg, id };
  };
  api.uploadAttachment = async () => ({ attachments: ["a"] });

  const { wrappedMethods } = wrapWithLimiter(api, { maxConcurrent: 1, minTime: 1 });
  assert.ok(wrappedMethods.includes("sendMessage"));
  assert.ok(wrappedMethods.includes("uploadAttachment"));
  const result = await api.sendMessage({ text: "hi" }, "thread-1");
  assert.deepEqual(result, { ok: true, msg: { text: "hi" }, id: "thread-1" });
  assert.equal(calls, 1);

  // Wrapping again must not double-wrap
  await wrapWithLimiter(api, {});
  await api.sendMessage({}, "t");
  assert.equal(calls, 2);
});

test("delivery rejections are flagged so callers never retry the payload", () => {
  const deliveryError = Object.assign(new Error("payload rejected"), { code: -200 });
  assert.equal(__isDeliveryRejection(deliveryError), true);
  const transportError = Object.assign(new Error("socket hung up"), { code: -999 });
  assert.equal(__isDeliveryRejection(transportError), false);
});

test("reconnect coordinator stats expose single loop state", () => {
  const coordinator = createReconnectCoordinator({
    onReconnect: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  coordinator.schedule("closed");
  const s1 = coordinator.stats();
  assert.equal(s1.pendingTimer, true);
  assert.equal(s1.lastReason, "closed");
  coordinator.notifySuccess();
  assert.equal(coordinator.stats().pendingTimer, false);
  assert.equal(coordinator.stats().attempts, 0);
  coordinator.dispose();
});
