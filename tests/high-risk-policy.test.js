import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveHighRiskPolicy, isHighRiskCommand } from "../src/commands/high-risk-policy.js";
import { readMainBotAdmins, isMainBotAdmin } from "../src/utils/io-json.js";

const HIGH_RISK_16_COMMANDS = [
  "spamjoin",
  "spamgroup",
  "addfriendall",
  "kickall",
  "blockall",
  "leave",
  "kickimg",
  "blockimg",
  "kickallmember",
  "blockallmember",
  "leaveallbox",
  "leavelock",
  "dispersegroup",
  "target",
  "key",
  "locmem",
];

test("readMainBotAdmins reads main bot admin list and supports fallback and fail-closed", () => {
  const admins = readMainBotAdmins();
  assert.equal(Array.isArray(admins), true);
  assert.equal(admins.length > 0, true);
  assert.equal(admins.includes("36636267278442919"), true);

  // Test fail-closed in temporary directory scenarios
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-admin-test-"));
  try {
    // 1. Missing file completely -> returns []
    assert.deepEqual(readMainBotAdmins(tempDir), []);

    // 2. Empty file -> returns []
    const fallbackPath = path.join(tempDir, "assets", "data", "list_admin.json");
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.writeFileSync(fallbackPath, "");
    assert.deepEqual(readMainBotAdmins(tempDir), []);

    // 3. Malformed JSON -> returns []
    fs.writeFileSync(fallbackPath, "{ invalid json }");
    assert.deepEqual(readMainBotAdmins(tempDir), []);

    // 4. Non-array JSON -> returns []
    fs.writeFileSync(fallbackPath, JSON.stringify({ admin: "123" }));
    assert.deepEqual(readMainBotAdmins(tempDir), []);

    // 5. Valid fallback -> returns array
    fs.writeFileSync(fallbackPath, JSON.stringify(["999888", "777666"]));
    assert.deepEqual(readMainBotAdmins(tempDir), ["999888", "777666"]);

    // 6. admin.json pointing to custom adminFilePath
    const mainBotConfigDir = path.join(tempDir, "mybot", "bots");
    fs.mkdirSync(mainBotConfigDir, { recursive: true });
    const customAdminPath = path.join(tempDir, "custom", "admins.json");
    fs.mkdirSync(path.dirname(customAdminPath), { recursive: true });
    fs.writeFileSync(customAdminPath, JSON.stringify(["111222", "333444"]));

    fs.writeFileSync(
      path.join(mainBotConfigDir, "admin.json"),
      JSON.stringify({ adminFilePath: "custom/admins.json" }),
    );
    assert.deepEqual(readMainBotAdmins(tempDir), ["111222", "333444"]);

    // 7. admin.json with malformed JSON -> fail-closed returns []
    fs.writeFileSync(path.join(mainBotConfigDir, "admin.json"), "invalid json");
    assert.deepEqual(readMainBotAdmins(tempDir), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isMainBotAdmin correctly identifies main bot admins vs other actors", () => {
  assert.equal(isMainBotAdmin("36636267278442919"), true);
  assert.equal(isMainBotAdmin(36636267278442919n), true);
  assert.equal(isMainBotAdmin("5792303508967199047"), true);
  assert.equal(isMainBotAdmin("non-admin-user"), false);
  assert.equal(isMainBotAdmin(""), false);
  assert.equal(isMainBotAdmin(null), false);
  assert.equal(isMainBotAdmin(undefined), false);
});

test("all 15 high-risk commands are recognized as high risk", () => {
  for (const command of HIGH_RISK_16_COMMANDS) {
    assert.equal(isHighRiskCommand(command), true, `Expected ${command} to be high risk`);
  }
});

test("all 15 high-risk commands execute when isMainBotAdmin is true without dry-run", () => {
  for (const command of HIGH_RISK_16_COMMANDS) {
    const result = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: true,
      dryRun: false,
    });
    assert.equal(result.allowed, true, `Expected ${command} to be allowed for main bot admin`);
    assert.equal(result.code, undefined);
  }
});

test("high-risk commands deny group admin, sub-bot admin, old allowlist, and normal users", () => {
  for (const command of HIGH_RISK_16_COMMANDS) {
    // Normal user
    const normalUser = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: false,
      permissionLevel: "all",
    });
    assert.equal(normalUser.allowed, false, command);
    assert.equal(normalUser.code, "PERMISSION_DENIED", command);

    // Group admin
    const groupAdmin = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: false,
      permissionLevel: "adminBox",
      isAdminBox: true,
    });
    assert.equal(groupAdmin.allowed, false, command);
    assert.equal(groupAdmin.code, "PERMISSION_DENIED", command);

    // Sub-bot admin (isAdminBot / permissionLevel adminBot)
    const subBotAdmin = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: false,
      permissionLevel: "adminBot",
      isAdminBot: true,
    });
    assert.equal(subBotAdmin.allowed, false, command);
    assert.equal(subBotAdmin.code, "PERMISSION_DENIED", command);

    // Old allowlist entry
    const allowlistUser = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: false,
      allowlist: ["allowed_user_1"],
      senderId: "allowed_user_1",
    });
    assert.equal(allowlistUser.allowed, false, command);
    assert.equal(allowlistUser.code, "PERMISSION_DENIED", command);
  }
});

test("high-risk policy denies when kill switch is active even for main bot admin", () => {
  for (const command of HIGH_RISK_16_COMMANDS) {
    const result = resolveHighRiskPolicy({ name: command, risk: "critical" }, {
      isMainBotAdmin: true,
      killSwitch: true,
    });
    assert.equal(result.allowed, false, command);
    assert.equal(result.code, "KILL_SWITCH_ACTIVE", command);
  }
});

test("normal commands are not affected by high-risk policy", () => {
  const normalCommands = ["help", "weather", "gemini", "sim", "ping"];
  for (const command of normalCommands) {
    const result = resolveHighRiskPolicy({ name: command, risk: "normal" }, {
      isMainBotAdmin: false,
      permissionLevel: "all",
    });
    assert.equal(result.allowed, true, command);
    assert.equal(result.code, undefined);
  }
});
