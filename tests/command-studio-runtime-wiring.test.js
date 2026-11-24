import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCommandConfigForContext, resolveStudioBehaviorOverlay, loadRuntimeCommandPolicy } from "../src/commands/command-policy-loader.js";
import { toBehaviorProfile, overlayBehaviorWithStudio, migrateBehaviorProfileToV2, applySecretsToEnv } from "../src/commands/studio/behavior-bridge.js";
import { getCommandStudioContract } from "../src/commands/studio/contracts.js";
import { resolveSendtaskCaption } from "../src/commands/bot-manager/utilities.js";
import { performRuntimeReload } from "../src/commands/mybot/System/runtime-reload.js";
import { buildSendtaskSchedulesFromStudio } from "../src/commands/studio/runtime-apply.js";

function buildRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-runtime-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ prefix: "!", commands: [{ name: "sendtask", permission: "adminBot", active: true }, { name: "help", permission: "all", active: true }] }));
  return root;
}

test("handlers receive merged context.commandConfig via resolveCommandConfigForContext", () => {
  const root = buildRoot();
  const policy = loadRuntimeCommandPolicy({ root, botId: "admin" });
  const resolved = resolveCommandConfigForContext({
    policy,
    root,
    commandName: "sendtask",
    botId: "admin",
    threadId: "55",
  });
  assert.ok(resolved, "expected commandConfig for sendtask");
  assert.equal(resolved.commandName, "sendtask");
  assert.ok("operation.enabled" in resolved.effective);
  assert.ok(resolved.provenance["schedules.timezone"]);
});

test("studio V2 overlay converts effective config into behavior gate profile", async () => {
  const root = buildRoot();
  fs.mkdirSync(path.join(root, "mybot", "instances", "admin", "data", "command-group-overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "mybot", "instances", "admin", "data", "command-group-overrides", "77.json"),
    JSON.stringify({ commands: { help: { values: { "operation.enabled": false } } } }));

  const policy = loadRuntimeCommandPolicy({ root, botId: "admin" });
  const overlay = resolveStudioBehaviorOverlay(policy, "help", { botId: "admin", threadId: "77", root });
  assert.ok(overlay, "overlay expected for help");
  assert.equal(overlay.operation.killSwitch, true);

  const otherThread = resolveStudioBehaviorOverlay(policy, "help", { botId: "admin", threadId: "88", root });
  assert.equal(otherThread?.operation?.killSwitch || false, false);
});

test("toBehaviorProfile maps cooldown and templates without changing defaults", () => {
  const empty = toBehaviorProfile({});
  assert.deepEqual(empty, {});
  const full = toBehaviorProfile({
    "operation.enabled": false,
    "operation.cooldownMode": "perThread",
    "operation.cooldownSeconds": 42,
    "operation.maxUsesPerHour": 10,
    "responses.useCustomTemplates": true,
    "responses.templates.onCooldown": "{user} đợi {remaining}s",
    "restrictions.mode": "whitelist",
    "restrictions.allowedThreads": [{ threadId: "123" }],
  });
  assert.equal(full.operation.killSwitch, true);
  assert.equal(full.operation.cooldownMode, "perThread");
  assert.equal(full.operation.cooldownOverride, 42);
  assert.equal(full.operation.maxUsesPerHour, 10);
  assert.equal(full.responses.templates.onCooldown, "{user} đợi {remaining}s");
  assert.equal(full.restrictions.mode, "whitelist");
  assert.deepEqual(full.restrictions.allowedThreads, [{ threadId: "123" }]);
});

test("overlayBehaviorWithStudio layers studio overrides on top of legacy policy", () => {
  const policy = {
    commands: [
      { name: "help", behavior: { operation: { killSwitch: false } } },
      { name: "sendtask" },
    ],
  };
  const merged = overlayBehaviorWithStudio(policy, {
    studioGlobal: { commands: { help: { values: { "responses.useCustomTemplates": true, "responses.templates.onSuccess": "done" } } } },
    studioBot: null,
    studioGroup: null,
    contractFor: (name) => (name === "help" ? getCommandStudioContract("help") : null),
  });
  const help = merged.commands.find((c) => c.name === "help");
  assert.equal(help.behavior.responses.templates.onSuccess, "done");
  assert.equal(help.behavior.operation.killSwitch, false);
});

test("migrateBehaviorProfileToV1 -> V2 -> behavior equivalence", () => {
  const v1 = {
    operation: { killSwitch: true, cooldownOverride: 30, maxUsesPerHour: 5 },
    responses: { useCustomTemplates: true, templates: { onError: "Lỗi rồi" } },
    restrictions: { mode: "blacklist", blockedThreads: [{ threadId: "9" }] },
  };
  const migrated = migrateBehaviorProfileToV2("help", v1);
  assert.equal(migrated.values["operation.enabled"], false);
  assert.equal(migrated.values["operation.cooldownSeconds"], 30);
  assert.equal(migrated.values["responses.templates.onError"], "Lỗi rồi");
  const back = toBehaviorProfile({ ...migrated.values });
  assert.deepEqual(back, v1);
});

test("resolveSendtaskCaption uses studio templates with fallback to legacy wording", () => {
  const custom = resolveSendtaskCaption(
    { effective: { "responses.messages.toggle": "Auto-send đã {state}!" } },
    { status: "", state: "bật" },
  );
  assert.equal(custom, "Auto-send đã bật!");
  const fallbackOn = resolveSendtaskCaption(null, { status: "on", state: "bật" });
  assert.equal(fallbackOn, "Đã bật chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!");
  const fallbackOff = resolveSendtaskCaption(undefined, { status: "off", state: "tắt" });
  assert.equal(fallbackOff, "Đã tắt chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!");
});

test("applySecretsToEnv only applies non-empty secret values", () => {
  const fakeEnv = {};
  const applied = applySecretsToEnv({
    "secrets.GEMINI_API_KEYS": "abc",
    "secrets.TENOR_API_KEY": "",
    "operation.enabled": true,
  }, { env: fakeEnv });
  assert.deepEqual(applied, ["GEMINI_API_KEYS"]);
  assert.equal(fakeEnv.GEMINI_API_KEYS, "abc");
  assert.equal("TENOR_API_KEY" in fakeEnv, false);
});

test("runtime reload handshake acks command-studio requests after successful apply", async () => {
  let writtenState = null;
  const applied = [];
  const state = await performRuntimeReload(
    { uid: "u1", requestId: "r1", reloadType: "command-studio", commandName: "sendtask", revision: 3, scope: "global" },
    {
      applyStudioCommand: async (request) => {
        applied.push(request.commandName);
        return { ok: true, commandName: request.commandName, scheduleSummary: { scheduled: 0 } };
      },
      writeReloadState: async (uid, nextState) => {
        writtenState = nextState;
        return nextState;
      },
    },
  );
  assert.deepEqual(applied, ["sendtask"]);
  assert.equal(state.status, "ready");
  assert.equal(writtenState.revision, 3);
  assert.equal(writtenState.commandName, "sendtask");

  let failedState = null;
  await performRuntimeReload(
    { uid: "u2", requestId: "r2", reloadType: "command-studio", commandName: "nope" },
    {
      applyStudioCommand: async () => {
        throw new Error("No studio contract for nope");
      },
      writeReloadState: async (uid, nextState) => {
        failedState = nextState;
        return nextState;
      },
    },
  );
  assert.equal(failedState.status, "failed");
  assert.match(failedState.error, /No studio contract/);

  const ignored = await performRuntimeReload({ uid: "u3", reloadType: "unknown-type" }, {});
  assert.equal(ignored.status, "ignored");
});

test("buildSendtaskSchedulesFromStudio reads layer files into scheduler-ready rows", () => {
  const root = buildRoot();
  const studio = buildSendtaskSchedulesFromStudio({ root, botId: "admin" });
  assert.equal(studio.schedules.length, 24);
  assert.equal(studio.schedulerEnabled, true);
  assert.equal(studio.retry.maxRetries, 2);
});
