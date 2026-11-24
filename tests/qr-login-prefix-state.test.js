import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAwaitingPrefix,
  findAwaitingPrefixByMessageId,
  isExpired,
  setAwaitingPrefix,
} from "../src/utils/qr-login-prefix-state.js";
import * as prefixState from "../src/utils/qr-login-prefix-state.js";
import {
  applyPrefixAndRestart,
  restartBotAfterStop,
} from "../src/utils/qr-login-prefix-workflow.js";
import {
  buildPrefixTimeoutMessage,
  buildPrefixCountdownReaction,
  startQrLoginPrefixCountdown,
} from "../src/utils/qr-login-prefix-countdown.js";

test("extracts the prompt message ID from the sendMessage response", () => {
  assert.equal(typeof prefixState.extractQrLoginMessageId, "function");
  assert.equal(
    prefixState.extractQrLoginMessageId({ message: [{ msgId: "prompt-1" }] }),
    "prompt-1",
  );
});

test("extracts the quoted message ID from a reply payload", () => {
  assert.equal(typeof prefixState.extractQrLoginQuotedMessageId, "function");
  assert.equal(
    prefixState.extractQrLoginQuotedMessageId({ msgId: "prompt-1" }),
    "prompt-1",
  );
});

test("allows the QR creator, scanned account, and admin bot to set the prefix", () => {
  const allowedUids = ["creator-1", "scanned-1", "admin-1"];
  const session = setAwaitingPrefix(
    "scanned-1",
    "creator-1",
    "thread-1",
    "prompt-1",
    allowedUids,
  );

  try {
    for (const uid of allowedUids) {
      const matched = prefixState.findAwaitingPrefixByMessageId("prompt-1", uid, "thread-1");
      assert.ok(matched, `prefix reply from ${uid} should be accepted`);
      assert.equal(matched.sessionId, session.sessionId);
      assert.equal(matched.workspaceUid, "scanned-1");
    }
  } finally {
    clearAwaitingPrefix("scanned-1");
  }
});

test("matches a prefix reply by requester and thread when prompt has no message id", () => {
  const botUid = "bot-without-prompt-id";
  setAwaitingPrefix(botUid, "requester-1", "thread-1", "", ["admin-1"]);

  try {
    const matched = findAwaitingPrefixByMessageId("reply-id", "admin-1", "thread-1");
    assert.equal(matched?.workspaceUid, botUid);
  } finally {
    clearAwaitingPrefix(botUid);
  }
});

test("does not use the missing-id fallback for another requester or thread", () => {
  const botUid = "bot-without-prompt-id-auth";
  setAwaitingPrefix(botUid, "requester-1", "thread-1", "", ["admin-1"]);

  try {
    assert.equal(findAwaitingPrefixByMessageId("reply-id", "other-user", "thread-1"), null);
    assert.equal(findAwaitingPrefixByMessageId("reply-id", "admin-1", "thread-2"), null);
  } finally {
    clearAwaitingPrefix(botUid);
  }
});

test("restarts the matched bot after applying its prefix", async () => {
  const calls = [];
  const prefix = await applyPrefixAndRestart({
    botUid: "bot-1",
    newPrefix: "?",
    applyPrefixToBot: async (botUid, newPrefix) => {
      calls.push(["apply", botUid, newPrefix]);
      return newPrefix;
    },
    restartBot: async (botUid) => {
      calls.push(["restart", botUid]);
      return true;
    },
  });

  assert.equal(prefix, "?");
  assert.deepEqual(calls, [["apply", "bot-1", "?"], ["restart", "bot-1"]]);
});

test("starts a bot that is already stopped", async () => {
  const calls = [];
  const result = await restartBotAfterStop({
    botUid: "bot-stopped",
    checkStatus: async () => ({ running: false }),
    killBot: async () => {
      calls.push("kill");
      return false;
    },
    startBot: async (botUid) => {
      calls.push(["start", botUid]);
      return true;
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [["start", "bot-stopped"]]);
});

test("does not start a second bot when kill fails and the process remains alive", async () => {
  const calls = [];
  const result = await restartBotAfterStop({
    botUid: "bot-alive",
    checkStatus: async () => ({ running: true }),
    killBot: async (botUid) => {
      calls.push(["kill", botUid]);
      return false;
    },
    startBot: async () => {
      calls.push("start");
      return true;
    },
  });

  assert.equal(result, false);
  assert.deepEqual(calls, [["kill", "bot-alive"]]);
});

test("expires an unanswered prefix prompt after one minute", () => {
  const now = Date.now();

  assert.equal(isExpired({ updatedAt: now - 59 * 1000 }), false);
  assert.equal(isExpired({ updatedAt: now - 61 * 1000 }), true);
});

test("counts the prefix prompt reaction from 60 down to 0", async () => {
  const scheduled = [];
  const reactions = [];
  let expiredPrefix = null;

  startQrLoginPrefixCountdown({
    seconds: 60,
    onTick: async (remaining) => reactions.push(remaining),
    getCurrentPrefix: async () => "?",
    onExpired: async (prefix) => {
      expiredPrefix = prefix;
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancelSchedule: () => {},
  });

  for (let index = 0; index <= 60; index += 1) {
    const callback = scheduled.shift();
    assert.ok(callback, `countdown callback ${index} should be scheduled`);
    await callback();
  }

  assert.deepEqual(reactions, Array.from({ length: 61 }, (_, index) => 60 - index));
  assert.equal(expiredPrefix, "?");
  assert.equal(scheduled.length, 0);
});

test("reports the prefix that remains active after timeout", () => {
  assert.equal(
    buildPrefixTimeoutMessage("?"),
    "✅ Hết thời gian đặt prefix. Bot sẽ dùng prefix hiện tại là: ?",
  );
});

test("builds clock reactions for the countdown", () => {
  assert.equal(buildPrefixCountdownReaction(60), "CLOCK");
});

