import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsername,
  normalizePhone,
  hashPhoneNumber,
  redactSensitive,
  extractProfileFromUserInfo,
  extractIdentifiersFromProfile,
  resolveOrLinkIdentity,
  resolveUidForBot,
  resolveGlobalUser,
  hydrateBotIdentity,
  IDENTITY_ERRORS,
  IdentityError,
} from "../src/identity/index.js";

function createMockIdentityStore() {
  const globalUsers = new Map();
  const userIdentifiers = [];
  const botMappings = new Map(); // key: `${botId}:${localUid}`
  const conflicts = [];
  const events = [];

  return {
    async findGlobalUserByUid(globalUid) {
      return globalUsers.get(globalUid) || null;
    },

    async findGlobalUserByCanonicalUsername(canonicalUsername) {
      for (const user of globalUsers.values()) {
        if (user.canonical_username === canonicalUsername) return user;
      }
      return null;
    },

    async findGlobalUserByIdentifier({ provider = "zalo", identifierType, normalizedValue } = {}) {
      const match = userIdentifiers.find(
        (i) => i.provider === provider && i.identifier_type === identifierType && i.normalized_value === normalizedValue
      );
      if (!match) return null;
      return globalUsers.get(match.global_uid) || null;
    },

    async findMappingByBotAndLocalUid(botId, localUid) {
      const m = botMappings.get(`${botId}:${localUid}`);
      if (m && m.status === "active") return m;
      return null;
    },

    async findMappingByBotAndGlobalUid(botId, globalUid) {
      for (const mapping of botMappings.values()) {
        if (mapping.bot_id === botId && mapping.global_uid === globalUid && mapping.status === "active") {
          return mapping;
        }
      }
      return null;
    },

    async listMappingsForGlobalUser(globalUid) {
      return Array.from(botMappings.values()).filter((m) => m.global_uid === globalUid && m.status === "active");
    },

    async createGlobalUserWithIdentity({
      globalUid,
      canonicalUsername = null,
      displayUsername = null,
      displayName = null,
      avatar = null,
      status = "active",
      identifiers = [],
      botId = null,
      localUid = null,
    } = {}) {
      const now = new Date().toISOString();
      const user = {
        global_uid: globalUid,
        canonical_username: canonicalUsername,
        display_username: displayUsername,
        display_name: displayName,
        avatar,
        status,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      globalUsers.set(globalUid, user);

      for (const ident of identifiers) {
        userIdentifiers.push({
          global_uid: globalUid,
          provider: ident.provider || "zalo",
          identifier_type: ident.identifierType,
          normalized_value: ident.normalizedValue,
          verified_at: now,
          source_bot_id: botId,
        });
      }

      if (botId && localUid) {
        botMappings.set(`${botId}:${localUid}`, {
          bot_id: String(botId),
          local_uid: String(localUid),
          global_uid: globalUid,
          status: "active",
          first_seen_at: now,
          last_seen_at: now,
        });
      }

      events.push({
        event_type: "user_created",
        global_uid: globalUid,
        bot_id: botId,
        local_uid: localUid,
      });

      return user;
    },

    async addIdentifierToUser({ globalUid, provider = "zalo", identifierType, normalizedValue, sourceBotId }) {
      userIdentifiers.push({
        global_uid: globalUid,
        provider,
        identifier_type: identifierType,
        normalized_value: normalizedValue,
        verified_at: new Date().toISOString(),
        source_bot_id: sourceBotId,
      });
    },

    async addOrUpdateMapping({ botId, localUid, globalUid, status = "active" }) {
      const now = new Date().toISOString();
      const key = `${botId}:${localUid}`;
      const existing = botMappings.get(key);
      botMappings.set(key, {
        bot_id: String(botId),
        local_uid: String(localUid),
        global_uid: String(globalUid),
        status,
        first_seen_at: existing?.first_seen_at || now,
        last_seen_at: now,
      });
    },

    async updateMappingLastSeen({ botId, localUid }) {
      const key = `${botId}:${localUid}`;
      const existing = botMappings.get(key);
      if (existing) {
        existing.last_seen_at = new Date().toISOString();
      }
    },

    async recordConflict({ botId, localUid, existingGlobalUid, candidateGlobalUid, reason, status = "pending" }) {
      const conflict = {
        id: conflicts.length + 1,
        bot_id: botId,
        local_uid: localUid,
        existing_global_uid: existingGlobalUid,
        candidate_global_uid: candidateGlobalUid,
        reason,
        status,
        created_at: new Date().toISOString(),
      };
      conflicts.push(conflict);
      events.push({ event_type: "conflict_detected", bot_id: botId, local_uid: localUid });
      return conflict.id;
    },

    async listPendingConflicts() {
      return conflicts.filter((c) => c.status === "pending");
    },

    async recordEvent({ eventType, globalUid, botId, localUid, actor, payloadJson }) {
      events.push({ event_type: eventType, global_uid: globalUid, bot_id: botId, local_uid: localUid, actor });
      return events.length;
    },

    async overrideMapping({ botId, localUid, globalUid, reason, actor }) {
      const now = new Date().toISOString();
      // Remove previous mapping
      for (const [key, mapping] of botMappings.entries()) {
        if (mapping.bot_id === botId && (mapping.local_uid === localUid || mapping.global_uid === globalUid)) {
          botMappings.delete(key);
        }
      }
      botMappings.set(`${botId}:${localUid}`, {
        bot_id: botId,
        local_uid: localUid,
        global_uid: globalUid,
        status: "active",
        first_seen_at: now,
        last_seen_at: now,
      });
      const user = globalUsers.get(globalUid);
      if (user) user.version = (user.version || 1) + 1;
      for (const c of conflicts) {
        if (c.bot_id === botId && c.local_uid === localUid && c.status === "pending") {
          c.status = "resolved";
        }
      }
      events.push({ event_type: "mapping_overridden", bot_id: botId, local_uid: localUid, global_uid: globalUid });
      return { success: true, botId, localUid, globalUid, status: "active" };
    },

    async revokeMapping({ botId, localUid, reason, actor }) {
      const key = `${botId}:${localUid}`;
      botMappings.delete(key);
      events.push({ event_type: "mapping_revoked", bot_id: botId, local_uid: localUid });
      return { success: true, botId, localUid, status: "revoked" };
    },
  };
}

test("normalization & redaction: canonicalizes username and masks sensitive data", () => {
  assert.equal(normalizeUsername("  @NguyenVanA  "), "nguyenvana");
  assert.equal(normalizeUsername("  Hòa_Bình  "), "hòa_bình");
  assert.equal(normalizePhone("0987-654-321"), "+84987654321");
  assert.equal(normalizePhone("+84 987 654 321"), "+84987654321");
  assert.equal(normalizePhone("84987654321"), "+84987654321");

  const redacted = redactSensitive("User phone is 0987654321 with cookie=secret_cookie_value");
  assert.ok(!redacted.includes("secret_cookie_value"));
  assert.ok(redacted.includes("cookie=[REDACTED]"));
  assert.ok(redacted.includes("***"));
});

test("resolves versioned Zalo profile key and keeps username", async () => {
  const userInfo = {
    unchanged_profiles: {
      "user123_0": {
        userId: "user123",
        username: "zalo_versioned_user",
        displayName: "Versioned User",
      },
    },
  };

  const profile = extractProfileFromUserInfo(userInfo, "user123");
  assert.ok(profile);
  assert.equal(profile.username, "zalo_versioned_user");

  const extracted = extractIdentifiersFromProfile(profile, "user123", "bot-1");
  assert.equal(extracted.canonicalUsername, "zalo_versioned_user");
  assert.ok(extracted.identifiers.some((i) => i.identifierType === "username" && i.normalizedValue === "zalo_versioned_user"));
});

test("does not create global user without verified identifiers", async () => {
  const store = createMockIdentityStore();
  const mockApi = {
    getUserInfo: async () => ({
      unchanged_profiles: {},
    }),
  };

  // API returns no profile and localUid has no verified identifiers
  await assert.rejects(
    async () => {
      await resolveOrLinkIdentity({
        store,
        api: mockApi,
        botId: "bot-1",
        localUid: "empty-uid-without-profile",
      });
    },
    (err) => {
      assert.ok(err instanceof IdentityError);
      assert.equal(err.code, IDENTITY_ERRORS.NOT_FOUND);
      return true;
    }
  );
});

test("phone hashing: hashes phone with HMAC-SHA256 and skips plaintext when key missing", () => {
  const testPhone = "0912345678";
  const normalized = normalizePhone(testPhone);
  assert.equal(normalized, "+84912345678");

  // No key -> null
  const noKey = hashPhoneNumber(normalized, "");
  assert.equal(noKey, null);

  // With key -> hex digest
  const hashed = hashPhoneNumber(normalized, "test_secret_salt_123");
  assert.ok(hashed);
  assert.equal(typeof hashed, "string");
  assert.equal(hashed.length, 64);

  // Identifiers extraction without key does not include phone
  const profileWithPhone = { userId: "uid1", phoneNumber: "0912345678", displayName: "Phone User" };
  const withoutKey = extractIdentifiersFromProfile(profileWithPhone, "uid1", "bot-1", "");
  assert.ok(!withoutKey.identifiers.some((i) => i.identifierType === "phone"));

  // Identifiers extraction with key includes hashed phone
  const withKey = extractIdentifiersFromProfile(profileWithPhone, "uid1", "bot-1", "test_secret_salt_123");
  assert.ok(withKey.identifiers.some((i) => i.identifierType === "phone" && i.normalizedValue === hashed));
});

test("resolver: resolves same real user across Bot A and Bot B to one global_uid", async () => {
  const store = createMockIdentityStore();
  const canonicalUsername = "duyquang_vip";

  // Mock API for Bot A
  const mockApiA = {
    getUserInfo: async (uids) => ({
      unchanged_profiles: {
        "local-uid-botA": {
          userId: "local-uid-botA",
          username: canonicalUsername,
          displayName: "Duy Quang",
          avatar: "https://avatar.zalo/botA.png",
        },
      },
    }),
  };

  // 1. Resolve user on Bot A
  const resA = await resolveOrLinkIdentity({
    store,
    api: mockApiA,
    botId: "bot-A",
    localUid: "local-uid-botA",
  });

  assert.ok(resA.globalUid);
  assert.equal(resA.canonicalUsername, canonicalUsername);
  assert.equal(resA.localUid, "local-uid-botA");
  assert.equal(resA.isNew, true);

  // Mock API for Bot B (different local UID for the same Zalo account)
  const mockApiB = {
    getUserInfo: async (uids) => ({
      unchanged_profiles: {
        "local-uid-botB": {
          userId: "local-uid-botB",
          username: canonicalUsername,
          displayName: "Duy Quang",
          avatar: "https://avatar.zalo/botB.png",
        },
      },
    }),
  };

  // 2. Resolve same user on Bot B
  const resB = await resolveOrLinkIdentity({
    store,
    api: mockApiB,
    botId: "bot-B",
    localUid: "local-uid-botB",
  });

  // MUST match the same global_uid!
  assert.equal(resB.globalUid, resA.globalUid);
  assert.equal(resB.canonicalUsername, canonicalUsername);
  assert.equal(resB.localUid, "local-uid-botB");
  assert.equal(resB.isNew, false);

  // 3. resolveUidForBot checks
  const resolvedOnA = await resolveUidForBot({ store, botId: "bot-A", globalUid: resA.globalUid });
  assert.equal(resolvedOnA, "local-uid-botA");

  const resolvedOnB = await resolveUidForBot({ store, botId: "bot-B", globalUid: resA.globalUid });
  assert.equal(resolvedOnB, "local-uid-botB");
});

test("resolver: detects conflict and does not overwrite when same bot encounters conflicting mapping", async () => {
  const store = createMockIdentityStore();
  const canonicalUsername = "user_test_conflict";

  const mockApi = {
    getUserInfo: async (uids) => ({
      unchanged_profiles: {
        "uid-1": { userId: "uid-1", username: canonicalUsername, displayName: "User One" },
        "uid-2": { userId: "uid-2", username: canonicalUsername, displayName: "User Two Impostor" },
      },
    }),
  };

  // First user registered on bot-A
  const res1 = await resolveOrLinkIdentity({
    store,
    api: mockApi,
    botId: "bot-A",
    localUid: "uid-1",
  });
  assert.ok(res1.globalUid);

  // Second user on same bot-A claims the exact same username -> conflict on bot-A!
  await assert.rejects(
    async () => {
      await resolveOrLinkIdentity({
        store,
        api: mockApi,
        botId: "bot-A",
        localUid: "uid-2",
      });
    },
    (err) => {
      assert.ok(err instanceof IdentityError);
      assert.equal(err.code, IDENTITY_ERRORS.CONFLICT);
      return true;
    }
  );

  const pendingConflicts = await store.listPendingConflicts();
  assert.equal(pendingConflicts.length, 1);
  assert.equal(pendingConflicts[0].bot_id, "bot-A");
  assert.equal(pendingConflicts[0].local_uid, "uid-2");
});

test("resolver: resolveGlobalUser finds user by UUID, canonical username, or phone hash", async () => {
  const store = createMockIdentityStore();
  const mockApi = {
    getUserInfo: async () => ({
      unchanged_profiles: {
        "uid-admin": {
          userId: "uid-admin",
          username: "super_admin_zalo",
          displayName: "Supreme Admin",
          phoneNumber: "0912345678",
        },
      },
    }),
  };

  const created = await resolveOrLinkIdentity({
    store,
    api: mockApi,
    botId: "main-admin",
    localUid: "uid-admin",
    phoneHashKey: "phone_key_test",
  });

  // Resolve by canonical username
  const byUsername = await resolveGlobalUser({ store, identifier: "super_admin_zalo" });
  assert.equal(byUsername.global_uid, created.globalUid);

  // Resolve by UUID
  const byUid = await resolveGlobalUser({ store, identifier: created.globalUid });
  assert.equal(byUid.canonical_username, "super_admin_zalo");

  // Resolve by Phone with hash key
  const byPhone = await resolveGlobalUser({ store, identifier: "0912345678", phoneHashKey: "phone_key_test" });
  assert.equal(byPhone.global_uid, created.globalUid);

  // Not found
  await assert.rejects(
    async () => resolveGlobalUser({ store, identifier: "non_existent_user_999" }),
    (err) => err.code === IDENTITY_ERRORS.NOT_FOUND
  );
});

test("hydrateBotIdentity resolves bot account identity on startup", async () => {
  const store = createMockIdentityStore();
  const mockApi = {
    getUserInfo: async () => ({
      unchanged_profiles: {
        "bot-self-uid": { userId: "bot-self-uid", username: "bot_system_official", displayName: "Bot System" },
      },
    }),
  };

  const hydrated = await hydrateBotIdentity({
    store,
    api: mockApi,
    botId: "child-bot-1",
    localUid: "bot-self-uid",
  });

  assert.ok(hydrated.globalUid);
  assert.equal(hydrated.canonicalUsername, "bot_system_official");
  assert.equal(hydrated.localUid, "bot-self-uid");
});
