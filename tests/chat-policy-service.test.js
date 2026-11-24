import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotRegistry } from "../src/dashboard/bot-registry.js";
import { ConfigStore } from "../src/dashboard/config-store.js";
import { ChatPolicyService } from "../src/dashboard/chat-policy-service.js";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-policy-service-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({
    name: "child",
    WEB_CONFIG_PATH: "mybot/web-config-child.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "web-config-child.json"), JSON.stringify({
    prefix: "!",
    selectedGroups: { one: true },
  }));
  return root;
}

test("chat policy defaults missing flags to enabled and preserves other keys", async () => {
  const root = await makeRoot();
  const service = new ChatPolicyService({
    root,
    registry: new BotRegistry({ root }),
    configStore: new ConfigStore({ backupDir: path.join(root, "logs", "backups") }),
  });

  const result = await service.read("child");

  assert.equal(result.groupEnabled, true);
  assert.equal(result.privateEnabled, true);
  assert.equal(result.value.prefix, "!");
  assert.deepEqual(result.value.selectedGroups, { one: true });
});

test("chat policy update validates booleans, writes a backup, and merges config", async () => {
  const root = await makeRoot();
  const service = new ChatPolicyService({
    root,
    registry: new BotRegistry({ root }),
    configStore: new ConfigStore({ backupDir: path.join(root, "logs", "backups") }),
  });

  const result = await service.update("child", { privateEnabled: false });
  const saved = JSON.parse(await fs.readFile(path.join(root, "mybot", "web-config-child.json"), "utf8"));

  assert.equal(result.value.groupEnabled, true);
  assert.equal(result.value.privateEnabled, false);
  assert.equal(saved.prefix, "!");
  assert.deepEqual(saved.selectedGroups, { one: true });
  assert.equal(result.restartRequired, true);
  assert.ok(result.backup?.file);
  await fs.access(result.backup.file);
});

test("chat policy rejects non-boolean fields and unknown bots", async () => {
  const root = await makeRoot();
  const service = new ChatPolicyService({ root, registry: new BotRegistry({ root }) });

  await assert.rejects(() => service.update("child", { groupEnabled: "yes" }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "CHAT_POLICY_VALIDATION_FAILED");
    return true;
  });
  await assert.rejects(() => service.read("missing"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, "BOT_NOT_FOUND");
    return true;
  });
});
