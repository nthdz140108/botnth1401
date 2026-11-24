import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatBotExpiryDisplay } from "../src/commands/mybot/System/mybot-display.js";
import { resolveBotRuntimeState } from "../src/commands/mybot/System/pm2-manager.js";
import { migrateLegacyMyBotIdentities } from "../src/commands/mybot/System/mybot-migration.js";
import { saveMyBotsRegistry, loadMyBotsRegistry } from "../src/commands/mybot/System/mybots-registry.js";

test("runtime display: Main Bot online shows Đang hoạt động, stopped pending child shows Chưa khởi động, stopped active child shows Tạm dừng", () => {
  // Main Bot
  const mainOnline = { isMain: true, status: "running", expiryAt: null };
  assert.equal(formatBotExpiryDisplay(mainOnline), "Đang hoạt động");

  const mainNoExpiry = { isMain: true, status: "stopped", expiryAt: "-1" };
  assert.equal(formatBotExpiryDisplay(mainNoExpiry), "Vĩnh Viễn");

  // Child Bot stopped pending
  const childPending = { isMain: false, status: "stopped", trialStatus: "pending", expiryAt: null };
  assert.equal(formatBotExpiryDisplay(childPending), "Chưa khởi động");

  // Child Bot stopped with unexpired time (has expiry)
  const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
  const childStoppedWithExpiry = { isMain: false, status: "stopped", trialStatus: "active", expiryAt: futureExpiry };
  assert.equal(formatBotExpiryDisplay(childStoppedWithExpiry), "Tạm dừng");

  // Child Bot running with active trial
  const childRunning = { isMain: false, status: "running", trialStatus: "active", expiryAt: futureExpiry };
  const disp = formatBotExpiryDisplay(childRunning);
  assert.match(disp, /giờ|phút/);

  // Child Bot rejected
  const childRejected = { isMain: false, status: "rejected", rejecter: "Admin" };
  assert.equal(formatBotExpiryDisplay(childRejected), "Vô Hiệu Hóa Bởi Admin");
});

test("resolveBotRuntimeState: correctly reports running=false for stopped child bot without truthy object distortion", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-state-test-"));
  try {
    const botUid = "child_stopped_bot";
    const registryPath = path.join(tmpDir, "mybot", "mybots.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const reg = {
      [botUid]: {
        name: "Child Bot",
        uid: botUid,
        status: "stopped",
        pid: "9999999", // non-existent dead PID
      },
    };
    saveMyBotsRegistry(reg, registryPath);

    const runtimeState = await resolveBotRuntimeState(botUid, { customRoot: tmpDir, registry: reg });
    assert.equal(runtimeState.running, false);
    assert.equal(runtimeState.status, "stopped");
    assert.equal(typeof runtimeState.running, "boolean");

    // Main Bot with process.pid
    const mainRuntimeState = await resolveBotRuntimeState("admin", { customRoot: tmpDir, registry: reg });
    assert.equal(mainRuntimeState.running, true);
    assert.equal(mainRuntimeState.status, "running");
    assert.equal(mainRuntimeState.source, "main-process");
    assert.equal(mainRuntimeState.pid, process.pid);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});


test("legacy migration: migrates createdBy UID to ownerUid with legacy flag, marks identityPending when seeds incomplete (fail-closed)", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "migration-test-"));
  const registryPath = path.join(tmpDir, "mybot", "mybots.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });

  const legacyRegistry = {
    admin: { name: "Main Bot", isMain: true, uid: "main1" },
    legacyBot1: {
      name: "Legacy Bot 1",
      uid: "bot1111111111",
      createdBy: "999999999999", // valid UID >= 10 chars
    },
    legacyBot2: {
      name: "Legacy Bot 2",
      uid: "bot2222222222",
      createdBy: "Nguyễn Văn A", // name string, not UID
    },
  };
  saveMyBotsRegistry(legacyRegistry, registryPath);

  const res = await migrateLegacyMyBotIdentities({ projectRoot: tmpDir, backup: true });
  assert.equal(res.success, true);
  assert.equal(res.totalCount, 3);
  assert.equal(res.migratedCount >= 2, true);

  const migrated = loadMyBotsRegistry(registryPath);

  // legacyBot1: createdBy converted to ownerUid, marked legacy.
  // identityPending is true (fail-closed) because the 3 admin identity seeds
  // (botAdminUsername, ownerUsername, selfUsername) are incomplete.
  assert.equal(migrated.legacyBot1.ownerUid, "999999999999");
  assert.equal(migrated.legacyBot1.ownerResolution, "legacy");
  assert.equal(migrated.legacyBot1.identityPending, true);

  // legacyBot2: createdBy is name so ownerResolution remains missing.
  // identityPending is true (fail-closed) because seeds are incomplete.
  assert.equal(migrated.legacyBot2.ownerUid, null);
  assert.equal(migrated.legacyBot2.ownerResolution, "missing");
  assert.equal(migrated.legacyBot2.identityPending, true);

  // Verify migration is idempotent
  const res2 = await migrateLegacyMyBotIdentities({ projectRoot: tmpDir, backup: false });
  assert.equal(res2.success, true);
  assert.equal(res2.migratedCount, 0); // No additional changes needed

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
