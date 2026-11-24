const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourcePath = path.join(__dirname, "../src/commands/command.js");

function readCommandSource() {
  return fs.readFileSync(sourcePath, "utf8");
}

function countMatches(haystack, regex) {
  return (haystack.match(regex) || []).length;
}

test("wiring present in command.js (cooldown ledger, gate, templates)", () => {
  const source = readCommandSource();
  assert.match(source, /command-behavior-context/);
  assert.match(source, /getBehaviorForCommand/);
  assert.match(source, /new CooldownLedger\(\)/);
  assert.match(source, /evaluateBehaviorGate/);
  assert.match(source, /renderBehaviorMessage/);
});

test("legacy lastCommandUsage state replaced by cooldown ledger", () => {
  const source = readCommandSource();
  assert.doesNotMatch(source, /lastCommandUsage\s*=\s*\{\}/);
  assert.match(source, /getCooldownLedger\(/);
  assert.match(source, /\.consume\(\{/);
});

test("behavior gate wired into both private and group handlers", () => {
  const source = readCommandSource();
  assert.ok(countMatches(source, /evaluateBehaviorGate\(\{/g) >= 2, "gate must run in handleCommandPrivate and handleCommand");
  assert.ok(countMatches(source, /getBehaviorForCommand\(commandPolicy\)/g) >= 2);
  assert.ok(countMatches(source, /sendPhase1Result\(api, message, \{ code: gateVerdict\.code/g) >= 2);
});

test("sendPhase1Result tries behavior template before default messages map", () => {
  const source = readCommandSource();
  const customIndex = source.indexOf("renderBehaviorMessage(behavior, result.code");
  const defaultIndex = source.indexOf("messages[result.code]");
  assert.notEqual(customIndex, -1, "template lookup missing in sendPhase1Result");
  assert.notEqual(defaultIndex, -1, "default messages map missing");
  assert.ok(customIndex < defaultIndex, "custom template must be attempted before default messages map");
});
