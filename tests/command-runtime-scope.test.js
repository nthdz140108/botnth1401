import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadRuntimeCommandPolicy,
  resolveRuntimeCommandPolicy,
} from "../src/commands/command-policy-loader.js";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-runtime-policy-"));
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "command-overrides"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    commands: [{ name: "demo", alias: ["d"], scope: "group", permission: "all" }],
  }));
  await fs.writeFile(path.join(root, "mybot", "command-overrides", "child.json"), JSON.stringify({
    demo: { scope: "private" },
  }));
  return root;
}

test("runtime loader applies global scope and the current bot override", async () => {
  const root = await makeRoot();
  const policy = loadRuntimeCommandPolicy({ root, botId: "child" });
  const result = resolveRuntimeCommandPolicy({ name: "demo", alias: ["d"], scope: "both" }, policy);

  assert.equal(result.effectiveScope, "private");
  assert.equal(result.override.scope, "private");
});

test("runtime loader falls back to global scope after an override reset", async () => {
  const root = await makeRoot();
  await fs.rm(path.join(root, "mybot", "command-overrides", "child.json"));
  const policy = loadRuntimeCommandPolicy({ root, botId: "child" });
  const result = resolveRuntimeCommandPolicy({ name: "demo", scope: "both" }, policy);

  assert.equal(result.effectiveScope, "group");
  assert.equal(result.override, null);
});

test("runtime policy keeps unrelated command metadata intact", async () => {
  const root = await makeRoot();
  const policy = loadRuntimeCommandPolicy({ root, botId: "child" });
  const result = resolveRuntimeCommandPolicy({ name: "demo", permission: "adminBot", active: false }, policy);

  assert.equal(result.permission, "adminBot");
  assert.equal(result.active, false);
  assert.equal(result.effectiveScope, "private");
});
