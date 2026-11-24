import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { normalizeBotInfo } from "../src/service-debug/info-service/bot-details-utils.js";
import { commandRegistry, phase2Registry, createPhase2Registry } from "../src/commands/command-registry.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { resolveCommand } from "../src/commands/command-router.js";
import { MessageType } from "../src/api-zalo/models/Message.js";
import { createBotInfoImage, clearImagePath } from "../src/utils/canvas/detailSystem-Config.js";
import { createNqduanBotDetailImage } from "../src/utils/canvas/nqduan-detail-renderer.js";

const mockDependencies = {
  zaloSession: true,
  python: true,
  ffmpeg: true,
  ffprobe: true,
};

test("normalizeBotInfo provides a safe profile when input is null or primitive", () => {
  for (const input of [null, undefined, "not-an-object", 12345, true]) {
    const result = normalizeBotInfo(input);
    assert.equal(result.name, "Bot");
    assert.equal(result.displayName, "Bot");
    assert.equal(result.avatar, null);
    assert.equal(result.status, "running");
    assert.equal(result.createdBy, "Admin");
    assert.equal(result.webPort, "Không có");
    assert.equal(result.database, "Không có");
    assert.equal(result.expiryAt, "-1");
    assert.ok(result.createdAt instanceof Date);
  }
});

test("normalizeBotInfo populates and preserves profile properties", () => {
  const profile = {
    name: "My Bot",
    displayName: "My Bot Pro",
    avatar: "https://example.com/avatar.jpg",
    status: "stopped",
    webPort: "3000",
  };
  const normalized = normalizeBotInfo(profile);
  assert.equal(normalized.name, "My Bot");
  assert.equal(normalized.displayName, "My Bot Pro");
  assert.equal(normalized.avatar, "https://example.com/avatar.jpg");
  assert.equal(normalized.status, "stopped");
  assert.equal(normalized.webPort, "3000");
  assert.equal(normalized.database, "Không có");
  assert.equal(normalized.createdBy, "Admin");
});

test("detail command metadata preserves permission 'all', countdown 15, and type 1", () => {
  const resolved = resolveCommand(["detail"], commandRegistry);
  assert.equal(resolved.code, "RESOLVED");
  assert.equal(resolved.definition.name, "detail");
  assert.equal(resolved.definition.permission, "all");
  assert.equal(resolved.definition.countdown, 15);
  assert.equal(resolved.definition.type, 1);
});

test("detail aliases (uptime, xtt) resolve to canonical 'detail' command", () => {
  for (const alias of ["uptime", "xtt", "DETAIL", "UPTIME", "XTT"]) {
    const resolved = resolveCommand([alias], commandRegistry);
    assert.equal(resolved.code, "RESOLVED", `Alias ${alias} should resolve`);
    assert.equal(resolved.definition.name, "detail");
  }
});

test("dispatchCommand invokes detail handler in group scope", async () => {
  const calls = [];
  const testRegistry = phase2Registry.definitions
    ? createPhase2Registry({
        detail: async (context) => {
          calls.push({ scope: "group", ...context });
          return "ok-group";
        },
      })
    : null;

  const mockApi = {
    sendMessage: async () => ({ messageId: "msg-123" }),
  };
  const mockMessage = {
    threadId: "group-thread-1",
    type: MessageType.GroupMessage,
    data: { uidFrom: "user-1", content: "!detail" },
  };
  const mockGroupSettings = { "group-thread-1": { activeBot: true } };

  const result = await dispatchCommand({
    commandParts: ["detail"],
    scope: "group",
    dbReady: true,
    dependencies: mockDependencies,
    api: mockApi,
    message: mockMessage,
    groupSettings: mockGroupSettings,
  }, testRegistry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "ok-group");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "group");
  assert.equal(calls[0].message.threadId, "group-thread-1");
  assert.deepEqual(calls[0].groupSettings, mockGroupSettings);
});

test("dispatchCommand invokes detail handler in private scope via alias", async () => {
  const calls = [];
  const testRegistry = createPhase2Registry({
    detail: async (context) => {
      calls.push({ scope: "private", ...context });
      return "ok-private";
    },
  });

  const mockApi = {
    sendMessage: async () => ({ messageId: "msg-456" }),
  };
  const mockMessage = {
    threadId: "user-thread-2",
    type: MessageType.DirectMessage,
    data: { uidFrom: "user-2", content: "!uptime" },
  };

  const result = await dispatchCommand({
    commandParts: ["uptime"],
    scope: "private",
    dbReady: true,
    dependencies: mockDependencies,
    api: mockApi,
    message: mockMessage,
  }, testRegistry);

  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "ok-private");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "private");
  assert.equal(calls[0].message.threadId, "user-thread-2");
});

test("withTimeout resolves value when promise finishes in time", async () => {
  const { withTimeout } = await import("../src/service-debug/info-service/bot-info.js");
  const result = await withTimeout(Promise.resolve("fast-result"), 100, "test_fast");
  assert.equal(result, "fast-result");
});

test("detail defines stage timeouts properly", async () => {
  const { DETAIL_STAGE_TIMEOUTS } = await import("../src/service-debug/info-service/bot-info.js");
  assert.equal(DETAIL_STAGE_TIMEOUTS.RENDER, 15_000);
  assert.equal(DETAIL_STAGE_TIMEOUTS.RENDER_PRIMARY, 8_000);
  assert.equal(DETAIL_STAGE_TIMEOUTS.RENDER_NQDUAN, 7_000);
  assert.equal(DETAIL_STAGE_TIMEOUTS.SEND, 8_000);
  assert.equal(DETAIL_STAGE_TIMEOUTS.PROFILE, 3_500);
  assert.equal(DETAIL_STAGE_TIMEOUTS.SYSINFO, 4_000);
});

test("withTimeout rejects with stage error and isTimeout=true when promise hangs", async () => {
  const { withTimeout } = await import("../src/service-debug/info-service/bot-info.js");
  const hangingPromise = new Promise((resolve) => setTimeout(resolve, 500));
  await assert.rejects(
    () => withTimeout(hangingPromise, 30, "render"),
    (err) => {
      assert.equal(err.stage, "render");
      assert.equal(err.isTimeout, true);
      assert.match(err.message, /Timeout after 30ms/);
      return true;
    }
  );
});

test("fetchBotProfile gracefully returns safe default when API hangs or throws", async () => {
  const { fetchBotProfile } = await import("../src/service-debug/info-service/bot-info.js");
  const hangingApi = {
    getUserInfo: () => new Promise((resolve) => setTimeout(resolve, 500)),
  };
  const profile = await fetchBotProfile(hangingApi, "bot-123", 20);
  assert.equal(profile.name, "Bot");
  assert.equal(profile.avatar, null);
});

test("collectSystemInfo returns structured botStats with fallback values", async () => {
  const { collectSystemInfo } = await import("../src/service-debug/info-service/bot-info.js");
  const stats = await collectSystemInfo(500);
  assert.equal(typeof stats, "object");
  assert.ok(stats.version);
  assert.ok(stats.os);
  assert.ok(stats.memoryUsage);
  assert.ok(stats.cpu);
  assert.ok(stats.ram);
  assert.ok(stats.cpuModel);
  assert.ok(stats.disk);
});

test("createBotInfoImage renders image file on disk safely", async () => {
  const botInfo = normalizeBotInfo({ name: "TestBot", displayName: "TestBot V3" });
  const botStats = {
    version: "2.5.0",
    os: "Windows",
    memoryUsage: "50 MB",
    cpu: "4 Cores - Utilization 10%",
    ram: "4 GB / 16 GB",
    cpuModel: "Intel",
    disk: "10 GB / 100 GB",
  };
  const filePath = await createBotInfoImage(botInfo, "1 giờ", botStats, ["antiSpam: ✅"], ["antiFile: ❌"]);
  assert.ok(filePath);
  assert.ok(fs.existsSync(filePath));
  await clearImagePath(filePath);
  assert.equal(fs.existsSync(filePath), false);
});

test("createNqduanBotDetailImage renders fallback image file on disk safely", async () => {
  const botInfo = normalizeBotInfo({ name: "NqduanBot", displayName: "NqduanBot Pro", status: "running" });
  const botStats = {
    version: "2.5.0",
    os: "Windows",
    memoryUsage: "45 MB",
    cpu: "4 Cores",
    ram: "3 GB / 16 GB",
    cpuModel: "Intel Core i7",
    disk: "15 GB / 120 GB",
  };
  const filePath = await createNqduanBotDetailImage(botInfo, "2 ngày, 3 giờ", botStats, ["antiSpam: ✅"], []);
  assert.ok(filePath);
  assert.ok(fs.existsSync(filePath));
  await clearImagePath(filePath);
  assert.equal(fs.existsSync(filePath), false);
});

test("buildDeleteMessagePayload constructs valid delete payload matching deleteMessage contract", async () => {
  const { buildDeleteMessagePayload } = await import("../src/service-debug/info-service/bot-info.js");

  // Case 1: From Message instance with data
  const fromInstance = buildDeleteMessagePayload(
    {
      type: MessageType.GroupMessage,
      threadId: "gr-1",
      data: { cliMsgId: "cli-11", msgId: "msg-22", uidFrom: "bot-99" },
    },
    "gr-1",
    MessageType.GroupMessage,
    "bot-99"
  );
  assert.deepEqual(fromInstance, {
    type: MessageType.GroupMessage,
    threadId: "gr-1",
    data: {
      cliMsgId: "cli-11",
      msgId: "msg-22",
      uidFrom: "bot-99",
    },
  });

  // Case 2: From api.sendMessage responses object with attachment array
  const fromApiResponse = buildDeleteMessagePayload(
    {
      message: null,
      attachment: [{ msgId: "att-msg-1", cliMsgId: "att-cli-1" }],
    },
    "direct-1",
    MessageType.DirectMessage,
    "admin-bot"
  );
  assert.deepEqual(fromApiResponse, {
    type: MessageType.DirectMessage,
    threadId: "direct-1",
    data: {
      cliMsgId: "att-cli-1",
      msgId: "att-msg-1",
      uidFrom: "admin-bot",
    },
  });

  // Case 3: Invalid / empty object returns null safely
  assert.equal(buildDeleteMessagePayload(null, "t-1", 0, "bot"), null);
  assert.equal(buildDeleteMessagePayload({}, "t-1", 0, "bot"), null);
});

test("sendDetailFallback sends standard Vietnamese error message and handles API errors safely", async () => {
  const { sendDetailFallback } = await import("../src/service-debug/info-service/bot-info.js");
  const sent = [];
  const mockApi = {
    sendMessage: async (payload, threadId, type) => {
      sent.push({ payload, threadId, type });
      return { msgId: "fb-1" };
    },
  };

  const message = { threadId: "thread-123", type: MessageType.GroupMessage };
  const ok = await sendDetailFallback(mockApi, message, "render_error", new Error("Canvas boom"));
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.msg, /Không thể lấy thông tin bot lúc này/);
  assert.equal(sent[0].threadId, "thread-123");

  // Safe when sendMessage throws
  const failingApi = {
    sendMessage: async () => { throw new Error("Network down"); },
  };
  const failResult = await sendDetailFallback(failingApi, message, "send_error");
  assert.equal(failResult, false);
});

test("scheduleDetailMessageCleanup does not throw when api.deleteMessage fails", async () => {
  const { scheduleDetailMessageCleanup } = await import("../src/service-debug/info-service/bot-info.js");
  const throwingApi = {
    deleteMessage: async () => { throw new Error("Delete permission denied"); },
  };
  assert.doesNotThrow(() => {
    scheduleDetailMessageCleanup(
      throwingApi,
      {
        type: MessageType.GroupMessage,
        threadId: "t-1",
        data: { cliMsgId: "1", msgId: "2", uidFrom: "3" },
      },
      10
    );
  });
});

test("getBotDetails end-to-end in group scope completes and sends image", async () => {
  const { getBotDetails } = await import("../src/service-debug/info-service/bot-info.js");
  const sent = [];
  const mockApi = {
    getUserInfo: async () => null,
    sendMessage: async (payload, threadId, type) => {
      sent.push({ payload, threadId, type });
      return {
        message: null,
        attachment: [{ msgId: "img-msg-1", cliMsgId: "img-cli-1" }],
      };
    },
    deleteMessage: async () => true,
    getBotId: () => "bot-admin",
  };

  const message = {
    threadId: "grp-999",
    type: MessageType.GroupMessage,
    data: { uidFrom: "usr-888", content: "!detail" },
  };
  const groupSettings = { "grp-999": { activeBot: true } };

  await assert.doesNotReject(async () => {
    await getBotDetails(mockApi, message, groupSettings);
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "grp-999");
  assert.equal(sent[0].type, MessageType.GroupMessage);
  assert.ok(Array.isArray(sent[0].payload.attachments));
  assert.equal(sent[0].payload.attachments.length, 1);
});

test("getBotDetails end-to-end in private scope completes and sends image", async () => {
  const { getBotDetails } = await import("../src/service-debug/info-service/bot-info.js");
  const sent = [];
  const mockApi = {
    getUserInfo: async () => null,
    sendMessage: async (payload, threadId, type) => {
      sent.push({ payload, threadId, type });
      return {
        message: null,
        attachment: [{ msgId: "img-msg-2", cliMsgId: "img-cli-2" }],
      };
    },
    deleteMessage: async () => true,
    getBotId: () => "bot-admin",
  };

  const message = {
    threadId: "priv-user-111",
    type: MessageType.DirectMessage,
    data: { uidFrom: "priv-user-111", content: "!uptime" },
  };

  await assert.doesNotReject(async () => {
    await getBotDetails(mockApi, message, {});
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "priv-user-111");
  assert.equal(sent[0].type, MessageType.DirectMessage);
  assert.ok(Array.isArray(sent[0].payload.attachments));
  assert.equal(sent[0].payload.attachments.length, 1);
});

test("getBotDetails falls back to Vietnamese text when image send fails", async () => {
  const { getBotDetails } = await import("../src/service-debug/info-service/bot-info.js");
  const sent = [];
  let sendCount = 0;
  const mockApi = {
    getUserInfo: async () => null,
    sendMessage: async (payload, threadId, type) => {
      sendCount++;
      if (sendCount === 1) {
        // Image send fails
        throw new Error("Upload image failed");
      }
      // Fallback text send succeeds
      sent.push({ payload, threadId, type });
      return { msgId: "fb-text-msg" };
    },
    deleteMessage: async () => true,
    getBotId: () => "bot-admin",
  };

  const message = {
    threadId: "priv-user-222",
    type: MessageType.DirectMessage,
    data: { uidFrom: "priv-user-222", content: "!detail" },
  };

  await assert.doesNotReject(async () => {
    await getBotDetails(mockApi, message, {});
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.msg, /Không thể lấy thông tin bot lúc này/);
});
