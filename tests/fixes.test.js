import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { API_TYPE, API_VERSION } from "../src/api-zalo/constants.js";
import { appContext } from "../src/api-zalo/context.js";
import { ZaloApiError } from "../src/api-zalo/Errors/ZaloApiError.js";
import { buildGetAllFriendsParams } from "../src/api-zalo/apis/fetchAllFriend.js";
import { sendMessageFactory } from "../src/api-zalo/apis/sendMessage.js";
import {
  createChunkParams,
  getUploadConcurrency,
} from "../src/api-zalo/apis/uploadAttachment.js";
import { ReactionMap } from "../src/api-zalo/models/Reaction.js";
import { MessageType } from "../src/api-zalo/models/Message.js";
import {
  API,
  CORE_SERVICE_KEYS,
  Zalo,
  createLoginSession,
  normalizeServiceMap,
  validateEndpoint,
  validateServiceMap,
} from "../src/api-zalo/zalo.js";
import { request, requestJson } from "../src/api-zalo/utils.js";
import { parseCommandContent } from "../src/commands/command-parser.js";
import { createCommandErrorReference, sendCommandError, sendReactionConfirmReceive } from "../src/commands/command-response.js";
import {
  getGroupInfoData,
  isHttpNotFound,
} from "../src/service-debug/info-service/group-info-data.js";
import { getAllInfoUser } from "../src/service-debug/info-service/user-info-data.js";
import { dedupeMyBotsRegistry, loadMyBotsRegistry } from "../src/commands/mybot/System/mybots-registry.js";

function makeServiceMap() {
  return {
    chat: ["https://tt-chat1-wpa.chat.zalo.me"],
    group: ["https://tt-group-wpa.chat.zalo.me"],
    file: ["https://tt-files-wpa.chat.zalo.me"],
    profile: ["https://tt-profile-wpa.chat.zalo.me"],
    reaction: ["https://tt-reaction-wpa.chat.zalo.me"],
  };
}

function makeLoginData(overrides = {}) {
  const stringServiceMap = Object.fromEntries(
    Object.entries(makeServiceMap()).map(([key, value]) => [key, value[0]])
  );
  stringServiceMap.zavi = "https://wpa.zaloapp.com";
  return {
    data: {
      uid: "bot-uid",
      zpw_enk: "test-secret-key",
      send2me_id: "send2me-id",
      zpw_service_map_v3: stringServiceMap,
      zpw_ws: ["wss://ws.zalo.me/ws"],
      ...overrides,
    },
  };
}

function setReadyContext(overrides = {}) {
  Object.assign(appContext, {
    secretKey: "test-secret-key",
    uid: "bot-uid",
    imei: "test-imei",
    cookie: "zpw_sek=test",
    userAgent: "test-agent",
    settings: undefined,
    ...overrides,
  });
  appContext.options ||= {};
  appContext.options.uploadAttachmentHooks ||= {};
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("limits large attachment uploads to a bounded concurrency", () => {
  // VPS default is 2 concurrent chunk uploads (configurable via env, cap 8).
  assert.equal(getUploadConcurrency(100), 2);
  assert.equal(getUploadConcurrency(2), 2);
  assert.equal(getUploadConcurrency(100, "99"), 8);
  assert.equal(getUploadConcurrency(100, "invalid"), 2);
});

test("builds an independent chunk parameter object", () => {
  const baseParams = { clientId: 10, chunkId: 1, totalChunk: 4 };
  const chunkParams = createChunkParams(baseParams, 3);

  assert.deepEqual(chunkParams, { clientId: 10, chunkId: 3, totalChunk: 4 });
  assert.equal(baseParams.chunkId, 1);
});

test("cleans upload promises without creating an unhandled rejection", () => {
  const uploadSource = readFileSync(
    new URL("../src/api-zalo/apis/uploadAttachment.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(uploadSource, /uploadPromise\.finally\(/);
  assert.match(uploadSource, /uploadPromise\.then\(\s*\(\) =>/);
});

test("API constants match the installed zca-js protocol", () => {
  assert.equal(API_TYPE, 30);
  assert.equal(API_VERSION, 671);
  assert.equal(Zalo.API_TYPE, API_TYPE);
  assert.equal(Zalo.API_VERSION, API_VERSION);
});

test("zca-js is pinned to the version used by the local protocol", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(packageJson.dependencies["zca-js"], "2.1.2");
});

test("HTTP endpoint validation preserves dynamic Zalo hosts", () => {
  const url = "https://tt-chat1-wpa.chat.zalo.me";
  assert.equal(validateEndpoint(url, "chat"), url);
});

test("HTTP endpoint validation rejects insecure and WebSocket protocols", () => {
  assert.throws(() => validateEndpoint("http://chat.zalo.me", "chat"), /protocol/);
  assert.throws(() => validateEndpoint("wss://chat.zalo.me", "chat"), /protocol/);
});

test("WebSocket endpoint validation only accepts wss", () => {
  const url = "wss://ws.zalo.me/ws";
  assert.equal(validateEndpoint(url, "websocket", "wss:"), url);
  assert.throws(
    () => validateEndpoint("https://ws.zalo.me/ws", "websocket", "wss:"),
    /protocol/
  );
});

test("endpoint validation rejects non-Zalo and lookalike hosts", () => {
  assert.throws(() => validateEndpoint("https://example.com", "chat"), /host/);
  assert.throws(
    () => validateEndpoint("https://chat.zalo.me.example.com", "chat"),
    /host/
  );
  assert.throws(() => validateEndpoint("https://zalo.me", "chat"), /host/);
});

test("service map normalization does not mutate server response URLs", () => {
  const input = {
    chat: "https://tt-chat1-wpa.chat.zalo.me",
    group: "https://tt-group-wpa.chat.zalo.me",
    file: "https://tt-files-wpa.chat.zalo.me",
    profile: "https://tt-profile-wpa.chat.zalo.me",
    reaction: "https://tt-reaction-wpa.chat.zalo.me",
    zavi: "https://wpa.zaloapp.com",
  };
  const original = structuredClone(input);
  const normalized = normalizeServiceMap(input);

  assert.deepEqual(input, original);
  assert.deepEqual(normalized.chat, [input.chat]);
  assert.deepEqual(normalized.group, [input.group]);
  assert.deepEqual(normalized.zavi, [input.zavi]);
});

test("core service validation requires every endpoint used at startup", () => {
  const serviceMap = makeServiceMap();
  assert.equal(validateServiceMap(serviceMap), serviceMap);
  assert.deepEqual(CORE_SERVICE_KEYS, ["chat", "group", "file", "profile", "reaction"]);

  for (const key of CORE_SERVICE_KEYS) {
    const incomplete = makeServiceMap();
    delete incomplete[key];
    assert.throws(() => validateServiceMap(incomplete), new RegExp(key));
  }
});

test("login session uses the misspelled setttings field returned by Zalo", () => {
  const settings = { features: { sharefile: { max_file: 7 } } };
  const session = createLoginSession(
    makeLoginData(),
    { setttings: settings, settings: { wrong: true } },
    123
  );

  assert.equal(session.settings, settings);
  assert.equal(session.uid, "bot-uid");
  assert.deepEqual(session.zpwServiceMap.chat, ["https://tt-chat1-wpa.chat.zalo.me"]);
  assert.deepEqual(session.zpwServiceMap.zavi, ["https://wpa.zaloapp.com"]);
  const wsUrl = new URL(session.wsUrl);
  assert.equal(wsUrl.protocol, "wss:");
  assert.equal(wsUrl.searchParams.get("zpw_ver"), "671");
  assert.equal(wsUrl.searchParams.get("zpw_type"), "30");
  assert.equal(wsUrl.searchParams.get("t"), "123");
});

test("login session falls back to the correctly spelled settings field", () => {
  const settings = { features: {} };
  assert.equal(createLoginSession(makeLoginData(), { settings }).settings, settings);
});

test("login session rejects missing secrets before mutating app context", () => {
  assert.throws(
    () => createLoginSession(makeLoginData({ zpw_enk: "" }), { settings: {} }),
    /zpw_enk/
  );
});

test("login session rejects an HTTPS URL in the WebSocket field", () => {
  assert.throws(
    () => createLoginSession(
      makeLoginData({ zpw_ws: ["https://ws.zalo.me/ws"] }),
      { settings: {} }
    ),
    /protocol/
  );
});

test("API initializes real core capabilities without server sharefile settings", () => {
  setReadyContext({ settings: undefined });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const api = new API(
      appContext.secretKey,
      makeServiceMap(),
      "wss://ws.zalo.me/ws"
    );
    assert.equal(api.assertReady(), true);
    for (const capability of [
      "sendMessage",
      "uploadAttachment",
      "getGroupInfo",
      "getUserInfo",
      "getAllGroups",
      "getAllFriends",
      "addReaction",
    ]) {
      assert.equal(typeof api[capability], "function", capability);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("API startup fails when a core capability endpoint is absent", () => {
  setReadyContext();
  const serviceMap = makeServiceMap();
  delete serviceMap.reaction;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.throws(
      () => new API(appContext.secretKey, serviceMap, "wss://ws.zalo.me/ws"),
      /core capability addReaction/
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("assertReady detects a partially initialized app context", () => {
  setReadyContext();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const api = new API(
      appContext.secretKey,
      makeServiceMap(),
      "wss://ws.zalo.me/ws"
    );
    appContext.uid = null;
    assert.throws(() => api.assertReady(), /uid/);
  } finally {
    console.warn = originalWarn;
  }
});

test("sendMessage factory reads sharefile settings lazily", () => {
  setReadyContext({ settings: undefined });
  assert.equal(typeof sendMessageFactory({ zpwServiceMap: makeServiceMap() }), "function");
});

test("attachment-only messages do not crash on an omitted msg field or swallow failure", async () => {
  setReadyContext({ settings: undefined });
  const uploadError = new Error("upload failed");
  const sendMessage = sendMessageFactory({
    zpwServiceMap: makeServiceMap(),
    uploadAttachment: async () => {
      throw uploadError;
    },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => sendMessage(
        { attachments: ["missing.bin"] },
        "thread-id",
        MessageType.DirectMessage
      ),
      (error) => error === uploadError
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("getAllFriends builds the flat payload expected by zca-js 2.1.2", () => {
  assert.deepEqual(buildGetAllFriendsParams("imei", 50, 2, 240), {
    incInvalid: 1,
    page: 2,
    count: 50,
    avatar_size: 240,
    actiontime: 0,
    imei: "imei",
  });
});

test("group-info retry classification uses HTTP status only", () => {
  assert.equal(isHttpNotFound({ status: 404, code: 0 }), true);
  assert.equal(isHttpNotFound({ status: null, code: 404 }), false);
  assert.equal(isHttpNotFound(new Error("contains 404")), false);
});

test("group info does not retry an API code that merely equals 404", async () => {
  let calls = 0;
  const api = {
    getGroupInfo: async () => {
      calls += 1;
      throw Object.assign(new Error("API error"), { code: 404, status: null });
    },
  };
  const threadId = `test-${Date.now()}-${Math.random()}`;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await getGroupInfoData(api, threadId);
    assert.equal(calls, 1);
    assert.equal(result.name, `Group ${threadId}`);
    assert.deepEqual(result.adminIds, []);
  } finally {
    console.warn = originalWarn;
  }
});

test("command parser ignores non-command and non-text messages", () => {
  assert.equal(parseCommandContent("hello", "!"), null);
  assert.equal(parseCommandContent({ content: "!menu" }, "!"), null);
});

test("command parser extracts normal prefixed commands", () => {
  assert.deepEqual(parseCommandContent("!menu admin", "!"), {
    command: "menu",
    commandParts: ["menu", "admin"],
  });
});

test("command parser preserves underscore arguments for special commands", () => {
  assert.deepEqual(parseCommandContent("!todo_title_body", "!"), {
    command: "todo",
    commandParts: ["!todo", "title", "body"],
  });
});

test("reaction helper sends the expected confirmation reaction once and deduplicates", async () => {
  const calls = [];
  const api = {
    addReaction: async (icon, message) => {
      calls.push({ icon, message });
    },
  };
  const message = {
    threadId: "thread-1",
    type: 1,
    data: { msgId: "123", uidFrom: "user-1" },
  };

  const firstCall = await sendReactionConfirmReceive(api, message, 1);
  const secondCall = await sendReactionConfirmReceive(api, message, 1);

  assert.equal(firstCall, true);
  assert.equal(secondCall, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].icon, "thanks");
  assert.equal(calls[0].message, message);
});

test("reaction helper sends the canonical confirmation for game handlers", async () => {
  const calls = [];
  const api = {
    addReaction: async (icon) => calls.push(icon),
  };
  const message = {
    threadId: "thread-1",
    data: { msgId: "123", uidFrom: "user-1" },
  };

  await sendReactionConfirmReceive(api, message, 5);

  assert.deepEqual(calls, ["thanks"]);
});

test("reaction helper supports types 1, 2, 3, 5 and ignores unknown types like 99", async () => {
  const calls = [];
  const api = { addReaction: async (icon) => calls.push(icon) };
  const message1 = { threadId: "thread-1", data: { msgId: "123" } };
  const message2 = { threadId: "thread-1", data: { msgId: "124" } };
  const message3 = { threadId: "thread-1", data: { msgId: "125" } };

  const res3 = await sendReactionConfirmReceive(api, message1, 3);
  const res2 = await sendReactionConfirmReceive(api, message2, 2);
  const res99 = await sendReactionConfirmReceive(api, message3, 99);

  assert.equal(res3, true);
  assert.equal(res2, true);
  assert.equal(res99, false);
  assert.deepEqual(calls, ["thanks", "thanks"]);
});

test("reaction helper catches addReaction failures gracefully without throwing", async () => {
  const api = {
    addReaction: async () => {
      throw new Error("reaction failed");
    },
  };
  const message = {
    threadId: "thread-2",
    type: 1,
    data: { msgId: "456", uidFrom: "user-2" },
  };

  const result = await sendReactionConfirmReceive(api, message, 5);
  assert.equal(result, false);
});

test("runtime file paths do not depend on a machine-specific root or Desktop", () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));
  const utilSource = readFileSync(path.join(projectRoot, "src", "utils", "util.js"), "utf8");

  assert.equal(utilSource.includes("'/root/ndq/assets/json-data/cache-link.json'"), false);
  assert.equal(existsSync(path.join(projectRoot, "assets", "temp")), true);
});

test("command error helper reports internal errors to the same chat with a reference", async () => {
  const api = {
    sendMessage: async (payload, threadId, type) => {
      api.calls.push({ payload, threadId, type });
    },
    calls: [],
  };
  const message = {
    threadId: "private-thread",
    type: 1,
    data: { uidFrom: "user-3" },
  };

  const result = await sendCommandError(api, message, new Error("parse exploded"));
  assert.equal(result, true);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].threadId, "private-thread");
  assert.equal(api.calls[0].type, 1);
  assert.match(api.calls[0].payload.msg, /Đã xảy ra lỗi khi xử lý lệnh/);
  assert.match(api.calls[0].payload.msg, /Mã lỗi: CMD-/);
  assert.doesNotMatch(api.calls[0].payload.msg, /parse exploded/);
});

test("command error helper skips sending when required message fields are missing", async () => {
  const api = {
    sendMessage: async () => {
      throw new Error("should not be called");
    },
  };
  const result = await sendCommandError(api, { data: {} }, new Error("boom"));
  assert.equal(result, false);
});

test("command error reference is stable enough for matching without exposing internals", () => {
  const message = { threadId: "thread-x", data: { uidFrom: "user-x" } };
  const reference = createCommandErrorReference(message, new Error("boom"));
  assert.match(reference, /^CMD-[0-9A-F]{8}$/);
});

test("requestJson rejects invalid URLs with a ZaloApiError", async () => {
  await assert.rejects(
    () => requestJson("not-a-url"),
    (error) => error instanceof ZaloApiError && error.code === "INVALID_URL"
  );
});

test("requestJson returns a response wrapper when rawResponse is requested", async () => {
  await withServer((req, res) => {
    res.writeHead(204, { "content-type": "application/json" });
    res.end();
  }, async (baseUrl) => {
    const result = await requestJson(baseUrl, { rawResponse: true });
    assert.equal(result.response, result.response);
    assert.equal(typeof result.response.text, "function");
    assert.equal(result.response.status, 204);
  });
});

test("request returns the native Response object", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  }, async (baseUrl) => {
    const response = await request(baseUrl);
    assert.equal(response, response);
    assert.equal(typeof response.json, "function");
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("requestJson parses JSON bodies and rejects empty responses clearly", async () => {
  await withServer((req, res) => {
    if (req.url === "/empty") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
      return;
    }
    if (req.url === "/error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":{"hello":"world"}}');
  }, async (baseUrl) => {
    assert.deepEqual(await requestJson(baseUrl), { data: { hello: "world" } });
    await assert.rejects(
      () => requestJson(`${baseUrl}/empty`),
      (error) => error instanceof ZaloApiError && error.code === "EMPTY_RESPONSE_BODY"
    );
    await assert.rejects(
      () => requestJson(`${baseUrl}/error`),
      (error) => error instanceof ZaloApiError && error.status === 500
    );
  });
});

test("Zalo accepts cookie arrays using either key or name", () => {
  new Zalo({
    imei: "imei",
    cookie: [
      { key: "a", value: "1" },
      { name: "b", value: "2" },
    ],
    userAgent: "agent",
  });
  assert.equal(appContext.cookie, "a=1; b=2");
});

test("Zalo rejects blank cookie strings before login", () => {
  assert.throws(
    () => new Zalo({ imei: "imei", cookie: "   ", userAgent: "agent" }),
    /cookie format/
  );
});

test("user profile normalization tolerates a missing Zalo name", () => {
  const user = getAllInfoUser({ userId: "uid", gender: 2 });
  assert.equal(user.uid, "uid");
  assert.equal(user.name, "Không xác định");
});

test("registry dedupe keeps admin and removes admin alias duplicates", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mybots-registry-"));
  const filePath = path.join(tempDir, "mybots.json");
  writeFileSync(filePath, JSON.stringify({
    admin: { name: "admin", pid: "100", webPort: "2000", status: "running", database: "admin" },
    "36636267278442919": { name: "admin", pid: "100", webPort: "2000", status: "running", database: "admin" },
    "Thanh Hung": { name: "Thanh Hung", pid: "200", webPort: "4444", status: "running", database: "Thanh Hung" }
  }, null, 2));

  const result = dedupeMyBotsRegistry({
    adminUid: "36636267278442919",
    adminPid: "100",
    adminWebPort: "2000",
    filePath,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(loadMyBotsRegistry(filePath)).sort(), ["Thanh Hung", "admin"]);
  const registry = loadMyBotsRegistry(filePath);
  assert.equal(registry.admin.pid, "100");
  assert.equal(registry.admin.webPort, "2000");
  assert.equal(registry.admin.database, "nthdz");
});

test("registry dedupe is a no-op when there are no duplicates", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "mybots-registry-clean-"));
  const filePath = path.join(tempDir, "mybots.json");
  const original = {
    admin: { name: "admin", pid: "100", webPort: "2000", status: "running", database: "nthdz" },
    "Thanh Hung": { name: "Thanh Hung", pid: "200", webPort: "4444", status: "running", database: "Thanh Hung" }
  };
  writeFileSync(filePath, JSON.stringify(original, null, 2));

  const result = dedupeMyBotsRegistry({ filePath });
  assert.equal(result.changed, false);
  assert.deepEqual(loadMyBotsRegistry(filePath), original);
});

test("PM2 owns dashboard startup and bot.js defers to PM2 under BOT_MANAGED", () => {
  const botSource = readFileSync(new URL("../bot.js", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../run.bat", import.meta.url), "utf8");

  // bot.js must not start the dashboard or call any health endpoint watcher
  assert.doesNotMatch(botSource, /DASHBOARD_SCRIPT|ensureDashboardRunning|watchDashboardLifecycle/);
  // bot.js must defer to PM2 when BOT_MANAGED=true
  assert.match(botSource, /BOT_MANAGED/);
  // run.bat must NOT spawn a separate CMD window for dashboard anymore
  assert.doesNotMatch(launcher, /start "MyBot Dashboard" cmd\.exe \/k/);
  // run.bat delegates dashboard to PM2 via reconcile-and-monitor
  assert.match(launcher, /reconcile-and-monitor\.js/);
});
