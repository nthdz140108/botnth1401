import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { Agent, setGlobalDispatcher } from "undici";

try {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 10 }));
} catch {}
import { registerInternalCommandRoutes } from "../src/web-service/internal-command-route.js";
import {
  relayCommandToChild,
  getInternalSecret,
  generateInternalSignature,
  verifyInternalSignature,
} from "../src/commands/mybot/System/mybot-command-relay.js";
import { parseAdminCommand } from "../src/utils/admin-command-parser.js";

async function createTestChildServer({ failGroupSend = false } = {}) {
  const app = express();
  app.use(express.json());
  const sentMessages = [];
  const mockChildApi = {
    sentMessages,
    getBotId: () => "child-bot-1",
    getGroupInfo: async (threadId) => {
      if (failGroupSend) {
        const err = new Error("HTTP 404: Group not found");
        err.status = 404;
        throw err;
      }
      return { id: threadId, name: "Test Group", adminIds: ["child-bot-1"] };
    },
    sendMessage: async (payload, threadId, type) => {
      if (failGroupSend && type === 1) {
        throw new Error("Thao tác không hợp lệ! (code: 114, bot not in group)");
      }
      sentMessages.push({ payload, threadId, type });
      return { status: 0 };
    },
  };

  registerInternalCommandRoutes(app, { api: mockChildApi });

  const server = createServer(app);
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = server.address().port;

  return {
    server,
    port,
    mockChildApi,
    sentMessages,
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close(() => resolve());
    }),
  };
}

test("generateInternalSignature and verifyInternalSignature correctly validate signatures", () => {
  const secret = "test-secret-12345";
  const params = {
    requestId: "req-1",
    actorUid: "user-100",
    actorGlobalUid: "global-user-100",
    sourceBotUid: "main-bot-1",
    targetBotUid: "child-bot-2",
    threadId: "thread-10",
    threadType: 1,
    commandText: "detail",
    mentions: [],
    timestamp: Date.now(),
    secret,
  };

  const sig = generateInternalSignature(params);
  assert.ok(typeof sig === "string" && sig.length === 64);

  const isValid = verifyInternalSignature({ ...params, signature: sig });
  assert.equal(isValid, true);

  const isInvalid = verifyInternalSignature({ ...params, signature: "invalid_sig_hex_string" });
  assert.equal(isInvalid, false);

  const isTampered = verifyInternalSignature({ ...params, actorUid: "hacker", signature: sig });
  assert.equal(isTampered, true); // Since actorGlobalUid is set in canonical, actorUid doesn't break canonical
});

test("envelope signature: tampering commandText, threadId, mentions, or targetBotUid causes signature rejection", () => {
  const secret = "test-secret-12345";
  const params = {
    requestId: "req-tamper-1",
    actorGlobalUid: "global-uuid-111",
    sourceBotUid: "main-bot-1",
    targetBotUid: "child-bot-2",
    threadId: "thread-orig",
    threadType: 1,
    commandText: "!info @target",
    mentions: [{ uid: "local-target", globalUid: "global-target" }],
    timestamp: Date.now(),
    secret,
  };

  const sig = generateInternalSignature(params);

  // Valid
  assert.equal(verifyInternalSignature({ ...params, signature: sig }), true);

  // Tamper commandText
  assert.equal(verifyInternalSignature({ ...params, commandText: "!admin delete bot", signature: sig }), false);

  // Tamper threadId
  assert.equal(verifyInternalSignature({ ...params, threadId: "thread-other", signature: sig }), false);

  // Tamper targetBotUid
  assert.equal(verifyInternalSignature({ ...params, targetBotUid: "child-bot-3", signature: sig }), false);

  // Tamper mentions
  assert.equal(verifyInternalSignature({ ...params, mentions: [], signature: sig }), false);

  // Tamper timestamp
  assert.equal(verifyInternalSignature({ ...params, timestamp: params.timestamp + 1000, signature: sig }), false);
});

test("envelope signature: enforce mode strictly rejects legacy signature format", () => {
  const secret = "test-secret-12345";
  const timestamp = Date.now();
  const requestId = "req-legacy-test";

  // Generate legacy signature (only signing requestId, actorKey, sourceBotUid, targetBotUid, timestamp)
  const legacyActorKey = "global-user-999";
  const legacyPayload = `${requestId}:${legacyActorKey}:main-bot:child-bot:${timestamp}`;
  import("crypto").then((crypto) => {
    const legacySig = crypto.createHmac("sha256", secret).update(legacyPayload).digest("hex");

    // In off / shadow mode: legacy signature is accepted for backward compatibility
    const acceptedInOff = verifyInternalSignature({
      requestId,
      actorGlobalUid: legacyActorKey,
      sourceBotUid: "main-bot",
      targetBotUid: "child-bot",
      threadId: "thread-1",
      threadType: 1,
      commandText: "!help",
      mentions: [],
      timestamp,
      signature: legacySig,
      secret,
      mode: "off",
    });
    assert.equal(acceptedInOff, true);

    // In enforce mode: legacy signature MUST BE REJECTED
    const rejectedInEnforce = verifyInternalSignature({
      requestId,
      actorGlobalUid: legacyActorKey,
      sourceBotUid: "main-bot",
      targetBotUid: "child-bot",
      threadId: "thread-1",
      threadType: 1,
      commandText: "!help",
      mentions: [],
      timestamp,
      signature: legacySig,
      secret,
      mode: "enforce",
    });
    assert.equal(rejectedInEnforce, false);
  });
});

test("relayCommandToChild communicates with child server and executes command", async () => {
  const childServer = await createTestChildServer();
  try {
    const targetBot = { uid: "child-bot-1", webPort: childServer.port };
    const result = await relayCommandToChild({
      targetBot,
      actorUid: "user-123",
      sourceBotUid: "main-admin-bot",
      threadId: "user-123",
      threadType: 0,
      commandText: "detail",
      mentions: [],
    });

    assert.equal(result.success, true);
    assert.ok(result.requestId);
    assert.equal(result.data.status, "completed");
    assert.equal(typeof result.data.delivered, "boolean");
    assert.equal(result.data.inGroup, false);
  } finally {
    await childServer.close();
  }
});

test("child server captures outputs and reports delivered=false when not in group", async () => {
  const childServer = await createTestChildServer({ failGroupSend: true });
  try {
    const targetBot = { uid: "child-bot-1", webPort: childServer.port };
    const result = await relayCommandToChild({
      targetBot,
      actorUid: "user-123",
      sourceBotUid: "main-admin-bot",
      threadId: "thread-456",
      threadType: 1,
      commandText: "detail",
      mentions: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.data.status, "completed");
    assert.equal(result.data.delivered, false);
    assert.equal(result.data.inGroup, false);
    assert.ok(Array.isArray(result.data.outputs));
  } finally {
    await childServer.close();
  }
});

test("parseAdminCommand resolves @mention tag to bot admin UID only when explicitly tagging @bot", () => {
  const adminBotUid = "111222333444";
  const syntheticMessage = {
    threadId: "thread-1",
    type: 1,
    data: {
      content: "!admin add qtv @bot",
      isRelayed: true,
      relayedFrom: adminBotUid,
      mentions: [],
    },
  };

  const parsed = parseAdminCommand("!admin add qtv @bot", "!", syntheticMessage, "group");
  assert.equal(parsed.action, "add");
  assert.equal(parsed.targetTier, "high");
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0].uid, adminBotUid);
});

test("parseAdminCommand preserves actual user UID when mentions are provided in relayed command", () => {
  const adminBotUid = "111222333444";
  const targetUserUid = "999888777666";
  const syntheticMessage = {
    threadId: "thread-1",
    type: 1,
    data: {
      content: "!admin add qtv @NguyenVanA",
      isRelayed: true,
      relayedFrom: adminBotUid,
      mentions: [{ uid: targetUserUid, pos: 15, len: 11 }],
    },
  };

  const parsed = parseAdminCommand("!admin add qtv @NguyenVanA", "!", syntheticMessage, "group");
  assert.equal(parsed.action, "add");
  assert.equal(parsed.targetTier, "high");
  assert.equal(parsed.targets.length, 1);
  assert.equal(parsed.targets[0].uid, targetUserUid);
  assert.notEqual(parsed.targets[0].uid, adminBotUid);
});

test("child server rejects requests with expired timestamps or invalid signatures", async () => {
  const childServer = await createTestChildServer();
  try {
    // 1. Expired timestamp
    const expiredRes = await fetch(`http://127.0.0.1:${childServer.port}/internal/command/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-exp",
        actorUid: "user-123",
        sourceBotUid: "main-bot",
        targetBotUid: "child-bot",
        threadId: "thread-1",
        commandText: "help",
        timestamp: Date.now() - 120000, // 2 minutes ago
      }),
    });
    assert.equal(expiredRes.status, 401);

    // 2. Invalid signature
    const badSigRes = await fetch(`http://127.0.0.1:${childServer.port}/internal/command/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Signature": "invalid-signature",
        "X-Internal-Timestamp": String(Date.now()),
        "X-Internal-Request-Id": "req-badsig",
      },
      body: JSON.stringify({
        requestId: "req-badsig",
        actorUid: "user-123",
        sourceBotUid: "main-bot",
        targetBotUid: "child-bot",
        threadId: "thread-1",
        commandText: "help",
        timestamp: Date.now(),
      }),
    });
    assert.equal(badSigRes.status, 403);
  } finally {
    await childServer.close();
  }
});

test("child server enforces idempotency on duplicate requestId", async () => {
  const childServer = await createTestChildServer();
  try {
    const targetBot = { uid: "child-bot-1", webPort: childServer.port };
    const requestId = "idempotent-req-test-1";

    const res1 = await relayCommandToChild({
      targetBot,
      actorUid: "user-123",
      sourceBotUid: "main-admin-bot",
      threadId: "thread-456",
      commandText: "detail",
      requestId,
    });
    assert.equal(res1.success, true);
    assert.equal(res1.data.status, "completed");

    const res2 = await relayCommandToChild({
      targetBot,
      actorUid: "user-123",
      sourceBotUid: "main-admin-bot",
      threadId: "thread-456",
      commandText: "detail",
      requestId,
    });
    assert.equal(res2.success, true);
    assert.equal(res2.data.duplicate, true);
  } finally {
    await childServer.close();
  }
});

test("relayCommandToChild handles unreachable child bot gracefully", async () => {
  const targetBot = { uid: "child-offline", webPort: 59999 }; // inactive port
  const result = await relayCommandToChild({
    targetBot,
    actorUid: "user-123",
    sourceBotUid: "main-admin-bot",
    threadId: "thread-456",
    commandText: "help",
    timeoutMs: 1000,
  });

  assert.equal(result.success, false);
  assert.ok(["CONNECTION_ERROR", "TIMEOUT"].includes(result.code));
  assert.match(result.message, /Không thể kết nối|Quá thời gian/);
});

test("relayCommandToChild includes actorGlobalUid and child server accepts valid identity signature", async () => {
  const childServer = await createTestChildServer();
  try {
    const targetBot = { uid: "child-bot-1", webPort: childServer.port };
    const actorGlobalUid = "00001111-2222-3333-4444-555566667777";
    const result = await relayCommandToChild({
      targetBot,
      actorUid: "user-123",
      actorGlobalUid,
      sourceBotUid: "main-admin-bot",
      threadId: "thread-456",
      threadType: 1,
      commandText: "detail",
      mentions: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.data.status, "completed");
    assert.equal(typeof result.data.delivered, "boolean");
  } finally {
    await childServer.close();
  }
});

test("child server rejects disallowed management commands (mybot, mebot, clean)", async () => {
  const childServer = await createTestChildServer();
  try {
    const targetBot = { uid: "child-bot-1", webPort: childServer.port };
    const disallowedCommands = [
      "!mybot list",
      "!mebot status",
      "!clean logs",
      "mybot stop 1",
      "(mybot restart all)",
      "<mebot help>",
      "[clean cache]",
    ];

    for (const cmd of disallowedCommands) {
      const result = await relayCommandToChild({
        targetBot,
        actorUid: "user-123",
        sourceBotUid: "main-admin-bot",
        threadId: "thread-456",
        threadType: 1,
        commandText: cmd,
        mentions: [],
      });

      assert.equal(result.success, false);
      assert.equal(result.code, "DISALLOWED_COMMAND");
    }
  } finally {
    await childServer.close();
  }
});

test("child server rejects target mismatch strictly", async () => {
  const childServer = await createTestChildServer();
  try {
    // Child server has getBotId() returning "child-bot-1"
    const mismatchBot = { uid: "different-child-99", webPort: childServer.port };
    const result = await relayCommandToChild({
      targetBot: mismatchBot,
      actorUid: "user-123",
      sourceBotUid: "main-admin-bot",
      threadId: "thread-456",
      threadType: 1,
      commandText: "detail",
      mentions: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.code, "TARGET_MISMATCH");
  } finally {
    await childServer.close();
  }
});

test("relay envelope: signed actorRole and capabilities are properly signed and verified", () => {
  const secret = "secret-xyz";
  const baseParams = {
    requestId: "req-cap-1",
    actorUid: "user-abc",
    actorGlobalUid: "global-abc",
    sourceBotUid: "main-bot",
    targetBotUid: "child-bot",
    targetGlobalUid: "global-child",
    threadId: "thread-123",
    threadType: 1,
    commandText: "help",
    mentions: [],
    timestamp: Date.now(),
    actorRole: "adminLevelHigh",
    capabilities: ["EXECUTE_CHILD_COMMAND"],
    secret,
  };

  const sig = generateInternalSignature(baseParams);

  // Exact match
  assert.equal(verifyInternalSignature({ ...baseParams, signature: sig }), true);

  // Altering actorRole fails signature verification in enforce mode
  assert.equal(verifyInternalSignature({ ...baseParams, actorRole: "user", signature: sig, mode: "enforce" }), false);

  // Altering capabilities fails signature verification in enforce mode
  assert.equal(verifyInternalSignature({ ...baseParams, capabilities: ["OTHER_CAP"], signature: sig, mode: "enforce" }), false);
});


