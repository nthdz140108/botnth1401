import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { commandRegistry } from "../src/commands/command-registry.js";
import {
  getStudioContractCatalog,
  getCommandStudioContract,
  buildCoverageMatrix,
  buildSendtaskContract,
} from "../src/commands/studio/contracts.js";
import { validateStudioContract, STUDIO_CONTRACT_VERSION } from "../src/commands/studio/contract-v2.js";
import { buildDefaultSendtaskSchedules } from "../src/commands/studio/sendtask-defaults.js";

test("every registry definition has a valid contract with handlerRef", () => {
  const catalog = getStudioContractCatalog();
  assert.equal(catalog.contracts.length, commandRegistry.definitions.length);
  for (const definition of commandRegistry.definitions) {
    const contract = catalog.byName.get(definition.name);
    assert.ok(contract, `missing contract for ${definition.name}`);
    const validation = validateStudioContract(contract);
    assert.deepEqual(
      validation.errors,
      [],
      `invalid contract for ${definition.name}: ${JSON.stringify(validation.errors)}`,
    );
    assert.equal(contract.version, STUDIO_CONTRACT_VERSION);
    assert.ok(contract.handlerRef.module, `${definition.name} must declare handler module`);
    assert.ok(typeof contract.handlerRef.export === "string" && contract.handlerRef.export, `${definition.name} must declare handler export`);
  }
});

test("coverage matrix is complete: no MISSING/PARTIAL and counts match registry", () => {
  const { summary } = buildCoverageMatrix();
  assert.equal(summary.totalRegistry, commandRegistry.definitions.length);
  assert.equal(summary.totalContracts, commandRegistry.definitions.length);
  assert.equal(summary.full, commandRegistry.definitions.length);
  assert.equal(summary.partial, 0);
  assert.equal(summary.missing, 0);
  assert.equal(summary.complete, true);
});

test("catalog, registry and command.json agree without alias collisions", () => {
  const doc = JSON.parse(fs.readFileSync(new URL("../assets/json-data/command.json", import.meta.url), "utf8"));
  const jsonNames = new Set((doc.commands || []).map((c) => c.name));
  const registryNames = new Set(commandRegistry.definitions.map((d) => d.name));
  assert.equal(registryNames.size, commandRegistry.definitions.length);
  assert.equal(jsonNames.size, registryNames.size);
  for (const name of registryNames) {
    assert.ok(jsonNames.has(name), `command.json missing ${name}`);
  }
  const seenAliases = new Set();
  for (const definition of commandRegistry.definitions) {
    for (const alias of definition.aliases) {
      assert.ok(!seenAliases.has(alias), `alias collision: ${alias}`);
      seenAliases.add(alias);
    }
  }
  assert.ok(jsonNames.has("antigif"), "antigif must be present in catalog");
  assert.equal(jsonNames.has("cotuong"), false);
});

test("sendtask deep contract declares schedules/sources tabs with 24 defaults", () => {
  const contract = getCommandStudioContract("sendtask");
  assert.equal(contract.adapter, "sendtask-scheduler");
  const tabIds = contract.tabs.map((t) => t.id);
  for (const id of ["overview", "handler", "schedules", "sources", "operation", "responses", "permissions", "secrets", "history"]) {
    assert.ok(tabIds.includes(id), `sendtask tab ${id} missing`);
  }
  const schedulesField = contract.tabs
    .find((tab) => tab.id === "schedules")
    .fields.find((field) => field.key === "schedules.items");
  assert.equal(schedulesField.default.length, 24);
  assert.equal(schedulesField.allowedScopes.includes("group"), false, "schedules must not be overridable per group");
  assert.equal(schedulesField.default[0].timezone, "Asia/Ho_Chi_Minh");
  const kinds = new Set(schedulesField.default.map((row) => row.kind));
  assert.deepEqual([...kinds].sort(), ["girl-video", "tiktok-search", "zing-chart"]);
  const sourcesTab = contract.tabs.find((tab) => tab.id === "sources");
  assert.ok(sourcesTab.fields.some((f) => f.key === "sources.girlVideo"));
  assert.ok(sourcesTab.fields.some((f) => f.key === "sources.tiktokSearch"));
  assert.ok(sourcesTab.fields.some((f) => f.key === "sources.zingChart"));
});

test("default sendtask schedules migrate legacy crons 1:1", () => {
  const rows = buildDefaultSendtaskSchedules();
  assert.equal(rows.length, 24);
  rows.forEach((row, hour) => {
    assert.equal(row.id, `hour-${String(hour).padStart(2, "0")}`);
    // Toàn bộ lịch bắn cố định ở phút :05 của từng giờ
    assert.equal(row.cron, `5 ${hour} * * *`);
    assert.equal(row.enabled, true);
  });
  assert.equal(rows[0].kind, "girl-video");
  assert.equal(rows[0].category, "sexy");
  assert.equal(rows[3].kind, "zing-chart");
  assert.equal(rows[4].kind, "tiktok-search");
  assert.match(rows[4].queryTemplate, /\{\{timestamp\}\}/);
});

test("contract validator rejects broken contracts", () => {
  assert.equal(validateStudioContract(null).ok, false);
  const bad = buildSendtaskContract({ name: "x", aliases: [], permission: "all", requiredConfig: [], requiredDependencies: [], handler: {} });
  bad.version = 1;
  bad.handlerRef = null;
  const result = validateStudioContract(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === "version"));
  assert.ok(result.errors.some((e) => e.path === "handlerRef"));
});
