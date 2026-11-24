import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_LEVELS,
  resolveUserRole,
  canManageTarget,
  filterManageableTargets,
} from "../src/utils/role-policy.js";

const base = {
  threadId: "group-a",
  mainAdmins: ["high-1", "high-2"],
  highCommandAdmins: ["cmd-high-1"],
  botAdmins: ["bot-admin"],
  groupSettings: { "group-a": { adminList: { "box-admin": "Box" } } },
  groupAdmins: ["zalo-admin"],
  botUid: "the-bot",
};

test("resolves the four roles without leaking group scope", () => {
  assert.equal(ROLE_LEVELS.adminLevelHigh, 3);
  assert.equal(resolveUserRole("high-1", base), "adminLevelHigh");
  assert.equal(resolveUserRole("cmd-high-1", base), "adminLevelHigh");
  assert.equal(resolveUserRole("bot-admin", base), "adminBot");
  assert.equal(resolveUserRole("box-admin", base), "adminBox");
  assert.equal(resolveUserRole("zalo-admin", base), "member");
  assert.equal(resolveUserRole("key-holder", { ...base, groupSettings: { "group-a": { keyGold: ["key-holder"], keySilver: [], adminList: {} } } }), "member");
  assert.equal(resolveUserRole("box-admin", { ...base, threadId: "group-b" }), "member");
  assert.equal(resolveUserRole("the-bot", base), "adminLevelHigh");
});

test("management is strictly caller level greater than target level and protects bot", () => {
  assert.equal(canManageTarget("adminBot", "adminBox"), true);
  assert.equal(canManageTarget("adminBot", "adminBot"), false);
  assert.equal(canManageTarget("adminLevelHigh", "adminBot"), true);
  assert.equal(canManageTarget("adminLevelHigh", "adminLevelHigh"), false);
  assert.equal(canManageTarget("adminLevelHigh", "member", { targetIsBot: true }), false);
});

test("bulk filtering skips bot, peers, and higher roles", () => {
  const targets = ["the-bot", "box-admin", "bot-admin", "high-1", "member-1"];
  assert.deepEqual(filterManageableTargets("adminBot", targets, base), {
    manageable: ["box-admin"],
    skipped: [
      { uid: "the-bot", reason: "bot" },
      { uid: "bot-admin", reason: "same-level" },
      { uid: "high-1", reason: "higher-level" },
      { uid: "member-1", reason: "not-found" },
    ],
  });
});

test("the checked-in migration keeps the two high-level admins separate", () => {
  const root = getProjectRoot();
  const highPath = path.join(root, "assets", "data", "list_admin_high.json");
  const botPath = path.join(root, "assets", "data", "list_admin.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(highPath, "utf8")), ["36636267278442919", "5792303508967199047"]);
  assert.deepEqual(readMainBotAdmins(root), ["36636267278442919", "5792303508967199047"]);
  assert.equal(readAdmins().includes("36636267278442919"), false);
  assert.equal(readAdmins().includes("5792303508967199047"), false);
  assert.ok(fs.existsSync(botPath));
});

test("admin parser maps plain targets to adminBot tier, box to adminBox and qtv to high", () => {
  assert.equal(parseAdminCommand("!admin add 123", "!", { type: 0 }, "private").targetTier, "bot");
  assert.equal(parseAdminCommand("!admin add 123", "!", { type: 0 }, "private").targetRole, "adminBot");
  assert.equal(parseAdminCommand("!admin add qtv 123", "!", { type: 0 }, "private").targetRole, "adminLevelHigh");
  assert.equal(parseAdminCommand("!admin add box @123", "!", { type: 1, data: { content: "!admin add box @123", mentions: [{ uid: "123", pos: 14, len: 4 }] } }, "group").targetRole, "adminBox");
  assert.equal(parseAdminCommand("!admin remove qtv 123", "!", { type: 1 }, "group").targetRole, "adminLevelHigh");
  // Standalone !add / !remove verbs were removed; they must not be admin verbs.
  assert.notEqual(parseAdminCommand("!add @123", "!", { type: 1 }, "group").action, "add");
  assert.notEqual(parseAdminCommand("!remove 123", "!", { type: 1 }, "group").action, "remove");
});
import fs from "node:fs";
import path from "node:path";
import { getProjectRoot } from "../src/utils/env.js";
import { readMainBotAdmins, readAdmins } from "../src/utils/io-json.js";
import { parseAdminCommand } from "../src/utils/admin-command-parser.js";
