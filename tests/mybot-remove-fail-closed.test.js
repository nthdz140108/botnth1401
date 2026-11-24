import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PM2Adapter, PM2ErrorCode } from "../src/runtime/pm2-adapter.js";
import { deleteChildBotLogic } from "../src/commands/mybot/System/mybot-lifecycle.js";

test("PM2Adapter.deleteBot() standardizes result and handles mock absent vs present", async () => {
  // 1. Success mock
  const adapter1 = new PM2Adapter({
    mock: {
      deleteBot: async (name) => ({ success: true, verifiedAbsent: true }),
    },
  });
  const res1 = await adapter1.deleteBot("bot-123");
  assert.equal(res1.success, true);
  assert.equal(res1.verifiedAbsent, true);
  assert.equal(res1.pm2Name, "bot-123");

  // 2. Failure mock (process still present)
  const adapter2 = new PM2Adapter({
    mock: {
      deleteBot: async (name) => ({ success: false, verifiedAbsent: false, reason: PM2ErrorCode.PM2_DELETE_FAILED }),
    },
  });
  const res2 = await adapter2.deleteBot("bot-123");
  assert.equal(res2.success, false);
  assert.equal(res2.verifiedAbsent, false);
  assert.equal(res2.reason, PM2ErrorCode.PM2_DELETE_FAILED);

  // 3. Missing name
  const adapter3 = new PM2Adapter();
  const res3 = await adapter3.deleteBot("");
  assert.equal(res3.success, false);
  assert.equal(res3.reason, PM2ErrorCode.MISSING_PM2_NAME);
  assert.equal(res3.verifiedAbsent, false);
});

test("deleteChildBotLogic fails closed when PM2 delete returns false", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-del-fail-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const credDir = path.join(mybotDir, "credentials");
  fs.mkdirSync(credDir, { recursive: true });

  const credPath = path.join(credDir, "bot-test.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "secret" }), "utf8");

  const registryPath = path.join(mybotDir, "mybots.json");
  const initialRegistry = {
    admin: { uid: "admin_uid", isMain: true, status: "running" },
    "bot-test": { uid: "bot-test", status: "online", displayName: "TestBot" },
  };
  fs.writeFileSync(registryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

  // Mock PM2 delete returning false (e.g. process still present)
  const result = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "bot-test",
    deleteProcessFn: async () => ({
      success: false,
      reason: PM2ErrorCode.PM2_DELETE_FAILED,
      verifiedAbsent: false,
      detail: "Process is locked",
    }),
  });

  assert.equal(result.success, false);
  assert.equal(result.verifiedAbsent, false);

  // Credentials must still exist!
  assert.equal(fs.existsSync(credPath), true, "Credentials file must NOT be deleted on PM2 error");

  // Registry must NOT have deleted the bot, and status must be rolled back to 'online'
  const currentRegistry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.ok(currentRegistry["bot-test"], "Bot must still exist in registry");
  assert.equal(currentRegistry["bot-test"].status, "online", "Status must rollback to online");
  assert.ok(currentRegistry["bot-test"].lastDeleteError, "lastDeleteError must be recorded");
});

test("deleteChildBotLogic fails closed when PM2 delete throws daemon unavailable", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-del-throw-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const credDir = path.join(mybotDir, "credentials");
  fs.mkdirSync(credDir, { recursive: true });

  const credPath = path.join(credDir, "bot-fail.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "secret" }), "utf8");

  const registryPath = path.join(mybotDir, "mybots.json");
  const initialRegistry = {
    admin: { uid: "admin_uid", isMain: true, status: "running" },
    "bot-fail": { uid: "bot-fail", status: "stopped" },
  };
  fs.writeFileSync(registryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

  const result = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "bot-fail",
    deleteProcessFn: async () => {
      const err = new Error("PM2 daemon unreachable");
      err.code = PM2ErrorCode.DAEMON_UNAVAILABLE;
      throw err;
    },
  });

  assert.equal(result.success, false);
  assert.equal(fs.existsSync(credPath), true, "Credentials file must NOT be deleted");

  const currentRegistry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.ok(currentRegistry["bot-fail"]);
  assert.equal(currentRegistry["bot-fail"].status, "stopped");
});

test("deleteChildBotLogic removes files and registry only when PM2 delete succeeds", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-del-success-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const credDir = path.join(mybotDir, "credentials");
  fs.mkdirSync(credDir, { recursive: true });

  const credPath = path.join(credDir, "bot-ok.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "secret" }), "utf8");

  const registryPath = path.join(mybotDir, "mybots.json");
  const initialRegistry = {
    admin: { uid: "admin_uid", isMain: true, status: "running" },
    "bot-ok": { uid: "bot-ok", status: "stopped" },
  };
  fs.writeFileSync(registryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

  let pm2DeleteCalled = false;
  let killCalled = false;

  const result = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "bot-ok",
    deleteProcessFn: async (key) => {
      pm2DeleteCalled = true;
      return { success: true, pm2Name: key, verifiedAbsent: true, ownershipVerified: true };
    },
    killProcessFn: async () => {
      killCalled = true;
    },
  });

  assert.equal(result.success, true);
  assert.equal(pm2DeleteCalled, true);
  assert.equal(killCalled, true);

  // Files and registry must be cleaned up
  assert.equal(fs.existsSync(credPath), false, "Credentials must be cleaned up on success");
  const currentRegistry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  assert.equal(currentRegistry["bot-ok"], undefined, "Registry entry must be removed on success");
});

test("deleteChildBotLogic rejects undefined or boolean callback and fails closed", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-del-bool-"));
  const mybotDir = path.join(tmpDir, "mybot");
  const credDir = path.join(mybotDir, "credentials");
  fs.mkdirSync(credDir, { recursive: true });
  const credPath = path.join(credDir, "bot-bool.json");
  fs.writeFileSync(credPath, '{"secret":"keep-me"}');

  const registryPath = path.join(mybotDir, "mybots.json");
  fs.writeFileSync(registryPath, JSON.stringify({
    admin: { uid: "admin", isMain: true, status: "running" },
    "bot-bool": { uid: "bot-bool", status: "online" },
  }));

  // Callback returns boolean true without structured verifiedAbsent/ownershipVerified
  const resBool = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "bot-bool",
    deleteProcessFn: async () => true, // legacy boolean
  });

  assert.equal(resBool.success, false, "legacy boolean callback must NOT succeed");
  assert.equal(fs.existsSync(credPath), true, "Credentials must NOT be deleted on boolean callback");

  // Callback returns undefined
  const resUndef = await deleteChildBotLogic({
    projectRoot: tmpDir,
    registryPath,
    botKey: "bot-bool",
    deleteProcessFn: async () => undefined,
  });

  assert.equal(resUndef.success, false, "legacy undefined callback must NOT succeed");
  assert.equal(fs.existsSync(credPath), true, "Credentials must NOT be deleted on undefined callback");
});

test("PM2Adapter.deleteBot fails closed on foreign process collision", async () => {
  const adapter = new PM2Adapter({
    mock: null,
  });
  // Simulate foreign process existing in listProcesses that is NOT managed by MyBot
  adapter.listProcesses = async () => [
    {
      name: "bot-foreign",
      pm2Name: "bot-foreign",
      pid: 9999,
      script: "/var/apps/other-app/server.js",
      env: { BOT_MANAGED: "false" },
    },
  ];

  const res = await adapter.deleteBot("bot-foreign");
  assert.equal(res.success, false);
  assert.equal(res.ownershipVerified, false);
  assert.equal(res.verifiedAbsent, false);
  assert.equal(res.reason, "foreign_process_collision");
});

test("Dashboard deleteBot fails closed and preserves inventory/files when PM2 delete fails", async () => {
  const { createBotActionService, DELETE_CONFIRMATION } = await import("../src/dashboard/bot-action-service.js");
  const { ConfigStore } = await import("../src/dashboard/config-store.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-del-fail-"));
  const invPath = path.join(tmpDir, "mybot", "mybots.json");
  const candFile = path.join(tmpDir, "mybot", "instances", "bot-child", "data.json");
  fs.mkdirSync(path.dirname(candFile), { recursive: true });
  fs.writeFileSync(candFile, '{"state":"ok"}');
  fs.writeFileSync(invPath, JSON.stringify({
    "bot-child": { uid: "bot-child", displayName: "Child", status: "online" }
  }));

  const mockRegistry = {
    inventoryPath: invPath,
    describe: async (id) => ({
      id,
      name: "bot-child",
      displayName: "Child",
      status: "online",
      isMain: false,
      candidatePaths: [candFile],
      files: { config: candFile },
    }),
  };

  const configStore = new ConfigStore({ backupDir: path.join(tmpDir, "logs", "backups") });

  const actionService = createBotActionService({
    root: tmpDir,
    registry: mockRegistry,
    configStore,
    pm2Adapter: {
      delete: async () => ({ success: false, reason: "PM2_DELETE_FAILED", verifiedAbsent: false, ownershipVerified: true }),
      stop: async () => ({ success: true }),
    },
  });

  await assert.rejects(async () => {
    await actionService.delete("bot-child", { confirm: DELETE_CONFIRMATION, confirmId: "bot-child", confirmName: "Child" });
  }, /PM2 delete failed/);

  // Candidate file and inventory MUST NOT be deleted
  assert.equal(fs.existsSync(candFile), true, "Candidate file must still exist");
  const inv = JSON.parse(fs.readFileSync(invPath, "utf8"));
  assert.ok(inv["bot-child"], "Inventory must still contain bot-child");
});
