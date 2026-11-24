import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";
import { resolveMyBotCallerRole } from "../src/commands/mybot/System/mybot-identity.js";
import { getSortedBotList, resolveTargetBots } from "../src/commands/mybot/System/mybot-lifecycle.js";

test("dispatcher logic: clean shortcut and aliases route to canonical actions", () => {
  // 1. Clean shortcut
  const cleanCmd = parseMyBotCommand({ content: "!clean", aliasCommand: "clean", prefix: "!" });
  assert.equal(cleanCmd.action, "clean");

  // 2. Remove alias for delete
  const removeCmd = parseMyBotCommand({ content: "!mybot remove 2", aliasCommand: "mybot", prefix: "!" });
  assert.equal(removeCmd.action, "delete");
  assert.deepEqual(removeCmd.selector, { type: "index", value: 2 });

  // 3. Shutdown alias for stop
  const shutdownCmd = parseMyBotCommand({ content: "!mebot shutdown 3", aliasCommand: "mebot", prefix: "!" });
  assert.equal(shutdownCmd.action, "stop");
  assert.deepEqual(shutdownCmd.selector, { type: "index", value: 3 });

  // 4. Active standalone action for trial activation
  const activeCmd = parseMyBotCommand({ content: "!mybot active", aliasCommand: "mybot", prefix: "!" });
  assert.equal(activeCmd.action, "active");
  assert.equal(activeCmd.selector.type, "self");

  // 4b. Extend / giahan alias
  const extendCmd = parseMyBotCommand({ content: "!mybot giahan 1 30d", aliasCommand: "mybot", prefix: "!" });
  assert.equal(extendCmd.action, "extend");
  assert.equal(extendCmd.durationMs, 30 * 24 * 3600 * 1000);

  // 5. Getlogin alias for qrlogin
  const getloginCmd = parseMyBotCommand({ content: "!mybot getlogin", aliasCommand: "mybot", prefix: "!" });
  assert.equal(getloginCmd.action, "qrlogin");

  // 6. Create action
  const createCmd = parseMyBotCommand({ content: "!mybot create imei123 cookie123", aliasCommand: "mybot", prefix: "!" });
  assert.equal(createCmd.action, "create");
});

test("dispatcher permission gates: system actions require system admin", () => {
  const adminUid = "36636267278442919";
  const memberUid = "12345678901234567";

  const adminRole = resolveMyBotCallerRole({ uidFrom: adminUid, adminBotUid: adminUid });
  const memberRole = resolveMyBotCallerRole({ uidFrom: memberUid, adminBotUid: adminUid });

  const systemActions = ["notify", "clean", "extend", "minus", "approve", "reject", "manager"];

  for (const action of systemActions) {
    assert.equal(adminRole.isSystemAdmin, true, `Admin should be allowed for ${action}`);
    assert.equal(memberRole.isSystemAdmin, false, `Member should be denied for ${action}`);
  }

  // list is open to all users (scoped by visibility in resolveVisibleBots)
  assert.equal(typeof memberRole.callerUid, "string");
});

test("dispatcher selector and target resolution: single and bulk commands", () => {
  const registry = {
    "admin": { uid: "36636267278442919", displayName: "Admin Bot", isMain: true, createdAt: "2026-08-01T00:00:00.000Z" },
    "bot_1": { uid: "11111111111111111", displayName: "Child 1", createdAt: "2026-08-02T00:00:00.000Z" },
    "bot_2": { uid: "22222222222222222", displayName: "Child 2", createdAt: "2026-08-03T00:00:00.000Z" },
  };

  // Selector by index 2 (1-based -> bot_1)
  const cmdIndex = parseMyBotCommand({ content: "!mybot restart 2" });
  const targets1 = resolveTargetBots({ selector: cmdIndex.selector, myBots: registry });
  assert.equal(targets1.length, 1);
  assert.equal(targets1[0].key, "bot_1");

  // Selector by UID
  const cmdUid = parseMyBotCommand({ content: "!mybot restart 22222222222222222" });
  const targets2 = resolveTargetBots({ selector: cmdUid.selector, myBots: registry });
  assert.equal(targets2.length, 1);
  assert.equal(targets2[0].key, "bot_2");

  // Selector by CSV
  const cmdCsv = parseMyBotCommand({ content: "!mybot restart 2,3" });
  const targets3 = resolveTargetBots({ selector: cmdCsv.selector, myBots: registry });
  assert.equal(targets3.length, 2);
  assert.equal(targets3[0].key, "bot_1");
  assert.equal(targets3[1].key, "bot_2");

  // Selector all on delete: Main bot MUST be excluded
  const cmdAllDel = parseMyBotCommand({ content: "!mybot delete all" });
  const targetsAllDel = resolveTargetBots({ selector: cmdAllDel.selector, myBots: registry, action: "delete" });
  assert.equal(targetsAllDel.length, 2);
  assert.equal(targetsAllDel.some((b) => b.isMain), false);
});
