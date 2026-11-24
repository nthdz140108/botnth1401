import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDefaultAntiState,
  evaluateAntiRules,
  migrateAntiConfigFiles,
  normalizeAntiState,
  resolveGroupAntiSettings,
} from "../src/service-debug/anti-service/anti-config-schema.js";

test("phase 5 migration normalizes legacy anti config and is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hhh-phase5-"));
  const antiDir = path.join(root, "src", "service-debug", "anti-service");
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.mkdir(antiDir, { recursive: true });

  const legacyGroupSettings = {
    "group-1": {
      removeLinks: true,
      antiSpam: true,
      whiteList: { "user-1": { name: "Alice" } },
    },
  };
  await fs.writeFile(
    path.join(root, "assets", "data", "group_settings.json"),
    `${JSON.stringify(legacyGroupSettings, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(antiDir, "link-whitelist.json"),
    `${JSON.stringify({ "group-1": { patterns: ["example.com"] } }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(antiDir, "list.json"),
    `${JSON.stringify(["badword"], null, 2)}\n`,
    "utf8"
  );

  const first = await migrateAntiConfigFiles(root);
  const firstConfig = JSON.parse(await fs.readFile(first.configPath, "utf8"));
  const second = await migrateAntiConfigFiles(root);
  const secondConfig = JSON.parse(await fs.readFile(second.configPath, "utf8"));

  assert.equal(firstConfig.groups["group-1"].removeLinks, true);
  assert.equal(firstConfig.groups["group-1"].antiSpam, true);
  assert.equal(firstConfig.groups["group-1"].whiteList["user-1"].name, "Alice");
  assert.deepEqual(firstConfig, secondConfig);
  assert.deepEqual(secondConfig.migratedSources, ["assets/data/group_settings.json"]);
});

test("phase 5 rule evaluation returns structured handled state without leaking action logic", async () => {
  const calls = [];
  const result = await evaluateAntiRules(
    { onError: (details) => calls.push(details) },
    [
      {
        name: "rule-a",
        run: async () => ({ handled: false }),
      },
      {
        name: "rule-b",
        run: async () => ({ handled: true, rule: "rule-b", action: "delete" }),
      },
      {
        name: "rule-c",
        run: async () => {
          throw new Error("should not run");
        },
      },
    ]
  );

  assert.deepEqual(result, { handled: true, rule: "rule-b", action: "delete" });
  assert.deepEqual(calls, []);
});

test("phase 5 group settings resolver fills missing defaults without mutating unrelated keys", () => {
  const groupSettings = {};
  const settings = resolveGroupAntiSettings(groupSettings, "group-9");

  assert.equal(settings.removeLinks, false);
  assert.equal(settings.antiSpam, false);
  assert.equal(settings.whiteList && typeof settings.whiteList, "object");
  assert.equal(groupSettings["group-9"].removeLinks, false);
});

test("phase 5 default anti state keeps the required schema keys", () => {
  const state = normalizeAntiState(createDefaultAntiState());
  assert.deepEqual(Object.keys(state).sort(), [
    "badWords",
    "groups",
    "linkRegex",
    "migratedSources",
    "violations",
    "violationsNude",
  ]);
});
