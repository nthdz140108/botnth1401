import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveManagedBotList,
  resolveManagedBotTarget,
  resolveManagedBotTargetRecord,
  resolveBotPaths,
  isMainBot,
} from "../src/commands/mybot/System/mybot-identity.js";
import {
  sendNotifyToOwners,
} from "../src/commands/mybot/System/mybot-lifecycle.js";
import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";
import { resolveInstanceKind, printRuntimeFingerprint } from "../src/bootstrap.js";

async function createMockProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-std-test-"));
  await fs.mkdir(path.join(root, "mybot", "profiles"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });

  const mainConfig = {
    botId: "main-admin-uid",
    displayName: "Main Admin Bot",
    isMain: true,
  };
  await fs.writeFile(path.join(root, "assets", "config.json"), JSON.stringify(mainConfig), "utf8");

  const registry = {
    admin: {
      isMain: true,
      name: "admin",
      displayName: "Main Bot",
      uid: "main-admin-uid",
      webPort: "3000",
      status: "running",
      ownerUid: "admin-owner-uid",
    },
    "child-bot-1": {
      uid: "child-1-real-uid",
      name: "child-bot-1",
      displayName: "Child Bot One",
      ownerUid: "100000000000001", // Verified owner UID
      ownerName: "Alice",
      webPort: "4001",
      status: "running",
      createdAt: "2026-08-01T00:00:00.000Z",
    },
    "child-bot-2": {
      uid: "child-2-real-uid",
      name: "child-bot-2",
      displayName: "Child Bot Two",
      ownerUid: "100000000000001", // Same owner as child 1!
      ownerName: "Alice",
      webPort: "4002",
      status: "stopped",
      createdAt: "2026-08-02T00:00:00.000Z",
    },
    "child-bot-3": {
      uid: "child-3-real-uid",
      name: "child-bot-3",
      displayName: "Child Bot Three",
      createdBy: "100000000000002", // Legacy numeric UID
      ownerName: "Bob",
      webPort: "4003",
      status: "running",
      createdAt: "2026-08-03T00:00:00.000Z",
    },
    "child-bot-4": {
      uid: "child-4-real-uid",
      name: "child-bot-4",
      displayName: "Child Bot Four",
      createdBy: "Anonymous Name Only", // Missing owner UID!
      webPort: "4004",
      status: "stopped",
      createdAt: "2026-08-04T00:00:00.000Z",
    },
  };

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(registry), "utf8");

  return {
    root,
    registry,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("resolveBotPaths returns canonical paths and preserves separation from Main Bot", async () => {
  const env = await createMockProject();
  try {
    // 1. Child bot paths
    const childTarget = { key: "my-alias-key", uid: "999888777", isMain: false };
    const childPaths = resolveBotPaths(childTarget, env.root);

    assert.equal(childPaths.canonicalKey, "my-alias-key");
    assert.equal(childPaths.canonicalUid, "999888777");
    assert.equal(childPaths.isMain, false);
    assert.ok(childPaths.credentialPath.endsWith(path.join("mybot", "credentials", "999888777.json")));
    assert.ok(childPaths.configPath.endsWith(path.join("mybot", "bots", "999888777.json")));
    assert.ok(childPaths.logDir.endsWith(path.join("logs", "999888777")));

    // 2. Fallback read paths for legacy alias file
    await fs.writeFile(path.join(env.root, "mybot", "credentials", "my-alias-key.json"), JSON.stringify({ cookie: {} }), "utf8");
    const pathsWithLegacy = resolveBotPaths(childTarget, env.root);
    // Write path is still canonical UID
    assert.ok(pathsWithLegacy.credentialPath.endsWith(path.join("mybot", "credentials", "999888777.json")));
    // Read path falls back to existing legacy key file
    assert.ok(pathsWithLegacy.readCredentialPath.endsWith(path.join("mybot", "credentials", "my-alias-key.json")));

    // 3. Main bot paths
    const mainTarget = { key: "admin", uid: "main-admin-uid", isMain: true };
    const mainPaths = resolveBotPaths(mainTarget, env.root);
    assert.equal(mainPaths.isMain, true);
    assert.ok(mainPaths.credentialPath.endsWith(path.join("assets", "config.json")));
  } finally {
    await env.cleanup();
  }
});

test("resolveManagedBotList classifies ownerResolution as verified, legacy, or missing", async () => {
  const env = await createMockProject();
  try {
    const list = resolveManagedBotList({ projectRoot: env.root, registry: env.registry, includeMain: true });
    assert.equal(list.length, 5);

    const main = list.find((b) => b.isMain);
    assert.equal(main.ownerResolution, "verified");

    const child1 = list.find((b) => b.key === "child-bot-1");
    assert.equal(child1.ownerResolution, "verified");
    assert.equal(child1.ownerUid, "100000000000001");

    const child3 = list.find((b) => b.key === "child-bot-3");
    assert.equal(child3.ownerResolution, "legacy");
    assert.equal(child3.ownerUid, "100000000000002");

    const child4 = list.find((b) => b.key === "child-bot-4");
    assert.equal(child4.ownerResolution, "missing");
    assert.equal(child4.ownerUid, null); // Must NEVER fallback to child UID!
  } finally {
    await env.cleanup();
  }
});

test("resolveManagedBotTarget strictly scopes UID selector to bot UID/key and self to caller", async () => {
  const env = await createMockProject();
  try {
    // 1. Selector type: "uid" matching real bot UID
    const targetRealUid = resolveManagedBotTarget({
      selector: { type: "uid", value: "child-1-real-uid" },
      registry: env.registry,
      projectRoot: env.root,
    });
    assert.equal(targetRealUid.length, 1);
    assert.equal(targetRealUid[0].key, "child-bot-1");

    // 2. Selector type: "uid" with owner UID must NOT match (avoid random bot collision)
    const targetOwnerUid = resolveManagedBotTarget({
      selector: { type: "uid", value: "100000000000001" },
      registry: env.registry,
      projectRoot: env.root,
    });
    assert.equal(targetOwnerUid.length, 0);

    // 3. Selector type: "self" with callerUid matches caller's owned bot
    const targetSelf = resolveManagedBotTarget({
      selector: { type: "self" },
      callerUid: "100000000000001",
      registry: env.registry,
      projectRoot: env.root,
    });
    assert.equal(targetSelf.length, 1);
    assert.equal(targetSelf[0].ownerUid, "100000000000001");

    // 4. Selector type: "all" for action restart excludes Main Bot
    const restartAll = resolveManagedBotTarget({
      selector: { type: "all" },
      action: "restart",
      registry: env.registry,
      projectRoot: env.root,
    });
    assert.equal(restartAll.length, 4);
    assert.ok(restartAll.every((b) => !b.isMain));
  } finally {
    await env.cleanup();
  }
});

test("sendNotifyToOwners deduplicates, skips missing owners, and reports migration list", async () => {
  const env = await createMockProject();
  try {
    const childBots = resolveManagedBotList({ projectRoot: env.root, registry: env.registry, includeMain: false });
    assert.equal(childBots.length, 4); // 2 verified (Alice), 1 legacy (Bob), 1 missing (Anonymous)

    const sentDMs = [];
    const sendFn = async (ownerUid, text) => {
      sentDMs.push({ ownerUid, text });
      return { success: true };
    };

    const report = await sendNotifyToOwners({
      targets: childBots,
      messageText: "Test Notification",
      sendFn,
      concurrency: 2,
    });

    assert.equal(report.totalChildBots, 4);
    assert.equal(report.totalOwners, 2); // Alice & Bob
    assert.equal(report.dedupedCount, 1); // 1 duplicate for Alice merged
    assert.equal(report.missingOwnerCount, 1); // 1 child bot with missing owner
    assert.equal(report.missingOwnerBots.length, 1);
    assert.equal(report.missingOwnerBots[0].key, "child-bot-4");
    assert.equal(report.successCount, 2);
    assert.equal(sentDMs.length, 2);
    assert.deepEqual(sentDMs.map((d) => d.ownerUid).sort(), ["100000000000001", "100000000000002"]);
  } finally {
    await env.cleanup();
  }
});

test("bootstrap resolveInstanceKind determines main vs child correctly", () => {
  // Explicit kind has top priority
  assert.equal(resolveInstanceKind({ explicitKind: "child", botName: "admin" }), "child");
  assert.equal(resolveInstanceKind({ explicitKind: "main", botName: "subbot" }), "main");

  // Fallback by name/uid
  assert.equal(resolveInstanceKind({ botName: "admin" }), "main");
  assert.equal(resolveInstanceKind({ botUid: "admin" }), "main");
  assert.equal(resolveInstanceKind({ botName: "subbot-1", botUid: "123456789" }), "child");
});

test("parseMyBotCommand supports canonical round brackets (cmd) and legacy angular brackets <cmd>", () => {
  // Canonical round brackets
  const p1 = parseMyBotCommand("!mybot cmd 1 (admin add qtv @user)");
  assert.equal(p1.valid, true);
  assert.equal(p1.action, "cmd");
  assert.equal(p1.commandText, "admin add qtv @user");
  assert.equal(p1.selector.type, "index");
  assert.equal(p1.selector.value, 1);

  // Canonical round brackets with UID selector
  const p2 = parseMyBotCommand("!mybot cmd 999888111222 (help)");
  assert.equal(p2.valid, true);
  assert.equal(p2.action, "cmd");
  assert.equal(p2.commandText, "help");
  assert.equal(p2.selector.type, "uid");
  assert.equal(p2.selector.value, "999888111222");

  // Legacy angular brackets
  const p3 = parseMyBotCommand("!mybot cmd 2 <detail>");
  assert.equal(p3.valid, true);
  assert.equal(p3.action, "cmd");
  assert.equal(p3.commandText, "detail");

  // Missing brackets
  const p4 = parseMyBotCommand("!mybot cmd 1 help");
  assert.equal(p4.valid, false);
  assert.equal(p4.errorReason, "missing_or_invalid_brackets");

  // Missing selector
  const p5 = parseMyBotCommand("!mybot cmd (help)");
  assert.equal(p5.valid, false);
  assert.equal(p5.errorReason, "missing_selector");
});
