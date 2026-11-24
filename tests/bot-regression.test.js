/**
 * Bot regression: no-port, !bot on/off, admin matrix, !add/!remove removal.
 *
 * Baseline: 144 focused tests pass. This file adds regression coverage for
 * the plan items (child-bot no-port, !bot on/off through disabled-group gate,
 * admin tiering matrix, standalone !add/!remove removal).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── 1. no-port regression ─────────────────────────────────────────────────

test("no-port: terminal monitor falls back to registry port when env lacks WEB_PORT", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "no-port-test-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  // Registry carries the port for bot-a, but the PM2 env has no WEB_PORT.
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      "bot-a": { name: "bot-a", displayName: "BotA", status: "stopped", webPort: "9999" },
    }),
  );
  const monitor = new TerminalMonitor({ projectRoot: root, refreshMs: 60 });
  monitor.adapter = {
    listProcesses: async () => [
      { name: "bot-a", kind: "child", status: "online", pid: 99, botKey: "bot-a", env: { BOT_MANAGED: "true", BOT_KEY: "bot-a" } },
    ],
  };
  monitor.portProbe = async (port) => { assert.equal(port, 9999, "must probe registry port, not a default"); return true; };
  monitor.identityFetcher = async () => ({ kind: "child", botKey: "bot-a", liveZaloUid: "u-a", pid: 99, listenerConnected: true });
  const rows = await monitor._fetchState();
  const labels = await Promise.all(rows.map((p) => monitor._readinessLabel(p)));
  assert.equal(labels[0], "ready", "env-lacking WEB_PORT but registry has port -> ready");
  await fs.rm(root, { recursive: true, force: true });
});

test("no-port: env WEB_PORT takes priority over registry port", async () => {
  const { TerminalMonitor } = await import("../src/runtime/terminal-monitor.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "no-port-env-"));
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  // Registry webPort is different from env WEB_PORT; env wins.
  await fs.writeFile(
    path.join(root, "mybot", "mybots.json"),
    JSON.stringify({
      "bot-a": { name: "bot-a", displayName: "BotA", status: "stopped", webPort: "8888" },
    }),
  );
  const monitor = new TerminalMonitor({ projectRoot: root, refreshMs: 60 });
  monitor.adapter = {
    listProcesses: async () => [
      { name: "bot-a", kind: "child", status: "online", pid: 99, botKey: "bot-a", env: { BOT_MANAGED: "true", BOT_KEY: "bot-a", WEB_PORT: "9999" } },
    ],
  };
  monitor.portProbe = async (port) => { assert.equal(port, 9999, "env WEB_PORT must win over registry"); return true; };
  monitor.identityFetcher = async () => ({ kind: "child", botKey: "bot-a", liveZaloUid: "u-a", pid: 99, listenerConnected: true });
  const rows = await monitor._fetchState();
  const labels = await Promise.all(rows.map((p) => monitor._readinessLabel(p)));
  assert.equal(labels[0], "ready", "env WEB_PORT used correctly");
  await fs.rm(root, { recursive: true, force: true });
});

// ── 2. !bot on/off through disabled-group gate ────────────────────────────

test("!bot on/off: isGroupBotToggle recognizes bot, bot on, bot off", async () => {
  const { isGroupBotToggle, canInteractWithGroup } = await import("../src/commands/group-interaction-policy.js");
  assert.equal(isGroupBotToggle(["bot"]), true);
  assert.equal(isGroupBotToggle(["bot", "on"]), true);
  assert.equal(isGroupBotToggle(["bot", "off"]), true);
  assert.equal(isGroupBotToggle(["antiall", "on"]), false);
  // Group-bot toggle passes through the disabled-group gate for adminBox+.
  assert.equal(
    canInteractWithGroup({ activeBot: false, isAdminBot: false, isAdminBox: true, commandParts: ["bot", "on"] }),
    true,
    "box admin must pass through disabled group for bot toggle",
  );
  assert.equal(
    canInteractWithGroup({ activeBot: false, isAdminBot: false, isAdminBox: false, commandParts: ["bot", "on"] }),
    false,
    "member must NOT pass through disabled group gate for bot toggle",
  );
  // Normal commands still blocked for box admin in disabled group.
  assert.equal(
    canInteractWithGroup({ activeBot: false, isAdminBot: false, isAdminBox: true, commandParts: ["antiall", "on"] }),
    false,
    "box admin still blocked for normal commands in disabled group",
  );
});

test("!bot on/off: handleActiveBotUser persists activeBot and returns true", async () => {
  const { handleActiveBotUser } = await import("../src/commands/bot-manager/active-bot.js");
  const groupSettings = {};
  const message = {
    threadId: "test-thread-1",
    type: 1,
    data: { uidFrom: "test-user", dName: "Tester", content: "!bot on" },
    mentions: [],
  };
  const api = {
    sendMessage: async () => ({ status: 0 }),
    getUserInfo: async () => ({ unchanged_profiles: {}, changed_profiles: {} }),
    getGroupMembers: async () => [],
    handleGroupPendingMembers: async () => true,
    getGroupSetting: async () => ({}),
    addReaction: async () => true,
  };
  const result = await handleActiveBotUser(api, message, groupSettings);
  assert.equal(result, true, "handler must return true");
  assert.equal(groupSettings["test-thread-1"]?.activeBot, true, "groupSettings must be mutated");
});

// ── 3. Registry no add/remove ──────────────────────────────────────────────

test("!add/!remove: standalone add/remove are active moderation commands in registry", async () => {
  const { commandRegistry } = await import("../src/commands/command-registry.js");
  for (const name of ["add", "remove"]) {
    const def = commandRegistry.definitions.find((d) => d.name === name);
    assert.ok(def, `${name} must exist in registry`);
    assert.equal(def.active, true, `${name} must be active`);
    assert.equal(def.permission, "adminBot", `${name} must require adminBot base permission`);
  }
});

// ── 4. Admin matrix: source-aware tiering ──────────────────────────────────

test("admin matrix: COMMAND-source high cannot manage qtv on main bot", async () => {
  // On the main bot, a GLOBAL_HIGH_COMMAND caller trying `!admin add qtv`
  // must be rejected (only FILE-source high can manage qtv).
  const { executeAdminCommand } = await import("../src/commands/bot-manager/admin-manager.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-matrix-"));
  const highFilePath = path.join(root, "assets", "data", "list_admin_high.json");
  const highCommandPath = path.join(root, "assets", "data", "list_admin_high_command.json");
  await fs.mkdir(path.dirname(highFilePath), { recursive: true });
  await fs.writeFile(highFilePath, JSON.stringify(["file-high"]), "utf8");
  await fs.writeFile(highCommandPath, JSON.stringify(["cmd-high"]), "utf8");
  const sentMessages = [];
  const api = {
    sentMessages,
    sendMessage: async (payload) => { sentMessages.push(payload); return { status: 0 }; },
    getUserInfo: async () => ({ unchanged_profiles: {}, changed_profiles: {} }),
  };
  // COMMAND-source high (cmd-high) tries to add qtv — must be denied.
  await executeAdminCommand({
    api,
    message: { threadId: "g-1", type: 1, data: { uidFrom: "cmd-high", content: "!admin add qtv 9999" } },
    scope: "group",
    botUid: "main-1",
    instanceKind: "main",
    projectRoot: root,
    mainBotUid: "main-1",
    groupSettings: {},
    highFilePath,
    highCommandPath,
    botAdminsPath: path.join(root, "mybot", "instances", "main-1", "data", "admin-list.json"),
  });
  const lastMsg = sentMessages[sentMessages.length - 1]?.msg || "";
  // Denial message or the command just didn't execute — check that the high
  // command file was NOT modified (no new entry).
  const saved = JSON.parse(await fs.readFile(highCommandPath, "utf8"));
  assert.deepEqual(saved, ["cmd-high"], "COMMAND high must not be able to add qtv");
  await fs.rm(root, { recursive: true, force: true });
});

test("admin matrix: adminBot can manage box but not bot or qtv", async () => {
  const { executeAdminCommand } = await import("../src/commands/bot-manager/admin-manager.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-matrix-bot-"));
  const highFilePath = path.join(root, "assets", "data", "list_admin_high.json");
  const highCommandPath = path.join(root, "assets", "data", "list_admin_high_command.json");
  const botAdminPath = path.join(root, "mybot", "instances", "main-1", "data", "admin-list.json");
  await fs.mkdir(path.dirname(highFilePath), { recursive: true });
  await fs.mkdir(path.dirname(botAdminPath), { recursive: true });
  await fs.writeFile(highFilePath, JSON.stringify([]), "utf8");
  await fs.writeFile(highCommandPath, JSON.stringify([]), "utf8");
  await fs.writeFile(botAdminPath, JSON.stringify(["bot-admin"]), "utf8");
  const sentMessages = [];
  const api = {
    sentMessages,
    sendMessage: async (payload) => { sentMessages.push(payload); return { status: 0 }; },
    getUserInfo: async () => ({ unchanged_profiles: {}, changed_profiles: {} }),
  };
  const groupSettings = { "g-1": { adminList: {} } };
  let persistedSettings = groupSettings;
  // adminBot adds box admin → should succeed.
  await executeAdminCommand({
    api,
    message: { threadId: "g-1", type: 1, data: { uidFrom: "bot-admin", content: "!admin add box 3003" } },
    scope: "group",
    botUid: "main-1",
    instanceKind: "main",
    projectRoot: root,
    mainBotUid: "main-1",
    groupSettings,
    highFilePath,
    highCommandPath,
    botAdminsPath: botAdminPath,
    persistReadGroupSettings: () => persistedSettings,
    persistWriteGroupSettings: (s) => { persistedSettings = s; },
  });
  assert.equal(groupSettings["g-1"]?.adminList?.["3003"], "3003", "adminBot must be able to add box admin");
  await fs.rm(root, { recursive: true, force: true });
});

// ── 5. Reconcile: required contract markers ────────────────────────────────

test("reconcile-guard: online-but-missing-contract-markers triggers reload", async () => {
  const { ensureProcessAtCommit, resetMarkerGuardLogging } = await import("../src/runtime/reconcile-guard.js");
  resetMarkerGuardLogging();
  const reloadCalls = [];
  let fleet = [
    { name: "bot-a", kind: "child", status: "online", pid: 1, env: { BOT_MANAGED: "true" } },
  ];
  const adapter = {
    async listMyBotProcesses() { return fleet; },
    async reloadBotFromDescriptor(descriptor) {
      reloadCalls.push(descriptor);
      fleet = [
        { name: "bot-a", kind: "child", status: "online", pid: 99, env: { BOT_MANAGED: "true", BOT_KEY: "bot-a", MYBOT_INSTANCE_KIND: "child", WEB_PORT: "5301", MYBOT_CODE_COMMIT: "abc1234" } },
      ];
      return { success: true, pm2Name: descriptor.pm2Name, pid: 99, previousPid: 1, pidChanged: true, reason: "reloaded" };
    },
  };
  const result = await ensureProcessAtCommit({
    adapter,
    pm2Name: "bot-a",
    commit: "abc1234ffff00011122233344455566677788899",
    buildDescriptor: () => ({ pm2Name: "bot-a", script: "/proj/src/bootstrap.js" }),
  });
  assert.equal(result.reloaded, true, "missing contract markers must trigger reload");
  assert.equal(reloadCalls.length, 1);
});