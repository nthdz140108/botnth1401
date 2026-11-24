import test from "node:test";
import assert from "node:assert/strict";
import { findUndoOriginalMessage, extractPhotoUrl } from "../src/service-debug/anti-service/anti-undo-utils.js";
import { __test } from "../src/service-debug/anti-service/anti-undo.js";
import { updateMessageCache, getMessageCache, getMessageCacheStore } from "../src/utils/message-cache.js";

const { processUndo, isDuplicateUndo, markUndoProcessed, getUndoEventKey } = __test;

function cacheMessageForTest(api, message) {
  const botUid = api?.currentUserId;
  if (botUid) {
    const store = getMessageCacheStore({ uid: botUid });
    store.update(message);
  } else {
    updateMessageCache(message);
  }
}

test("extractPhotoUrl extracts URLs from all known Zalo media fields and JSON strings", () => {
  assert.equal(extractPhotoUrl({ href: "https://zalo.me/a.jpg" }), "https://zalo.me/a.jpg");
  assert.equal(extractPhotoUrl({ hdUrl: "https://zalo.me/hd.jpg" }), "https://zalo.me/hd.jpg");
  assert.equal(extractPhotoUrl({ oriUrl: "https://zalo.me/ori.jpg" }), "https://zalo.me/ori.jpg");
  assert.equal(extractPhotoUrl({ normalUrl: "https://zalo.me/normal.jpg" }), "https://zalo.me/normal.jpg");
  assert.equal(extractPhotoUrl({ url: "https://zalo.me/url.jpg" }), "https://zalo.me/url.jpg");
  assert.equal(extractPhotoUrl({ thumbUrl: "https://zalo.me/thumb.jpg" }), "https://zalo.me/thumb.jpg");
  assert.equal(extractPhotoUrl({ thumb: "https://zalo.me/tb.jpg" }), "https://zalo.me/tb.jpg");
  assert.equal(extractPhotoUrl({ previewUrl: "https://zalo.me/prev.jpg" }), "https://zalo.me/prev.jpg");
  assert.equal(extractPhotoUrl({ attachUrl: "https://zalo.me/att.jpg" }), "https://zalo.me/att.jpg");

  // Stringified JSON payload
  const jsonString = JSON.stringify({ hdUrl: "https://zalo.me/nested-hd.jpg" });
  assert.equal(extractPhotoUrl(jsonString), "https://zalo.me/nested-hd.jpg");

  // Raw URL string
  assert.equal(extractPhotoUrl("https://zalo.me/direct.jpg"), "https://zalo.me/direct.jpg");

  // Invalid inputs return null
  assert.equal(extractPhotoUrl(null), null);
  assert.equal(extractPhotoUrl(undefined), null);
  assert.equal(extractPhotoUrl({}), null);
  assert.equal(extractPhotoUrl("not-a-valid-url"), null);
});

test("antiundo: message is cached immediately and can be recovered if recalled right away", () => {
  const cliMsgId = "early-cache-cli-123";
  const threadId = "thread-early-1";
  const uidFrom = "user-early-1";

  const incomingMsg = {
    cliMsgId,
    msgId: "srv-msg-123",
    globalMsgId: "global-123",
    threadId,
    idTo: threadId,
    uidFrom,
    dName: "Alice",
    msgType: "chat.photo",
    content: {
      hdUrl: "https://zalo.me/photos/early.jpg",
      title: "Ảnh đẹp",
    },
    timestampString: "10:00:00",
  };

  // 1. Simulate early cache in inbound-dispatcher
  updateMessageCache(incomingMsg);

  // 2. Immediately verify message is accessible via findUndoOriginalMessage
  const undoEvent = {
    threadId,
    data: {
      idTo: threadId,
      uidFrom,
      content: { cliMsgId },
    },
  };

  const lookup = findUndoOriginalMessage(getMessageCache(), undoEvent);
  assert.equal(lookup.reason, null);
  assert.equal(lookup.message.cliMsgId, cliMsgId);
  assert.equal(lookup.message.uidFrom, uidFrom);
  assert.equal(lookup.message.threadId, threadId);
});

test("antiundo: sends text notice before image, marks restored only after success", async () => {
  const actions = [];
  const fakeApi = {
    currentUserId: "bot-uid-order",
    sendMessageForward: async (payload) => {
      actions.push({ type: "sendNotice", msg: payload.msg });
      return { msgId: "notice-id" };
    },
    sendImage: async (photoUrl, originalMsg, title) => {
      actions.push({ type: "sendImage", photoUrl, title });
      return { msgId: "img-id" };
    },
  };

  const threadId = "t-photo-order";
  const uidFrom = "user-photo-1";
  const cliMsgId = "cli-photo-order-1";

  const originalMsg = {
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom,
    dName: "Bob",
    msgType: "chat.photo",
    content: {
      hdUrl: "https://zalo.me/photo-hd.jpg",
      title: "Selfie",
    },
    isUndo: false,
    timestampString: "10:15",
  };

  cacheMessageForTest(fakeApi, originalMsg);

  const undoEvent = {
    threadId,
    data: {
      idTo: threadId,
      uidFrom,
      content: { cliMsgId },
    },
  };

  const groupSettings = {
    [threadId]: { antiUndo: true },
  };

  await processUndo(fakeApi, undoEvent, false, groupSettings, false, false);

  // Assert order: text notice FIRST, then image
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, "sendNotice");
  assert.ok(actions[0].msg.includes("Ảnh..."));
  assert.equal(actions[1].type, "sendImage");
  assert.equal(actions[1].photoUrl, "https://zalo.me/photo-hd.jpg");

  // Assert marked restored
  const store = getMessageCacheStore({ uid: fakeApi.currentUserId });
  const cached = store.getByMsgId(cliMsgId);
  assert.equal(cached.isUndo, true);
});

test("antiundo: handles unreachable / failed image gracefully without crashing and notifies group", async () => {
  const notices = [];
  const fakeApi = {
    currentUserId: "bot-uid-fail",
    sendMessageForward: async (payload) => {
      notices.push(payload.msg);
      return { msgId: "notice-id" };
    },
    sendImage: async () => {
      throw new Error("403 Forbidden - URL expired");
    },
  };

  const threadId = "t-photo-fail";
  const uidFrom = "user-fail-1";
  const cliMsgId = "cli-photo-fail-1";

  const originalMsg = {
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom,
    dName: "Charlie",
    msgType: "chat.photo",
    content: {
      url: "https://zalo.me/expired.jpg",
    },
    isUndo: false,
    timestampString: "10:20",
  };

  cacheMessageForTest(fakeApi, originalMsg);

  const undoEvent = {
    threadId,
    data: {
      idTo: threadId,
      uidFrom,
      content: { cliMsgId },
    },
  };

  const groupSettings = {
    [threadId]: { antiUndo: true },
  };

  await processUndo(fakeApi, undoEvent, false, groupSettings, false, false);

  assert.equal(notices.length, 2);
  assert.ok(notices[0].includes("Ảnh..."));
  assert.ok(notices[1].includes("Không thể khôi phục ảnh"));
});

test("antiundo: suppresses duplicate undo events within duplicate window", async () => {
  let callCount = 0;
  const fakeApi = {
    currentUserId: "bot-uid-dup",
    sendMessageForward: async () => {
      callCount++;
      return { msgId: "notice-id" };
    },
  };

  const threadId = "t-duplicate-1";
  const uidFrom = "user-dup-1";
  const cliMsgId = "cli-dup-1";

  const originalMsg = {
    cliMsgId,
    threadId,
    idTo: threadId,
    uidFrom,
    msgType: "chat.text",
    content: "Tin nhắn thử nghiệm trùng lặp",
    isUndo: false,
  };
  cacheMessageForTest(fakeApi, originalMsg);

  const undoEvent = {
    threadId,
    data: {
      idTo: threadId,
      uidFrom,
      content: { cliMsgId },
    },
  };
  const groupSettings = { [threadId]: { antiUndo: true } };

  // First undo event
  await processUndo(fakeApi, undoEvent, false, groupSettings, false, false);
  assert.equal(callCount, 1);

  // Duplicate undo event immediately afterwards
  await processUndo(fakeApi, undoEvent, false, groupSettings, false, false);
  assert.equal(callCount, 1, "Duplicate undo event must be suppressed");
});

test("antiundo: respects admin, self, whitelist, and disabled group exemptions", async () => {
  let callCount = 0;
  const fakeApi = {
    currentUserId: "bot-uid-exempt",
    sendMessageForward: async () => {
      callCount++;
      return { msgId: "ok" };
    },
  };

  const threadId = "t-exemptions";
  const originalMsg = {
    cliMsgId: "cli-ex-1",
    threadId,
    idTo: threadId,
    uidFrom: "admin-user",
    msgType: "chat.text",
    content: "Admin message",
  };
  cacheMessageForTest(fakeApi, originalMsg);

  const undoEvent = {
    threadId,
    data: {
      idTo: threadId,
      uidFrom: "admin-user",
      content: { cliMsgId: "cli-ex-1" },
    },
  };

  // 1. isSelf = true
  await processUndo(fakeApi, undoEvent, false, { [threadId]: { antiUndo: true } }, false, true);
  assert.equal(callCount, 0, "Self messages must be exempted");

  // 2. isAdminBox = true
  await processUndo(fakeApi, undoEvent, true, { [threadId]: { antiUndo: true } }, false, false);
  assert.equal(callCount, 0, "Admin box messages must be exempted");

  // 3. In whiteList
  const whiteListSettings = {
    [threadId]: {
      antiUndo: true,
      whiteList: ["admin-user"],
    },
  };
  await processUndo(fakeApi, undoEvent, false, whiteListSettings, false, false);
  assert.equal(callCount, 0, "Whitelisted sender must be exempted");

  // 4. Group antiUndo is turned off
  const turnedOffSettings = {
    [threadId]: { antiUndo: false },
  };
  await processUndo(fakeApi, undoEvent, false, turnedOffSettings, false, false);
  assert.equal(callCount, 0, "Disabled antiUndo must not trigger");
});

test("antiundo: supports text, gif, video, voice, sticker, and file media types", async () => {
  const dispatched = [];
  const fakeApi = {
    currentUserId: "bot-uid-all-types",
    sendMessageForward: async (payload) => {
      dispatched.push({ action: "notice", msg: payload.msg });
      return { ok: true };
    },
    sendGif: async (url) => {
      dispatched.push({ action: "sendGif", url });
      return { ok: true };
    },
    sendVideo: async (payload) => {
      dispatched.push({ action: "sendVideo", url: payload.videoUrl });
      return { ok: true };
    },
    sendVoice: async (target, voiceUrl) => {
      dispatched.push({ action: "sendVoice", url: voiceUrl });
      return { ok: true };
    },
    sendSticker: async (sticker) => {
      dispatched.push({ action: "sendSticker", id: sticker.id });
      return { ok: true };
    },
    sendFile: async (msg, fileUrl) => {
      dispatched.push({ action: "sendFile", url: fileUrl });
      return { ok: true };
    },
  };

  const groupSettings = { "t-all-types": { antiUndo: true } };

  // 1. chat.text
  const textMsg = {
    cliMsgId: "cli-m-text",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "chat.text",
    content: "Xin chào thế giới",
  };
  cacheMessageForTest(fakeApi, textMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-text" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "notice" && d.msg.includes("Xin chào thế giới")));

  // 2. chat.gif
  const gifMsg = {
    cliMsgId: "cli-m-gif",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "chat.gif",
    content: { href: "https://zalo.me/cat.gif" },
  };
  cacheMessageForTest(fakeApi, gifMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-gif" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "sendGif" && d.url === "https://zalo.me/cat.gif"));

  // 3. chat.video.msg
  const videoMsg = {
    cliMsgId: "cli-m-video",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "chat.video.msg",
    content: { href: "https://zalo.me/sample.mp4", thumb: "https://zalo.me/sample.jpg" },
  };
  cacheMessageForTest(fakeApi, videoMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-video" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "sendVideo" && d.url === "https://zalo.me/sample.mp4"));

  // 4. chat.voice
  const voiceMsg = {
    cliMsgId: "cli-m-voice",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "chat.voice",
    content: { href: "https://zalo.me/voice.aac" },
  };
  cacheMessageForTest(fakeApi, voiceMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-voice" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "sendVoice" && d.url === "https://zalo.me/voice.aac"));

  // 5. chat.sticker
  const stickerMsg = {
    cliMsgId: "cli-m-sticker",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "chat.sticker",
    content: { id: "stk-999" },
  };
  cacheMessageForTest(fakeApi, stickerMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-sticker" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "sendSticker" && d.id === "stk-999"));

  // 6. share.file
  const fileMsg = {
    cliMsgId: "cli-m-file",
    threadId: "t-all-types",
    idTo: "t-all-types",
    uidFrom: "u-1",
    msgType: "share.file",
    content: JSON.stringify({ href: "https://zalo.me/docs/report.pdf", title: "report.pdf", fileSize: 1024 }),
  };
  cacheMessageForTest(fakeApi, fileMsg);
  await processUndo(fakeApi, { threadId: "t-all-types", data: { idTo: "t-all-types", uidFrom: "u-1", content: { cliMsgId: "cli-m-file" } } }, false, groupSettings, false, false);
  assert.ok(dispatched.some((d) => d.action === "sendFile" && d.url === "https://zalo.me/docs/report.pdf"));
});
