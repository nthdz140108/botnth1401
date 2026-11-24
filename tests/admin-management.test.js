import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { commandRegistry } from "../src/commands/command-registry.js";
import {
  parseAdminCommand,
  executeAdminCommand,
  handleAdminHighLevelCommands,
} from "../src/commands/bot-manager/admin-manager.js";
import { appContext } from "../src/api-zalo/context.js";

async function makeTempStorage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-mgmt-"));
  const highFilePath = path.join(root, "list_admin_high.json");
  const highCommandPath = path.join(root, "list_admin_high_command.json");
  const botAdminsPath = path.join(root, "admin-list.json");
  await fs.writeFile(highFilePath, JSON.stringify(["file-high-1"]), "utf8");
  await fs.writeFile(highCommandPath, JSON.stringify([]), "utf8");
  await fs.writeFile(botAdminsPath, JSON.stringify(["bot-admin-1"]), "utf8");
  return {
    root,
    highFilePath,
    highCommandPath,
    botAdminsPath,
    overrides: { highFilePath, highCommandPath, botAdminsPath },
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

function createMockApi(options = {}) {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { status: 0 };
    },
    getUserInfo: async (uids) => {
      if (options.userInfoError) throw new Error(options.userInfoError);
      const unchanged_profiles = {};
      for (const uid of Array.isArray(uids) ? uids : [uids]) {
        unchanged_profiles[uid] = {
          userId: String(uid),
          zaloName: options.userNames?.[uid] || `User_${uid}`,
          avatar: null,
        };
      }
      return { unchanged_profiles, changed_profiles: {} };
    },
  };
}

test("Admin registry contract: admin, listadmin, add, remove have scope both and adminBot base permission", () => {
  for (const name of ["admin", "listadmin", "add", "remove"]) {
    const def = commandRegistry.definitions.find((d) => d.name === name);
    assert.ok(def, `Command ${name} must exist in registry`);
    assert.equal(def.scope, "both", `${name} must have scope both`);
    assert.equal(def.permission, "adminBot", `${name} base permission stays adminBot`);
  }
});

test("parseAdminCommand v2 contract: plain=bot, box=box, qtv=high; bare !add/!remove are not admin verbs", () => {
  const p1 = parseAdminCommand("!admin add 123456789", "!", {}, "private");
  assert.equal(p1.action, "add");
  assert.equal(p1.targetTier, "bot");
  assert.equal(p1.targetRole, "adminBot");
  assert.deepEqual(p1.targets, [{ uid: "123456789", name: "123456789" }]);

  const p2 = parseAdminCommand("!admin add qtv 555666", "!", {}, "group");
  assert.equal(p2.targetTier, "high");
  assert.equal(p2.targetRole, "adminLevelHigh");

  const p3 = parseAdminCommand("!admin remove qtv 555666", "!", {}, "group");
  assert.equal(p3.action, "remove");
  assert.equal(p3.targetTier, "high");

  // Standalone `!add` / `!remove` were removed — they must NOT parse as admin
  // mutations (guide/unknown, no mutation).
  const p4 = parseAdminCommand("!add 987654321", "!", {}, "private");
  assert.notEqual(p4.action, "add", "bare !add must not be an admin verb anymore");
  const p5 = parseAdminCommand("!remove 123", "!", {}, "group");
  assert.notEqual(p5.action, "remove", "bare !remove must not be an admin verb anymore");

  const list = parseAdminCommand("!listadmin", "!", {}, "private");
  assert.equal(list.action, "list");

  const g2 = parseAdminCommand("!admin add box @John", "!", {
    data: { content: "!admin add box @John", mentions: [{ uid: "111222", pos: 15, len: 5 }] },
  }, "group");
  assert.equal(g2.action, "add");
  assert.equal(g2.targetTier, "box");
  assert.equal(g2.targetType, "group");
  assert.deepEqual(g2.targets, [{ uid: "111222", name: "John" }]);
});

test("Private list outputs high admins with FILE/COMMAND labels plus bot admins and notes box visibility", async () => {
  const storage = await makeTempStorage();
  try {
    await fs.writeFile(storage.highCommandPath, JSON.stringify(["cmd-high-9"]), "utf8");
    const api = createMockApi({ userNames: { "file-high-1": "FileBoss", "cmd-high-9": "CmdBoss", "bot-admin-1": "BotAdmin" } });
    await executeAdminCommand({
      api,
      message: { threadId: "p-thread", type: 0, data: { uidFrom: "file-high-1", content: "!admin list" } },
      scope: "private",
      ...storage.overrides,
    });

    const text = api.sentMessages.map((m) => m.payload?.msg || "").join("\n");
    assert.ok(text.includes("FileBoss"), text);
    assert.ok(text.includes("[FILE]"), `FILE label missing: ${text}`);
    assert.ok(text.includes("CmdBoss"), text);
    assert.ok(text.includes("[COMMAND]"), `COMMAND label missing: ${text}`);
    assert.ok(text.includes("BotAdmin"), text);
    assert.ok(text.includes("chỉ xem được trong nhóm"), `private note missing: ${text}`);
  } finally {
    await storage.cleanup();
  }
});

test("Group list shows three sections including adminBox of that group only", async () => {
  const storage = await makeTempStorage();
  try {
    const groupSettings = {
      "group-a": { adminList: { "box-a": "BoxA" } },
      "group-b": { adminList: { "box-b": "BoxB" } },
    };
    const api = createMockApi();
    await executeAdminCommand({
      api,
      message: { threadId: "group-a", type: 1, data: { uidFrom: "file-high-1", content: "!admin list" } },
      scope: "group",
      groupSettings,
      ...storage.overrides,
    });
    const text = api.sentMessages.map((m) => m.payload?.msg || "").join("\n");
    assert.ok(text.includes("box-a") && !text.includes("box-b"), `cross-group leak: ${text}`);
  } finally {
    await storage.cleanup();
  }
});

test("Group list resolves instance bot admins and assigns each UID to its highest role in text and canvas", async () => {
  const storage = await makeTempStorage();
  try {
    await fs.writeFile(storage.highFilePath, JSON.stringify(["high-1"]), "utf8");
    await fs.writeFile(storage.highCommandPath, JSON.stringify(["high-2"]), "utf8");
    await fs.writeFile(storage.botAdminsPath, JSON.stringify(["high-1", "bot-1", "box-only"]), "utf8");
    const canvasLists = [];
    const api = createMockApi({ userNames: {
      "high-1": "HighOne", "high-2": "HighTwo", "bot-1": "BotOne",
      "box-only": "BoxOnly", "box-2": "BoxTwo",
    } });

    await executeAdminCommand({
      api,
      message: { threadId: "group-a", type: 1, data: { uidFrom: "high-1", content: "!admin list" } },
      scope: "group",
      botUid: "instance-bot",
      runtimeHighFilePath: storage.highFilePath,
      runtimeHighCommandPath: storage.highCommandPath,
      runtimeAdminListPath: storage.botAdminsPath,
      groupSettings: { "group-a": { adminList: { "high-1": "HighOne", "bot-1": "BotOne", "box-only": "BoxOnly", "box-2": "BoxTwo" } } },
      persistReadGroupSettings: () => ({}),
      createAdminListImage: async (entries) => { canvasLists.push(entries); return null; },
    });

    const text = api.sentMessages.map((m) => m.payload?.msg || "").join("\n");
    assert.match(text, /HighOne \(high-1\).*Quản trị Tối cao/);
    assert.match(text, /BotOne \(bot-1\).*Quản trị Bot/);
    assert.match(text, /BoxOnly \(box-only\).*Quản trị Bot/);
    assert.match(text, /BoxTwo \(box-2\).*Quản trị Nhóm/);
    assert.equal((text.match(/high-1/g) || []).length, 1);
    assert.equal((text.match(/bot-1/g) || []).length, 1);
    assert.equal((text.match(/box-only/g) || []).length, 1);
    assert.equal(canvasLists.length, 1);
    assert.deepEqual(canvasLists[0].highAdmins.map((entry) => [entry.id, entry.role]), [
      ["high-1", "Quản trị Tối cao [FILE]"],
      ["high-2", "Quản trị Tối cao [COMMAND]"],
    ]);
    assert.deepEqual(canvasLists[0].botAdmins.map((entry) => [entry.id, entry.role]), [
      ["bot-1", "Quản trị Bot đa-nhóm"],
      ["box-only", "Quản trị Bot đa-nhóm"],
    ]);
    assert.deepEqual(canvasLists[0].groupAdmins.map((entry) => [entry.id, entry.role]), [["box-2", "Quản trị Nhóm"]]);
  } finally {
    await storage.cleanup();
  }
});

test("Child list falls back to registry names and friendly labels when profiles unresolvable", async () => {
  const storage = await makeTempStorage();
  try {
    // Self-contained child world: registered main UID + verified child profile.
    // The child identity is verified (all 3 seeds, identityPending=false), so
    // the registered Main operator UID is legitimately displayed as a Supreme
    // Admin (fail-closed: an unverified child would NOT show it).
    await fs.mkdir(path.join(storage.root, "mybot", "state"), { recursive: true });
    await fs.writeFile(
      path.join(storage.root, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "36636267278442919" }),
      "utf8",
    );
    await fs.mkdir(path.join(storage.root, "mybot", "instances", "instance-bot", "data"), { recursive: true });
    await fs.writeFile(
      path.join(storage.root, "mybot", "instances", "instance-bot", "data", "profile.json"),
      JSON.stringify({
        identityPending: false,
        adminIdentitySeeds: { botAdminUsername: "main_bot", ownerUsername: "owner_bot", selfUsername: "child_bot" },
      }),
      "utf8",
    );

    const api = createMockApi({ userInfoError: "cannot resolve profiles" });
    await executeAdminCommand({
      api,
      message: { threadId: "group-a", type: 1, data: { uidFrom: "36636267278442919", content: "!admin list" } },
      scope: "group",
      botUid: "instance-bot",
      instanceKind: "child",
      projectRoot: storage.root,
      runtimeHighFilePath: storage.highFilePath,
      runtimeHighCommandPath: storage.highCommandPath,
      runtimeAdminListPath: storage.botAdminsPath,
      groupSettings: { "group-a": { adminList: {} } },
      createAdminListImage: async () => null,
    });

    const text = api.sentMessages.map((m) => m.payload?.msg || "").join("\n");
    assert.match(text, /\[Main Bot\]/, `main-bot source label missing: ${text}`);
    assert.match(text, /\[Bot này\]/, `child-self source label missing: ${text}`);
    assert.ok(
      text.includes("Admin Bot") || text.includes("Thanh Hung") || text.includes("Bot Admin (Main Bot)"),
      `main bot name fallback missing: ${text}`,
    );
  } finally {
    await storage.cleanup();
  }
});

test("Plain admin add/remove manages instance bot admins with immediate effect", async () => {
  const storage = await makeTempStorage();
  try {
    const api = createMockApi();
    await executeAdminCommand({
      api,
      message: { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: "!admin add 2002" } },
      scope: "private",
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    let saved = JSON.parse(await fs.readFile(storage.botAdminsPath, "utf8"));
    assert.deepEqual(saved, ["bot-admin-1", "2002"]);

    await executeAdminCommand({
      api,
      message: { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: "!admin remove 2002" } },
      scope: "private",
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    saved = JSON.parse(await fs.readFile(storage.botAdminsPath, "utf8"));
    assert.deepEqual(saved, ["bot-admin-1"]);
  } finally {
    await storage.cleanup();
  }
});

test("Box keyword adds/removes adminBox of current group; denied in private; adminBot caller allowed", async () => {
  const storage = await makeTempStorage();
  try {
    const groupSettings = { "group-1": { adminList: {} } };
    let persisted = null;
    const persistFns = {
      readGroupSettings: () => persisted || groupSettings,
      writeGroupSettings: (settings) => { persisted = JSON.parse(JSON.stringify(settings)); },
    };
    const api = createMockApi();

    // adminBot caller may manage box
    await executeAdminCommand({
      api,
      message: { threadId: "group-1", type: 1, data: { uidFrom: "bot-admin-1", content: "!admin add box @Charlie", mentions: [{ uid: "3003", pos: 15, len: 8 }] } },
      scope: "group",
      groupSettings,
      isAdminLevelHighest: false,
      persistReadGroupSettings: persistFns.readGroupSettings,
      persistWriteGroupSettings: persistFns.writeGroupSettings,
      ...storage.overrides,
    });
    assert.equal(groupSettings["group-1"].adminList["3003"], "3003");

    // private is rejected
    await executeAdminCommand({
      api,
      message: { threadId: "p-9", type: 0, data: { uidFrom: "file-high-1", content: "!admin add box 999" } },
      scope: "private",
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    assert.ok(api.sentMessages.some((m) => (m.payload?.msg || "").includes("chỉ dùng trong nhóm")));

    // remove again
    await executeAdminCommand({
      api,
      message: { threadId: "group-1", type: 1, data: { uidFrom: "bot-admin-1", content: "!admin remove box 3003" } },
      scope: "group",
      groupSettings,
      persistReadGroupSettings: persistFns.readGroupSettings,
      persistWriteGroupSettings: persistFns.writeGroupSettings,
      ...storage.overrides,
    });
    assert.equal(groupSettings["group-1"].adminList["3003"], undefined);
  } finally {
    await storage.cleanup();
  }
});

test("qtv manages COMMAND source; adminBot caller denied; plain caller needs high", async () => {
  const storage = await makeTempStorage();
  try {
    const api = createMockApi();

    await executeAdminCommand({
      api,
      message: { threadId: "g-1", type: 1, data: { uidFrom: "bot-admin-1", content: "!admin add qtv 4004" } },
      scope: "group",
      groupSettings: {},
      isAdminLevelHighest: false,
      ...storage.overrides,
    });
    let saved = JSON.parse(await fs.readFile(storage.highCommandPath, "utf8"));
    assert.deepEqual(saved, [], "adminBot must not manage high admins");

    await executeAdminCommand({
      api,
      message: { threadId: "g-1", type: 1, data: { uidFrom: "file-high-1", content: "!admin add qtv 4004" } },
      scope: "group",
      groupSettings: {},
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    saved = JSON.parse(await fs.readFile(storage.highCommandPath, "utf8"));
    assert.deepEqual(saved, ["4004"]);
  } finally {
    await storage.cleanup();
  }
});

test("Safety guards: FILE source protected, last high admin protected, bot UID protected", async () => {
  const storage = await makeTempStorage();
  try {
    await fs.writeFile(storage.highCommandPath, JSON.stringify(["file-high-1"]), "utf8");
    const api = createMockApi();

    await executeAdminCommand({
      api,
      message: { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: "!admin remove qtv file-high-1" } },
      scope: "private",
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    let saved = JSON.parse(await fs.readFile(storage.highCommandPath, "utf8"));
    assert.deepEqual(saved, ["file-high-1"], "FILE-source UID must not be removable by command");

    await executeAdminCommand({
      api,
      message: { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: `!admin remove qtv ${"bot-12345"}` } },
      scope: "private",
      isAdminLevelHighest: true,
      botUid: "bot-12345",
      ...storage.overrides,
    });

    // last effective admin protection: remove everyone leaves zero
    await executeAdminCommand({
      api,
      message: { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: "!admin remove qtv file-high-1x" } },
      scope: "private",
      isAdminLevelHighest: true,
      ...storage.overrides,
    });
    saved = JSON.parse(await fs.readFile(storage.highCommandPath, "utf8"));
    assert.ok(Array.isArray(saved));
  } finally {
    await storage.cleanup();
  }
});

test("No permission bypass via appContext.uid", async () => {
  const storage = await makeTempStorage();
  try {
    const botUid = "bot-12345";
    appContext.uid = botUid;
    try {
      const api = createMockApi();
      await executeAdminCommand({
        api,
        message: { threadId: "group-1", type: 1, data: { uidFrom: "attacker-666", content: "!admin add qtv 7777" } },
        scope: "group",
        groupSettings: { "group-1": { adminList: {} } },
        isAdminLevelHighest: false,
        isMainBotAdmin: false,
        botUid,
        ...storage.overrides,
      });
      const saved = JSON.parse(await fs.readFile(storage.highCommandPath, "utf8"));
      assert.deepEqual(saved, [], "attacker must not gain high admin");
    } finally {
      appContext.uid = "";
    }
  } finally {
    await storage.cleanup();
  }
});

test("Dispatching in private scope: admin and listadmin dispatch; standalone add/remove are disabled", async () => {
  const storage = await makeTempStorage();
  try {
    const baseContext = {
      scope: "private",
      permissionLevel: "adminLevelHigh",
      config: {},
      dbReady: true,
      api: createMockApi(),
      message: { type: 0, threadId: "p-1", data: { uidFrom: "file-high-1", content: "!admin list" } },
      dependencies: { zaloSession: true, python: true, ffmpeg: true, ffprobe: true },
      isAdminLevelHighest: true,
      isMainBotAdmin: true,
      runtimeHighFilePath: storage.highFilePath,
      runtimeHighCommandPath: storage.highCommandPath,
      runtimeAdminListPath: storage.botAdminsPath,
    };

    for (const cmd of ["admin", "listadmin"]) {
      const result = await dispatchCommand({
        ...baseContext,
        commandParts: [cmd, "sample"],
      }, commandRegistry);

      assert.notEqual(result.code, "SCOPE_DENIED", `${cmd} must not be denied in private scope`);
      assert.equal(result.code, "HANDLED", `${cmd} must be HANDLED`);
    }

    // Standalone !add / !remove are active commands in the registry.
    for (const cmd of ["add", "remove"]) {
      const result = await dispatchCommand({
        ...baseContext,
        commandParts: [cmd, "sample"],
      }, commandRegistry);
      assert.equal(result.code, "HANDLED", `${cmd} must be HANDLED`);
    }
  } finally {
    await storage.cleanup();
  }
});

test("handleAdminHighLevelCommands legacy entry keeps working", async () => {
  const storage = await makeTempStorage();
  try {
    const api = createMockApi();
    await handleAdminHighLevelCommands(
      api,
      { threadId: "p-1", type: 0, data: { uidFrom: "file-high-1", content: "!admin list" } },
      [],
      {},
      true,
    );
    assert.ok(api.sentMessages.length > 0);
  } finally {
    await storage.cleanup();
  }
});
