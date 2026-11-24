import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { ConfigStore } from "../src/dashboard/config-store.js";

test("bot registry resolves admin and never exposes credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({ child: { name: "child", displayName: "Child" } }));
  await fs.writeFile(path.join(root, "mybot", "bots", "admin.json"), JSON.stringify({ name: "admin", configFilePath: "secret.json" }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({ name: "child", configFilePath: "child-secret.json" }));
  const bots = await new BotRegistry({ root }).list();
  assert.equal(bots.length, 2);
  assert.equal(Object.hasOwn(bots[0], "cookie"), false);
  assert.equal(bots.find((bot) => bot.id === "child").configPath, path.join(root, "child-secret.json"));
  assert.equal(bots.find((bot) => bot.id === "child").credential.state, "missing");
});

test("config store writes a backup and rolls back invalid JSON input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-store-"));
  const file = path.join(root, "config.json");
  await fs.writeFile(file, JSON.stringify({ prefix: "!" }));
  const store = new ConfigStore({ backupDir: path.join(root, "backups") });
  const result = await store.writeJson(file, { prefix: "." });
  assert.equal(result.value.prefix, ".");
  assert.equal((await fs.readdir(path.join(root, "backups"))).length, 1);
  await assert.rejects(() => store.writeJson(file, null), /object/);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).prefix, ".");
  const rollback = await store.rollback(file, result.backup);
  assert.equal(rollback.value.prefix, "!");
  const arrayResult = await store.writeJson(file, [{ name: "admin" }]);
  assert.deepEqual(arrayResult.value, [{ name: "admin" }]);
});
