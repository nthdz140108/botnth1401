import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeStatusResolver } from "../src/dashboard/runtime-status-resolver.js";

/**
 * Dashboard expiry classification regression tests.
 *
 * Production bug: dashboard used `Date.parse("-1")` which yields NaN, so
 * `"-1"` was treated as a missing expiry. The compare-with-now never
 * matched and bots whose `expiryAt === "-1"` (permanent plan) showed up as
 * "Expired" on the dashboard forever.
 *
 * The resolver + bot-registry now share `classifyBotExpiry`. These tests
 * verify the resolver no longer relies on `Date.parse(expiryAt)` directly:
 *   - "-1" → not expired (status from configured/running layer)
 *   - future ISO → not expired
 *   - past ISO → expired (decision ladder still runs)
 *   - malformed/missing → not auto-expired (no false expired)
 */

function sup(overrides = {}) {
  return { available: true, status: "online", pid: 1234, pm2Id: 3, uptime: 5000, restartCount: 0, ...overrides };
}

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dashboard-expiry-"));
}

test("resolver: expiryAt '-1' is treated as permanent (not expired)", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ kind: "child", botKey: "user-1", liveZaloUid: "999" }),
  });
  const snap = await resolver.resolveBot({
    id: "user-1",
    port: 3111,
    expiryAt: "-1",
    configuredStatus: "running",
  });
  assert.notEqual(snap.status, "expired", "'-1' must NEVER be classified as expired");
  assert.equal(snap.expired, false);
});

test("resolver: future ISO expiry is not expired", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ kind: "child", botKey: "user-2", liveZaloUid: "999" }),
  });
  const snap = await resolver.resolveBot({
    id: "user-2",
    port: 3111,
    expiryAt: new Date(Date.now() + 86400000).toISOString(),
    configuredStatus: "running",
  });
  assert.notEqual(snap.status, "expired");
  assert.equal(snap.expired, false);
});

test("resolver: past ISO expiry is expired", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ kind: "child", botKey: "user-3", liveZaloUid: "999" }),
  });
  const snap = await resolver.resolveBot({
    id: "user-3",
    port: 3111,
    expiryAt: new Date(Date.now() - 86400000).toISOString(),
    configuredStatus: "running",
  });
  assert.equal(snap.status, "expired");
  assert.equal(snap.expired, true);
});

test("resolver: malformed expiry string is never auto-expired", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ kind: "child", botKey: "user-4", liveZaloUid: "999" }),
  });
  const snap = await resolver.resolveBot({
    id: "user-4",
    port: 3111,
    expiryAt: "not-a-date",
    configuredStatus: "running",
  });
  assert.notEqual(snap.status, "expired", "malformed expiry must never auto-expire");
});

test("resolver: missing expiry without trialStatus is not expired", async () => {
  const root = await tempRoot();
  const resolver = createRuntimeStatusResolver({
    root,
    pm2: { getProcessStatus: async () => sup() },
    portProbe: async () => true,
    identityFetcher: async () => ({ kind: "child", botKey: "user-5", liveZaloUid: "999" }),
  });
  const snap = await resolver.resolveBot({
    id: "user-5",
    port: 3111,
    expiryAt: null,
    configuredStatus: "running",
  });
  // Null expiry without active trial is malformed/unknown, but must NOT be
  // auto-expired (would have been the old behavior).
  assert.notEqual(snap.status, "expired");
});

test("bot-registry normalizeStatus: '-1' is NOT expired", async () => {
  const { BotRegistry } = await import("../src/dashboard/bot-registry.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-registry-perm-"));
  const mybotDir = path.join(root, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });
  await fs.writeFile(path.join(mybotDir, "mybots.json"),
    JSON.stringify({ "bot-perm": { status: "running", expiryAt: "-1", webPort: 5311 } }), "utf8");

  // Stub a no-op PM2 + portProbe.
  const reg = new BotRegistry({
    root,
    pm2: { listProcesses: async () => [], getProcessStatus: async () => ({ available: true, status: "stopped" }) },
    portProbe: async () => false,
  });

  const bots = await reg.list();
  const target = bots.find((b) => b.id === "bot-perm");
  assert.ok(target, "bot-perm must be in the listing");
  assert.notEqual(target.status, "expired", "'-1' expiry must not be classified as expired");
  assert.notEqual(target.configuredStatus, "expired");
});