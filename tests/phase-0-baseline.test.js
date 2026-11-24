import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  VIP_FEATURE_FLAGS,
  VIP_FLAG_GROUPS,
  buildCommandBaseline,
  detectCommandRegistryCollisions,
  readCommandBaselineFiles,
  writePhase0BaselineSnapshot,
} from "../src/utils/command-baseline.js";
import { commandRegistry } from "../src/commands/command-registry.js";

const root = path.resolve(process.cwd());

test("phase 0 baseline keeps command.json and defaultCommand.json aligned at 218 commands", async () => {
  const baseline = await readCommandBaselineFiles(root);

  assert.equal(baseline.summary.canonicalCount, 218);
  assert.equal(baseline.summary.defaultCount, 218);
  assert.equal(baseline.summary.registryCount, 218);
  assert.equal(baseline.summary.activeMismatchCount, 0);
  assert.equal(baseline.collisions.length, 0);
  assert.equal(baseline.missingInDefault.length, 0);
  assert.equal(baseline.missingInCommand.length, 0);
  assert.deepEqual(baseline.registryMissingInCommand, []);
  assert.deepEqual(baseline.registryMissingHandlers, []);
});

test("phase 0 baseline exposes a stable feature-flag catalog", () => {
  const baseline = buildCommandBaseline({
    commandConfig: { commands: [] },
    defaultCommandConfig: { commands: [] },
    registry: commandRegistry,
  });

  assert.deepEqual(baseline.featureFlags, VIP_FEATURE_FLAGS);
  assert.deepEqual(baseline.featureFlagGroups, {
    media: ["vip.media"],
    ai: ["vip.ai"],
    group: ["vip.group"],
    utility: ["vip.utility"],
    highRisk: ["vip.highRisk"],
  });
  assert.deepEqual(VIP_FLAG_GROUPS.media, ["vip.media"]);
});

test("phase 0 baseline detects registry collisions without leaking secrets", () => {
  const collisions = detectCommandRegistryCollisions({
    definitions: [
      { name: "help", aliases: ["menu"] },
      { name: "menu", aliases: [] },
    ],
  });

  assert.deepEqual(collisions, [
    { key: "menu", first: "help", second: "menu" },
  ]);
});

test("phase 0 snapshot writes isolated backup artifacts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "phase-0-baseline-"));
  await fs.mkdir(path.join(tempRoot, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "mybot"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!", commands: [] }));
  await fs.writeFile(path.join(tempRoot, "mybot", "defaultCommand.json"), JSON.stringify({ prefix: "!", commands: [] }));

  const output = await writePhase0BaselineSnapshot(tempRoot, {
    summary: { canonicalCount: 0, registryCount: 0, defaultCount: 0, collisionCount: 0, activeMismatchCount: 0, permissionMismatchCount: 0 },
    commands: [],
    defaults: [],
    collisions: [],
    missingInDefault: [],
    missingInCommand: [],
    registryMissingHandlers: [],
    registryMissingInCommand: [],
    activeMismatch: [],
    permissionMismatch: [],
    featureFlags: VIP_FEATURE_FLAGS,
    featureFlagGroups: { media: ["vip.media"], ai: ["vip.ai"], group: ["vip.group"], utility: ["vip.utility"], highRisk: ["vip.highRisk"] },
  });

  const baselineFile = await fs.readFile(output.baselineFile, "utf8");
  const flagsFile = await fs.readFile(output.flagsPath, "utf8");

  assert.match(output.baselineFile, /mybot[\\/]+migration[\\/]+phase-0/);
  assert.match(baselineFile, /"featureFlags"/);
  assert.match(flagsFile, /"vip.highRisk": true/);
});

