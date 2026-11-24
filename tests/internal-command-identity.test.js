import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import { registerInternalCommandRoutes } from "../src/web-service/internal-command-route.js";
import { generateInternalSignature, getInternalSecret } from "../src/commands/mybot/System/mybot-command-relay.js";

function createMockStoreForRelayTest() {
  const users = new Map();
  const mappings = new Map(); // key: `${botId}:${globalUid}`

  // Actor
  const actorUser = {
    global_uid: "global-actor-uuid-111",
    canonical_username: "actor_vip",
    display_name: "Actor VIP",
  };
  users.set(actorUser.global_uid, actorUser);
  mappings.set("bot-main:global-actor-uuid-111", { bot_id: "bot-main", local_uid: "actor-local-main", global_uid: actorUser.global_uid, status: "active" });
  mappings.set("child-bot-1:global-actor-uuid-111", { bot_id: "child-bot-1", local_uid: "actor-local-child", global_uid: actorUser.global_uid, status: "active" });

  // Mentioned user
  const mentionUser = {
    global_uid: "global-mention-uuid-222",
    canonical_username: "target_user",
    display_name: "Target User",
  };
  users.set(mentionUser.global_uid, mentionUser);
  mappings.set("bot-main:global-mention-uuid-222", { bot_id: "bot-main", local_uid: "mention-local-main", global_uid: mentionUser.global_uid, status: "active" });
  mappings.set("child-bot-1:global-mention-uuid-222", { bot_id: "child-bot-1", local_uid: "mention-local-child", global_uid: mentionUser.global_uid, status: "active" });

  return {
    async findGlobalUserByUid(uid) {
      return users.get(uid) || null;
    },
    async findMappingByBotAndGlobalUid(botId, globalUid) {
      return mappings.get(`${botId}:${globalUid}`) || null;
    },
    async findMappingByBotAndLocalUid(botId, localUid) {
      for (const m of mappings.values()) {
        if (m.bot_id === botId && m.local_uid === localUid) return m;
      }
      return null;
    },
  };
}

test("internal-command: rewrites actor and mention local UIDs from Bot A to Bot B in enforce mode", async () => {
  const store = createMockStoreForRelayTest();
  const app = express();
  app.use(express.json());

  const mockApi = {
    getBotId: () => "child-bot-1",
    sendMessage: async (msg, thread) => ({ msg, thread }),
    sendImage: async () => ({}),
    getGroupInfo: async () => ({ gridInfoMap: {} }),
  };

  registerInternalCommandRoutes(app, {
    api: mockApi,
    projectRoot: process.cwd(),
    identityStore: store,
    identityMode: "enforce",
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const requestId = "test_req_identity_1";
    const timestamp = Date.now();
    const secret = getInternalSecret();

    const mentions = [
      { uid: "mention-local-main", globalUid: "global-mention-uuid-222", pos: 0, len: 10 },
    ];

    const signature = generateInternalSignature({
      requestId,
      actorUid: "actor-local-main",
      actorGlobalUid: "global-actor-uuid-111",
      sourceBotUid: "bot-main",
      targetBotUid: "child-bot-1",
      threadId: "group-thread-123",
      threadType: 1,
      commandText: "!info @user",
      mentions,
      timestamp,
      secret,
    });

    const payload = {
      requestId,
      actorUid: "actor-local-main",
      actorGlobalUid: "global-actor-uuid-111",
      sourceBotUid: "bot-main",
      targetBotUid: "child-bot-1",
      threadId: "group-thread-123",
      threadType: 1,
      commandText: "!info @user",
      mentions,
      timestamp,
    };

    const res = await fetch(`http://127.0.0.1:${port}/internal/command/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Signature": signature,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Request-Id": requestId,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  } finally {
    server.close();
  }
});

test("internal-command: fails closed and does not execute when mention cannot be resolved on child bot", async () => {
  const store = createMockStoreForRelayTest();
  const app = express();
  app.use(express.json());

  let wasApiCalled = false;
  const mockApi = {
    getBotId: () => "child-bot-1",
    sendMessage: async () => {
      wasApiCalled = true;
      return {};
    },
  };

  registerInternalCommandRoutes(app, {
    api: mockApi,
    projectRoot: process.cwd(),
    identityStore: store,
    identityMode: "enforce",
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const requestId = "test_req_unlinked_mention";
    const timestamp = Date.now();
    const secret = getInternalSecret();

    // Mention with unknown global UID
    const unlinkedMentions = [
      { uid: "unlinked-local-uid", globalUid: "unknown-global-uuid-999" },
    ];

    const signature = generateInternalSignature({
      requestId,
      actorUid: "actor-local-main",
      actorGlobalUid: "global-actor-uuid-111",
      sourceBotUid: "bot-main",
      targetBotUid: "child-bot-1",
      threadId: "group-thread-123",
      threadType: 1,
      commandText: "!info @ghost",
      mentions: unlinkedMentions,
      timestamp,
      secret,
    });

    const payload = {
      requestId,
      actorUid: "actor-local-main",
      actorGlobalUid: "global-actor-uuid-111",
      sourceBotUid: "bot-main",
      targetBotUid: "child-bot-1",
      threadId: "group-thread-123",
      threadType: 1,
      commandText: "!info @ghost",
      mentions: unlinkedMentions,
      timestamp,
    };

    const res = await fetch(`http://127.0.0.1:${port}/internal/command/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Signature": signature,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Request-Id": requestId,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, "IDENTITY_NOT_LINKED");
    assert.equal(wasApiCalled, false);
  } finally {
    server.close();
  }
});
