import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  hydrateCurrentBotIdentity,
  resolveAdminIdentity,
} from "../src/commands/mybot/System/mybot-identity.js";

function createMockIdentityStore() {
  const users = new Map();
  const mappings = new Map();
  const identifiers = [];

  return {
    async findGlobalUserByUid(uid) {
      return users.get(uid) || null;
    },
    async findGlobalUserByCanonicalUsername(username) {
      for (const u of users.values()) {
        if (u.canonical_username === username) return u;
      }
      return null;
    },
    async findGlobalUserByIdentifier({ provider = "zalo", identifierType, normalizedValue } = {}) {
      const match = identifiers.find(
        (i) => i.provider === provider && i.identifier_type === identifierType && i.normalized_value === normalizedValue
      );
      if (!match) return null;
      return users.get(match.global_uid) || null;
    },
    async findMappingByBotAndLocalUid(botId, localUid) {
      return mappings.get(`${botId}:${localUid}`) || null;
    },
    async findMappingByBotAndGlobalUid(botId, globalUid) {
      for (const m of mappings.values()) {
        if (m.bot_id === botId && m.global_uid === globalUid && m.status === "active") return m;
      }
      return null;
    },
    async addOrUpdateMapping({ botId, localUid, globalUid, status = "active" }) {
      mappings.set(`${botId}:${localUid}`, { bot_id: botId, local_uid: localUid, global_uid: globalUid, status });
    },
    async addIdentifierToUser({ globalUid, provider = "zalo", identifierType, normalizedValue, sourceBotId }) {
      identifiers.push({ global_uid: globalUid, provider, identifier_type: identifierType, normalized_value: normalizedValue, source_bot_id: sourceBotId });
    },
    async createGlobalUserWithIdentity({ globalUid, canonicalUsername, displayName, avatar, botId, localUid, identifiers: idents = [] }) {
      const user = {
        global_uid: globalUid,
        canonical_username: canonicalUsername,
        display_name: displayName,
        avatar,
        status: "active",
      };
      users.set(globalUid, user);
      if (botId && localUid) {
        mappings.set(`${botId}:${localUid}`, { bot_id: botId, local_uid: localUid, global_uid: globalUid, status: "active" });
      }
      for (const i of idents) {
        identifiers.push({ global_uid: globalUid, provider: i.provider || "zalo", identifier_type: i.identifierType, normalized_value: i.normalizedValue, source_bot_id: botId });
      }
      return user;
    },
  };
}

test("startup hydration: off mode returns immediately without database connection", async () => {
  const res = await hydrateCurrentBotIdentity({
    mode: "off",
    botId: "admin",
  });
  assert.equal(res.mode, "off");
  assert.equal(res.ready, false);
});

test("startup hydration: shadow mode reports DB unavailable without throwing", async () => {
  const res = await hydrateCurrentBotIdentity({
    mode: "shadow",
    botId: "admin",
    store: null,
  });
  assert.equal(res.mode, "shadow");
  assert.equal(res.ready, false);
  assert.equal(res.dbAvailable, false);
});

test("startup hydration: enforce mode fails closed when store/db is unavailable", async () => {
  await assert.rejects(
    async () => {
      await hydrateCurrentBotIdentity({
        mode: "enforce",
        botId: "admin",
        store: null,
      });
    },
    (err) => {
      assert.ok(err);
      return true;
    }
  );
});

test("startup hydration: enforce mode hydrates bot identity when store is available", async () => {
  const store = createMockIdentityStore();
  const mockApi = {
    getUserInfo: async () => ({
      unchanged_profiles: {
        "bot-admin-uid": {
          userId: "bot-admin-uid",
          username: "main_bot_admin_official",
          displayName: "Main Bot Admin",
          avatar: "https://avatar.zalo/bot.png",
        },
      },
    }),
  };

  const res = await hydrateCurrentBotIdentity({
    mode: "enforce",
    botId: "bot-admin-uid",
    api: mockApi,
    store,
  });

  assert.equal(res.ready, true);
  assert.equal(res.hydrated, true);
  assert.equal(res.canonicalUsername, "main_bot_admin_official");
  assert.equal(res.botId, "bot-admin-uid");
});

test("resolveAdminIdentity: only reads verified username and never treats displayName as username", () => {
  // Use isolated temp dir so resolveAdminIdentity doesn't read real config.json from project root
  const tmpDir = path.join(os.tmpdir(), `identity-test-${Date.now()}`);
  fs.mkdirSync(path.join(tmpDir, "mybot", "state"), { recursive: true });
  try {
    const result = resolveAdminIdentity({
      projectRoot: tmpDir,
      config: {
        name: "Display Name Only",
        displayName: "Display Name Only",
      },
    });

    assert.equal(result.canonicalUsername, null);
    assert.equal(result.displayUsername, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
