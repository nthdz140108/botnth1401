import test from "node:test";
import assert from "node:assert/strict";
import {
  scoldUser,
  _resetScoldState,
  scoldUsers,
  hasActiveScold,
  handleScoldFreeChat,
  isAdminBotOrHigher,
} from "../src/service-debug/chat-bot/scold-user/scold-user.js";
import { messagesUser } from "../src/automations/event-send-msg.js";
import { MessageType } from "../src/api-zalo/models/Message.js";
import { updateGroupSettings } from "../src/utils/io-json.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setEnvVars } from "../src/utils/env.js";
import { clearGroupSettingsCache } from "../src/utils/group-settings-store.js";

/**
 * Cô lập group-settings store vào thư mục tạm để test không bao giờ chạm
 * vào group-settings thật của workspace (guard sẽ fail ngay nếu vi phạm).
 */
async function useTempGroupStore(t) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scold-store-test-"));
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  await fs.writeFile(settingsPath, "{}", "utf8");
  const configPath = path.join(runtimeRoot, "bot.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath }),
    "utf8",
  );
  const previousConfigPath = process.env.CONFIG_PATH;
  setEnvVars({ CONFIG_PATH: configPath });
  clearGroupSettingsCache();
  t.after(async () => {
    if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
    clearGroupSettingsCache();
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });
}

function createMockApi(overrides = {}) {
  const sentMessages = [];
  let activeSendCount = 0;
  let maxConcurrentSends = 0;

  const api = {
    sentMessages,
    get maxConcurrentSends() {
      return maxConcurrentSends;
    },
    async sendMessage(payload, threadId, messageType) {
      activeSendCount++;
      if (activeSendCount > maxConcurrentSends) {
        maxConcurrentSends = activeSendCount;
      }

      if (typeof overrides.onSendMessage === "function") {
        await overrides.onSendMessage(payload, threadId, messageType);
      }

      if (overrides.sendMessageDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, overrides.sendMessageDelayMs));
      }

      if (overrides.sendMessageError) {
        activeSendCount--;
        throw overrides.sendMessageError;
      }

      sentMessages.push({ payload, threadId, messageType, timestamp: Date.now() });
      activeSendCount--;
      return { status: 0, message: "OK" };
    },
    async getUserInfo(userId) {
      if (overrides.getUserInfoDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, overrides.getUserInfoDelayMs));
      }

      if (overrides.getUserInfoError) {
        throw overrides.getUserInfoError;
      }

      if (overrides.userInfoMap && overrides.userInfoMap[userId]) {
        return overrides.userInfoMap[userId];
      }

      return {
        unchanged_profiles: {
          [userId]: {
            userId,
            zaloName: `User_${userId}`,
            gender: 0,
          },
        },
      };
    },
    ...overrides.extraApi,
  };

  return api;
}

function createMessage(content, options = {}) {
  let mentions = options.mentions;
  if (mentions === undefined) {
    if (content.includes("@")) {
      const atIndex = content.indexOf("@");
      mentions = [{ uid: options.targetId || "target-456", pos: atIndex, len: 11 }];
    } else {
      mentions = [];
    }
  }

  return {
    threadId: options.threadId || "test-thread-1",
    type: options.type || "group",
    data: {
      uidFrom: options.senderId || "36636267278442919",
      content,
      mentions,
      ...options.extraData,
    },
  };
}

test("Phase 2 & 3: scold delay normalization enforces minimum 1000ms and default 1000ms", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const message = createMessage("/scold @target-456 200ms");

  const promise = scoldUser(api, message);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Initial message should be sent immediately
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Tao chuẩn bị mắng yêu/);

  // At 500ms, second message should NOT have been sent yet (minimum delay is 1000ms, not 200ms)
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(api.sentMessages.length, 1, "Should not send second message at 500ms when min delay is 1000ms");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await promise;
});

test("Phase 2 & 3: slow getUserInfoData does not cause TDZ ReferenceError or crash", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi({ getUserInfoDelayMs: 200 });
  const message = createMessage("/scold @target-slow 1000ms", {
    targetId: "target-slow",
  });

  assert.doesNotThrow(() => {
    const scoldPromise = scoldUser(api, message);
    setTimeout(() => {
      if (typeof _resetScoldState === "function") _resetScoldState();
    }, 300);
    if (typeof _resetScoldState === "function") _resetScoldState();
    return scoldPromise;
  });
});

test("Phase 2 & 3: messages are sent sequentially without overlapping requests", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi({ sendMessageDelayMs: 50 });
  const message = createMessage("/scold @target-seq 1000ms", {
    targetId: "target-seq",
  });

  const scoldPromise = scoldUser(api, message);
  // Let initial message and at least 1 scold message execute
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Verify concurrency never exceeded 1
  assert.equal(api.maxConcurrentSends, 1, "Messages must be sent strictly sequentially");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Phase 2 & 4: api.sendMessage error is safely caught and cleans up state", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  let sendCount = 0;
  const api = createMockApi({
    onSendMessage: async (payload) => {
      sendCount++;
      // Let initial message pass, fail on the first scold message
      if (sendCount > 1) {
        throw new Error("Simulated Zalo Network Failure");
      }
    },
  });
  const message = createMessage("/scold @target-err 1000ms", {
    targetId: "target-err",
  });

  const scoldPromise = scoldUser(api, message);
  // Wait for the scold timer to fire and hit the error
  await new Promise((resolve) => setTimeout(resolve, 1150));

  // Should have sent initial message, failed on scold message, and cleaned up
  assert.equal(scoldUsers.has("target-err"), false, "scoldUsers should be cleared after fatal send error");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Phase 2 & 4: scold tha stops session and sends forgiveness message exactly once (idempotent)", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-tha";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  // Admin sends `scold tha`
  const thaMessage = createMessage("/scold tha", {
    senderId: "36636267278442919", // recognized admin
  });

  await scoldUser(api, thaMessage);

  // Calling `scold tha` a second time should be idempotent and not duplicate messages
  await scoldUser(api, thaMessage);

  const forgiveMsg = api.sentMessages.filter((m) => m.payload.msg && m.payload.msg.includes("nể Đại Ca của tao tha Bạn lần này"));
  assert.equal(forgiveMsg.length, 1, "Forgiveness message should only be sent once even if tha is called multiple times");
  assert.equal(scoldUsers.has(targetId), false, "Target should be removed from scoldUsers");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Phase 2 & 4: scold stop stops session and cleans up state properly", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-stop";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  // Admin sends `scold stop`
  const stopMessage = createMessage("/scold stop", {
    senderId: "36636267278442919", // recognized admin
  });

  await scoldUser(api, stopMessage);

  // Confirm admin message and forgiveness message sent
  const adminReply = api.sentMessages.find((m) => m.payload.msg && m.payload.msg.includes("Dạ Đại Ca em sẽ tha cho nó."));
  const forgiveMsg = api.sentMessages.filter((m) => m.payload.msg && m.payload.msg.includes("nể Đại Ca của tao tha Bạn lần này"));

  assert.ok(adminReply, "Admin confirmation message should be sent for scold stop");
  assert.equal(forgiveMsg.length, 1, "Forgiveness message should be sent exactly once");
  assert.equal(scoldUsers.has(targetId), false, "Target should be removed from scoldUsers");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Phase 2: preserved validations reject missing mention, target equal/higher admin, and duplicate target", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();

  // 1. Missing mention
  const noMentionMsg = createMessage("/scold", { mentions: [], senderId: "36636267278442919" });
  await scoldUser(api, noMentionMsg);
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Đại Ca muốn em chửi ai\?/);

  // 2. Target equal or higher admin
  api.sentMessages.length = 0;
  const targetAdminMsg = createMessage("/scold @admin", {
    senderId: "36636267278442919", // Level 2 adminBot
    mentions: [{ uid: "36636267278442919", pos: 0, len: 6 }], // Level 2 adminBot (equal)
  });
  await scoldUser(api, targetAdminMsg);
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Không thể ra lệnh chửi người có cấp bậc quản trị bằng hoặc cao hơn bạn/);

  // 3. Normal member cannot execute scold
  api.sentMessages.length = 0;
  const memberMsg = createMessage("/scold @target", {
    senderId: "normal-member-999", // Level 0 member
    mentions: [{ uid: "normal-member-888", pos: 0, len: 6 }],
  });
  await scoldUser(api, memberMsg);
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Bạn không có đủ quyền hạn để sử dụng lệnh này/);

  // 4. Duplicate target
  api.sentMessages.length = 0;
  const targetId = "target-dup-1";
  scoldUsers.set(targetId, true);
  const dupMsg = createMessage(`/scold @${targetId}`, {
    senderId: "36636267278442919",
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
  });
  await scoldUser(api, dupMsg);
  assert.equal(api.sentMessages.length, 1);
  assert.match(api.sentMessages[0].payload.msg, /Người này đang bị chửi/);

  if (typeof _resetScoldState === "function") _resetScoldState();
});

test("Free chat 'tha' from adminBot stops scolding and sends forgiveness message", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-freechat-1";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
    threadId: "group-thread-100",
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);
  assert.equal(hasActiveScold("group-thread-100"), true);

  // Adminbot chats "tha" freely without any prefix
  const freeThaMessage = createMessage("tha", {
    senderId: "36636267278442919", // recognized admin
    threadId: "group-thread-100",
  });

  const stopped = await handleScoldFreeChat(api, freeThaMessage);
  assert.equal(stopped, true);

  const adminReply = api.sentMessages.find((m) => m.payload.msg && m.payload.msg.includes("Dạ Đại Ca em sẽ tha cho nó."));
  const forgiveMsg = api.sentMessages.filter((m) => m.payload.msg && m.payload.msg.includes("nể Đại Ca của tao tha Bạn lần này"));

  assert.ok(adminReply, "Admin confirmation message should be sent for free chat tha");
  assert.equal(forgiveMsg.length, 1, "Forgiveness message should be sent exactly once");
  assert.equal(scoldUsers.has(targetId), false, "Target should be removed from scoldUsers");
  assert.equal(hasActiveScold("group-thread-100"), false);

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Free chat variants like 'tha đi', 'tha nó đi' from adminBot also stop scolding", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-freechat-2";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
    threadId: "group-thread-200",
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  // Adminbot chats "tha nó đi" freely
  const freeThaMessage = createMessage("tha nó đi đại ca", {
    senderId: "36636267278442919",
    threadId: "group-thread-200",
  });

  const stopped = await handleScoldFreeChat(api, freeThaMessage);
  assert.equal(stopped, true);
  assert.equal(scoldUsers.has(targetId), false);

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Free chat 'tha' from normal member does NOT stop scolding", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-freechat-3";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
    threadId: "group-thread-300",
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  // Regular user (not admin) chats "tha"
  const nonAdminMessage = createMessage("tha nó đi mà", {
    senderId: "regular-user-999",
    threadId: "group-thread-300",
  });

  const stopped = await handleScoldFreeChat(api, nonAdminMessage);
  assert.equal(stopped, false);
  assert.equal(scoldUsers.has(targetId), true, "Scold session must remain active");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Vietnamese words starting with tha like 'tháng', 'thảo luận', 'thách' do NOT trigger scold stop", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetId = "target-freechat-4";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
    threadId: "group-thread-400",
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  // Admin chats sentences with words containing 'tha' as a prefix
  for (const text of ["tháng này doanh thu tốt", "thảo luận kế hoạch nhé", "thách thức mọi đối thủ", "thanh toán hóa đơn"]) {
    const msg = createMessage(text, {
      senderId: "36636267278442919",
      threadId: "group-thread-400",
    });
    const stopped = await handleScoldFreeChat(api, msg);
    assert.equal(stopped, false, `Should not stop on text: "${text}"`);
    assert.equal(scoldUsers.has(targetId), true);
  }

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Free chat 'tha' when no scold is active is a safe no-op", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const freeThaMessage = createMessage("tha", {
    senderId: "36636267278442919",
    threadId: "group-thread-idle",
  });

  const stopped = await handleScoldFreeChat(api, freeThaMessage);
  assert.equal(stopped, false);
  assert.equal(api.sentMessages.length, 0);
});

test("Stopping scold in Thread A does not stop active scold in Thread B", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();
  const targetA = "target-thread-a";
  const targetB = "target-thread-b";

  const msgA = createMessage(`/scold @${targetA} 1000ms`, {
    mentions: [{ uid: targetA, pos: 0, len: 10 }],
    threadId: "thread-A",
  });
  const msgB = createMessage(`/scold @${targetB} 1000ms`, {
    mentions: [{ uid: targetB, pos: 0, len: 10 }],
    threadId: "thread-B",
  });

  const promiseA = scoldUser(api, msgA);
  const promiseB = scoldUser(api, msgB);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetA), true);
  assert.equal(scoldUsers.has(targetB), true);
  assert.equal(hasActiveScold("thread-A"), true);
  assert.equal(hasActiveScold("thread-B"), true);

  // Stop thread-A only
  const stopA = createMessage("tha", {
    senderId: "36636267278442919",
    threadId: "thread-A",
  });
  const stoppedA = await handleScoldFreeChat(api, stopA);
  assert.equal(stoppedA, true);

  assert.equal(scoldUsers.has(targetA), false, "Thread A target should be forgiven");
  assert.equal(scoldUsers.has(targetB), true, "Thread B target must still be scolded");
  assert.equal(hasActiveScold("thread-A"), false);
  assert.equal(hasActiveScold("thread-B"), true);

  if (typeof _resetScoldState === "function") _resetScoldState();
  await Promise.all([promiseA, promiseB]);
});

test("messagesUser pipeline: free chat 'tha' from adminBot in group stops active scold", async (t) => {
  await useTempGroupStore(t);
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi({
    extraApi: {
      getGroupInfo: async () => ({ gridInfoMap: {} }),
    },
  });
  const targetId = "target-pipeline-1";
  const startMessage = createMessage(`/scold @${targetId} 1000ms`, {
    mentions: [{ uid: targetId, pos: 0, len: 10 }],
    threadId: "pipeline-group-1",
    type: MessageType.GroupMessage,
  });

  const scoldPromise = scoldUser(api, startMessage);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(scoldUsers.has(targetId), true);

  const groupMsg = {
    threadId: "pipeline-group-1",
    type: MessageType.GroupMessage,
    data: {
      uidFrom: "36636267278442919", // recognized admin
      content: "tha nó đi em",
      dName: "Admin User",
    },
  };

  await messagesUser(api, groupMsg);

  assert.equal(scoldUsers.has(targetId), false);
  const forgiveMsg = api.sentMessages.filter((m) => m.payload.msg && m.payload.msg.includes("nể Đại Ca của tao tha Bạn lần này"));
  assert.equal(forgiveMsg.length, 1);

  if (typeof _resetScoldState === "function") _resetScoldState();
  await scoldPromise;
});

test("Role Hierarchy: higher rank can scold lower rank, equal/lower rank is blocked", async (t) => {
  await useTempGroupStore(t);
  if (typeof _resetScoldState === "function") _resetScoldState();

  updateGroupSettings((settings) => ({
    ...settings,
    "g-100": {
      adminList: {
        "adminbot-999": "AdminBot",
      },
    },
  }));

  const api = createMockApi();
  const threadId = "hierarchy-thread-1";

  // 1. Level 2 (adminBot: 36636267278442919) scolding Level 0 (member-1) -> ALLOWED
  api.sentMessages.length = 0;
  const p1 = scoldUser(api, createMessage("/scold @member-1 1000ms", {
    senderId: "36636267278442919", // adminBot (Level 2)
    targetId: "member-1", // Member (Level 0)
    threadId,
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scoldUsers.has("member-1"), true, "adminBot should be allowed to scold member");
  if (typeof _resetScoldState === "function") _resetScoldState();
  await p1;

  // 2. Level 2 (adminBot) scolding Level 2 (adminBot) -> BLOCKED (equal rank)
  api.sentMessages.length = 0;
  await scoldUser(api, createMessage("/scold @bot-admin-equal 1000ms", {
    senderId: "36636267278442919", // adminBot
    targetId: "36636267278442919", // adminBot
    threadId,
  }));
  assert.equal(scoldUsers.has("36636267278442919"), false);
  assert.match(api.sentMessages[0].payload.msg, /Không thể ra lệnh chửi người có cấp bậc quản trị bằng hoặc cao hơn/);

  // 3. Level 1 (adminBox: adminbot-999 in g-100) scolding Level 0 (member-2) -> ALLOWED
  api.sentMessages.length = 0;
  const p3 = scoldUser(api, createMessage("/scold @member-2 1000ms", {
    senderId: "adminbot-999", // in g-100 adminList (adminBox Level 1)
    targetId: "member-2", // Member (Level 0)
    threadId: "g-100",
    mentions: [{ uid: "member-2", pos: 0, len: 9 }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scoldUsers.has("member-2"), true, "adminBox should be allowed to scold member");
  if (typeof _resetScoldState === "function") _resetScoldState();
  await p3;

  // 4. Level 1 (adminBox: adminbot-999 in g-100) scolding Level 2 (adminBot: 36636267278442919) -> BLOCKED
  api.sentMessages.length = 0;
  await scoldUser(api, createMessage("/scold @admin-bot-2 1000ms", {
    senderId: "adminbot-999", // Level 1 adminBox
    targetId: "36636267278442919", // Level 2 adminBot
    threadId: "g-100",
    mentions: [{ uid: "36636267278442919", pos: 0, len: 17 }],
  }));
  assert.equal(scoldUsers.has("36636267278442919"), false);
  assert.match(api.sentMessages[0].payload.msg, /Không thể ra lệnh chửi người có cấp bậc quản trị bằng hoặc cao hơn/);

  // 5. Level 0 (member) scolding anyone -> BLOCKED (insufficient permission)
  api.sentMessages.length = 0;
  await scoldUser(api, createMessage("/scold @any-target 1000ms", {
    senderId: "random-member-777", // Level 0
    targetId: "member-target-888",
    threadId: "g-100",
    mentions: [{ uid: "member-target-888", pos: 0, len: 18 }],
  }));
  assert.equal(scoldUsers.has("member-target-888"), false);
  assert.match(api.sentMessages[0].payload.msg, /Bạn không có đủ quyền hạn để sử dụng lệnh này/);

  updateGroupSettings((settings) => {
    const next = { ...settings };
    delete next["g-100"];
    return next;
  });

  if (typeof _resetScoldState === "function") _resetScoldState();
});

test("Cross-group isolation: admin of Group A is NOT admin in Group B", async () => {
  if (typeof _resetScoldState === "function") _resetScoldState();

  const api = createMockApi();

  // adminbot-999 is only configured in "g-100" adminList
  // In "other-group-999", adminbot-999 is a regular member (Level 0)
  const scoldInOtherGroup = createMessage("/scold @target-member 1000ms", {
    senderId: "adminbot-999", // Admin only of g-100
    targetId: "target-member",
    threadId: "other-group-999", // NOT g-100
    mentions: [{ uid: "target-member", pos: 0, len: 14 }],
  });

  await scoldUser(api, scoldInOtherGroup);
  assert.equal(scoldUsers.has("target-member"), false, "Must not be allowed to scold in a group where they are not admin");
  assert.match(api.sentMessages[0].payload.msg, /Bạn không có đủ quyền hạn để sử dụng lệnh này/);

  // Also test free-chat tha from admin of Group A in Group B
  // First start a legitimate scold in other-group-999 by a global bot admin
  const legitimateScold = scoldUser(api, createMessage("/scold @target-legit 1000ms", {
    senderId: "36636267278442919", // global adminBot
    targetId: "target-legit",
    threadId: "other-group-999",
    mentions: [{ uid: "target-legit", pos: 0, len: 13 }],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scoldUsers.has("target-legit"), true);

  // adminbot-999 (admin of g-100 only) attempts free chat tha in other-group-999
  const foreignTha = createMessage("tha nó đi", {
    senderId: "adminbot-999",
    threadId: "other-group-999",
  });
  const stopped = await handleScoldFreeChat(api, foreignTha);
  assert.equal(stopped, false, "Admin of another group cannot stop scold in this group");
  assert.equal(scoldUsers.has("target-legit"), true, "Scold must remain active");

  if (typeof _resetScoldState === "function") _resetScoldState();
  await legitimateScold;
});
