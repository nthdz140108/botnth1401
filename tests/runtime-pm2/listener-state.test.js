import test from "node:test";
import assert from "node:assert/strict";

/**
 * Listener runtime state bridge:
 * - connectListenerWithRetry must NOT close the web-server bridge on
 *   transient listener start failures (the port-closed-under-PM2 bug).
 * - listener state transitions: starting → connected / retrying → connected.
 * - AbortSignal stops the retry loop.
 * - startup phase tracking fields are written and readable.
 */

test("listener-state module exposes the shared state snapshot contract", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({ now: () => 1_000 });
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, false);
  assert.equal(snap.listenerState, "starting");
  assert.equal(snap.listenerLastError, null);
  assert.equal(snap.startupPhase, "login");
  assert.ok(snap.startupStartedAt > 0);
  assert.equal(snap.startupLastError, null);
});

test("connectListenerWithRetry keeps the web bridge alive across transient failures and reports retrying", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const events = [];
  let closeCalls = 0;
  let attempts = 0;
  const state = createListenerRuntimeState({
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    onWebBridgeClosureRequested: () => { closeCalls += 1; },
  });

  const controller = new AbortController();
  const runPromise = state.connectListenerWithRetry({
    start: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ws handshake failed (transient)");
      return true;
    },
    signal: controller.signal,
    retryDelayMs: 15,
    maxRetries: 10,
    onEvent: (e) => events.push(e),
  });

  const result = await runPromise;
  assert.equal(result.connected, true);
  assert.equal(result.attempts, 3);
  // THE regression: the bridge must NOT be closed on transient listener errors.
  assert.equal(closeCalls, 0, "web bridge must never be closed for transient listener failures");
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, true);
  assert.equal(snap.listenerState, "connected");
  assert.equal(snap.listenerLastError, null);
});

test("connectListenerWithRetry reports retrying state while failures persist", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({
    sleep: () => new Promise((r) => setTimeout(r, 1)),
  });
  const controller = new AbortController();
  const promise = state.connectListenerWithRetry({
    start: async () => { throw new Error("still down"); },
    signal: controller.signal,
    retryDelayMs: 1,
    maxRetries: 2,
  });
  const result = await promise;
  assert.equal(result.connected, false);
  const snap = state.getSnapshot();
  assert.equal(snap.listenerConnected, false);
  assert.equal(snap.listenerState, "retrying");
  assert.match(snap.listenerLastError || "", /still down/);
});

test("connectListenerWithRetry aborts promptly on AbortSignal", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const controller = new AbortController();
  const promise = state.connectListenerWithRetry({
    start: async () => { throw new Error("boom"); },
    signal: controller.signal,
    retryDelayMs: 60_000, // huge; abort must cut the wait short
    maxRetries: Infinity,
  });
  // Let it fail once, then abort while sleeping.
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const result = await promise;
  assert.equal(result.connected, false);
  assert.equal(result.aborted, true);
});

test("markConnected transitions retrying → connected and clears lastError", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({ now: () => 5_000 });
  state.markRetrying("ws closed");
  assert.equal(state.getSnapshot().listenerState, "retrying");
  assert.equal(state.getSnapshot().listenerLastError, "ws closed");
  state.markConnected();
  const snap = state.getSnapshot();
  assert.equal(snap.listenerState, "connected");
  assert.equal(snap.listenerConnected, true);
  assert.equal(snap.listenerLastError, null);
});

test("markStopped transitions to stopped/disconnected", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({});
  state.markConnected();
  state.markStopped("process shutdown");
  const snap = state.getSnapshot();
  assert.equal(snap.listenerState, "stopped");
  assert.equal(snap.listenerConnected, false);
});

test("startup phase tracking updates pid, phase and timestamps", async () => {
  const { createListenerRuntimeState } = await import("../../src/runtime/listener-state.js");
  const state = createListenerRuntimeState({ now: () => 42_000, pid: 777 });
  state.setStartupPhase("qr-recovery");
  const snap = state.getSnapshot();
  assert.equal(snap.startupPid, 777);
  assert.equal(snap.startupPhase, "qr-recovery");
  assert.equal(snap.startupStartedAt, 42_000);
  assert.equal(snap.startupUpdatedAt, 42_000);
  state.setStartupError("qr timed out");
  assert.equal(state.getSnapshot().startupLastError, "qr timed out");
});

test("login deadline helper resolves before timeout and throws after", async () => {
  const { withDeadline } = await import("../../src/runtime/listener-state.js");
  const ok = await withDeadline(Promise.resolve("ok"), 30_000, "login deadline");
  assert.equal(ok, "ok");
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 25, "login deadline exceeded"),
    /login deadline exceeded/
  );
});
