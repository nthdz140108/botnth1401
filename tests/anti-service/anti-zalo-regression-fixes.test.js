import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

// Create an isolated sandbox root BEFORE importing any runtime-stateful modules
// so getProjectRoot() resolves inside os.tmpdir() and never touches workspace assets/data.
const sandboxRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "cluster3-zalo-anti-"));
fsSync.mkdirSync(path.join(sandboxRoot, "assets", "data"), { recursive: true });
fsSync.mkdirSync(path.join(sandboxRoot, "assets", "json-data"), { recursive: true });
fsSync.mkdirSync(path.join(sandboxRoot, "mybot", "bots"), { recursive: true });
fsSync.mkdirSync(path.join(sandboxRoot, "mybot", "configs"), { recursive: true });
fsSync.writeFileSync(
  path.join(sandboxRoot, "assets", "config.json"),
  JSON.stringify({ uid: "admin", name: "admin" }, null, 2),
  "utf8"
);
fsSync.writeFileSync(
  path.join(sandboxRoot, "assets", "data", "list_admin_high.json"),
  JSON.stringify(["high-admin-1"], null, 2),
  "utf8"
);
fsSync.writeFileSync(
  path.join(sandboxRoot, "assets", "data", "list_admin.json"),
  JSON.stringify(["bot-admin-1"], null, 2),
  "utf8"
);
fsSync.writeFileSync(
  path.join(sandboxRoot, "assets", "data", "group_settings.json"),
  JSON.stringify({}, null, 2),
  "utf8"
);
fsSync.writeFileSync(
  path.join(sandboxRoot, "mybot", "defaultCommand.json"),
  JSON.stringify({ prefix: "!", commands: [] }, null, 2),
  "utf8"
);

process.env.SKIP_ENV_VALIDATION = "1";
process.env.NODE_ENV = "test";
process.env.PROJECT_ROOT = sandboxRoot;

const TEST_SECRET_KEY = Buffer.alloc(16, 7).toString("base64");
const TINY_GIF_BUFFER = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

const { appContext } = await import("../../src/api-zalo/context.js");
const { Undo } = await import("../../src/api-zalo/models/Undo.js");
const { MessageType } = await import("../../src/api-zalo/models/Message.js");
const { decodeAES, encodeAES } = await import("../../src/api-zalo/utils.js");
const { uploadThumbnailFactory } = await import("../../src/api-zalo/apis/uploadThumbnail.js");
const { sendGifFactory } = await import("../../src/api-zalo/apis/sendGif.js");
const { sendMessageForwardFactory } = await import("../../src/api-zalo/apis/sendMessageForward.js");
const { sendVoiceFactory } = await import("../../src/api-zalo/apis/sendVoice.js");
const {
  withUserViolationLock,
  getUserViolationLockCountForTest,
  classifyLocalImageFile,
  resetMockClassifierForTest,
} = await import("../../src/service-debug/anti-service/anti-nude/anti-nude.js");
const {
  antiLink,
  handleAntiLinkCommand,
  setMockQrScannerForTest,
  resetMockQrScannerForTest,
} = await import("../../src/service-debug/anti-service/anti-link.js");
const {
  antiPhoneNumber,
  handleAntiPhoneNumberCommand,
} = await import("../../src/service-debug/anti-service/anti-phone-number.js");
const {
  handleMuteUser,
  startMuteCheck,
  stopMuteCheck,
} = await import("../../src/service-debug/anti-service/mute-user.js");
const { handleAutoJoin } = await import("../../src/service-debug/anti-service/auto-join.js");
const { antiBotCheck } = await import("../../src/service-debug/anti-service/anti-bot.js");
const {
  antiSpam,
  analyzeSpamBehavior,
  SPAM_PATTERNS,
} = await import("../../src/service-debug/anti-service/anti-spam.js");
const { writeGroupSettings, readGroupSettings, invalidateAdminCaches } = await import(
  "../../src/utils/io-json.js"
);

test.after(async () => {
  stopMuteCheck();
  resetMockQrScannerForTest();
  resetMockClassifierForTest();
  await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

function configureMockZaloAppContext() {
  appContext.uid = "bot-uid-999";
  appContext.imei = "imei-test-12345";
  appContext.cookie = "zpw_sek=super_secret_zalo_cookie";
  appContext.userAgent = "Mozilla/5.0 TestAgent";
  appContext.secretKey = TEST_SECRET_KEY;
  appContext.language = "vi";
}

function sendEncryptedZaloJson(res, dataPayload) {
  const encrypted = encodeAES(
    TEST_SECRET_KEY,
    JSON.stringify({ error_code: 0, data: dataPayload })
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error_code: 0, data: encrypted }));
}

async function startLocalServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("1. Undo model resolves group threadId to data.idTo and preserves DM semantics", () => {
  configureMockZaloAppContext();

  const groupUndo = new Undo(
    { uidFrom: "member-42", idTo: "group-888", content: { cliMsgId: "1" } },
    true
  );
  assert.equal(groupUndo.threadId, "group-888");
  assert.equal(groupUndo.isGroup, true);
  assert.equal(groupUndo.isSelf, false);

  const dmPeerUndo = new Undo(
    { uidFrom: "peer-77", idTo: "0", content: { cliMsgId: "2" } },
    false
  );
  assert.equal(dmPeerUndo.threadId, "peer-77");
  assert.equal(dmPeerUndo.data.idTo, "bot-uid-999");
  assert.equal(dmPeerUndo.isSelf, false);

  const dmSelfUndo = new Undo(
    { uidFrom: "0", idTo: "peer-77", content: { cliMsgId: "3" } },
    false
  );
  assert.equal(dmSelfUndo.threadId, "peer-77");
  assert.equal(dmSelfUndo.data.uidFrom, "bot-uid-999");
  assert.equal(dmSelfUndo.isSelf, true);
});

test("2 & 3. uploadThumbnail builds valid /api/message/upthumb URL and sendGif uses Windows-safe temp filenames", async (t) => {
  configureMockZaloAppContext();
  const capturedRequests = [];

  const server = await startLocalServer((req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    capturedRequests.push({
      method: req.method,
      pathname: parsedUrl.pathname,
      searchParams: Object.fromEntries(parsedUrl.searchParams.entries()),
    });

    if (parsedUrl.pathname === "/cdn/funny.gif") {
      res.writeHead(200, { "Content-Type": "image/gif" });
      res.end(TINY_GIF_BUFFER);
      return;
    }

    if (parsedUrl.pathname === "/api/message/upthumb") {
      sendEncryptedZaloJson(res, { url: "https://cdn.example.com/thumb.png" });
      return;
    }

    if (parsedUrl.pathname === "/api/group/gif") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const decrypted = JSON.parse(decodeAES(TEST_SECRET_KEY, form.get("params")));
        sendEncryptedZaloJson(res, { msgId: "gif-msg-1", echoed: decrypted });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  t.after(() => server.close());

  const api = {
    zpwServiceMap: { file: [server.baseUrl] },
  };
  api.uploadThumbnail = uploadThumbnailFactory(api);
  const sendGif = sendGifFactory(api);

  // Signed URL with query params & characters illegal in Windows NTFS filenames
  const signedGifUrl = `${server.baseUrl}/cdn/funny.gif?token=abc:123&expires=999*777`;
  const result = await sendGif(
    signedGifUrl,
    { threadId: "group-100", type: MessageType.GroupMessage },
    "hello gif"
  );

  const upthumbReq = capturedRequests.find((r) => r.pathname.includes("upthumb"));
  assert.ok(upthumbReq, "uploadThumbnail endpoint must be called");
  assert.equal(upthumbReq.pathname, "/api/message/upthumb");
  assert.equal(upthumbReq.searchParams.nretry, "0");
  assert.ok(upthumbReq.searchParams.params, "encrypted params query parameter must exist");

  const decryptedThumbParams = JSON.parse(
    decodeAES(TEST_SECRET_KEY, upthumbReq.searchParams.params)
  );
  assert.equal(decryptedThumbParams.imei, "imei-test-12345");

  assert.equal(result.msgId, "gif-msg-1");
  assert.equal(result.echoed.thumb, "https://cdn.example.com/thumb.png");
  assert.equal(result.echoed.width, 1);
  assert.equal(result.echoed.height, 1);
});

test("4. sendMessageForward accepts DirectMessage (0), serializes imei, and guards non-media/null parseLink", async (t) => {
  configureMockZaloAppContext();
  const forwardedPayloads = [];

  const server = await startLocalServer((req, res) => {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const decrypted = JSON.parse(decodeAES(TEST_SECRET_KEY, form.get("params")));
      forwardedPayloads.push({ pathname: parsedUrl.pathname, decrypted });
      sendEncryptedZaloJson(res, { ok: true, count: forwardedPayloads.length });
    });
  });
  t.after(() => server.close());

  let parseLinkResponse = {
    data: {
      href: "https://news.example.com/article-1",
      title: "Article Title",
      desc: "Article Desc",
      thumb: "https://news.example.com/t.jpg",
      // Intentionally omit `media` to verify non-media links do not throw
    },
  };

  const api = {
    zpwServiceMap: { file: [server.baseUrl] },
    parseLink: async () => parseLinkResponse,
  };
  const sendMessageForward = sendMessageForwardFactory(api);

  // Case A: DirectMessage (type === 0) with non-media link
  const dmRes = await sendMessageForward(
    { link: "https://news.example.com/article-1", msg: "check this" },
    "user-555",
    MessageType.DirectMessage
  );
  assert.equal(dmRes.ok, true);
  assert.equal(forwardedPayloads[0].pathname, "/api/message/mforward");
  assert.equal(forwardedPayloads[0].decrypted.imei, "imei-test-12345");
  assert.equal(forwardedPayloads[0].decrypted.toIds[0].toUid, "user-555");
  assert.equal(forwardedPayloads[0].decrypted.toIds[0].imei, "imei-test-12345");
  const dmMsgInfo = JSON.parse(forwardedPayloads[0].decrypted.msgInfo);
  const dmExtData = JSON.parse(dmMsgInfo.extData);
  assert.equal(dmExtData.src, "news.example.com");
  assert.equal(dmExtData.mediaTitle, "");

  // Case B: GroupMessage when parseLink returns null and link is non-URL text
  parseLinkResponse = null;
  const grpRes = await sendMessageForward(
    { link: "not-a-valid-url-scheme", msg: "fallback link" },
    "group-777",
    MessageType.GroupMessage
  );
  assert.equal(grpRes.ok, true);
  const grpMsgInfo = JSON.parse(forwardedPayloads[1].decrypted.msgInfo);
  assert.equal(grpMsgInfo.link, "not-a-valid-url-scheme");
  assert.equal(JSON.parse(grpMsgInfo.extData).src, "");

  // Missing type (null/undefined) still throws
  await assert.rejects(
    () => sendMessageForward({ msg: "hi" }, "user-555", undefined),
    /Missing type/
  );
});

test("5. sendVoice probes external voiceUrl with cookie-free HEAD and falls back cleanly on HEAD error", async (t) => {
  configureMockZaloAppContext();
  let externalHeadHeaders = null;
  let headMode = "ok";
  const zaloVoicePayloads = [];

  const externalServer = await startLocalServer((req, res) => {
    externalHeadHeaders = req.headers;
    if (headMode === "ok") {
      res.writeHead(200, {
        "Content-Length": "48123",
        "Set-Cookie": "evil_cookie=hijacked; Path=/",
      });
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  t.after(() => externalServer.close());

  const zaloServer = await startLocalServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const decrypted = JSON.parse(decodeAES(TEST_SECRET_KEY, form.get("params")));
      zaloVoicePayloads.push({
        cookieHeader: req.headers.cookie,
        decrypted,
      });
      sendEncryptedZaloJson(res, { sent: true });
    });
  });
  t.after(() => zaloServer.close());

  const sendVoice = sendVoiceFactory({
    zpwServiceMap: { file: [zaloServer.baseUrl] },
  });

  await sendVoice(
    { threadId: "user-123", type: MessageType.DirectMessage },
    `${externalServer.baseUrl}/audio/sample.m4a`
  );

  // External host MUST NOT receive Zalo session cookies, and its Set-Cookie MUST NOT mutate appContext.cookie
  assert.equal(externalHeadHeaders.cookie, undefined);
  assert.equal(appContext.cookie, "zpw_sek=super_secret_zalo_cookie");
  assert.equal(zaloVoicePayloads[0].cookieHeader, "zpw_sek=super_secret_zalo_cookie");
  assert.equal(JSON.parse(zaloVoicePayloads[0].decrypted.msgInfo).fileSize, 48123);

  // Fallback when HEAD returns 405 / unreachable
  headMode = "405";
  await sendVoice(
    { threadId: "group-123", type: MessageType.GroupMessage },
    `${externalServer.baseUrl}/audio/no-head.m4a`
  );
  assert.equal(JSON.parse(zaloVoicePayloads[1].decrypted.msgInfo).fileSize, 0);
});

test("6. anti-nude cleans up userViolationLocks and preserves busy sibling workers on retry", async () => {
  resetMockClassifierForTest();
  assert.equal(getUserViolationLockCountForTest(), 0);

  const executionOrder = [];
  await Promise.all([
    withUserViolationLock("user-lock-1", async () => {
      executionOrder.push("start-1");
      await new Promise((r) => setTimeout(r, 25));
      executionOrder.push("end-1");
    }),
    withUserViolationLock("user-lock-1", async () => {
      executionOrder.push("start-2");
      executionOrder.push("end-2");
    }),
    withUserViolationLock("user-lock-2", async () => {
      executionOrder.push("other-user");
    }),
  ]);

  assert.deepEqual(
    executionOrder.filter((x) => x !== "other-user"),
    ["start-1", "end-1", "start-2", "end-2"]
  );
  assert.equal(getUserViolationLockCountForTest(), 0);

  await assert.rejects(
    () =>
      withUserViolationLock("user-lock-err", async () => {
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(getUserViolationLockCountForTest(), 0);

  // Worker pool retry: busy sibling worker must NOT be killed via recycleAll()
  let attempts = 0;
  let pruneIdleCalls = 0;
  let recycleAllCalls = 0;
  const fakePool = {
    stats: () => ({ total: 2, busy: 1 }),
    pruneIdle: async () => {
      pruneIdleCalls += 1;
    },
    recycleAll: async () => {
      recycleAllCalls += 1;
    },
    runTask: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient worker timeout");
      }
      return { nsfwScore: 12.5 };
    },
  };

  const score = await classifyLocalImageFile("fake-image.jpg", { workerPool: fakePool });
  assert.equal(score, 12.5);
  assert.equal(pruneIdleCalls, 1);
  assert.equal(recycleAllCalls, 0);
});

test("7. anti-link & anti-phone-number enforce .every() whitelist and ignore non-link bank VietQR images", async () => {
  const threadId = "group-anti-link-1";
  const groupSettings = {
    [threadId]: {
      removeLinks: true,
      antiPhoneNumber: true,
      whiteList: {},
    },
  };

  let deletedCount = 0;
  let blockedUsersCalls = 0;
  const sentMessages = [];
  const api = {
    deleteMessage: async () => {
      deletedCount += 1;
      return { status: 0 };
    },
    sendMessage: async (payload) => {
      sentMessages.push(payload);
      return { message: { msgId: String(sentMessages.length) } };
    },
    blockUsers: async () => {
      blockedUsersCalls += 1;
    },
  };

  // Whitelist tiktok.com for links and 0901234567 for phones
  await handleAntiLinkCommand(
    api,
    {
      threadId,
      data: { content: "!antilink add tiktok.com", mentions: [], uidFrom: "admin", dName: "Admin" },
    },
    groupSettings
  );
  await handleAntiPhoneNumberCommand(
    api,
    {
      threadId,
      data: { content: "!antiphone add 0901234567", mentions: [], uidFrom: "admin", dName: "Admin" },
    },
    groupSettings
  );

  deletedCount = 0;
  blockedUsersCalls = 0;
  sentMessages.length = 0;

  // Whitelisted link alone -> allowed
  const allowedLink = await antiLink(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-1",
        dName: "Member 1",
        msgType: "webchat",
        content: "Xem video https://tiktok.com/@channel/video/1",
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(allowedLink, false);
  assert.equal(deletedCount, 0);

  // Whitelisted link + non-whitelisted link -> MUST be blocked/deleted (.every())
  const mixedLink = await antiLink(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-1",
        dName: "Member 1",
        msgType: "webchat",
        content: "https://tiktok.com/@ok và link lừa đảo https://phishing-bad.xyz/login",
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(mixedLink, true);
  assert.equal(deletedCount, 1);
  assert.equal(blockedUsersCalls, 0);

  // Bank transfer VietQR (parsed bank_transfer object without .content & EMVCo numeric payload) -> allowed!
  setMockQrScannerForTest(async () => ({
    success: true,
    data: { type: "bank_transfer", bankName: "Vietcombank", accountNumber: "0123456789" },
  }));
  const bankQrTransfer = await antiLink(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-2",
        dName: "Member 2",
        msgType: "chat.photo",
        content: { href: "https://cdn.example.com/vietqr-bank.png" },
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(bankQrTransfer, false);
  assert.equal(blockedUsersCalls, 0);

  setMockQrScannerForTest(async () => ({
    success: true,
    data: {
      type: "text",
      content: "00020101021138570010A00000072701270006970436011301234567890208QRIBFTTA53037045802VN6304ABCD",
    },
  }));
  const emvVietQr = await antiLink(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-2",
        dName: "Member 2",
        msgType: "chat.photo",
        content: { href: "https://cdn.example.com/emv-vietqr.png" },
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(emvVietQr, false);
  assert.equal(blockedUsersCalls, 0);

  // QR image containing non-whitelisted link -> deletes message & warns (NO instant 1st-offense kick!)
  setMockQrScannerForTest(async () => ({
    success: true,
    data: { type: "url", content: "https://evil-group.xyz/invite" },
  }));
  const spamQr = await antiLink(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-2",
        dName: "Member 2",
        msgType: "chat.photo",
        content: { href: "https://cdn.example.com/spam-qr.png" },
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  resetMockQrScannerForTest();
  assert.equal(spamQr, true);
  assert.equal(blockedUsersCalls, 0, "1st QR link offense must warn via updateLinkCount, not instant block");

  // Phone number whitelist: whitelisted alone -> allowed; mixed with non-whitelisted -> deleted (.every())
  const prevDeletes = deletedCount;
  const allowedPhone = await antiPhoneNumber(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-3",
        dName: "Member 3",
        content: "Liên hệ hotline CSKH 0901234567 nhé",
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(allowedPhone, false);
  assert.equal(deletedCount, prevDeletes);

  const mixedPhone = await antiPhoneNumber(
    api,
    {
      threadId,
      data: {
        uidFrom: "member-3",
        dName: "Member 3",
        content: "Gọi 0901234567 hoặc số phụ 0987654321",
      },
    },
    false,
    groupSettings,
    true,
    false
  );
  assert.equal(mixedPhone, true);
  assert.equal(deletedCount, prevDeletes + 1);
});

test("8. mute-user refuses to mute admins and startMuteCheck omits invalid -1 mention & catches errors", async () => {
  const threadId = "group-mute-1";
  const groupSettings = {
    [threadId]: {
      nameGroup: "Mute Test Group",
      muteList: {},
      adminList: {},
    },
  };
  writeGroupSettings(groupSettings);
  invalidateAdminCaches();

  const sentMessages = [];
  const api = {
    sendMessage: async (payload, targetThreadId) => {
      sentMessages.push({ payload, targetThreadId });
      return { message: { msgId: "m-1" } };
    },
  };

  const changed = await handleMuteUser(
    api,
    {
      threadId,
      type: MessageType.GroupMessage,
      data: {
        uidFrom: "high-admin-1",
        dName: "Owner",
        msgId: "cmd-msg-1",
        content: "!mute 10m @AdminTarget",
        mentions: [{ uid: "native-group-admin", pos: 10, len: 12 }],
      },
    },
    groupSettings,
    ["native-group-admin"]
  );

  assert.equal(changed, false);
  assert.equal(groupSettings[threadId].muteList["native-group-admin"], undefined);
  assert.equal(global.mutes?.[threadId]?.["native-group-admin"], undefined);
  assert.ok(
    sentMessages.some((m) => String(m.payload?.msg || "").includes("Không thể cấm chat")),
    "Should send warning explaining admin cannot be muted"
  );

  // Test startMuteCheck with expired "-1" (mute all) and regular user, plus error resilience
  const expiredSettings = {
    [threadId]: {
      nameGroup: "Mute Test Group",
      muteList: {
        "-1": { name: "All Users", timeMute: 1 },
        "user-88": { name: "User 88", timeMute: 1 },
      },
    },
  };
  writeGroupSettings(expiredSettings);

  const unmuteNotifications = [];
  let shouldThrowOnce = true;
  const timer = await startMuteCheck(
    {
      sendMessage: async (payload, targetThreadId) => {
        unmuteNotifications.push({ payload, targetThreadId });
        if (shouldThrowOnce) {
          shouldThrowOnce = false;
          throw new Error("transient send failure");
        }
      },
    },
    25
  );

  assert.equal(typeof timer.hasRef, "function");
  assert.equal(timer.hasRef(), false, "muteCheckInterval must be unref'd");

  await new Promise((r) => setTimeout(r, 90));
  stopMuteCheck();

  const allUnmuteMsg = unmuteNotifications.find((n) =>
    n.payload.msg.startsWith("Tất cả thành viên")
  );
  const userUnmuteMsg = unmuteNotifications.find((n) =>
    n.payload.msg.startsWith("User 88")
  );
  assert.ok(allUnmuteMsg, "Should notify group when mute-all expires");
  assert.deepEqual(allUnmuteMsg.payload.mentions, []);
  assert.ok(userUnmuteMsg, "Should continue processing remaining expired mutes after send error");
  assert.equal(userUnmuteMsg.payload.mentions.length, 1);
  assert.equal(userUnmuteMsg.payload.mentions[0].uid, "user-88");

  const persistedAfterCheck = readGroupSettings();
  assert.deepEqual(persistedAfterCheck[threadId].muteList, {});
});

test("9. auto-join blocks non-admin strangers and allows configured bot/high admins", async () => {
  const threadId = "group-autojoin-1";
  const groupSettings = {
    [threadId]: {
      autoJoin: true,
      whiteList: {},
      adminList: {},
    },
  };
  writeGroupSettings(groupSettings);
  invalidateAdminCaches();

  const joinedLinks = [];
  const api = {
    joinGroup: async (url) => {
      joinedLinks.push(url);
    },
    sendMessage: async () => ({ message: { msgId: "1" } }),
  };

  // Stranger attempts to force bot into external group
  const strangerHandled = await handleAutoJoin(
    api,
    {
      threadId,
      type: MessageType.GroupMessage,
      data: {
        uidFrom: "random-stranger-999",
        dName: "Stranger",
        msgType: "webchat",
        content: "Tham gia nhóm này đi https://zalo.me/g/maliciousgroup1",
      },
    },
    groupSettings,
    true,
    false
  );
  assert.equal(strangerHandled, false);
  assert.deepEqual(joinedLinks, []);

  // Bot admin sends valid invite link -> allowed
  const adminHandled = await handleAutoJoin(
    api,
    {
      threadId,
      type: MessageType.GroupMessage,
      data: {
        uidFrom: "bot-admin-1",
        dName: "Bot Admin",
        msgType: "webchat",
        content: "Vào nhóm hỗ trợ https://zalo.me/g/trustedgroup2",
      },
    },
    groupSettings,
    true,
    false
  );
  assert.equal(adminHandled, true);
  assert.deepEqual(joinedLinks, ["https://zalo.me/g/trustedgroup2"]);
});

test("10a. anti-bot ignores standard Zalo human disappearing message TTL presets while catching short bot TTLs", async () => {
  const threadId = "group-antibot-1";
  const groupSettings = {
    [threadId]: {
      enableAntiBot: true,
      whiteList: {},
    },
  };

  const blocked = [];
  const api = {
    appContext: { uid: "bot-uid-999" },
    getGroupInfo: async () => ({
      gridInfoMap: {
        [threadId]: { creatorId: "owner-1", adminIds: [] },
      },
    }),
    sendMessage: async () => undefined,
    blockUsers: async (_tid, uids) => {
      blocked.push(...uids);
    },
  };

  // Standard Zalo disappearing message presets: 1 day, 7 days, 30 days
  for (const humanTtl of [86_400_000, 604_800_000, 2_592_000_000]) {
    const res = await antiBotCheck(
      api,
      {
        threadId,
        type: MessageType.GroupMessage,
        data: {
          uidFrom: "normal-human-1",
          dName: "Normal Human",
          msgType: "webchat",
          content: "tin nhắn tự xóa 1 ngày",
          ttl: humanTtl,
        },
      },
      groupSettings,
      false,
      false
    );
    assert.equal(res, false, `Human disappearing TTL ${humanTtl} must not trigger anti-bot`);
  }
  assert.deepEqual(blocked, []);

  // Short-TTL third-party bot message (5000ms) -> blocked
  const botRes = await antiBotCheck(
    api,
    {
      threadId,
      type: MessageType.GroupMessage,
      data: {
        uidFrom: "rogue-bot-7",
        dName: "Rogue Bot",
        msgType: "webchat",
        content: "auto reply",
        ttl: 5000,
      },
    },
    groupSettings,
    false,
    false
  );
  assert.equal(botRes, true);
  assert.deepEqual(blocked, ["rogue-bot-7"]);
});

test("10b. anti-spam reaches REPEATED_CONTENT across >3s intervals and removes dead LRU caches", async () => {
  const antiSpamSource = await fs.readFile(
    path.join(repoRoot, "src/service-debug/anti-service/anti-spam.js"),
    "utf8"
  );
  assert.doesNotMatch(antiSpamSource, /\buserMessageCounts\b/);
  assert.doesNotMatch(antiSpamSource, /\bconst userMessage\s*=/);

  const baseTs = Date.now();
  const spacedRepeated = Array.from({ length: 5 }, (_, idx) => ({
    time: baseTs + idx * 4500, // 4.5s apart -> never triggers 3-in-3s RAPID_MESSAGES
    content: "Mua xu giá rẻ inbox ngay!",
    length: 25,
  }));
  const analysis = analyzeSpamBehavior(spacedRepeated);
  assert.deepEqual(analysis, {
    isSpam: true,
    type: SPAM_PATTERNS.REPEATED_CONTENT,
  });

  // End-to-end through antiSpam()
  const threadId = "group-antispam-repeat";
  const groupSettings = {
    [threadId]: { antiSpam: true, whiteList: {} },
  };
  let deletes = 0;
  const warnings = [];
  const api = {
    deleteMessage: async () => {
      deletes += 1;
    },
    sendMessage: async (payload) => {
      warnings.push(payload);
    },
    blockUsers: async () => {},
  };

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(
      await antiSpam(
        api,
        {
          threadId,
          type: MessageType.GroupMessage,
          data: {
            uidFrom: "repeater-1",
            dName: "Repeater",
            content: "Spam lập lại cùng một nội dung",
            ts: baseTs + i * 4500,
          },
        },
        false,
        groupSettings,
        true,
        false
      )
    );
  }
  assert.deepEqual(results, [false, false, false, false, true]);
  assert.equal(deletes, 1);
  assert.equal(warnings.length, 1);
});

test("11. event-send-msg removes hardcoded group/author promo and gates checkAndSendBusinessCard on main + BOT_PROMO_TEXT", async () => {
  const eventSendMsgSource = await fs.readFile(
    path.join(repoRoot, "src/automations/event-send-msg.js"),
    "utf8"
  );
  assert.doesNotMatch(eventSendMsgSource, /6456980305260228374/);
  assert.doesNotMatch(eventSendMsgSource, /testFutureGroup/);
  assert.doesNotMatch(eventSendMsgSource, /ndq-test\.js/);
  assert.doesNotMatch(eventSendMsgSource, /𝐇𝐚̀ 𝐇𝐮𝐲 𝐇𝐨𝐚̀𝐧𝐠|Hà Huy Hoàng/);
  assert.doesNotMatch(eventSendMsgSource, /zalo\.me\/g\/aoosnn075/);

  const eventModuleUrl = pathToFileURL(
    path.join(repoRoot, "src/automations/event-send-msg.js")
  ).href;
  const runtimeInstanceUrl = pathToFileURL(
    path.join(repoRoot, "src/core/runtime-instance.js")
  ).href;

  const subSandbox = await fs.mkdtemp(path.join(os.tmpdir(), "cluster3-promo-sub-"));
  await fs.mkdir(path.join(subSandbox, "assets", "data"), { recursive: true });
  await fs.mkdir(path.join(subSandbox, "mybot", "bots"), { recursive: true });
  await fs.writeFile(
    path.join(subSandbox, "assets", "config.json"),
    JSON.stringify({ uid: "main-bot-uid", name: "admin" }),
    "utf8"
  );
  const adminCfgPath = path.join(subSandbox, "mybot", "bots", "admin.json");
  await fs.writeFile(
    adminCfgPath,
    JSON.stringify({ uid: "main-bot-uid", name: "admin" }),
    "utf8"
  );
  await fs.writeFile(
    path.join(subSandbox, "assets", "data", "list_admin_high.json"),
    JSON.stringify(["owner-admin-1"], null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(subSandbox, "assets", "data", "list_admin.json"),
    JSON.stringify(["sub-admin-2"], null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(subSandbox, "assets", "data", "group_settings.json"),
    JSON.stringify({}, null, 2),
    "utf8"
  );

  const script = `
    const { RuntimeInstanceDescriptor, setRuntimeInstanceDescriptor } = await import(${JSON.stringify(runtimeInstanceUrl)});
    const { checkAndSendBusinessCard } = await import(${JSON.stringify(eventModuleUrl)});

    const sentMessages = [];
    const sentCards = [];
    const api = {
      sendMessage: async (payload, threadId, type) => {
        sentMessages.push({ payload, threadId, type });
      },
      sendBusinessCard: async (_a, adminId, _b, type, recipientId) => {
        sentCards.push({ adminId, type, recipientId });
      }
    };

    // 1) Default (BOT_PROMO_TEXT unset) on main -> disabled
    delete process.env.BOT_PROMO_TEXT;
    setRuntimeInstanceDescriptor(new RuntimeInstanceDescriptor({
      kind: "main",
      botKey: "admin",
      configuredUid: "main-bot-uid",
      liveZaloUid: "main-bot-uid",
      projectRoot: process.env.PROJECT_ROOT,
    }));
    const defaultResult = await checkAndSendBusinessCard(api, "visitor-1", "Visitor 1");

    // 2) Child Mini Bot WITH BOT_PROMO_TEXT set -> STILL disabled
    process.env.BOT_PROMO_TEXT = "  Chào mừng bạn đến với hệ thống Bot chính!  ";
    setRuntimeInstanceDescriptor(new RuntimeInstanceDescriptor({
      kind: "child",
      botKey: "child-100",
      configuredUid: "child-100",
      liveZaloUid: "child-100",
      projectRoot: process.env.PROJECT_ROOT,
    }));
    const childResult = await checkAndSendBusinessCard(api, "visitor-2", "Visitor 2");

    // 3) Main Bot WITH BOT_PROMO_TEXT set -> sends exact trimmed BOT_PROMO_TEXT
    setRuntimeInstanceDescriptor(new RuntimeInstanceDescriptor({
      kind: "main",
      botKey: "admin",
      configuredUid: "main-bot-uid",
      liveZaloUid: "main-bot-uid",
      projectRoot: process.env.PROJECT_ROOT,
    }));
    const mainResult = await checkAndSendBusinessCard(api, "visitor-3", "Visitor 3");
    const cooldownResult = await checkAndSendBusinessCard(api, "visitor-3", "Visitor 3");

    process.stdout.write("__PROMO_RESULT__" + JSON.stringify({
      defaultResult,
      childResult,
      mainResult,
      cooldownResult,
      sentMessages,
      sentCards,
    }) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: subSandbox,
        env: {
          ...process.env,
          SKIP_ENV_VALIDATION: "1",
          NODE_ENV: "test",
          PROJECT_ROOT: subSandbox,
          CONFIG_PATH: adminCfgPath,
          BOT_ID: "admin",
        },
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      }
    );

    const match = stdout.match(/__PROMO_RESULT__(.*?)__END__/s);
    assert.ok(match, `Expected subprocess result marker, got: ${stdout}`);
    const parsed = JSON.parse(match[1]);

    assert.equal(parsed.defaultResult, false);
    assert.equal(parsed.childResult, false);
    assert.equal(parsed.mainResult, true);
    assert.equal(parsed.cooldownResult, false);
    assert.equal(parsed.sentMessages.length, 1);
    assert.equal(parsed.sentMessages[0].threadId, "visitor-3");
    assert.equal(
      parsed.sentMessages[0].payload.msg,
      "Chào mừng bạn đến với hệ thống Bot chính!"
    );
  } finally {
    await fs.rm(subSandbox, { recursive: true, force: true }).catch(() => {});
  }
});
