import test from "node:test";
import assert from "node:assert/strict";

/**
 * Readiness must reflect the ability to RECEIVE messages:
 * - identity/health payloads expose listenerConnected/listenerState/listenerLastError
 * - resolver: PM2 online + port open + identity ok + listener connected → running
 * - resolver: port open but listener disconnected → 'listener-disconnected'
 * - terminal monitor readiness label mirrors the same contract.
 */

function makeIdentityPayload(overrides = {}) {
  return {
    kind: "main",
    botKey: "admin",
    configuredUid: "admin",
    liveZaloUid: "999",
    pid: process.pid,
    webPort: 2000,
    listenerConnected: true,
    listenerState: "connected",
    listenerLastError: null,
    ...overrides,
  };
}

async function loadResolver() {
  return import("../src/dashboard/runtime-status-resolver.js");
}

test("resolver: online + port + identity + listener connected → running", async () => {
  const { createRuntimeStatusResolver } = await loadResolver();
  const resolver = createRuntimeStatusResolver({
    pm2: {
      getProcessStatus: async () => ({ available: true, status: "online", pid: 111, pm2Id: 1, uptime: 120_000, restartCount: 0 }),
    },
    portProbe: async () => true,
    identityFetcher: async () => makeIdentityPayload(),
  });
  const result = await resolver.resolveBot({ id: "admin", port: 2000 });
  assert.equal(result.status, "running");
  assert.equal(result.readiness.listenerConnected, true);
});

test("resolver: online + port open but listener disconnected → listener-disconnected, not running", async () => {
  const { createRuntimeStatusResolver } = await loadResolver();
  const resolver = createRuntimeStatusResolver({
    pm2: {
      getProcessStatus: async () => ({ available: true, status: "online", pid: 111, pm2Id: 1, uptime: 120_000, restartCount: 0 }),
    },
    portProbe: async () => true,
    identityFetcher: async () => makeIdentityPayload({ listenerConnected: false, listenerState: "retrying", listenerLastError: "ws closed" }),
  });
  const result = await resolver.resolveBot({ id: "admin", port: 2000 });
  assert.equal(result.status, "listener-disconnected");
  assert.equal(result.reason, "listener-disconnected");
  assert.equal(result.connected, false, "must not fake Running/Ready");
  assert.equal(result.readiness.listenerState, "retrying");
});

test("resolver: identity payload without listener fields is treated as connected (backward compat)", async () => {
  const { createRuntimeStatusResolver } = await loadResolver();
  const payload = makeIdentityPayload();
  delete payload.listenerConnected;
  delete payload.listenerState;
  const resolver = createRuntimeStatusResolver({
    pm2: {
      getProcessStatus: async () => ({ available: true, status: "online", pid: 111, pm2Id: 1, uptime: 120_000, restartCount: 0 }),
    },
    portProbe: async () => true,
    identityFetcher: async () => payload,
  });
  const result = await resolver.resolveBot({ id: "admin", port: 2000 });
  assert.equal(result.status, "running");
});

test("terminal readiness label: listener-disconnected when listener is down", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const monitor = new TerminalMonitor({
    projectRoot: process.cwd(),
    portProbe: async () => true,
    identityFetcher: async () => makeIdentityPayload({ listenerConnected: false, listenerState: "retrying" }),
  });
  const label = await monitor._readinessLabel({
    name: "admin",
    botKey: "admin",
    status: "online",
    env: { WEB_PORT: "2000" },
  });
  assert.equal(label, "listener-disconnected");
});

test("terminal readiness label: ready when listener connected", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const monitor = new TerminalMonitor({
    projectRoot: process.cwd(),
    portProbe: async () => true,
    identityFetcher: async () => makeIdentityPayload(),
  });
  const label = await monitor._readinessLabel({
    name: "admin",
    botKey: "admin",
    status: "online",
    env: { WEB_PORT: "2000" },
  });
  assert.equal(label, "ready");
});

test("test-mode resolver still honors listener state when identity reports disconnect", async () => {
  const { createRuntimeStatusResolver } = await loadResolver();
  const resolver = createRuntimeStatusResolver({
    testMode: true,
    portProbe: async () => true,
    identityFetcher: async () => makeIdentityPayload({ listenerConnected: false, listenerState: "retrying" }),
  });
  const result = await resolver.resolveBot({ id: "admin", port: 2000 });
  assert.equal(result.status, "listener-disconnected");
  assert.equal(result.connected, false);
});
