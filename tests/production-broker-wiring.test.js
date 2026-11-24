import test from "node:test";
import assert from "node:assert/strict";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { createCommandRegistry, createCommandDefinition, COMMAND_RESULT_CODES } from "../src/commands/command-router.js";
import { commandRegistry } from "../src/commands/command-registry.js";

test("COMMAND_RESULT_CODES includes ACCEPTED", () => {
  assert.ok(COMMAND_RESULT_CODES.includes("ACCEPTED"));
});

test("Fast commands execute immediately via broker and return HANDLED", async () => {
  const broker = createWorkloadBroker();
  let executed = false;

  const registry = createCommandRegistry([
    createCommandDefinition({
      name: "help",
      permission: "all",
      executionLane: "fast",
      handler: async () => {
        executed = true;
        return "fast-done";
      },
    }),
  ]);

  const result = await dispatchCommand({
    commandParts: ["help"],
    aliasCommand: "help",
    scope: "group",
    permissionLevel: "all",
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    dbReady: true,
    workloadBroker: broker,
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "fast-done");
  assert.equal(executed, true);
});

test("Control commands execute via control lane and return HANDLED", async () => {
  const broker = createWorkloadBroker();
  let executed = false;

  const registry = createCommandRegistry([
    createCommandDefinition({
      name: "listadmin",
      permission: "adminBot",
      executionLane: "control",
      handler: async () => {
        executed = true;
        return "ctrl-done";
      },
    }),
  ]);

  const result = await dispatchCommand({
    commandParts: ["listadmin"],
    aliasCommand: "listadmin",
    scope: "group",
    permissionLevel: "adminBot",
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    dbReady: true,
    workloadBroker: broker,
  }, registry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "ctrl-done");
  assert.equal(executed, true);
});

test("Heavy and Broadcast commands return ACCEPTED with jobId and lane", async () => {
  const broker = createWorkloadBroker();
  let heavyCompleted = false;
  let broadcastCompleted = false;

  const registry = createCommandRegistry([
    createCommandDefinition({
      name: "poststatus",
      permission: "adminLevelHigh",
      executionLane: "heavy",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 20));
        heavyCompleted = true;
        return "heavy-done";
      },
    }),
    createCommandDefinition({
      name: "tagall",
      permission: "adminBox",
      executionLane: "broadcast",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 20));
        broadcastCompleted = true;
        return "bcast-done";
      },
    }),
  ]);

  const heavyResult = await dispatchCommand({
    commandParts: ["poststatus"],
    aliasCommand: "poststatus",
    scope: "group",
    permissionLevel: "adminLevelHigh",
    isAdminLevelHighest: true,
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    dbReady: true,
    workloadBroker: broker,
  }, registry);

  assert.equal(heavyResult.code, "ACCEPTED");
  assert.equal(heavyResult.lane, "heavy");
  assert.ok(heavyResult.jobId);

  const bcastResult = await dispatchCommand({
    commandParts: ["tagall"],
    aliasCommand: "tagall",
    scope: "group",
    permissionLevel: "adminBox",
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    dbReady: true,
    workloadBroker: broker,
  }, registry);

  assert.equal(bcastResult.code, "ACCEPTED");
  assert.equal(bcastResult.lane, "broadcast");
  assert.ok(bcastResult.jobId);

  // Wait for background tasks to finish
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(heavyCompleted, true);
  assert.equal(broadcastCompleted, true);
});

test("Background errors in heavy commands are caught and do not cause unhandled rejections", async () => {
  const broker = createWorkloadBroker();

  const registry = createCommandRegistry([
    createCommandDefinition({
      name: "poststatus",
      permission: "adminLevelHigh",
      executionLane: "heavy",
      handler: async () => {
        throw new Error("Background failure in heavy command");
      },
    }),
  ]);

  const result = await dispatchCommand({
    commandParts: ["poststatus"],
    aliasCommand: "poststatus",
    scope: "group",
    permissionLevel: "adminLevelHigh",
    isAdminLevelHighest: true,
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    dbReady: true,
    workloadBroker: broker,
  }, registry);

  assert.equal(result.code, "ACCEPTED");
  assert.equal(result.lane, "heavy");

  // Wait for background execution
  await new Promise((r) => setTimeout(r, 40));
});

test("Command registry commands have explicit executionLane declared", () => {
  const commands = commandRegistry.definitions;
  assert.ok(commands.length > 0);
  for (const cmd of commands) {
    assert.ok(
      ["fast", "control", "heavy", "broadcast"].includes(cmd.executionLane),
      `Command ${cmd.name} should have valid executionLane, got ${cmd.executionLane}`
    );
  }
});
