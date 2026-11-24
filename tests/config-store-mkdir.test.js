import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore } from "../src/dashboard/config-store.js";

test("writeJson creates missing parent directories before atomic rename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-mkdir-"));
  const store = new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  const target = path.join(root, "mybot", "command-overrides", "admin.json");

  const result = await store.writeJson(target, { help: { active: true } });
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).help.active, true);
  assert.ok(result.backup === null, "first write has no backup");

  const second = await store.writeJson(target, { help: { active: false } });
  assert.ok(second.backup.file && fs.existsSync(second.backup.file));
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).help.active, false);
});

test("updateJson also works when the target file and directories do not exist yet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-mkdir-"));
  const store = new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  const target = path.join(root, "mybot", "instances", "bot-1", "data", "command-studio.json");

  const result = await store.updateJson(target, (current) => ({ ...current, commands: { help: {} } }));
  assert.ok(result.value.commands.help);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).commands.help, {});
});
