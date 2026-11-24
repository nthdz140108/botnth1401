import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addHighAdminViaCommand,
  removeHighAdminViaCommand,
  mutateBotAdmin,
  mutateBoxAdmin,
  resolveCallerRole,
  buildFullRoleContext,
  readHighAdminSources,
  invalidateAdminRoleCache,
} from "../src/utils/admin-role-store.js";
import { resolveUserRole } from "../src/utils/role-policy.js";

async function makeStorage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-hierarchy-"));
  const overrides = {
    highFilePath: path.join(root, "list_admin_high.json"),
    highCommandPath: path.join(root, "list_admin_high_command.json"),
    botAdminsPath: path.join(root, "admin-list.json"),
  };
  await fs.writeFile(overrides.highFilePath, JSON.stringify(["file-high-1"]), "utf8");
  await fs.writeFile(overrides.highCommandPath, JSON.stringify([]), "utf8");
  await fs.writeFile(overrides.botAdminsPath, JSON.stringify(["bot-admin-1"]), "utf8");
  return { root, overrides, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

const baseArgs = (storage) => ({
  botUid: "bot-1",
  projectRoot: storage.root,
  overrides: storage.overrides,
});

test("resolver precedence: bot > FILE high > COMMAND high > adminBot > adminBox > member", async () => {
  const storage = await makeStorage();
  try {
    await fs.writeFile(storage.overrides.highCommandPath, JSON.stringify(["dual-role"]), "utf8");
    await fs.writeFile(storage.overrides.botAdminsPath, JSON.stringify(["dual-role", "box-and-bot"]), "utf8");
    const settings = { "g-a": { adminList: { "box-and-bot": "X", "pure-box": "Y" } } };
    const ctx = { threadId: "g-a", botUid: "bot-1", groupSettings: settings, ...baseArgs(storage) };

    assert.equal(resolveCallerRole({ userId: "bot-1", ...ctx }), "adminLevelHigh");
    assert.equal(resolveCallerRole({ userId: "file-high-1", ...ctx }), "adminLevelHigh");
    assert.equal(resolveCallerRole({ userId: "dual-role", ...ctx }), "adminLevelHigh");
    assert.equal(resolveCallerRole({ userId: "box-and-bot", ...ctx }), "adminBot");
    assert.equal(resolveCallerRole({ userId: "pure-box", ...ctx }), "adminBox");
    assert.equal(resolveCallerRole({ userId: "random-user", ...ctx }), "member");
  } finally {
    await storage.cleanup();
  }
});

test("adminBox is isolated between groups A and B", async () => {
  const storage = await makeStorage();
  try {
    const settings = {
      "group-a": { adminList: { "box-a": "A" } },
      "group-b": { adminList: {} },
    };
    const mk = (threadId) => ({ threadId, botUid: "bot-1", groupSettings: settings, ...baseArgs(storage) });
    assert.equal(resolveCallerRole({ userId: "box-a", ...mk("group-a") }), "adminBox");
    assert.equal(resolveCallerRole({ userId: "box-a", ...mk("group-b") }), "member");
  } finally {
    await storage.cleanup();
  }
});

test("Zalo key holders and Zalo group admins resolve to member", async () => {
  const settings = {
    "g-k": {
      creatorId: "creator-1",
      adminIds: ["zalo-deputy-1"],
      keyGold: ["gold-key-holder"],
      keySilver: ["silver-key-holder"],
      adminList: {},
    },
  };
  for (const uid of ["creator-1", "zalo-deputy-1", "gold-key-holder", "silver-key-holder"]) {
    assert.equal(
      resolveUserRole(uid, { threadId: "g-k", botUid: "bot-1", groupSettings: settings }),
      "member",
      uid,
    );
  }
});

test("COMMAND-source mutation takes effect immediately without restart", async () => {
  const storage = await makeStorage();
  try {
    const ctx = { threadId: "", botUid: "bot-1", groupSettings: {}, ...baseArgs(storage) };
    assert.equal(resolveCallerRole({ userId: "promoted", ...ctx }), "member");

    await addHighAdminViaCommand({ uid: "promoted", actorId: "file-high-1", ...baseArgs(storage) });
    assert.equal(resolveCallerRole({ userId: "promoted", ...ctx }), "adminLevelHigh");

    // both sources co-exist without dedupe
    const sources = await readHighAdminSources({ projectRoot: storage.root, overrides: storage.overrides });
    assert.deepEqual(sources.map((s) => s.source), ["FILE", "COMMAND"]);
    assert.deepEqual(sources[1].uids, ["promoted"]);

    await removeHighAdminViaCommand({ uid: "promoted", actorId: "file-high-1", ...baseArgs(storage) });
    assert.equal(resolveCallerRole({ userId: "promoted", ...ctx }), "member");
  } finally {
    await storage.cleanup();
  }
});

test("FILE source cannot be removed by command; COMMAND source can", async () => {
  const storage = await makeStorage();
  try {
    await removeHighAdminViaCommand({ uid: "nonexistent", actorId: "x", ...baseArgs(storage) }).catch(() => {});
    await assert.rejects(
      () => removeHighAdminViaCommand({ uid: "file-high-1", actorId: "file-high-1", ...baseArgs(storage) }),
      (error) => error.code === "FILE_SOURCE_PROTECTED",
    );
    const sources = await readHighAdminSources({ projectRoot: storage.root, overrides: storage.overrides });
    assert.deepEqual(sources[0].uids, ["file-high-1"], "FILE list untouched");
  } finally {
    await storage.cleanup();
  }
});

test("self-removal of COMMAND source allowed while another high admin remains", async () => {
  const storage = await makeStorage();
  try {
    await addHighAdminViaCommand({ uid: "cmd-self", actorId: "file-high-1", ...baseArgs(storage) });
    const result = await removeHighAdminViaCommand({ uid: "cmd-self", actorId: "cmd-self", ...baseArgs(storage) });
    assert.equal(result.changed, true);
  } finally {
    await storage.cleanup();
  }
});

test("last effective high admin cannot be removed", async () => {
  const storage = await makeStorage();
  try {
    // sole effective high admin lives in COMMAND source
    await fs.writeFile(storage.overrides.highFilePath, JSON.stringify([]), "utf8");
    await fs.writeFile(storage.overrides.highCommandPath, JSON.stringify(["last-cmd-high"]), "utf8");
    invalidateAdminRoleCache();
    await assert.rejects(
      () => removeHighAdminViaCommand({ uid: "last-cmd-high", actorId: "last-cmd-high", ...baseArgs(storage) }),
      (error) => error.code === "LAST_ADMIN_PROTECTED",
    );
  } finally {
    await storage.cleanup();
  }
});

test("rollback restores snapshot when re-read verification fails", async () => {
  const storage = await makeStorage();
  try {
    const { default: fsSync } = await import("node:fs");
    const faultyDeps = {
      readJson: (filePath) => {
        if (filePath === storage.overrides.botAdminsPath) return [];
        return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
      },
      writeJsonAtomic: (filePath, data) => {
        fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
      },
      lockFile: async () => ({ release() {} }),
      unlockFile: async () => {},
    };
    await assert.rejects(
      () => mutateBotAdmin({
        uid: "ghost-admin",
        mode: "add",
        actorId: "file-high-1",
        deps: faultyDeps,
        ...baseArgs(storage),
      }),
      (error) => error.code === "VERIFY_FAILED",
    );
    const saved = JSON.parse(await fs.readFile(storage.overrides.botAdminsPath, "utf8"));
    assert.deepEqual(saved, [], "snapshot must be restored after failed verify");
  } finally {
    await storage.cleanup();
  }
});

test("audit log records actor, target, role tier, source and result", async () => {
  const storage = await makeStorage();
  try {
    const auditPath = path.join(storage.root, "audit.jsonl");
    await addHighAdminViaCommand({ uid: "audited-admin", actorId: "actor-777", auditPath, ...baseArgs(storage) });
    const lines = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const record = lines.at(-1);
    assert.equal(record.actorId, "actor-777");
    assert.equal(record.targetUid, "audited-admin");
    assert.equal(record.tier, "high");
    assert.equal(record.source, "COMMAND");
    assert.equal(record.result, "ok");
    assert.ok(record.ts);
  } finally {
    await storage.cleanup();
  }
});

test("buildFullRoleContext feeds resolver-compatible lists", async () => {
  const storage = await makeStorage();
  try {
    const context = buildFullRoleContext({
      threadId: "g-1",
      botUid: "bot-1",
      groupSettings: { "g-1": { adminList: { boxy: "B" } } },
      projectRoot: storage.root,
      overrides: storage.overrides,
    });
    assert.deepEqual(context.mainAdmins, ["file-high-1"]);
    assert.deepEqual(context.highCommandAdmins, []);
    assert.deepEqual(context.botAdmins, ["bot-admin-1"]);
    assert.equal(resolveUserRole("boxy", context), "adminBox");
    assert.equal(resolveUserRole("bot-admin-1", context), "adminBot");
    assert.equal(resolveUserRole("file-high-1", context), "adminLevelHigh");
  } finally {
    await storage.cleanup();
  }
});
