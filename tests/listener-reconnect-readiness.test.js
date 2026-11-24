import test from "node:test";
import assert from "node:assert/strict";
import {
  createListenerRuntimeState,
  resetListenerRuntimeState,
} from "../src/runtime/listener-state.js";

/**
 * Listener reconnect readiness regression (PM2/VPS fix):
 * - closed -> retrying -> reconnect success -> connected; attempts reset to 0
 * - a real Zalo event heals a stale `retrying` state back to connected
 * - reconnect failure keeps `listener-disconnected` (never fakes ready)
 * - a stale `closed` from a REPLACED socket cannot clobber the new connection
 */

test("closed -> retrying -> reconnect success -> connected and attempts reset", async () => {
  const state = createListenerRuntimeState();
  let calls = 0;
  const result = await state.connectListenerWithRetry({
    start: async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    },
    retryDelayMs: 1,
    maxRetries: 5,
  });

  assert.equal(result.connected, true, "second attempt must connect");
  assert.equal(result.attempts, 2, "two attempts were made");
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, true);
  assert.equal(snap.listenerState, "connected");
  assert.equal(snap.listenerLastError, null, "markConnected clears listenerLastError");
  // Reconnect backoff reset is coordinator-side (notifySuccess); the state
  // surface must be `connected` so readiness stops reporting disconnect.
});

test("reconnect failure keeps listener-disconnected (never fakes ready)", async () => {
  const state = createListenerRuntimeState();
  const result = await state.connectListenerWithRetry({
    start: async () => {
      throw new Error("still down");
    },
    retryDelayMs: 1,
    maxRetries: 2,
  });

  assert.equal(result.connected, false);
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, false);
  assert.equal(snap.listenerState, "retrying");
  assert.match(snap.listenerLastError, /still down/);
});

test("a live Zalo event heals a stale retrying state to connected", () => {
  const state = createListenerRuntimeState();
  state.markConnected();
  state.markRetrying("ws closed");
  assert.equal(state.getSnapshot().listenerState, "retrying");

  // Real Zalo message evidence: the socket is actually alive.
  state.markEventEvidence();
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, true);
  assert.equal(snap.listenerState, "connected");
  assert.equal(snap.listenerLastError, null, "heal clears the error surface");
});

test("markEventEvidence does not downgrade an already connected state", () => {
  const state = createListenerRuntimeState();
  state.markConnected();
  state.markEventEvidence();
  assert.equal(state.getSnapshot().listenerState, "connected");
});

test("stale closed event from a replaced socket cannot overwrite the new connection", () => {
  const state = createListenerRuntimeState();

  // First socket: generation 1, healthy.
  const gen1 = state.beginConnection();
  assert.equal(gen1, 1);
  state.markConnected();

  // Stale `closed` from the FIRST socket arriving late must be dropped...
  assert.equal(state.markRetryingForGeneration("late close of gen1", gen1), true);
  assert.equal(state.getSnapshot().listenerState, "retrying", "current socket close still marks retrying");

  // ...heal, then open a NEW socket (reconnect success).
  state.markEventEvidence();
  const gen2 = state.beginConnection();
  assert.equal(gen2, 2);
  state.markConnected();
  assert.equal(state.getSnapshot().listenerState, "connected");

  // The OLD socket's late `closed` (gen 1) must NOT clobber the new state.
  assert.equal(state.markRetryingForGeneration("stale gen1 close", gen1), false);
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, true);
  assert.equal(snap.listenerState, "connected");
  assert.equal(snap.connectionGeneration, 2);

  // The CURRENT socket's close (gen 2) is a genuine transport-down signal.
  assert.equal(state.markRetryingForGeneration("current gen2 close", gen2), true);
  assert.equal(state.getSnapshot().listenerState, "retrying");
});

test("events without a generation are accepted unconditionally (fail-open)", () => {
  const state = createListenerRuntimeState();
  state.beginConnection();
  state.markConnected();
  assert.equal(state.markRetryingForGeneration("no-gen close", undefined), true);
  assert.equal(state.getSnapshot().listenerState, "retrying");
});

test("connectListenerWithRetry never requests a web-bridge closure", async () => {
  resetListenerRuntimeState();
  let closureRequested = false;
  const state = createListenerRuntimeState({
    onWebBridgeClosureRequested: () => {
      closureRequested = true;
    },
  });
  await state.connectListenerWithRetry({ start: async () => { throw new Error("x"); }, retryDelayMs: 1, maxRetries: 1 });
  assert.equal(closureRequested, false, "a failed start must keep the bridge open");
});
