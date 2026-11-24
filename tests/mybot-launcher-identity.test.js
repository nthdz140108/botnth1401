import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  printRuntimeFingerprint,
  resolveInstanceKind,
  loadProviderEnvironment,
  RUNTIME_VERSION,
} from "../src/bootstrap.js";

const execFileAsync = promisify(execFile);

test("Task 2: resolveInstanceKind accurately identifies Main vs Child", () => {
  assert.equal(resolveInstanceKind({ botUid: "admin" }), "main");
  assert.equal(resolveInstanceKind({ botName: "admin" }), "main");
  assert.equal(resolveInstanceKind({ botUid: "" }), "main");
  assert.equal(resolveInstanceKind({ explicitKind: "main" }), "main");
  assert.equal(resolveInstanceKind({ botUid: "1234567890" }), "child");
  assert.equal(resolveInstanceKind({ botName: "my_child_bot" }), "child");
  assert.equal(resolveInstanceKind({ explicitKind: "child" }), "child");
});

test("Task 2: printRuntimeFingerprint formats all runtime identity parameters", () => {
  const banner = printRuntimeFingerprint({
    entrypoint: "src/bootstrap.js",
    botName: "TestBotKey",
    botKey: "TestBotKey",
    botUid: "9988776655",
    instanceKind: "child",
    configPath: "mybot/configs/custom.json",
    commit: "abc1234",
  });

  assert.ok(banner.includes('root='));
  assert.ok(banner.includes('bot="TestBotKey"'));
  assert.ok(banner.includes('key="TestBotKey"'));
  assert.ok(banner.includes('uid="9988776655"'));
  assert.ok(banner.includes('kind="child"'));
  assert.ok(banner.includes('config="mybot/configs/custom.json"'));
  assert.ok(banner.includes(`version="${RUNTIME_VERSION}"`));
  assert.ok(banner.includes('commit="abc1234"'));
});

test("Task 2: run.bat and PM2 adapter propagate runtime identity on Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows-only batch script test");
    return;
  }

  const runBatContent = await fs.readFile(path.resolve("run.bat"), "utf8");
  const pm2AdapterContent = await fs.readFile(path.resolve("src/runtime/pm2-adapter.js"), "utf8");
  assert.ok(runBatContent.includes("NODE_SKIP_PLATFORM_CHECK=1"));
  assert.ok(runBatContent.includes("reconcile-and-monitor.js"));
  assert.ok(pm2AdapterContent.includes("bootstrap.js"));
  assert.ok(pm2AdapterContent.includes("BOT_KEY"));
});
