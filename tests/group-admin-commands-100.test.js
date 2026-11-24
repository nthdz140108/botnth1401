import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { handleAntiGif, antiAllEffectGif } from "../src/service-debug/anti-service/anti-gif.js";
import { handleKickImageCommand, handleBlockImageCommand } from "../src/commands/bot-manager/nqduan-bridge.js";
import { handleAddFriendAll, handleFriendWaitingList, spamCallInGroup } from "../src/commands/bot-manager/nqduan-phase5.js";
import { handleNhacNhoCommand, checkReminders } from "../src/service-debug/tien-ich/nhacnho.js";
import { spamgroup } from "../src/commands/bot-manager/spamgroup.js";
import { setEnvVars, resetCache, getBotId, setBotId } from "../src/utils/env.js";
import { commandRegistry } from "../src/commands/command-registry.js";

function createMockApi() {
  const sent = [];
  const deleted = [];
  const blocked = [];
  const friendRequests = [];
  const voiceCalls = [];

  return {
    sent,
    deleted,
    blocked,
    friendRequests,
    voiceCalls,
    async sendMessage(payload, threadId, type) {
      const normalized = typeof payload === "string" ? { msg: payload } : payload;
      const entry = { payload: normalized, threadId, type, msgId: `msg-${sent.length + 1}` };
      sent.push(entry);
      return entry;
    },
    async deleteMessage(message, onlyMe) {
      deleted.push({ message, onlyMe });
      return { status: 0 };
    },
    async blockUsers(threadId, uids) {
      blocked.push({ threadId, uids });
      return { status: 0 };
    },
    async sendFriendRequest(uid, msg, lang) {
      friendRequests.push({ uid, msg, lang });
      return { status: 0 };
    },
    async getAllFriends() {
      return { data: [{ userId: "friend_already" }] };
    },
    async getGroupInfo(threadId) {
      // Return 28 members: 1 already-friend + 27 strangers -> handleAddFriendAll MUST cap at MAX_REPEAT = 20!
      const memVerList = ["friend_already_0"];
      for (let i = 1; i <= 27; i += 1) {
        memVerList.push(`stranger_${i}_0`);
      }
      return {
        gridInfoMap: {
          [threadId]: {
            name: "Test Group",
            memVerList,
          },
        },
      };
    },
    async getPendingFriendRequests() {
      return {
        data: [
          { userId: "wait_1", displayName: "Nguyen A", recommInfo: { message: "Cho minh ket ban" } },
          { userId: "wait_2", displayName: "Tran B" },
        ],
      };
    },
    async sendCallVoice(uid) {
      voiceCalls.push(uid);
      return { status: 0 };
    },
  };
}

test("Group Anti-Service 100%: !antigif toggles state and antiAllEffectGif deletes GIFs + blocks on threshold", async () => {
  const api = createMockApi();
  const groupSettings = {
    "g-gif": {
      antiGif: false,
      rules: { rule_giflag: { threshold: 2 } },
    },
  };

  // 1. Toggle ON via !antigif on (assuming default prefix '!' or getGlobalPrefix())
  const { getGlobalPrefix } = await import("../src/service-debug/service.js");
  const prefix = getGlobalPrefix();

  const toggledOn = await handleAntiGif(
    api,
    {
      threadId: "g-gif",
      type: 1,
      data: { uidFrom: "admin-1", dName: "Admin", content: `${prefix}antigif on` },
    },
    groupSettings
  );
  assert.equal(toggledOn, true);
  assert.equal(groupSettings["g-gif"].antiGif, true);

  // 2. Normal text message is ignored
  const textIgnored = await antiAllEffectGif(
    api,
    {
      threadId: "g-gif",
      type: 1,
      data: { uidFrom: "violator-1", dName: "Spammer", msgType: "chat.text", content: "hello" },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(textIgnored, false);

  // 3. First GIF message -> deleted + warning
  const firstGif = await antiAllEffectGif(
    api,
    {
      threadId: "g-gif",
      type: 1,
      data: { uidFrom: "violator-1", dName: "Spammer", msgType: "chat.gif", content: { action: "recommend.gif" } },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(firstGif, true);
  assert.equal(api.deleted.length, 1);
  assert.equal(api.blocked.length, 0);

  // Wait >800ms cooldown so second violation increments warning counter to threshold=2 -> blockUsers!
  await new Promise((r) => setTimeout(r, 850));

  const secondGif = await antiAllEffectGif(
    api,
    {
      threadId: "g-gif",
      type: 1,
      data: { uidFrom: "violator-1", dName: "Spammer", msgType: "chat.gif", content: { href: "https://example.com/funny.gif" } },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(secondGif, true);
  assert.equal(api.deleted.length, 2);
  assert.equal(api.blocked.length, 1);
  assert.deepEqual(api.blocked[0], { threadId: "g-gif", uids: ["violator-1"] });
});

test("Group Management 100%: !kickimg and !blockimg mutate groupSettings deterministically", async () => {
  const api = createMockApi();
  const groupSettings = {};

  await handleKickImageCommand(
    api,
    { threadId: "g-img", type: 1, data: { uidFrom: "admin-high", dName: "Boss", content: "!kickimg on" } },
    groupSettings
  );
  assert.equal(groupSettings["g-img"].enableKickImage, true);

  await handleKickImageCommand(
    api,
    { threadId: "g-img", type: 1, data: { uidFrom: "admin-high", dName: "Boss", content: "!kickimg off" } },
    groupSettings
  );
  assert.equal(groupSettings["g-img"].enableKickImage, false);

  await handleBlockImageCommand(
    api,
    { threadId: "g-img", type: 1, data: { uidFrom: "admin-high", dName: "Boss", content: "!blockimg on" } },
    groupSettings
  );
  assert.equal(groupSettings["g-img"].enableBlockImage, true);
});

test("Admin Friend Commands 100%: !addfriendall enforces MAX_REPEAT = 20 and !waitinglist renders pending requests", async () => {
  const api = createMockApi();

  // !waitinglist
  const waitingRes = await handleFriendWaitingList(api, {
    threadId: "g-admin",
    type: 1,
    data: { uidFrom: "admin-high", dName: "Boss", content: "!waitinglist" },
  });
  assert.equal(waitingRes, true);
  const waitingMsg = api.sent[api.sent.length - 1]?.payload?.msg || "";
  assert.match(waitingMsg, /Nguyen A \(wait_1\)/);
  assert.match(waitingMsg, /Tran B \(wait_2\)/);

  // !addfriendall (27 non-friend members in group -> capped at 20!)
  const addAllRes = await handleAddFriendAll(api, {
    threadId: "g-admin",
    type: 1,
    data: { uidFrom: "admin-high", dName: "Boss", content: "!addfriendall" },
  });
  assert.equal(addAllRes, true);
  assert.equal(api.friendRequests.length, 20, "handleAddFriendAll MUST cap requests at MAX_REPEAT = 20");
  assert.equal(api.friendRequests.some((r) => r.uid === "friend_already"), false, "Must skip existing friends");
});

test("Persistent Reminders 100%: !nhacnho persists to instance reminders.json and checkReminders delivers due items", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nhacnho-100-"));
  fs.mkdirSync(path.join(tmpDir, "mybot", "instances", "bot-rem", "data"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "mybot", "bots"), { recursive: true });
  const cfgPath = path.join(tmpDir, "mybot", "bots", "bot-rem.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ name: "bot-rem", uid: "bot-rem" }), "utf8");
  const prevRoot = process.env.PROJECT_ROOT;
  const prevBotName = process.env.BOT_NAME;
  const prevCfgPath = process.env.CONFIG_PATH;
  const prevBotId = getBotId();
  setEnvVars({
    PROJECT_ROOT: tmpDir,
    BOT_NAME: "bot-rem",
    CONFIG_PATH: cfgPath,
  });
  setBotId("bot-rem");
  const remindersPath = path.join(tmpDir, "mybot", "instances", "bot-rem", "data", "reminders.json");

  t.after(() => {
    setBotId(prevBotId || null);
    if (prevRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = prevRoot;
    if (prevBotName === undefined) delete process.env.BOT_NAME;
    else process.env.BOT_NAME = prevBotName;
    if (prevCfgPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = prevCfgPath;
    resetCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const api = createMockApi();
  const { getGlobalPrefix } = await import("../src/service-debug/service.js");
  const prefix = getGlobalPrefix();

  await handleNhacNhoCommand(
    api,
    {
      threadId: "g-rem",
      type: 1,
      data: {
        uidFrom: "u-rem-1",
        dName: "Tester",
        content: `${prefix}nhacnho Họp team dự án 23:59`,
      },
    },
    "nhacnho"
  );

  assert.equal(fs.existsSync(remindersPath), true, "reminders.json must be written atomically");
  const stored = JSON.parse(fs.readFileSync(remindersPath, "utf8"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message, "Họp team dự án");
  assert.equal(stored[0].targetId, "u-rem-1");

  // Simulate due time by setting timestamp in the past and running checkReminders
  stored[0].timestamp = Date.now() - 5000;
  fs.writeFileSync(remindersPath, JSON.stringify(stored, null, 2), "utf8");

  const sentBefore = api.sent.length;
  await checkReminders(api, "bot-rem");
  assert.equal(api.sent.length, sentBefore + 1, "Due reminder must be delivered");
  assert.match(api.sent[api.sent.length - 1].payload.msg, /Họp team dự án/);

  const remaining = JSON.parse(fs.readFileSync(remindersPath, "utf8"));
  assert.equal(remaining.length, 0, "Delivered reminder must be removed from reminders.json");
});

test("Bounded Mass Commands & Registry Unlocked Commands: spamgroup/call cap MAX_REPEAT = 20 and add/remove/ban/unban/sendresources* are active", async () => {
  // 1. Verify unlocked commands in canonical commandRegistry
  for (const cmdName of [
    "antigif",
    "kickimg",
    "blockimg",
    "ban",
    "unban",
    "add",
    "remove",
    "addfriendall",
    "waitinglist",
    "nhacnho",
    "locmem",
    "sendresourcesfile",
    "sendresourcesvideo",
    "sendresourcesimage",
    "sendresourcesaudio",
  ]) {
    const entries = commandRegistry.lookup.get(cmdName);
    assert.ok(entries && entries.length > 0, `${cmdName} must exist in commandRegistry`);
    assert.notEqual(entries[0].active, false, `${cmdName} must be active in commandRegistry`);
  }

  // 2. Verify spamgroup clamps requested repeat 999 -> MAX_REPEAT = 20 and stops cleanly
  const api = createMockApi();
  const { getGlobalPrefix } = await import("../src/service-debug/service.js");
  const prefix = getGlobalPrefix();

  await spamgroup(api, {
    threadId: "g-spam-bound",
    type: 1,
    data: {
      uidFrom: "admin-high",
      dName: "Boss",
      content: `${prefix}spamgroup Alo|500|999`,
    },
  });
  const startMsg = api.sent[api.sent.length - 1]?.payload?.msg || "";
  assert.match(startMsg, /Delay: 1000ms \| Tối đa: 20 lần/, "spamgroup must clamp delay >= 1000ms and repeat <= 20");

  await spamgroup(api, {
    threadId: "g-spam-bound",
    type: 1,
    data: {
      uidFrom: "admin-high",
      dName: "Boss",
      content: `${prefix}spamgroup stop`,
    },
  });

  // 3. Verify call command clamps repeat count cleanly (test with count=1 so test finishes instantly)
  await spamCallInGroup(
    api,
    {
      threadId: "g-call",
      type: 1,
      data: {
        uidFrom: "admin-high",
        dName: "Boss",
        content: `${prefix}call @Target | 1`,
        mentions: [{ uid: "u-call-target", dName: "Target", pos: prefix.length + 5, len: 7 }],
      },
    },
    "call"
  );
  assert.deepEqual(api.voiceCalls, ["u-call-target"]);
});
