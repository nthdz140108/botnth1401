import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("legacy moderation handlers do not own permission resolution", () => {
  const scold = fs.readFileSync(path.join(root, "src/service-debug/chat-bot/scold-user/scold-user.js"), "utf8");

  assert.doesNotMatch(scold, /resolveUserRole|readAdmins|readMainBotAdmins|isMainBotAdmin/);
});

test("command dispatch does not gate prefix through a local admin shortcut", () => {
  const command = fs.readFileSync(path.join(root, "src/commands/command.js"), "utf8");
  assert.doesNotMatch(command, /content\.startsWith\(.*prefix.*\)[\s\S]{0,500}isAdminBot/);
});
