import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-consistency-"));
  await fs.mkdir(path.join(root, "mybot/bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot/state"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot/mybots.json"), JSON.stringify({
    child: { name: "child", displayName: "Child Bot", status: "running", webPort: 3111 },
    "user-123": { name: "user-123", displayName: "UID Key Bot", status: "running", webPort: 3112 },
  }));
  await fs.writeFile(path.join(root, "mybot/bots/child.json"), JSON.stringify({ name: "child", webPort: 3111 }));
  // Stale PID recorded in state: must NOT make the bot appear running
  await fs.writeFile(path.join(root, "mybot/state/child.json"), JSON.stringify({ status: "running", pid: 999999 }));
  await fs.writeFile(path.join(root, "mybot/bots/user-123.json"), JSON.stringify({ name: "user-123", webPort: 3112 }));
  return root;
}

test("registry: running in mybots.json but no PM2 process → status stopped, connected false", async () => {
  const root = await fixture();
  const registry = new BotRegistry({
    root,
    portProbe: async () => true,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
  });
  const bot = await registry.describe("child");
  assert.equal(bot.configuredStatus, "running");
  assert.equal(bot.status, "stopped", "configured running must not become actual running without PM2 process");
  assert.equal(bot.connected, false);
});

test("registry: stale/reused PID must not fake running or connected", async () => {
  const root = await fixture();
  const registry = new BotRegistry({
    root,
    portProbe: async () => false,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
  });
  const bot = await registry.describe("child");
  assert.equal(bot.processAlive, false, "PID 999999 is not alive");
  assert.equal(bot.connected, false);
  assert.notEqual(bot.status, "running");
});

test("registry: non bot- keys (user-123) resolve through the same status engine", async () => {
  const root = await fixture();
  const registry = new BotRegistry({
    root,
    portProbe: async () => true,
    pm2: {
      getProcessStatus: async (id) => id === "user-123"
        ? { available: true, status: "online", pid: 42, pm2Id: 7, uptime: 5000, restartCount: 0 }
        : { available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 },
    },
  });
  const bot = await registry.describe("user-123");
  assert.equal(bot.supervisor.status, "online");
  assert.ok("readiness" in bot, "readiness layer must be exposed");
  assert.ok("supervisor" in bot, "supervisor layer must be exposed");
});

test("registry: PM2 daemon down → status unknown (not running) for both /api/bots style describe", async () => {
  const root = await fixture();
  const registry = new BotRegistry({
    root,
    portProbe: async () => true,
    pm2: { getProcessStatus: async () => ({ available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "daemon down" }) },
  });
  for (const id of ["child", "user-123"]) {
    const bot = await registry.describe(id);
    assert.equal(bot.status, "unknown", `${id} must be unknown when PM2 daemon is unreachable`);
    assert.equal(bot.connected, false);
  }
});
