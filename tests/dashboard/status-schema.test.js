import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "status-schema-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), "{}", "utf8");
  return root;
}

test("registry describe() stamps statusSchemaVersion 2 with supervisor/readiness/reason", async () => {
  const root = await tempRoot();
  const registry = new BotRegistry({
    root,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
  });
  const bot = await registry.describe("admin");
  assert.equal(bot.statusSchemaVersion, 2);
  assert.equal(bot.status, "stopped");
  assert.equal(bot.statusReason, "pm2-stopped");
  assert.equal(bot.supervisor.status, null);
  assert.ok(bot.readiness);
  assert.ok(bot.supervisor);
});

test("registry describe() degrades to schema v2 with unknown when PM2 daemon is down", async () => {
  const root = await tempRoot();
  const registry = new BotRegistry({
    root,
    pm2: { getProcessStatus: async () => ({ available: false, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0, reason: "daemon down", code: "daemon_unavailable" }) },
  });
  const bot = await registry.describe("admin");
  assert.equal(bot.statusSchemaVersion, 2);
  assert.equal(bot.status, "unknown");
  assert.ok(bot.statusReason, "statusReason must be present");
  assert.equal(bot.supervisor.available, false);
});

test("registry list() stamps schema v2 on every bot record", async () => {
  const root = await tempRoot();
  const registry = new BotRegistry({
    root,
    pm2: { getProcessStatus: async () => ({ available: true, status: null, pid: null, pm2Id: null, uptime: 0, restartCount: 0 }) },
  });
  const bots = await registry.list();
  assert.ok(bots.length >= 1);
  for (const bot of bots) {
    assert.equal(bot.statusSchemaVersion, 2, `${bot.id} must carry schema v2`);
    assert.ok("statusReason" in bot, `${bot.id} must carry statusReason`);
    assert.ok(bot.supervisor, `${bot.id} must carry supervisor`);
    assert.ok(bot.readiness, `${bot.id} must carry readiness`);
  }
});
