import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { undoMessageFactory } from "../src/api-zalo/apis/undoMessage.js";
import { appContext } from "../src/api-zalo/context.js";
import { decodeAES, encodeAES } from "../src/api-zalo/utils.js";
import {
  recallBotMessage,
  createDownloadProgress,
} from "../src/utils/interaction-countdown.js";

test("undoMessageFactory supports both quote messages and normalized sent-message references", async () => {
  const secretKey = "12345678901234567890123456789012";
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei-uuid";
  appContext.cookie = "zpw_sek=123";
  appContext.userAgent = "mock-agent";

  const interceptedRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const params = new URLSearchParams(body).get("params");
      const decrypted = JSON.parse(decodeAES(secretKey, params));
      interceptedRequests.push({ url: req.url, body: decrypted });
      const responsePayload = {
        error_code: 0,
        data: encodeAES(secretKey, JSON.stringify({ error_code: 0, data: { status: 0 } })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responsePayload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const fakeApi = {
      zpwServiceMap: {
        chat: [baseUrl],
        group: [baseUrl],
      },
    };

    const undoMessage = undoMessageFactory(fakeApi);

    const tStart = Date.now() - 1000;
    // 1. Quote message format
    const quoteMsg = {
      threadId: "group-123",
      type: 1,
      data: {
        quote: {
          globalMsgId: "111222",
          cliMsgId: "333444",
          msgType: "chat.message",
        },
      },
    };
    await undoMessage(quoteMsg);
    const tEnd = Date.now() + 1000;
    assert.match(interceptedRequests[0].url, /\/api\/group\/undomsg/);
    assert.equal(interceptedRequests[0].body.grid, "group-123");
    assert.equal(interceptedRequests[0].body.msgId, "111222");
    assert.equal(interceptedRequests[0].body.cliMsgIdUndo, "333444");
    assert.equal(interceptedRequests[0].body.visibility, 0);
    assert.equal(interceptedRequests[0].body.imei, "mock-imei-uuid");
    assert.ok(
      Number(interceptedRequests[0].body.clientId) >= tStart &&
      Number(interceptedRequests[0].body.clientId) <= tEnd,
      `Undo request clientId (${interceptedRequests[0].body.clientId}) should be ~Date.now() between ${tStart} and ${tEnd}`
    );

    // 2. Normalized sent-message reference in Group
    const sentGroupMsg = {
      threadId: "group-456",
      type: 1,
      data: {
        msgId: "555666",
        cliMsgId: "777888",
      },
    };
    await undoMessage(sentGroupMsg);
    assert.match(interceptedRequests[1].url, /\/api\/group\/undomsg/);
    assert.equal(interceptedRequests[1].body.grid, "group-456");
    assert.equal(interceptedRequests[1].body.msgId, "555666");
    assert.equal(interceptedRequests[1].body.cliMsgIdUndo, "777888");

    // 3. Direct user message format
    const sentDirectMsg = {
      threadId: "user-789",
      type: 0,
      msgId: "999000",
      cliMsgId: "111000",
    };
    await undoMessage(sentDirectMsg);
    assert.match(interceptedRequests[2].url, /\/api\/message\/undo/);
    assert.equal(interceptedRequests[2].body.toid, "user-789");
    assert.equal(interceptedRequests[2].body.msgId, "999000");
    assert.equal(interceptedRequests[2].body.cliMsgIdUndo, "111000");

    // 4. Incoming command containing both its own IDs and a quote must undo the replied message.
    const sentMsgWithQuote = {
      threadId: "group-777",
      type: 1,
      data: {
        msgId: "bot-own-msg-999",
        cliMsgId: "bot-own-cli-888",
        quote: {
          globalMsgId: "user-incoming-msg-111",
          cliMsgId: "user-incoming-cli-222",
        },
      },
    };
    await undoMessage(sentMsgWithQuote);
    assert.match(interceptedRequests[3].url, /\/api\/group\/undomsg/);
    assert.equal(interceptedRequests[3].body.grid, "group-777");
    assert.equal(interceptedRequests[3].body.msgId, "user-incoming-msg-111");
    assert.equal(interceptedRequests[3].body.cliMsgIdUndo, "user-incoming-cli-222");

    // 5. Group message with distinct globalMsgId, msgId, cliMsgId
    const groupDistinctIds = {
      threadId: "group-distinct-ids",
      type: 1,
      data: {
        msgId: "local-distinct-100",
        globalMsgId: "global-distinct-200",
        cliMsgId: "cli-distinct-300",
      },
    };
    await undoMessage(groupDistinctIds);
    assert.match(interceptedRequests[4].url, /\/api\/group\/undomsg/);
    assert.equal(interceptedRequests[4].body.grid, "group-distinct-ids");
    assert.equal(interceptedRequests[4].body.msgId, "global-distinct-200");
    assert.equal(interceptedRequests[4].body.cliMsgIdUndo, "cli-distinct-300");

    // 6. Direct message with distinct globalMsgId, msgId, cliMsgId
    const directDistinctIds = {
      threadId: "user-distinct-ids",
      type: 0,
      data: {
        msgId: "local-distinct-300",
        globalMsgId: "global-distinct-400",
        cliMsgId: "cli-distinct-500",
      },
    };
    await undoMessage(directDistinctIds);
    assert.match(interceptedRequests[5].url, /\/api\/message\/undo/);
    assert.equal(interceptedRequests[5].body.toid, "user-distinct-ids");
    assert.equal(interceptedRequests[5].body.grid, undefined);
    assert.equal(interceptedRequests[5].body.msgId, "global-distinct-400");
    assert.equal(interceptedRequests[5].body.cliMsgIdUndo, "cli-distinct-500");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("undoMessageFactory rejects missing msgId or cliMsgId without falling back", async () => {
  const fakeApi = {
    zpwServiceMap: {
      chat: ["http://127.0.0.1:9999"],
      group: ["http://127.0.0.1:9999"],
    },
  };
  const undoMessage = undoMessageFactory(fakeApi);

  // Missing msgId
  await assert.rejects(
    async () => {
      await undoMessage({ threadId: "t1", type: 0, data: { cliMsgId: "c1" } });
    },
    { code: "UNDO_MSG_ID_MISSING" }
  );

  // Missing cliMsgId
  await assert.rejects(
    async () => {
      await undoMessage({ threadId: "t1", type: 0, data: { msgId: "m1" } });
    },
    { code: "UNDO_CLI_MSG_ID_MISSING" }
  );
});

test("undoMessageFactory performs single request and does not loop internally on Zalo error", async () => {
  const secretKey = "12345678901234567890123456789012";
  appContext.secretKey = secretKey;
  appContext.imei = "mock-imei-uuid";
  appContext.cookie = "zpw_sek=123";
  appContext.userAgent = "mock-agent";

  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    const innerPayload = {
      error_code: 11000,
      error_message: "Message cannot be undone",
      data: null,
    };
    const responsePayload = {
      error_code: 0,
      data: encodeAES(secretKey, JSON.stringify(innerPayload)),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responsePayload));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const fakeApi = {
      zpwServiceMap: {
        chat: [baseUrl],
        group: [baseUrl],
      },
    };
    const undoMessage = undoMessageFactory(fakeApi);
    await assert.rejects(
      async () => {
        await undoMessage({ threadId: "t1", type: 0, data: { msgId: "m1", cliMsgId: "c1" } });
      },
      (err) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
    assert.equal(requestCount, 1, "undoMessageFactory should make exactly 1 request without inner retry loops");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("recallBotMessage retries on temporary failures and succeeds", async () => {
  let attempts = 0;
  const api = {
    undoMessage: async () => {
      attempts++;
      if (attempts < 2) {
        const err = new Error("Temporary network timeout");
        err.retryable = true;
        throw err;
      }
      return { error_code: 0 };
    },
  };

  const recalled = await recallBotMessage({
    api,
    message: { threadId: "t1", type: 1, data: { msgId: "m1", cliMsgId: "c1" } },
    maxRetries: 3,
    delayMs: 10,
  });

  assert.equal(recalled, true);
  assert.equal(attempts, 2);
});

test("recallBotMessage skips undo and returns false when cliMsgId is missing", async () => {
  let undoCalled = false;
  const api = {
    undoMessage: async () => {
      undoCalled = true;
      return { error_code: 0 };
    },
  };

  const recalled = await recallBotMessage({
    api,
    message: { threadId: "t1", type: 1, data: { msgId: "m1" } },
  });

  assert.equal(recalled, false);
  assert.equal(undoCalled, false, "api.undoMessage should not be called when cliMsgId is missing");
});

test("recallBotMessage stops immediately on non-retryable protocol errors without retrying", async () => {
  let attempts = 0;
  const api = {
    undoMessage: async () => {
      attempts++;
      const err = new Error("Invalid message recall target");
      err.code = 12001;
      err.status = 200;
      err.retryable = false;
      throw err;
    },
  };

  const recalled = await recallBotMessage({
    api,
    message: { threadId: "t1", type: 1, data: { msgId: "m1", cliMsgId: "c1" } },
    maxRetries: 3,
    delayMs: 10,
  });

  assert.equal(recalled, false);
  assert.equal(attempts, 1, "Should stop after 1 attempt for non-retryable error");
});

test("download progress lifecycle creates tag, sends media, then recalls tag", async () => {
  const lifecycleEvents = [];
  const mockApi = {
    undoMessage: async (msg) => {
      lifecycleEvents.push({ event: "undoMessage", msg });
      return { status: 0 };
    },
    sendVideo: async (payload) => {
      lifecycleEvents.push({ event: "sendVideo", payload });
      return { msgId: "video-sent-1" };
    },
  };

  const incomingMessage = {
    threadId: "chat-room-456",
    type: 1,
    data: { uidFrom: "u123", dName: "Tester" },
  };

  const sendProcessingFn = async (apiRef, msg, payload, ttl) => {
    lifecycleEvents.push({ event: "sendProcessing", payload, ttl });
    return {
      message: [{ msgId: "prog-tag-123", cliMsgId: "cli-tag-123" }],
    };
  };

  // Step 1: Create download progress tag
  const progress = await createDownloadProgress({
    api: mockApi,
    message: incomingMessage,
    caption: "Chờ bé tải video chút nhé!",
    ttl: 8000,
    sendProcessingFn,
  });

  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0].event, "sendProcessing");

  // Step 2: Media finishes upload and sends video successfully
  await mockApi.sendVideo({ videoUrl: "https://video.mp4" });
  assert.equal(lifecycleEvents.length, 2);
  assert.equal(lifecycleEvents[1].event, "sendVideo");

  // Step 3: progress.complete() is called immediately AFTER sendVideo
  await progress.complete();

  assert.equal(lifecycleEvents.length, 3);
  assert.equal(lifecycleEvents[2].event, "undoMessage");
  assert.equal(lifecycleEvents[2].msg.data.msgId, "prog-tag-123");

  // Step 4: finally block calls progress.complete() again -> idempotent, no double undo
  const secondComplete = await progress.complete();
  assert.equal(secondComplete, false);
  assert.equal(lifecycleEvents.length, 3);
});

test("download progress lifecycle cleans up in finally block when an exception occurs during download", async () => {
  const lifecycleEvents = [];
  const mockApi = {
    undoMessage: async (msg) => {
      lifecycleEvents.push({ event: "undoMessage", msg });
      return { status: 0 };
    },
  };

  const incomingMessage = {
    threadId: "room-err",
    type: 1,
    data: { uidFrom: "u2" },
  };

  const sendProcessingFn = async (apiRef, msg, payload, ttl) => {
    lifecycleEvents.push({ event: "sendProcessing", payload, ttl });
    return {
      message: [{ msgId: "prog-err-tag", cliMsgId: "cli-err-tag" }],
    };
  };

  let progress = null;
  let errorCaught = false;

  try {
    progress = await createDownloadProgress({
      api: mockApi,
      message: incomingMessage,
      caption: "Processing...",
      sendProcessingFn,
    });

    // Simulate network error during download
    throw new Error("Download stream broke");
  } catch (err) {
    errorCaught = true;
  } finally {
    await progress?.complete();
  }

  assert.equal(errorCaught, true);
  assert.equal(lifecycleEvents.length, 2);
  assert.equal(lifecycleEvents[0].event, "sendProcessing");
  assert.equal(lifecycleEvents[1].event, "undoMessage");
  assert.equal(lifecycleEvents[1].msg.data.msgId, "prog-err-tag");
});

test("YouTube direct link workflow: sends processing tag, sends video, then recalls processing tag with correct ID", async () => {
  const eventLog = [];
  const mockApi = {
    sendMessage: async (payload, threadId, type) => {
      eventLog.push({ type: "sendMessage", payload });
      return {
        message: [{ msgId: "yt-processing-msg-456", cliMsgId: "yt-cli-456" }],
      };
    },
    uploadAttachment: async (files, threadId, type) => {
      eventLog.push({ type: "uploadAttachment", files });
      return [{ fileUrl: "https://zalo.mock/yt-vid.mp4" }];
    },
    sendVideo: async (payload) => {
      eventLog.push({ type: "sendVideo", payload });
      return { msgId: "yt-final-video-789" };
    },
    undoMessage: async (msgRef) => {
      eventLog.push({ type: "undoMessage", msgRef });
      return { status: 0 };
    },
  };

  const incomingMsg = {
    threadId: "group-yt-1",
    type: 1,
    data: { uidFrom: "u-yt-1", dName: "Lan" },
  };

  // Simulate YouTube download flow
  const progress = await createDownloadProgress({
    api: mockApi,
    message: incomingMsg,
    caption: "Chờ bé lấy video một chút...",
    ttl: 10000,
    sendProcessingFn: async (apiRef, msg, data, ttl) => {
      return await apiRef.sendMessage({ msg: data.caption, ttl }, msg.threadId, msg.type);
    },
  });

  // Verify processing message sent first
  assert.equal(eventLog.length, 1);
  assert.equal(eventLog[0].type, "sendMessage");

  // Video uploaded & sent
  const uploadRes = await mockApi.uploadAttachment(["/tmp/vid.mp4"], incomingMsg.threadId, incomingMsg.type);
  const sentVideo = await mockApi.sendVideo({ videoUrl: uploadRes[0].fileUrl });
  assert.equal(eventLog.length, 3);
  assert.equal(eventLog[1].type, "uploadAttachment");
  assert.equal(eventLog[2].type, "sendVideo");

  // Recall processing tag AFTER video sent
  await progress.complete();

  assert.equal(eventLog.length, 4);
  assert.equal(eventLog[3].type, "undoMessage");
  assert.equal(eventLog[3].msgRef.data.msgId, "yt-processing-msg-456");
  assert.equal(eventLog[3].msgRef.data.cliMsgId, "yt-cli-456");
});

test("YouTube reply selection workflow: claims prompt and recalls processing tag after sending media", async () => {
  const eventLog = [];
  const mockApi = {
    sendMessage: async (payload) => {
      eventLog.push({ type: "sendMessage", payload });
      return {
        message: [{ msgId: "yt-select-processing-999", cliMsgId: "yt-select-cli-999" }],
      };
    },
    sendVideo: async (payload) => {
      eventLog.push({ type: "sendVideo", payload });
      return { msgId: "yt-selected-video-111" };
    },
    undoMessage: async (msgRef) => {
      eventLog.push({ type: "undoMessage", msgRef });
      return { status: 0 };
    },
    addReaction: async (icon, batch) => {
      eventLog.push({ type: "addReaction", icon, count: batch.length });
      return { success: true };
    },
  };

  const replyMessage = {
    threadId: "group-yt-reply",
    type: 1,
    data: {
      uidFrom: "u-reply",
      dName: "Hung",
      quote: { globalMsgId: "yt-prompt-msg-888", cliMsgId: "yt-prompt-cli-888" },
    },
  };

  // 1. Progress tag created during media processing
  const progress = await createDownloadProgress({
    api: mockApi,
    message: replyMessage,
    caption: "Chờ bé lấy video số 1...",
    sendProcessingFn: async (apiRef, msg, data, ttl) => {
      return await apiRef.sendMessage({ msg: data.caption }, msg.threadId, msg.type);
    },
  });

  assert.equal(eventLog[0].type, "sendMessage");

  // 2. Video sent
  await mockApi.sendVideo({ videoUrl: "https://zalo.mock/selected.mp4" });
  assert.equal(eventLog[1].type, "sendVideo");

  // 3. Recall processing tag with its own msgId (NOT the quoted prompt msgId!)
  await progress.complete();
  assert.equal(eventLog[2].type, "undoMessage");
  assert.equal(eventLog[2].msgRef.data.msgId, "yt-select-processing-999");
});

test("TikTok direct link workflow: creates progress tag, sends video, then recalls progress tag", async () => {
  const eventLog = [];
  const mockApi = {
    sendMessage: async (payload) => {
      eventLog.push({ type: "sendMessage", payload });
      return {
        message: [{ msgId: "tt-prog-555", cliMsgId: "tt-cli-555" }],
      };
    },
    uploadAttachment: async (files) => {
      eventLog.push({ type: "uploadAttachment", files });
      return [{ fileUrl: "https://zalo.mock/tiktok-vid.mp4" }];
    },
    sendVideo: async (payload) => {
      eventLog.push({ type: "sendVideo", payload });
      return { msgId: "tt-vid-555" };
    },
    undoMessage: async (msgRef) => {
      eventLog.push({ type: "undoMessage", msgRef });
      return { status: 0 };
    },
  };

  const incomingMessage = {
    threadId: "group-tt-direct",
    type: 1,
    data: { uidFrom: "u-tt", dName: "TikToker" },
  };

  // Progress tag created
  const progress = await createDownloadProgress({
    api: mockApi,
    message: incomingMessage,
    caption: "Chờ bé lấy video một chút, xong bé gọi cho hay!",
    sendProcessingFn: async (apiRef, msg, data, ttl) => {
      return await apiRef.sendMessage({ msg: data.caption }, msg.threadId, msg.type);
    },
  });

  assert.equal(eventLog[0].type, "sendMessage");

  // Media uploaded and sent
  await mockApi.uploadAttachment(["/tmp/tt.mp4"]);
  await mockApi.sendVideo({ videoUrl: "https://zalo.mock/tiktok-vid.mp4" });

  assert.equal(eventLog[1].type, "uploadAttachment");
  assert.equal(eventLog[2].type, "sendVideo");

  // Progress tag recalled after sendVideo
  await progress.complete();
  assert.equal(eventLog[3].type, "undoMessage");
  assert.equal(eventLog[3].msgRef.data.msgId, "tt-prog-555");
});

test("TikTok audio mode workflow: creates progress tag, sends voice, then recalls progress tag", async () => {
  const eventLog = [];
  const mockApi = {
    sendMessage: async (payload) => {
      eventLog.push({ type: "sendMessage", payload });
      return {
        message: [{ msgId: "tt-audio-prog-777", cliMsgId: "tt-audio-cli-777" }],
      };
    },
    sendVoice: async (msg, voiceUrl, ttl) => {
      eventLog.push({ type: "sendVoice", voiceUrl });
      return { msgId: "tt-voice-777" };
    },
    undoMessage: async (msgRef) => {
      eventLog.push({ type: "undoMessage", msgRef });
      return { status: 0 };
    },
  };

  const incomingMessage = {
    threadId: "group-tt-audio",
    type: 1,
    data: { uidFrom: "u-tt-audio", dName: "MusicFan" },
  };

  // Progress tag created
  const progress = await createDownloadProgress({
    api: mockApi,
    message: incomingMessage,
    caption: "Chờ bé lấy nhạc một chút...",
    sendProcessingFn: async (apiRef, msg, data, ttl) => {
      return await apiRef.sendMessage({ msg: data.caption }, msg.threadId, msg.type);
    },
  });

  assert.equal(eventLog[0].type, "sendMessage");

  // Music sent
  await mockApi.sendVoice(incomingMessage, "https://zalo.mock/audio.mp3", 1800000);
  assert.equal(eventLog[1].type, "sendVoice");

  // Progress tag recalled AFTER sendVoice
  await progress.complete();
  assert.equal(eventLog[2].type, "undoMessage");
  assert.equal(eventLog[2].msgRef.data.msgId, "tt-audio-prog-777");
});
