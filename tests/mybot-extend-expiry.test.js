import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseDuration } from "../src/commands/mybot/System/mybot-parser.js";
import { extendBotExpiryLogic, calculateExtendExpiry } from "../src/commands/mybot/System/mybot-lifecycle.js";

test("parseDuration supports s, m, min, h, d, w, mon, y", () => {
  assert.equal(parseDuration("30m"), 30 * 60 * 1000);
  assert.equal(parseDuration("30min"), 30 * 60 * 1000);
  assert.equal(parseDuration("1h"), 3600 * 1000);
  assert.equal(parseDuration("12h"), 12 * 3600 * 1000);
  assert.equal(parseDuration("1d"), 24 * 3600 * 1000);
  assert.equal(parseDuration("7d"), 7 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1w"), 7 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1mon"), 30 * 24 * 3600 * 1000);
  assert.equal(parseDuration("1y"), 365 * 24 * 3600 * 1000);
  assert.equal(parseDuration("-1"), -1);
  assert.equal(parseDuration("invalid"), null);
});

test("extendBotExpiryLogic extends expiry without mutating requester or auto-starting bot", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-ext-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  const initialExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
  const registry = {
    "bot_target": {
      uid: "bot_target",
      displayName: "Target Bot",
      status: "stopped",
      expiryAt: initialExpiry,
    },
  };
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  let startInvoked = false;
  const result = await extendBotExpiryLogic({
    registryPath,
    botKey: "bot_target",
    durationMs: 24 * 3600 * 1000,
    startBotFn: async () => { startInvoked = true; },
  });

  assert.equal(result.success, true);
  assert.equal(startInvoked, false, "extend must NOT auto-start bot");

  const updatedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const updatedExpiry = updatedRegistry.bot_target.expiryAt;
  const diff = new Date(updatedExpiry).getTime() - new Date(initialExpiry).getTime();
  assert.equal(diff, 24 * 3600 * 1000);
});
