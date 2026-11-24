import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";
import {
  resolveManagedBotList,
  resolveManagedBotTargetRecord,
  resolveMyBotCallerRole,
} from "../src/commands/mybot/System/mybot-identity.js";
import {
  sendNotifyToOwners,
} from "../src/commands/mybot/System/mybot-lifecycle.js";

async function createFixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-handler-int-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "configs"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });

  const adminConfig = {
    botId: "main-admin-bot",
    displayName: "Main Bot",
    isMain: true,
  };
  await fs.writeFile(path.join(root, "assets", "config.json"), JSON.stringify(adminConfig), "utf8");
  await fs.writeFile(path.join(root, "assets", "data", "list_admin_high.json"), JSON.stringify(["high-admin-user"]), "utf8");

  const registry = {
    "alias-child-1": {
      uid: "child-uid-999",
      name: "alias-child-1",
      displayName: "First Child Bot",
      ownerUid: "owner-user-999",
      webPort: "6001",
      status: "running",
    },
    "legacy-child-2": {
      uid: "child-uid-888",
      name: "legacy-child-2",
      displayName: "Legacy Child Bot",
      ownerUid: null, // missing owner
      webPort: "6002",
      status: "stopped",
    },
  };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify(registry, null, 2), "utf8");

  return {
    root,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("Task 7: parseMyBotCommand parses round bracket syntax cleanly", () => {
  const p1 = parseMyBotCommand("(mybot start alias-child-1)");
  assert.equal(p1.valid, true);
  assert.equal(p1.action, "start");
  assert.equal(p1.selector.value, "alias-child-1");

  const p2 = parseMyBotCommand("(mybot restart all)");
  assert.equal(p2.valid, true);
  assert.equal(p2.action, "restart");
  assert.equal(p2.selector.type, "all");

  const p3 = parseMyBotCommand("(mybot notify Hệ thống bảo trì trong 15 phút)");
  assert.equal(p3.valid, true);
  assert.equal(p3.action, "notify");
  assert.equal(p3.notifyMessage, "Hệ thống bảo trì trong 15 phút");

  const p4 = parseMyBotCommand("(mybot cmd alias-child-1 (!menu))");
  assert.equal(p4.valid, true);
  assert.equal(p4.action, "cmd");
  assert.equal(p4.selector.value, "alias-child-1");
  assert.equal(p4.commandText, "!menu");
});

test("Task 7: Caller role resolution accurately identifies system admin vs bot owner vs normal user", async () => {
  const env = await createFixtureProject();
  try {
    const childBot = {
      key: "alias-child-1",
      uid: "child-uid-999",
      ownerUid: "owner-user-999",
    };

    // System high admin
    const highAdminRole = resolveMyBotCallerRole({
      uidFrom: "high-admin-user",
      adminBotUid: "main-admin-bot",
      projectRoot: env.root,
    });
    assert.equal(highAdminRole.isSystemAdmin, true);
    assert.equal(highAdminRole.canManageBot(childBot), true);

    // Bot owner
    const ownerRole = resolveMyBotCallerRole({
      uidFrom: "owner-user-999",
      adminBotUid: "main-admin-bot",
      projectRoot: env.root,
    });
    assert.equal(ownerRole.isSystemAdmin, false);
    assert.equal(ownerRole.canManageBot(childBot), true);

    // Other user
    const otherUserRole = resolveMyBotCallerRole({
      uidFrom: "random-stranger",
      adminBotUid: "main-admin-bot",
      projectRoot: env.root,
    });
    assert.equal(otherUserRole.isSystemAdmin, false);
    assert.equal(otherUserRole.canManageBot(childBot), false);
  } finally {
    await env.cleanup();
  }
});

test("Task 7: Target resolution resolves bot by key, UID, or normalized name", async () => {
  const env = await createFixtureProject();
  try {
    const list = resolveManagedBotList({ projectRoot: env.root, includeMain: false });
    assert.equal(list.length, 2);

    // By key
    const targetByKey = resolveManagedBotTargetRecord("alias-child-1", { projectRoot: env.root });
    assert.equal(targetByKey.key, "alias-child-1");
    assert.equal(targetByKey.uid, "child-uid-999");

    // By real UID
    const targetByUid = resolveManagedBotTargetRecord("child-uid-999", { projectRoot: env.root });
    assert.equal(targetByUid.key, "alias-child-1");
    assert.equal(targetByUid.uid, "child-uid-999");
  } finally {
    await env.cleanup();
  }
});
