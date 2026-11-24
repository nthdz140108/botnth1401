import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLogs } from "../src/dashboard/log-reader.js";
import { BackupStore } from "../src/dashboard/backup-store.js";

test("log reader filters severity and search", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "logs-"));
  await fs.mkdir(path.join(root, "logs", "admin"), { recursive: true });
  await fs.writeFile(path.join(root, "logs", "admin", "bot.log"), "info ready\nERROR port conflict\nwarning retry\n");
  const rows = await readLogs({ root, botId: "admin", severity: "error", search: "port" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, "error");
});

test("backup store refuses paths outside project root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"));
  await fs.writeFile(path.join(root, "config.json"), "{}", "utf8");
  const store = new BackupStore({ root });
  const result = await store.backup(["config.json"]);
  assert.equal(result.count, 1);
  await assert.rejects(() => store.backup(["..\\outside.json"]), /Invalid project path/);
});
