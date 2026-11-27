import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry } from "../src/commands/command-registry.js";
import { executeCommand, resolveCommand, createCommandRegistry } from "../src/commands/command-router.js";
import {
  COMMAND_PERMISSION_POLICY,
  resolveRequiredRole,
  hasPermissionPolicyEntry,
} from "../src/commands/command-permission-policy.js";
import { ROLE_LEVELS } from "../src/utils/role-policy.js";
import { roleSatisfies } from "../src/commands/command-permission-policy.js";

const ALL_DEFINITIONS = commandRegistry.definitions;

test("inventory: every canonical command in the registry has a permission policy entry", () => {
  const missing = [];
  for (const definition of ALL_DEFINITIONS) {
    if (!hasPermissionPolicyEntry(definition.name)) missing.push(definition.name);
  }
  assert.deepEqual(missing, [], `commands without policy: ${missing.join(", ")}`);
  assert.equal(ALL_DEFINITIONS.length, 220, `expected 220 canonical commands, got ${ALL_DEFINITIONS.length}`);
});

test("policy entries are well-formed for all canonical commands", () => {
  for (const definition of ALL_DEFINITIONS) {
    const policy = resolveRequiredRole({ canonicalName: definition.name });
    assert.equal(policy.failClosed, false, definition.name);
    assert.ok(["member", "adminBox", "adminBot", "adminLevelHigh"].includes(policy.requiredRole), definition.name);
    assert.ok(["user", "group", "multiGroup", "global"].includes(policy.effectScope), definition.name);
    assert.ok(["normal", "sensitive", "high", "critical"].includes(policy.risk), definition.name);
  }
});

test("every alias resolves to a canonical command covered by policy", () => {
  for (const key of commandRegistry.keys) {
    const resolved = resolveCommand(key.split(" "), commandRegistry);
    assert.equal(resolved.code, "RESOLVED", key);
    assert.ok(hasPermissionPolicyEntry(resolved.definition.name), `${key} -> ${resolved.definition.name}`);
  }
});

test("high-risk and bulk group is adminLevelHigh only", () => {
  const highRiskBulk = [
    "spamjoin", "spamgroup", "addfriendall", "kickall", "blockall", "kickimg",
    "blockimg", "kickallmember", "blockallmember", "leaveallbox", "leavelock",
    "dispersegroup", "target", "key", "locmem",
  ];
  for (const name of highRiskBulk) {
    const policy = resolveRequiredRole({ canonicalName: name });
    assert.equal(policy.requiredRole, "adminLevelHigh", name);
  }
});

test("runtime, resource and account management is adminLevelHigh only", () => {
  const runtimeCommands = [
    "data", "prefix", "setcmd", "restart", "alias", "downloadresource",
    "deleteresource", "sendsrc", "sendresourcesfile", "sendresourcesvideo",
    "sendresourcesimage", "sendresourcesaudio", "datavideo", "scanapi", "cpus",
    "benchmark", "showcode", "poststatus", "senduser", "ketban", "kb",
    "addfriend", "addfriendall", "waitinglist", "undofriend", "rejectfriend", "listfriend", "removefriend",
    "ban", "unban", "buff", "mybank", "acclq", "dinhgiasim", "fakecccd",
    "autojoin", "call", "sendp", "leave",
  ];
  for (const name of runtimeCommands) {
    const policy = resolveRequiredRole({ canonicalName: name });
    assert.equal(policy.requiredRole, "adminLevelHigh", name);
  }
});

test("Zalo key management commands are adminLevelHigh", () => {
  for (const name of ["keygold", "keysilver", "unkey"]) {
    assert.equal(resolveRequiredRole({ canonicalName: name }).requiredRole, "adminLevelHigh", name);
  }
});

test("adminBot exclusive commands stay below adminLevelHigh", () => {
  const botOnly = ["join", "listgroups", "scangroups", "blockbot", "unblockbot", "listblockbot", "todo"];
  for (const name of botOnly) {
    assert.equal(resolveRequiredRole({ canonicalName: name }).requiredRole, "adminBot", name);
  }
});

test("adminBox tier covers group operation, anti-service and moderation commands", () => {
  const boxTier = [
    "bot", "antigif", "autodownload", "manager", "listmute", "settinggroup",
    "changelink", "prservice", "sendtext", "sendstk", "sendtask", "welcome",
    "bye", "updategroup", "approve", "prwelcome", "whitelist", "antispam",
    "antibadword", "antilink", "antijoin", "learn", "learnnow", "unlearn",
    "reply", "autoreply", "mute", "unmute", "kick", "block", "taget",
    "deletemessage", "scold", "undo", "tagall", "replytag", "keylist",
  ];
  for (const name of boxTier) {
    assert.equal(resolveRequiredRole({ canonicalName: name }).requiredRole, "adminBox", name);
  }
});

test("pinterest and googlesearchai became member commands", () => {
  assert.equal(resolveRequiredRole({ canonicalName: "pinterest" }).requiredRole, "member");
  assert.equal(resolveRequiredRole({ canonicalName: "googlesearchai" }).requiredRole, "member");
});

test("action-level policies raise the requirement for sensitive sub-actions", () => {
  // admin plain add/remove requires high caller
  assert.equal(
    resolveRequiredRole({ canonicalName: "admin", alias: "admin", args: ["add", "123"] }).requiredRole,
    "adminLevelHigh",
  );
  // box stays manageable by adminBot
  assert.equal(
    resolveRequiredRole({ canonicalName: "admin", alias: "admin", args: ["add", "box", "123"] }).requiredRole,
    "adminBot",
  );
  // qtv is critical high
  const qtv = resolveRequiredRole({ canonicalName: "admin", alias: "admin", args: ["remove", "qtv", "123"] });
  assert.equal(qtv.requiredRole, "adminLevelHigh");
  assert.equal(qtv.risk, "critical");

  // group creation actions
  assert.equal(
    resolveRequiredRole({ canonicalName: "group", alias: "creategr", args: [] }).requiredRole,
    "adminLevelHigh",
  );
  assert.equal(resolveRequiredRole({ canonicalName: "group", alias: "kiemtra", args: [] }).requiredRole, "member");

  // account rename inside name
  assert.equal(
    resolveRequiredRole({ canonicalName: "name", alias: "name", args: ["rename"] }).requiredRole,
    "adminLevelHigh",
  );

  // mybot admin action
  assert.equal(
    resolveRequiredRole({ canonicalName: "mybot", alias: "mybot", args: ["restart"] }).requiredRole,
    "adminLevelHigh",
  );
});

test("router denies unmapped definitions even when caller claims adminBot (fail-closed)", async () => {
  let called = false;
  const rogue = createCommandRegistry([{
    name: "totally-unmapped-cmd",
    handler: async () => { called = true; return "ok"; },
    aliases: [],
    scope: "both",
  }].map((entry) => entry));

  const result = await executeCommand({
    scope: "group",
    permissionLevel: "adminBot",
    args: [],
  }, rogue.definitions[0]);

  assert.equal(result.code, "PERMISSION_DENIED");
  assert.equal(result.reason, "POLICY_MISSING");
  assert.equal(called, false);
});

test("router enforces the policy floor over registry metadata", async () => {
  // Synthetic definition reusing a canonical name whose policy tier is adminBox
  const { definitions } = createCommandRegistry([{
    name: "tagall",
    aliases: [],
    scope: "group",
    permission: "adminBox",
    handler: async () => "ok",
  }]);
  const tagall = definitions[0];

  const result = await executeCommand({
    scope: "group",
    permissionLevel: "all",
    args: [],
  }, tagall);
  assert.equal(result.code, "PERMISSION_DENIED");

  // an adminBox caller passes the same command
  const allowed = await executeCommand({
    scope: "group",
    permissionLevel: "adminBox",
    args: [],
    dependencies: { zaloSession: true },
  }, tagall);
  assert.equal(allowed.code, "HANDLED");
});

test("role ordering matches the four-tier hierarchy", () => {
  assert.ok(ROLE_LEVELS.member < ROLE_LEVELS.adminBox);
  assert.ok(ROLE_LEVELS.adminBox < ROLE_LEVELS.adminBot);
  assert.ok(ROLE_LEVELS.adminBot < ROLE_LEVELS.adminLevelHigh);
});

test("role inheritance matrix and legacy aliases use one comparator", () => {
  const roles = ["member", "adminBox", "adminBot", "adminLevelHigh"];
  for (const caller of roles) {
    for (const required of roles) {
      assert.equal(roleSatisfies(caller, required), ROLE_LEVELS[caller] >= ROLE_LEVELS[required], `${caller} -> ${required}`);
    }
  }
  assert.equal(roleSatisfies("all", "member"), true);
  assert.equal(roleSatisfies("adminBotOrGroup", "adminBox"), true);
  assert.equal(roleSatisfies("member", "adminBotOrGroup"), false);
  assert.equal(roleSatisfies("unknown", "member"), false);
  assert.equal(roleSatisfies("adminLevelHigh", "unknown"), false);
});
