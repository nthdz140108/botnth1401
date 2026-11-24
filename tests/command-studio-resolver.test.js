import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeCommandLayers, sparseOverrideFromPatch } from "../src/commands/studio/config-resolver.js";
import {
  globalStudioPath,
  botStudioPath,
  groupOverridePath,
  readLayerDoc,
  atomicWriteJson,
  bumpRevision,
} from "../src/commands/studio/sparse-store.js";
import { getCommandStudioContract } from "../src/commands/studio/contracts.js";
import { resolveCommandConfigSync } from "../src/commands/studio/config-resolver.js";

function buildRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-resolver-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  return root;
}

test("merge precedence default -> global -> bot -> group with provenance", () => {
  const contract = getCommandStudioContract("sendtask");
  const layers = {
    global: { commands: { sendtask: { values: { "operation.enabled": true, "responses.messages.on": "global-on" } } } },
    bot: { commands: { sendtask: { values: { "responses.messages.on": "bot-on" } } } },
    group: { commands: { sendtask: { values: {} } } },
  };
  const resolved = mergeCommandLayers({ contract, layers });
  assert.equal(resolved.effective["operation.enabled"], true);
  assert.equal(resolved.provenance["operation.enabled"].source, "global");
  assert.equal(resolved.effective["responses.messages.on"], "bot-on");
  assert.equal(resolved.provenance["responses.messages.on"].source, "bot");
  assert.equal(resolved.effective["schedules.timezone"], "Asia/Ho_Chi_Minh");
  assert.equal(resolved.provenance["schedules.timezone"].source, "default");
});

test("fields outside allowedScopes never inherit from that layer", () => {
  const contract = getCommandStudioContract("sendtask");
  const layers = {
    bot: { commands: { sendtask: { values: { "schedules.items": [] } } } },
    group: { commands: { sendtask: { values: { "schedules.enabled": false } } } },
  };
  const resolved = mergeCommandLayers({ contract, layers });
  assert.notEqual(resolved.effective["schedules.items"], undefined);
  assert.equal(Array.isArray(resolved.effective["schedules.items"]), true);
  assert.equal(resolved.effective["schedules.enabled"], true);
  assert.equal(resolved.provenance["schedules.enabled"].source, "default");
});

test("resolveCommandConfigSync reads layer files and honors group overrides only for target thread", async () => {
  const root = buildRoot();
  await atomicWriteJson(globalStudioPath(root), { commands: { help: { values: { "operation.enabled": true } } } });
  await atomicWriteJson(botStudioPath(root, "admin"), { commands: { help: { values: { "operation.cooldownSeconds": 7 } } } });
  await atomicWriteJson(groupOverridePath(root, "admin", "thread-A"), { commands: { help: { values: { "operation.enabled": false } } } });

  const base = getCommandStudioContract("help");
  const withoutGroup = resolveCommandConfigSync({ root, commandName: "help", contract: base, botId: "admin" });
  assert.equal(withoutGroup.effective["operation.enabled"], true);
  assert.equal(withoutGroup.effective["operation.cooldownSeconds"], 7);

  const withGroup = resolveCommandConfigSync({ root, commandName: "help", contract: base, botId: "admin", threadId: "thread-A" });
  assert.equal(withGroup.effective["operation.enabled"], false);
  assert.equal(withGroup.effective["operation.cooldownSeconds"], 7);
  assert.equal(withGroup.provenance["operation.enabled"].source, "group");

  const otherThread = resolveCommandConfigSync({ root, commandName: "help", contract: base, botId: "admin", threadId: "thread-B" });
  assert.equal(otherThread.effective["operation.enabled"], true);
});

test("sparse override builder rejects unknown fields", () => {
  const contract = getCommandStudioContract("help");
  assert.throws(() => sparseOverrideFromPatch(contract, { "nope.field": 1 }), /Unknown studio field/);
  const sparse = sparseOverrideFromPatch(contract, { "operation.enabled": false });
  assert.deepEqual(sparse.values, { "operation.enabled": false });
});

test("layer documents keep revision metadata through write cycles", async () => {
  const root = buildRoot();
  const file = globalStudioPath(root);
  let doc = await readLayerDoc(file);
  assert.equal(doc.meta.revision, 0);
  doc.commands.help = { values: { "operation.enabled": true } };
  bumpRevision(doc);
  await atomicWriteJson(file, doc);
  doc = await readLayerDoc(file);
  assert.equal(doc.meta.revision, 1);
});
