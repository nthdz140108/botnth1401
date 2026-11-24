import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";
import { Listener } from "../src/api-zalo/apis/listen.js";
import { appContext } from "../src/api-zalo/context.js";

test("reconnect coordinator schedules exactly one loop per close event", async () => {
  let attempts = 0;
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [20, 20, 20, 20],
    jitterRatio: 0,
    onReconnect: async () => {
      attempts += 1;
    },
    logger: { warn: () => {}, error: () => {} },
  });
  const scheduled1 = coordinator.schedule("closed");
  const scheduled2 = coordinator.schedule("closed");
  assert.equal(scheduled1, true);
  assert.equal(scheduled2, false, "duplicate close must not create a second loop");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, 1);
  coordinator.dispose();
});

test("successful reconnect resets backoff attempts", () => {
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [10, 500],
    jitterRatio: 0,
    onReconnect: async () => {},
    logger: { warn: () => {}, error: () => {} },
  });
  coordinator.schedule("closed");
  coordinator.notifySuccess();
  assert.equal(coordinator.stats().attempts, 0);
  coordinator.dispose();
});

test("failed reconnect attempt reschedules itself", async () => {
  let failures = 0;
  let successes = 0;
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [10],
    jitterRatio: 0,
    onReconnect: async () => {
      if (failures < 2) {
        failures += 1;
        throw new Error(`still down ${failures}`);
      }
      successes += 1;
    },
    logger: { warn: () => {}, error: () => {} },
  });
  coordinator.schedule("closed");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(failures, 2);
  assert.equal(successes, 1);
  coordinator.dispose();
});

function buildTestListener() {
  appContext.cookie = "test=1";
  appContext.userAgent = "test-agent";
  appContext.options = appContext.options || {};
  return new Listener("wss://ws.test.zalo.me");
}

test("malformed frames are logged and dropped without throwing", async () => {
  const listener = buildTestListener();
  const logs = [];
  listener.ws = {
    readyState: 1,
    close: () => {},
    send: () => {},
  };
  // Silence logger output
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await listener.handleFrame(Buffer.from([1])); // header too short
    await listener.handleFrame(Buffer.alloc(8, 7)); // invalid JSON payload
    await listener.handleFrame(Buffer.from("plain text frame"));
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(true, "handleFrame survived all garbage inputs");
});

test("valid frame still dispatches after garbage frames", async () => {
  const listener = buildTestListener();
  let keyExchangeSeen = null;
  listener.handleKeyExchange = (parsed) => {
    keyExchangeSeen = parsed;
  };
  listener.ws = { readyState: 1, close: () => {}, send: () => {} };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await listener.handleFrame(Buffer.from([9, 9, 9, 9]));
    const body = Buffer.from(JSON.stringify({ key: "secret-key" }));
    const frame = Buffer.concat([Buffer.from([1, 1, 0, 1]), body]);
    await listener.handleFrame(frame);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(keyExchangeSeen, { key: "secret-key" });
});
