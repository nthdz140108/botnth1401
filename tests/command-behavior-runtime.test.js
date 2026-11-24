import assert from "node:assert/strict";
import test from "node:test";
import {
  isWithinSchedule,
  evaluateRestrictions,
  resolveCooldownSeconds,
  cooldownBucket,
  checkHourlyLimit,
} from "../src/commands/command-behavior-runtime.js";

test("empty schedule always allows", () => {
  assert.equal(isWithinSchedule(new Date("2026-08-23T03:00:00"), []), true);
});

test("schedule window days range and time bounds", () => {
  const windows = [{ days: "1-5", from: "08:00", to: "22:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-19T10:00:00"), windows), true); // Thứ 4
  assert.equal(isWithinSchedule(new Date("2026-08-23T10:00:00"), windows), false); // Chủ nhật
  assert.equal(isWithinSchedule(new Date("2026-08-19T07:59:00"), windows), false);
  assert.equal(isWithinSchedule(new Date("2026-08-19T22:00:00"), windows), true); // biên inclusive
});

test("overnight windows span midnight", () => {
  const overnight = [{ days: "*", from: "22:00", to: "02:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-23T23:30:00"), overnight), true);
  assert.equal(isWithinSchedule(new Date("2026-08-24T01:00:00"), overnight), true);
  assert.equal(isWithinSchedule(new Date("2026-08-23T12:00:00"), overnight), false);
  const daytime = [{ days: "*", from: "08:00", to: "22:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-23T08:00:00"), daytime), true);
  assert.equal(isWithinSchedule(new Date("2026-08-23T22:00:00"), daytime), true);
});

test("wildcard days and comma list", () => {
  const windows = [{ days: "*", from: "00:00", to: "23:59" }];
  assert.equal(isWithinSchedule(new Date("2026-08-23T12:00:00"), windows), true);
  const weekend = [{ days: "0,6", from: "09:00", to: "11:00" }];
  assert.equal(isWithinSchedule(new Date("2026-08-22T09:30:00"), weekend), true); // Thứ 7
});

test("restriction modes enforce whitelist/blacklist/user allowlist", () => {
  const base = { restrictions: { mode: "all", allowedThreads: [], blockedThreads: [], allowedUsers: [] } };
  assert.deepEqual(evaluateRestrictions(base, { threadId: "t1", senderId: "u1" }), { allowed: true, reason: "" });

  const wl = { restrictions: { mode: "whitelist", allowedThreads: [{ threadId: "ok" }], blockedThreads: [], allowedUsers: [] } };
  assert.equal(evaluateRestrictions(wl, { threadId: "nope", senderId: "u1" }).allowed, false);

  const bl = { restrictions: { mode: "blacklist", allowedThreads: [], blockedThreads: [{ threadId: "bad" }], allowedUsers: [] } };
  assert.equal(evaluateRestrictions(bl, { threadId: "bad", senderId: "u1" }).allowed, false);
  assert.equal(evaluateRestrictions(bl, { threadId: "good", senderId: "u1" }).allowed, true);

  const users = { restrictions: { mode: "all", allowedThreads: [], blockedThreads: [], allowedUsers: [{ userId: "vip" }] } };
  assert.equal(evaluateRestrictions(users, { threadId: "t", senderId: "vip" }).allowed, true);
  assert.equal(evaluateRestrictions(users, { threadId: "t", senderId: "other" }).allowed, false);
});

test("cooldown resolution falls back and buckets by mode", () => {
  assert.equal(resolveCooldownSeconds({}, 15), 15);
  assert.equal(resolveCooldownSeconds({ operation: { cooldownOverride: null } }, 15), 15);
  assert.equal(resolveCooldownSeconds({ operation: { cooldownOverride: 60 } }, 15), 60);
  assert.equal(cooldownBucket("perUser", { userId: "u1", threadId: "t1" }), "u:u1");
  assert.equal(cooldownBucket("perThread", { userId: "u1", threadId: "t1" }), "t:t1");
  assert.equal(cooldownBucket("global", { userId: "u1", threadId: "t1" }), "*");
});

test("hourly limit counts only within window", () => {
  const now = 1_800_000_000_000;
  const history = [now - 10 * 60_000, now - 70 * 60_000]; // 1 hit trong giờ, 1 ngoài
  const ok = checkHourlyLimit(history, 2, now);
  assert.equal(ok.allowed, true);
  const full = checkHourlyLimit([...history, now - 5 * 60_000], 2, now);
  assert.equal(full.allowed, false);
  assert.ok(full.oldestRemainingMs > 0);
  assert.equal(checkHourlyLimit([], 0, now).allowed, true); // 0 = unlimited
});
