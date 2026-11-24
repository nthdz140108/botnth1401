import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { undoMessageEvents } from "../src/automations/event-undo-msg.js";
import {
  handleAntiUndoCommand,
  antiUndoGroup,
  __test,
} from "../src/service-debug/anti-service/anti-undo.js";
import { findUndoOriginalMessage } from "../src/service-debug/anti-service/anti-undo-utils.js";
import {
  createMessageCacheStore,
  getMessageCacheStore,
  resolveMessageCacheStore,
  resetMessageCacheInstances,
} from "../src/utils/message-cache.js";

const { processUndo, isDuplicateUndo, inFlightUndoKeys, processedUndoKeys } = __test;

function createMockApi(botId, options = {}) {
  const sentMessages = [];
  const sendImages = [];
  let firstNoticeTime = null;

  const mockApi = {
    currentUserId: botId,
    botKey: botId,
    botId,
    sentMessages,
    sendImages,
    groupSettings: options.groupSettings || {},
    getFirstNoticeTime: () => firstNoticeTime,
    resetTimestamps: () => {
      firstNoticeTime = null;
      sentMessages.length = 0;
      sendImages.length = 0;
    },
    sendMessageForward: async (payload, threadId, type, ttl) => {
      if (firstNoticeTime === null) {
        firstNoticeTime = performance.now();
      }
      if (options.onSendMessageForward) {
        await options.onSendMessageForward(payload, threadId);
      }
      sentMessages.push({ payload, threadId, type, ttl });
      return { msgId: `notice-${Date.now()}` };
    },
    sendMessage: async (payload, threadId, type, ttl) => {
      return mockApi.sendMessageForward(payload, threadId, type, ttl);
    },
    sendImage: async (photoUrl, originalMsg, title, ttl) => {
      if (options.sendImageDelay) {
        await new Promise((r) => setTimeout(r, options.sendImageDelay));
      }
      if (options.failImage) {
        throw new Error("403 Forbidden - Upload expired");
      }
      sendImages.push({ photoUrl, originalMsg, title, ttl });
      return { msgId: `img-${Date.now()}` };
    },
    getGroupInfo: async (threadId) => {
      return {
        gridInfoMap: {
          [threadId]: {
            name: `Group ${threadId}`,
            creatorId: "creator-admin-1",
            adminIds: ["creator-admin-1"],
          },
        },
      };
    },
  };

  return mockApi;
}

test("1. Dispatcher -> cache -> undo flow: restores when event ID != original message ID", async () => {
  resetMessageCacheInstances();
  const botId = "bot-flow-1";
  const threadId = "g-flow-1";
  const mockApi = createMockApi(botId, {
    groupSettings: { [threadId]: { antiUndo: true } },
  });
  const store = getMessageCacheStore(botId);

  const senderId = "user-alice-1";
  const origCliMsgId = "orig-cli-msg-101";
  const origSrvMsgId = "orig-srv-msg-101";

  const dispatcher = createFastPathDispatcher({
    api: mockApi,
    botId,
    messageStore: store,
    handlers: {
      undo: undoMessageEvents,
    },
  });

  // 1. Message arrives via dispatcher and is cached in bot's runtime store
  const incomingMsg = {
    threadId,
    data: {
      cliMsgId: origCliMsgId,
      msgId: origSrvMsgId,
      threadId,
      idTo: threadId,
      uidFrom: senderId,
      dName: "Alice",
      msgType: "chat.text",
      content: "Bí mật không được tiết lộ",
    },
  };
  await dispatcher.dispatchMessage(incomingMsg);

  // Verify message is indexed in memory
  const cached = store.getByMsgId(origCliMsgId);
  assert.ok(cached, "Message must be indexed in store");
  assert.equal(cached.content, "Bí mật không được tiết lộ");

  // 2. Undo event arrives with EVENT ID DIFFERENT FROM ORIGINAL MESSAGE ID
  const undoEvent = {
    threadId,
    isGroup: true,
    data: {
      msgId: "undo-packet-event-id-99999", // Different event ID!
      cliMsgId: "undo-packet-cli-99999",
      idTo: threadId,
      uidFrom: senderId,
      content: {
        cliMsgId: origCliMsgId, // Original message ID in content
        msgId: origSrvMsgId,
      },
    },
  };

  await dispatcher.dispatchUndo(undoEvent);

  // Wait for worker queue to process
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(mockApi.sentMessages.length, 1);
  assert.ok(mockApi.sentMessages[0].payload.msg.includes("Bí mật không được tiết lộ"));
  assert.ok(mockApi.sentMessages[0].payload.msg.includes("Alice đã thu hồi tin nhắn"));
});

test("2. !antiundo on/off toggle controls message recovery", async () => {
  const botId = "bot-toggle-1";
  const mockApi = createMockApi(botId);
  const store = getMessageCacheStore(botId);
  const threadId = "g-toggle-1";
  const senderId = "user-bob-1";
  const cliMsgId = "orig-cli-toggle-1";

  store.update({
    cliMsgId,
    msgId: "srv-toggle-1",
    threadId,
    idTo: threadId,
    uidFrom: senderId,
    dName: "Bob",
    msgType: "chat.text",
    content: "Tin nhắn kiểm tra toggle",
  });

  const groupSettings = {
    [threadId]: { antiUndo: true },
  };

  // Turn antiundo OFF
  await handleAntiUndoCommand(
    mockApi,
    { threadId, content: "!antiundo off" },
    groupSettings
  );
  assert.equal(groupSettings[threadId].antiUndo, false);

  const undoEvent = {
    threadId,
    isGroup: true,
    data: {
      idTo: threadId,
      uidFrom: senderId,
      content: { cliMsgId },
    },
  };

  mockApi.resetTimestamps();
  await processUndo(mockApi, undoEvent, false, groupSettings, false, false);
  assert.equal(mockApi.sentMessages.length, 0, "Must not recover when antiUndo is off");

  // Turn antiundo ON
  await handleAntiUndoCommand(
    mockApi,
    { threadId, content: "!antiundo on" },
    groupSettings
  );
  assert.equal(groupSettings[threadId].antiUndo, true);

  mockApi.resetTimestamps();
  await processUndo(mockApi, undoEvent, false, groupSettings, false, false);
  assert.equal(mockApi.sentMessages.length, 1, "Must recover when antiUndo is turned back on");
});

test("3. findUndoOriginalMessage strictly validates matching group and matching sender", () => {
  const store = createMessageCacheStore();
  const threadId = "g-correct-1";
  const senderId = "u-correct-1";
  const cliMsgId = "cli-validation-1";

  store.update({
    cliMsgId,
    msgId: "srv-validation-1",
    threadId,
    idTo: threadId,
    uidFrom: senderId,
    dName: "Charlie",
    content: "Nội dung chuẩn",
  });

  // Correct match
  const valid = findUndoOriginalMessage(store, {
    threadId,
    data: { idTo: threadId, uidFrom: senderId, content: { cliMsgId } },
  });
  assert.equal(valid.reason, null);
  assert.equal(valid.message.cliMsgId, cliMsgId);

  // Group mismatch
  const wrongGroup = findUndoOriginalMessage(store, {
    threadId: "g-other-2",
    data: { idTo: "g-other-2", uidFrom: senderId, content: { cliMsgId } },
  });
  assert.equal(wrongGroup.message, null);
  assert.equal(wrongGroup.reason, "thread-mismatch");

  // Sender mismatch
  const wrongSender = findUndoOriginalMessage(store, {
    threadId,
    data: { idTo: threadId, uidFrom: "u-imposter-2", content: { cliMsgId } },
  });
  assert.equal(wrongSender.message, null);
  assert.equal(wrongSender.reason, "sender-mismatch");
});

test("4. Multi-bot isolation: bots have separate runtime caches", async () => {
  resetMessageCacheInstances();
  const botA = "bot-instance-A";
  const botB = "bot-instance-B";
  const apiA = createMockApi(botA);
  const apiB = createMockApi(botB);

  const storeA = resolveMessageCacheStore(apiA);
  const storeB = resolveMessageCacheStore(apiB);

  const cliMsgId = "cli-isolated-1";
  storeA.update({
    cliMsgId,
    msgId: "srv-iso-1",
    threadId: "g-shared",
    idTo: "g-shared",
    uidFrom: "u-1",
    content: "Chỉ bot A có tin này",
  });

  // Bot A finds it
  const lookupA = findUndoOriginalMessage(storeA, {
    threadId: "g-shared",
    data: { idTo: "g-shared", uidFrom: "u-1", content: { cliMsgId } },
  });
  assert.equal(lookupA.reason, null);
  assert.ok(lookupA.message);

  // Bot B must NOT find it
  const lookupB = findUndoOriginalMessage(storeB, {
    threadId: "g-shared",
    data: { idTo: "g-shared", uidFrom: "u-1", content: { cliMsgId } },
  });
  assert.equal(lookupB.message, null);
  assert.equal(lookupB.reason, "cache-miss");
});

test("5. Recovery from saved data: cache miss falls back to reading message.json and re-indexes", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antiundo-disk-"));
  const logsDir = path.join(tmpDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const messageJsonPath = path.join(logsDir, "message.json");

  const customCtx = {
    uid: "bot-disk-recovery",
    messageJsonPath,
    projectRoot: tmpDir,
    instanceRoot: tmpDir,
    logsDir,
  };

  const store = createMessageCacheStore(customCtx);
  const cliMsgId = "cli-disk-msg-777";
  const threadId = "g-disk-1";
  const senderId = "u-disk-1";

  store.update({
    cliMsgId,
    msgId: "srv-disk-777",
    globalMsgId: "global-disk-777",
    threadId,
    idTo: threadId,
    uidFrom: senderId,
    dName: "DiskUser",
    msgType: "chat.text",
    content: "Tin nhắn lưu trữ trên đĩa",
  });

  // Flush to disk
  store.flush();
  assert.ok(fs.existsSync(messageJsonPath), "message.json must exist after flush");

  // Wipe in-memory LRU and index to simulate process restart / eviction
  store.lru.clear();
  store.idIndex.clear();
  assert.equal(store.lru.has(cliMsgId), false, "LRU must be empty");

  // Lookup triggered by undo event
  const lookup = findUndoOriginalMessage(store, {
    threadId,
    data: {
      idTo: threadId,
      uidFrom: senderId,
      content: { cliMsgId },
    },
  });

  assert.equal(lookup.reason, null);
  assert.ok(lookup.message, "Must find entry via disk fallback on cache miss");
  assert.equal(lookup.message.content, "Tin nhắn lưu trữ trên đĩa");

  // Entry is now re-indexed into memory for future O(1) lookups
  assert.equal(store.lru.has(cliMsgId), true, "Entry must be re-cached in memory");

  // Clean up temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test("6. Concurrent duplicate events: suppressed both in-flight and post-completion", async () => {
  const botId = "bot-dup-concurrency";
  const mockApi = createMockApi(botId);
  const store = getMessageCacheStore(botId);
  const threadId = "g-concurr-dup";
  const senderId = "u-dup-concurr";
  const cliMsgId = "cli-concurrent-dup";

  store.update({
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom: senderId,
    dName: "Dan",
    msgType: "chat.text",
    content: "Trùng lặp đồng thời",
  });

  const undoEvent = {
    threadId,
    isGroup: true,
    data: {
      idTo: threadId,
      uidFrom: senderId,
      content: { cliMsgId },
    },
  };

  const groupSettings = { [threadId]: { antiUndo: true } };

  // Dispatch 5 identical events concurrently
  await Promise.all([
    processUndo(mockApi, undoEvent, false, groupSettings, false, false),
    processUndo(mockApi, undoEvent, false, groupSettings, false, false),
    processUndo(mockApi, undoEvent, false, groupSettings, false, false),
    processUndo(mockApi, undoEvent, false, groupSettings, false, false),
    processUndo(mockApi, undoEvent, false, groupSettings, false, false),
  ]);

  assert.equal(mockApi.sentMessages.length, 1, "Exactly one undo message must be sent");
});

test("7. Per-group independent processing: slow media in Group A does not delay text notice in Group B", async () => {
  const botId = "bot-independent-groups";
  // Group A sends media with 120ms artificial delay
  const mockApi = createMockApi(botId, { sendImageDelay: 120 });
  const store = getMessageCacheStore(botId);

  const groupA = "g-slow-media";
  const groupB = "g-fast-text";

  store.update({
    cliMsgId: "cli-media-A",
    threadId: groupA,
    idTo: groupA,
    uidFrom: "u-media",
    dName: "MediaUser",
    msgType: "chat.photo",
    content: { url: "https://zalo.me/photoA.jpg" },
  });

  store.update({
    cliMsgId: "cli-text-B",
    threadId: groupB,
    idTo: groupB,
    uidFrom: "u-text",
    dName: "TextUser",
    msgType: "chat.text",
    content: "Tin nhắn nhanh nhóm B",
  });

  const groupSettings = {
    [groupA]: { antiUndo: true },
    [groupB]: { antiUndo: true },
  };

  const undoEventA = {
    threadId: groupA,
    data: { idTo: groupA, uidFrom: "u-media", content: { cliMsgId: "cli-media-A" } },
  };

  const undoEventB = {
    threadId: groupB,
    data: { idTo: groupB, uidFrom: "u-text", content: { cliMsgId: "cli-text-B" } },
  };

  const eventOrder = [];

  // Wrap sendMessageForward to record completion order
  const origSend = mockApi.sendMessageForward;
  mockApi.sendMessageForward = async (payload, threadId, type, ttl) => {
    eventOrder.push({ type: "notice", threadId, time: performance.now() });
    return origSend(payload, threadId, type, ttl);
  };
  mockApi.sendImage = async (photoUrl, originalMsg, title, ttl) => {
    await new Promise((r) => setTimeout(r, 120));
    eventOrder.push({ type: "image", threadId: originalMsg.threadId, time: performance.now() });
    return { msgId: "img-done" };
  };

  // Dispatch both events concurrently through antiUndoGroup
  await Promise.all([
    antiUndoGroup(mockApi, undoEventA, false, groupSettings, false, false),
    antiUndoGroup(mockApi, undoEventB, false, groupSettings, false, false),
  ]);

  // Wait for all workers to settle
  await new Promise((r) => setTimeout(r, 200));

  // Assertions:
  // 1. Group B notice was NOT blocked by Group A's 120ms image send
  const groupBNotice = eventOrder.find((e) => e.threadId === groupB);
  const groupAImage = eventOrder.find((e) => e.type === "image" && e.threadId === groupA);

  assert.ok(groupBNotice, "Group B notice must have been sent");
  assert.ok(groupAImage, "Group A image must have been sent");
  assert.ok(
    groupBNotice.time < groupAImage.time,
    "Group B text notice must complete before Group A slow media finishes"
  );
});

test("8. Send failure does NOT mark message as successfully restored", async () => {
  const botId = "bot-fail-restored";
  const mockApi = createMockApi(botId, { failImage: true });
  const store = getMessageCacheStore(botId);
  const threadId = "g-fail-restore";
  const cliMsgId = "cli-photo-must-fail";

  store.update({
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom: "u-fail",
    dName: "FailingUser",
    msgType: "chat.photo",
    content: { url: "https://zalo.me/broken.jpg" },
    isUndo: false,
  });

  const undoEvent = {
    threadId,
    data: { idTo: threadId, uidFrom: "u-fail", content: { cliMsgId } },
  };

  const groupSettings = { [threadId]: { antiUndo: true } };

  await processUndo(mockApi, undoEvent, false, groupSettings, false, false);

  // Group got notice of failure
  assert.ok(mockApi.sentMessages.length >= 2);
  const failNotice = mockApi.sentMessages.find((m) =>
    m.payload.msg.includes("Không thể khôi phục ảnh")
  );
  assert.ok(failNotice, "Must notify group about failure");

  // Cache entry must NOT be marked restored
  const cached = store.getByMsgId(cliMsgId);
  assert.equal(cached.isUndo, false, "Failed send MUST NOT mark isUndo as true");
});

test("9. Latency benchmark: Dispatcher to first send notice is under 100 ms", async () => {
  const botId = "bot-latency-bench";
  const threadId = "g-bench-100ms";
  const mockApi = createMockApi(botId, {
    groupSettings: { [threadId]: { antiUndo: true } },
  });
  const store = getMessageCacheStore(botId);
  const cliMsgId = "cli-latency-msg-1";

  const dispatcher = createFastPathDispatcher({
    api: mockApi,
    botId,
    messageStore: store,
    handlers: {
      undo: undoMessageEvents,
    },
  });

  // Pre-seed message into cache
  store.update({
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom: "user-bench",
    dName: "Speedy",
    msgType: "chat.text",
    content: "Đo thời gian phản hồi",
  });

  // Pre-seed group info cache in getGroupInfoData
  await mockApi.getGroupInfo(threadId);

  const undoEvent = {
    threadId,
    isGroup: true,
    data: {
      msgId: "undo-packet-999",
      idTo: threadId,
      uidFrom: "user-bench",
      content: { cliMsgId },
    },
  };

  mockApi.resetTimestamps();
  const t0 = performance.now();
  await dispatcher.dispatchUndo(undoEvent);

  // Wait a short slice for async handler to invoke first API call
  while (!mockApi.getFirstNoticeTime() && performance.now() - t0 < 150) {
    await new Promise((r) => setTimeout(r, 2));
  }

  const firstNoticeTime = mockApi.getFirstNoticeTime();
  assert.ok(firstNoticeTime !== null, "API sendMessageForward must have been called");
  const elapsedMs = firstNoticeTime - t0;

  console.log(
    `\n  🚀 [LATENCY BENCHMARK] Dispatcher to first send notice: ${elapsedMs.toFixed(2)} ms (TARGET < 100 ms)\n`
  );

  assert.ok(
    elapsedMs < 100,
    `Latency must be under 100 ms (measured: ${elapsedMs.toFixed(2)} ms)`
  );
});
