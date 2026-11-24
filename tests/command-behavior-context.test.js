import assert from "node:assert/strict";
import test from "node:test";
import {
  CooldownLedger,
  buildTemplateVars,
  evaluateBehaviorGate,
  getBehaviorForCommand,
  renderBehaviorMessage,
} from "../src/commands/command-behavior-context.js";

test("getBehaviorForCommand extracts profile or null", () => {
  const behavior = { operation: { cooldownMode: "global" } };
  assert.equal(getBehaviorForCommand({ behavior }), behavior);
  assert.equal(getBehaviorForCommand({ behavior: null }), null);
  assert.equal(getBehaviorForCommand({}), null);
  assert.equal(getBehaviorForCommand(undefined), null);
  assert.equal(getBehaviorForCommand({ behavior: "nope" }), null);
});

test("gate passes through when no behavior profile", () => {
  assert.equal(evaluateBehaviorGate({ behavior: null, threadId: "t", senderId: "u" }).code, "OK");
});

test("gate honours kill switch and schedule", () => {
  assert.equal(
    evaluateBehaviorGate({ behavior: { operation: { killSwitch: true } }, threadId: "t", senderId: "u" }).code,
    "KILL_SWITCH_ACTIVE"
  );
  const nightOwl = { operation: { scheduleWindows: [{ days: "*", from: "08:00", to: "22:00" }] } };
  assert.equal(
    evaluateBehaviorGate({ behavior: nightOwl, threadId: "t", senderId: "u", now: new Date("2026-08-23T23:00:00") }).code,
    "OUT_OF_SCHEDULE"
  );
  assert.equal(
    evaluateBehaviorGate({ behavior: nightOwl, threadId: "t", senderId: "u", now: new Date("2026-08-23T12:00:00") }).code,
    "OK"
  );
});

test("gate surfaces restriction verdict reasons", () => {
  const blacklist = {
    restrictions: { mode: "blacklist", blockedThreads: [{ threadId: "bad-thread" }] },
  };
  assert.equal(evaluateBehaviorGate({ behavior: blacklist, threadId: "bad-thread", senderId: "u" }).code, "THREAD_BLOCKED");
  assert.equal(evaluateBehaviorGate({ behavior: blacklist, threadId: "ok-thread", senderId: "u" }).code, "OK");

  const whitelist = {
    restrictions: { mode: "whitelist", allowedThreads: [{ threadId: "good-thread" }] },
  };
  assert.equal(evaluateBehaviorGate({ behavior: whitelist, threadId: "other", senderId: "u" }).code, "THREAD_NOT_WHITELISTED");

  const userAllowList = {
    restrictions: { allowedUsers: [{ userId: "vip" }] },
  };
  assert.equal(evaluateBehaviorGate({ behavior: userAllowList, threadId: "t", senderId: "random" }).code, "USER_NOT_ALLOWED");
});

test("ledger blocks per-user but isolates users", () => {
  const ledger = new CooldownLedger();
  const first = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u1", threadId: "t1", now: 1_000_000 });
  assert.equal(first.allowed, true);
  const blocked = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u1", threadId: "t1", now: 1_030_000 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.remainingSeconds > 25 && blocked.remainingSeconds <= 31);
  const other = ledger.consume({ behavior: null, fallbackCountdownSeconds: 60, userId: "u2", threadId: "t1", now: 1_030_000 });
  assert.equal(other.allowed, true);
});

test("ledger honours perThread bucketing via behavior override", () => {
  const ledger = new CooldownLedger();
  const behavior = { operation: { cooldownMode: "perThread", cooldownOverride: 30 } };
  assert.equal(ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "a", threadId: "t1", now: 1_000_000 }).allowed, true);
  assert.equal(ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "b", threadId: "t1", now: 1_010_000 }).allowed, false);
  assert.equal(ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "b", threadId: "t2", now: 1_010_000 }).allowed, true);
});

test("ledger enforces maxUsesPerHour with reason code", () => {
  const ledger = new CooldownLedger();
  const behavior = { operation: { maxUsesPerHour: 2 } };
  assert.equal(ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "u", threadId: "t", now: 1_000_000 }).allowed, true);
  assert.equal(ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "u", threadId: "t", now: 1_100_000 }).allowed, true);
  const third = ledger.consume({ behavior, fallbackCountdownSeconds: 0, userId: "u", threadId: "t", now: 1_200_000 });
  assert.equal(third.allowed, false);
  assert.equal(third.reasonCode, "MAX_USES_PER_HOUR");
});

test("renderBehaviourMessage only renders enabled custom templates", () => {
  const disabled = { responses: { useCustomTemplates: false, templates: { onCooldown: "wait {remaining}s" } } };
  assert.equal(renderBehaviorMessage(disabled, "onCooldown", { remaining: 5 }), null);

  const missingTemplate = { responses: { useCustomTemplates: true, templates: {} } };
  assert.equal(renderBehaviorMessage(missingTemplate, "onCooldown", {}), null);

  const enabled = {
    responses: {
      useCustomTemplates: true,
      templates: { onCooldown: "Wait {remaining}s more, {user}!", onKillSwitch: "blocked for {thread}" },
    },
  };
  assert.equal(renderBehaviorMessage(enabled, "onCooldown", { remaining: 30, user: "U1" }), "Wait 30s more, U1!");
  assert.equal(renderBehaviorMessage(enabled, "KILL_SWITCH_ACTIVE", { thread: "t9" }), "blocked for t9");
  assert.equal(renderBehaviorMessage(null, "onCooldown", {}), null);
});

test("buildTemplateVars maps param items into {param:key} lookup", () => {
  const behavior = {
    params: {
      items: [
        { key: "level", value: "3", defaultValue: "1" },
        { key: "mode", value: null, defaultValue: "fast" },
        { key: "empty", value: null, defaultValue: null },
        { key: "", value: "ignored" },
        { key: "   ", value: "ignored" },
      ],
    },
  };
  const vars = buildTemplateVars({ behavior, prefix: "!", command: "check", remaining: 5 });
  assert.deepEqual(vars.params, { level: "3", mode: "fast", empty: "" });
  assert.equal(vars.prefix, "!");
  assert.equal(vars.command, "check");
  assert.equal(vars.remaining, 5);
});

test("buildTemplateVars tolerates missing behavior and items", () => {
  assert.deepEqual(buildTemplateVars({}).params, {});
  assert.deepEqual(
    buildTemplateVars({ behavior: { params: {} } }).params,
    {}
  );
  assert.deepEqual(buildTemplateVars().params, {});
});

test("renderTemplate resolves {param:key} through vars built by buildTemplateVars", () => {
  const behavior = {
    responses: {
      useCustomTemplates: true,
      templates: { onCooldown: "{command}: còn {remaining}s (mức {param:level})" },
    },
    params: { items: [{ key: "level", value: null, defaultValue: "2" }] },
  };
  const vars = buildTemplateVars({ behavior, command: "scan", remaining: 9 });
  assert.equal(renderBehaviorMessage(behavior, "onCooldown", vars), "scan: còn 9s (mức 2)");
});
