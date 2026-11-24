import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveCurrentInstanceIdentity,
  persistVerifiedInstanceIdentity,
  resolveMainBotUid,
} from "../src/utils/instance-authorization.js";
import { mybotHandleCommand } from "../src/commands/mybot/myBotManager.js";
import { appContext } from "../src/api-zalo/context.js";
import { setEnvVars, resetCache } from "../src/utils/env.js";

async function createTestEnvironment({
  adminUid = "bot-admin-uid",
  childUid = "child-live-uid",
  childName = "child-123",
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "id-resolution-test-"));
  const myBotDir = path.join(root, "mybot");
  const stateDir = path.join(myBotDir, "state");
  const botsDir = path.join(myBotDir, "bots");
  const assetsDir = path.join(root, "assets");
  const instancesDir = path.join(myBotDir, "instances");
  const childInstanceDir = path.join(instancesDir, childUid, "data");

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(botsDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.mkdir(childInstanceDir, { recursive: true });

  // Main config at assets/config.json
  await fs.writeFile(
    path.join(assetsDir, "config.json"),
    JSON.stringify({
      name: "admin",
      cookie: "main_cookie",
      imei: "main_imei",
      webPort: "2000",
    }, null, 2),
    "utf8"
  );

  // Admin state with initial (possibly old) UID
  await fs.writeFile(
    path.join(stateDir, "admin.json"),
    JSON.stringify({
      uid: adminUid,
      displayName: "Main Bot Admin",
      avatar: "https://avatar.main/admin.png",
      globalUid: "global-main-001",
      canonicalUsername: "admin_bot",
    }, null, 2),
    "utf8"
  );

  // Registry
  await fs.writeFile(
    path.join(myBotDir, "mybots.json"),
    JSON.stringify({
      admin: {
        name: "admin",
        uid: adminUid,
        displayName: "Main Bot Admin",
        avatar: "https://avatar.main/admin.png",
        globalUid: "global-main-001",
        isMain: true,
        status: "running",
      },
      [childUid]: {
        name: childName,
        uid: childUid,
        displayName: "Child Bot",
        isMain: false,
        status: "running",
        expiryAt: String(Date.now() + 3600000),
      },
    }, null, 2),
    "utf8"
  );

  // Child bot config
  await fs.writeFile(
    path.join(botsDir, `${childName}.json`),
    JSON.stringify({
      name: childName,
      uid: childUid,
      cookie: "test_cookie",
      imei: "test_imei",
    }, null, 2),
    "utf8"
  );

  const sentMessages = [];
  const mockApi = {
    sentMessages,
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { status: 0 };
    },
    getUserInfo: async (uids) => {
      const unchanged_profiles = {};
      for (const uid of Array.isArray(uids) ? uids : [uids]) {
        unchanged_profiles[uid] = { userId: uid, zaloName: `User_${uid}`, avatar: `https://avatar/${uid}.png` };
      }
      return { unchanged_profiles, changed_profiles: {} };
    },
  };

  return {
    root,
    myBotDir,
    stateDir,
    assetsDir,
    botsDir,
    mockApi,
    sentMessages,
    cleanup: async () => {
      resetCache();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("Scenario 1: Main Bot with old persisted UID repairs state and permits mybot commands", async () => {
  const env = await createTestEnvironment({
    adminUid: "bot-admin-uid", // Old persisted UID
  });
  const liveMainUid = "366362672788442919"; // Live UID from current session

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: "admin",
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = liveMainUid;

    try {
      // 1. Pure resolve identity
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => liveMainUid },
        appContext: { uid: liveMainUid },
        botName: "admin",
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "main");
      assert.equal(identity.processBotUid, liveMainUid);
      assert.equal(identity.persistedMismatch, true);
      assert.equal(identity.verified, true);
      assert.equal(identity.identitySource, "live-login");

      // Verify resolver did NOT mutate state yet (pure function)
      let state = JSON.parse(await fs.readFile(path.join(env.stateDir, "admin.json"), "utf8"));
      assert.equal(state.uid, "bot-admin-uid");

      // Call separated persistVerifiedInstanceIdentity
      const persistRes = persistVerifiedInstanceIdentity({
        instanceKind: identity.instanceKind,
        liveUid: identity.processBotUid,
        botName: "admin",
        projectRoot: env.root,
      });
      assert.equal(persistRes.repaired, true);

      // Verify persisted state was repaired atomically
      state = JSON.parse(await fs.readFile(path.join(env.stateDir, "admin.json"), "utf8"));
      assert.equal(state.uid, liveMainUid);
      assert.equal(state.globalUid, "global-main-001");
      assert.equal(state.canonicalUsername, "admin_bot");

      const registry = JSON.parse(await fs.readFile(path.join(env.myBotDir, "mybots.json"), "utf8"));
      assert.equal(registry.admin.uid, liveMainUid);
      assert.equal(registry.admin.isMain, true);

      // 2. Execute command !mybot help on Main Bot -> must NOT be denied
      await mybotHandleCommand(env.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: liveMainUid, dName: "Owner", content: "!mybot help" },
      });

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.ok(lastMsg, "Should send response message");
      assert.doesNotMatch(lastMsg.payload.msg, /INSTANCE_DENIED/);
      assert.match(lastMsg.payload.msg, /HỆ THỐNG QUẢN LÝ BOT/);
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 2: Child Bot receiving command from Main UID is rejected with INSTANCE_DENIED", async () => {
  const env = await createTestEnvironment({
    adminUid: "main-live-uid",
    childUid: "child-live-uid",
    childName: "child-123",
  });

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: "child-123",
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = "child-live-uid";

    try {
      // 1. Resolve identity
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => "child-live-uid" },
        appContext: { uid: "child-live-uid" },
        botName: "child-123",
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "child");
      assert.equal(identity.processBotUid, "child-live-uid");
      assert.equal(identity.mainBotUid, "main-live-uid");

      // 2. Main UID sends !mybot detail to Child Bot
      await mybotHandleCommand(env.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: "main-live-uid", dName: "Main Owner", content: "!mybot detail" },
      });

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.ok(lastMsg, "Should send warning response");
      assert.match(lastMsg.payload.msg, /Lệnh này chỉ khả dụng trên bot admin\/Main Bot\. \(INSTANCE_DENIED\)/);

      // Verify admin.json was NOT overwritten by child
      const state = JSON.parse(await fs.readFile(path.join(env.stateDir, "admin.json"), "utf8"));
      assert.equal(state.uid, "main-live-uid");
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 3: Main Bot manages Child via selector / commands without identity leak", async () => {
  const env = await createTestEnvironment({
    adminUid: "main-live-uid",
    childUid: "child-live-uid",
    childName: "child-123",
  });

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: "admin",
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = "main-live-uid";

    try {
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => "main-live-uid" },
        appContext: { uid: "main-live-uid" },
        botName: "admin",
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "main");

      // Execute !mybot showinfo on Main Bot as high admin
      await mybotHandleCommand(
        env.mockApi,
        {
          threadId: "group-1",
          type: 1,
          data: { uidFrom: "main-live-uid", dName: "Owner", content: "!mybot showinfo all" },
        },
        true // isAdminLevelHighest
      );

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.ok(lastMsg);
      assert.doesNotMatch(lastMsg.payload.msg, /INSTANCE_DENIED/);

      // Ensure Main identity is preserved
      assert.equal(resolveMainBotUid({ projectRoot: env.root }), "main-live-uid");
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 4: Identity mismatch on Child fails closed with IDENTITY_MISMATCH", async () => {
  const env = await createTestEnvironment({
    adminUid: "366362672788442919",
    childUid: "366362672788442919", // Conflict: child accidentally has main's UID
    childName: "child-conflict",
  });

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: "child-conflict",
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = "366362672788442919";

    try {
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => "366362672788442919" },
        appContext: { uid: "366362672788442919" },
        botName: "child-conflict",
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "child");
      assert.equal(identity.persistedMismatch, true);
      assert.equal(identity.verified, false);
      assert.equal(identity.identitySource, "child-live-uid-conflict");

      // Attempt command on conflicting child -> denied
      await mybotHandleCommand(env.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: "some-user", dName: "User", content: "!mybot qrlogin" },
      });

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.match(lastMsg.payload.msg, /INSTANCE_DENIED/);
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 5: Reproduction 1 — Main uses assets/config.json with BOT_NAME unset", async () => {
  const env = await createTestEnvironment({
    adminUid: "bot-admin-uid",
  });
  const liveMainUid = "366362672788442919";

  try {
    delete process.env.BOT_NAME;
    delete process.env.BOT_ID;
    delete process.env.MYBOT_INSTANCE_KIND;
    setEnvVars({
      PROJECT_ROOT: env.root,
      CONFIG_PATH: path.join(env.assetsDir, "config.json"),
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = liveMainUid;

    try {
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => liveMainUid },
        appContext: { uid: liveMainUid },
        configPath: path.join(env.assetsDir, "config.json"),
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "main");
      assert.equal(identity.processBotUid, liveMainUid);
      assert.equal(identity.verified, true);

      // Execute !mybot help -> allowed
      await mybotHandleCommand(env.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: liveMainUid, dName: "Owner", content: "!mybot help" },
      });

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.ok(lastMsg);
      assert.doesNotMatch(lastMsg.payload.msg, /INSTANCE_DENIED/);
      assert.match(lastMsg.payload.msg, /HỆ THỐNG QUẢN LÝ BOT/);
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 6: Reproduction 2 — Main launcher uses real UID as BOT_NAME", async () => {
  const env = await createTestEnvironment({
    adminUid: "bot-admin-uid",
  });
  const liveMainUid = "366362672788442919";

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: liveMainUid,
    });

    const prevAppContextUid = appContext.uid;
    appContext.uid = liveMainUid;

    try {
      const identity = resolveCurrentInstanceIdentity({
        api: { getOwnId: () => liveMainUid },
        appContext: { uid: liveMainUid },
        botName: liveMainUid,
        projectRoot: env.root,
      });

      assert.equal(identity.instanceKind, "main");
      assert.equal(identity.processBotUid, liveMainUid);
      assert.equal(identity.verified, true);

      await mybotHandleCommand(env.mockApi, {
        threadId: "group-1",
        type: 1,
        data: { uidFrom: liveMainUid, dName: "Owner", content: "!mybot help" },
      });

      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.ok(lastMsg);
      assert.doesNotMatch(lastMsg.payload.msg, /INSTANCE_DENIED/);
    } finally {
      appContext.uid = prevAppContextUid;
    }
  } finally {
    await env.cleanup();
  }
});

test("Scenario 7: Pure resolver does not mutate files on disk", async () => {
  const env = await createTestEnvironment({
    adminUid: "persisted-old-uid",
  });
  const liveMainUid = "366362672788442919";

  try {
    setEnvVars({
      PROJECT_ROOT: env.root,
      BOT_NAME: "admin",
    });

    const adminStateBefore = await fs.readFile(path.join(env.stateDir, "admin.json"), "utf8");
    const mybotsBefore = await fs.readFile(path.join(env.myBotDir, "mybots.json"), "utf8");

    // Call resolver 5 times concurrently
    await Promise.all([
      resolveCurrentInstanceIdentity({ api: { getOwnId: () => liveMainUid }, projectRoot: env.root }),
      resolveCurrentInstanceIdentity({ api: { getOwnId: () => liveMainUid }, projectRoot: env.root }),
      resolveCurrentInstanceIdentity({ api: { getOwnId: () => liveMainUid }, projectRoot: env.root }),
      resolveCurrentInstanceIdentity({ api: { getOwnId: () => liveMainUid }, projectRoot: env.root }),
      resolveCurrentInstanceIdentity({ api: { getOwnId: () => liveMainUid }, projectRoot: env.root }),
    ]);

    const adminStateAfter = await fs.readFile(path.join(env.stateDir, "admin.json"), "utf8");
    const mybotsAfter = await fs.readFile(path.join(env.myBotDir, "mybots.json"), "utf8");

    assert.equal(adminStateAfter, adminStateBefore, "admin.json must NOT be modified by resolver");
    assert.equal(mybotsAfter, mybotsBefore, "mybots.json must NOT be modified by resolver");
  } finally {
    await env.cleanup();
  }
});

test("Scenario 8: Explicit launcher contract and conflicting configurations fail closed", async () => {
  const env = await createTestEnvironment({
    adminUid: "main-uid-100",
    childUid: "child-uid-200",
    childName: "child-200",
  });

  try {
    // 1. Explicit main launcher contract
    const mainIdentity = resolveCurrentInstanceIdentity({
      instanceKind: "main",
      configPath: path.join(env.assetsDir, "config.json"),
      botName: "admin",
      projectRoot: env.root,
    });
    assert.equal(mainIdentity.instanceKind, "main");
    assert.equal(mainIdentity.verified, true);
    assert.equal(mainIdentity.identitySource, "launcher-main-env");

    // 2. Explicit child launcher contract
    const childIdentity = resolveCurrentInstanceIdentity({
      instanceKind: "child",
      configPath: path.join(env.botsDir, "child-200.json"),
      botName: "child-200",
      projectRoot: env.root,
    });
    assert.equal(childIdentity.instanceKind, "child");
    assert.equal(childIdentity.verified, true);
    assert.equal(childIdentity.identitySource, "launcher-child-env");

    // 3. Conflict: Main launcher with Child config -> must fail closed
    const conflictMain = resolveCurrentInstanceIdentity({
      instanceKind: "main",
      configPath: path.join(env.botsDir, "child-200.json"),
      projectRoot: env.root,
    });
    assert.equal(conflictMain.verified, false);
    assert.equal(conflictMain.identitySource, "conflict-main-with-child-config");

    // 4. Conflict: Child launcher with Main config -> must fail closed
    const conflictChild = resolveCurrentInstanceIdentity({
      instanceKind: "child",
      configPath: path.join(env.assetsDir, "config.json"),
      projectRoot: env.root,
    });
    assert.equal(conflictChild.verified, false);
    assert.equal(conflictChild.identitySource, "conflict-child-with-main-config");
  } finally {
    await env.cleanup();
  }
});
