import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createRuntimeStatusResolver, matchesIdentity, STARTUP_GRACE_MS } from "../../src/dashboard/runtime-status-resolver.js";
import { PM2Adapter, PM2ErrorCode, isMyBotProcess, normalizePM2Process } from "../../src/runtime/pm2-adapter.js";

function sup(overrides = {}) {
  return { available: true, status: "online", pid: 1234, pm2Id: 3, uptime: 5000, restartCount: 0, ...overrides };
}

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "runtime-resolver-"));
}

test("resolver: PM2 online + identity match + live Zalo UID → running", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "child", botKey: "user-123", configuredUid: "user-123", liveZaloUid: "999888777" }),
  });
  const snap = await resolver.resolveBot({ id: "user-123", port: 3111, configuredStatus: "running" });
  assert.equal(snap.status, "running");
  assert.equal(snap.connected, true);
  assert.equal(snap.readiness.identityVerified, true);
  assert.equal(snap.readiness.portOpen, true);
});

test("resolver: registry says running but PM2 has no process → stopped (no fake running from PID)", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "child", botKey: "child", liveZaloUid: "1" }),
  });
  const snap = await resolver.resolveBot({ id: "child", port: 3111, configuredStatus: "running" });
  assert.equal(snap.status, "stopped");
  assert.equal(snap.connected, false);
});

test("resolver: PM2 daemon unreachable → unknown, never running", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => ({ available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "daemon down", code: PM2ErrorCode.DAEMON_UNAVAILABLE }) },
    portProbe: async () => true,
    identityFetcher: async () => null,
  });
  const snap = await resolver.resolveBot({ id: "child", port: 3111, configuredStatus: "running" });
  assert.equal(snap.status, "unknown");
  assert.equal(snap.connected, false);
  assert.equal(snap.supervisor.available, false);
});

test("resolver: PM2 errored → error", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup({ status: "errored" }) },
    portProbe: async () => true,
    identityFetcher: async () => null,
  });
  const snap = await resolver.resolveBot({ id: "child", port: 3111 });
  assert.equal(snap.status, "error");
});

test("resolver: PM2 online under 60s but port closed → starting; over 60s → error", async () => {
  const root = await tempRoot();
  const fresh = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup({ uptime: 10_000 }) },
    portProbe: async () => false,
    identityFetcher: async () => null,
  });
  assert.equal((await fresh.resolveBot({ id: "child", port: 3111 })).status, "starting");

  const stale = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup({ uptime: STARTUP_GRACE_MS + 5000 }) },
    portProbe: async () => false,
    identityFetcher: async () => null,
  });
  assert.equal((await stale.resolveBot({ id: "child", port: 3111 })).status, "error");
});

test("resolver: port open but wrong identity → identity-mismatch; no identity payload → starting", async () => {
  const root = await tempRoot();
  const mismatch = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "child", botKey: "other-bot", liveZaloUid: "42" }),
  });
  assert.equal((await mismatch.resolveBot({ id: "child", port: 3111 })).status, "identity-mismatch");

  const noPayload = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => null,
  });
  assert.equal((await noPayload.resolveBot({ id: "child", port: 3111 })).status, "starting");
});

test("resolver: disabled/expired bots keep configured state and skip probes", async () => {
  const root = await tempRoot();
  const probes = [];
  const pm2Mock = { getProcessStatus: async () => { probes.push("pm2"); return sup(); } };
  const resolver = createRuntimeStatusResolver({ root, pm2: pm2Mock, portProbe: async () => { probes.push("port"); return true; }, identityFetcher: async () => { probes.push("identity"); return null; } });
  const disabled = await resolver.resolveBot({ id: "child", port: 3111, enabled: false });
  assert.equal(disabled.status, "disabled");
  const expired = await resolver.resolveBot({ id: "child", port: 3111, expiryAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(expired.status, "expired");
  assert.equal(probes.filter((p) => p === "port").length, 0, "no port probes for disabled/expired");
});

test("resolver: admin requires kind main identity", async () => {
  const root = await tempRoot();
  const ok = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "main", botKey: "admin", liveZaloUid: "777" }),
  });
  assert.equal((await ok.resolveBot({ id: "admin", port: 2000 })).status, "running");
  const bad = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "child", botKey: "someone", liveZaloUid: "777" }),
  });
  assert.equal((await bad.resolveBot({ id: "admin", port: 2000 })).status, "identity-mismatch");
});

test("matchesIdentity requires exact management key, process and listener evidence", () => {
  const valid = { kind: "child", botKey: "user-123", pid: 1234, listenerConnected: true };
  assert.equal(matchesIdentity({ id: "user-123" }, valid, 1234), true);
  assert.equal(matchesIdentity({ id: "user-123" }, { ...valid, botKey: "other", configuredUid: "user-123" }, 1234), false);
  assert.equal(matchesIdentity({ id: "user-123" }, { ...valid, pid: 999 }, 1234), false);
  assert.equal(matchesIdentity({ id: "admin" }, { ...valid, kind: "main", botKey: "admin" }, 1234), true);
});

test("resolver result shape: supervisor + readiness layers present", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ pid: 1234, listenerConnected: true, kind: "child", botKey: "child", liveZaloUid: "1" }),
  });
  const snap = await resolver.resolveBot({ id: "child", port: 3111 });
  assert.deepEqual(Object.keys(snap.supervisor).sort(), ["available", "code", "pid", "pm2Id", "reason", "restartCount", "status", "uptime"]);
  assert.deepEqual(Object.keys(snap.readiness).sort(), ["checkedAt", "identityVerified", "listenerConnected", "listenerLastError", "listenerState", "memory", "portOpen", "reason", "status"]);
  assert.ok(snap.readiness.checkedAt);
});

// ---------- PM2 adapter: managed inventory ----------

test("pm2-adapter: isMyBotProcess accepts env markers without bot- prefix", () => {
  assert.equal(isMyBotProcess({ name: "user-123", env: { BOT_MANAGED: "true", BOT_KEY: "user-123", MYBOT_INSTANCE_KIND: "child" } }), true);
  assert.equal(isMyBotProcess({ name: "user-123", pm2Env: { env: { BOT_MANAGED: "true", BOT_KEY: "user-123" } } }), true);
  assert.equal(isMyBotProcess({ name: "admin" }), true);
  assert.equal(isMyBotProcess({ name: "mybot-dashboard" }), true);
  assert.equal(isMyBotProcess({ name: "mybot-guardian" }), true);
  assert.equal(isMyBotProcess({ name: "bot-legacy" }), true, "legacy bot- prefix still recognized");
  // Foreign app with colliding name but no markers stays out
  assert.equal(isMyBotProcess({ name: "user-123" }), false);
  assert.equal(isMyBotProcess({ name: "some-other-app" }), false);
  assert.equal(isMyBotProcess(null), false);
});

test("pm2-adapter: normalizePM2Process carries env markers snapshot", () => {
  const raw = {
    name: "user-123",
    pm_id: 7,
    pid: 4321,
    pm2_env: {
      status: "online",
      restart_time: 1,
      env: { BOT_MANAGED: "true", BOT_KEY: "user-123", MYBOT_INSTANCE_KIND: "child", SECRET: "x" },
    },
  };
  const norm = normalizePM2Process(raw);
  assert.equal(norm.env.BOT_MANAGED, "true");
  assert.equal(norm.env.BOT_KEY, "user-123");
  assert.equal(norm.env.SECRET, undefined, "only marker fields are copied");
});

test("pm2-adapter: listManagedProcesses keeps registry-key children and drops foreign apps", async () => {
  const rawFleet = [
    { name: "admin", pm_id: 0, pid: 1, pm2_env: { status: "online", env: { BOT_MANAGED: "true", BOT_KEY: "admin", MYBOT_INSTANCE_KIND: "main" } } },
    { name: "user-123", pm_id: 1, pid: 2, pm2_env: { status: "online", env: { BOT_MANAGED: "true", BOT_KEY: "user-123", MYBOT_INSTANCE_KIND: "child" } } },
    // Legacy process: no env markers, registry key fallback must adopt it
    { name: "user-456", pm_id: 2, pid: 3, pm2_env: { status: "online", env: {} } },
    // bot- prefix without markers: legacy fallback
    { name: "bot-789", pm_id: 3, pid: 4, pm2_env: { status: "online", env: {} } },
    // Foreign PM2 app — never adopted, no markers and not a registry key
    { name: "next-app", pm_id: 4, pid: 5, pm2_env: { status: "online", env: {} } },
    // Explicitly opted-out: BOT_MANAGED=false wins over registry collision
    { name: "intruder", pm_id: 5, pid: 6, pm2_env: { status: "online", env: { BOT_MANAGED: "false" } } },
  ];
  const adapter = new PM2Adapter({ projectRoot: process.cwd(), mock: { listProcesses: async () => rawFleet.map(normalizePM2Process) } });
  const managed = await adapter.listManagedProcesses({ botKeys: ["user-456", "intruder"] });
  const names = managed.map((p) => p.name).sort();
  assert.deepEqual(names, ["admin", "bot-789", "user-123", "user-456"]);
});

test("pm2-adapter: getProcessStatus returns structured availability and never throws on daemon-down", async () => {
  const okAdapter = new PM2Adapter({ projectRoot: process.cwd(), mock: { listProcesses: async () => [normalizePM2Process({ name: "child", pm_id: 1, pid: 9, pm2_env: { status: "online", restart_time: 4 } })] } });
  const ok = await okAdapter.getProcessStatus("child");
  assert.equal(ok.available, true);
  assert.equal(ok.status, "online");
  assert.equal(ok.pid, 9);
  assert.equal(ok.restartCount, 4);

  const downAdapter = new PM2Adapter({ projectRoot: process.cwd(), mock: { listProcesses: async () => { const err = new Error("PM2 daemon unavailable: ECONNREFUSED"); err.code = PM2ErrorCode.DAEMON_UNAVAILABLE; throw err; } } });
  const down = await downAdapter.getProcessStatus("child");
  assert.equal(down.available, false);
  assert.equal(down.code, PM2ErrorCode.DAEMON_UNAVAILABLE);
  assert.equal(down.status, null);
});
