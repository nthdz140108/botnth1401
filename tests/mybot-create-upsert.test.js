import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBot } from "../src/commands/mybot/Manager/createBot.js";
import { getProfile } from "../src/commands/mybot/System/mybot-profile-service.js";

async function setupCreateFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-create-test-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "credentials"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "profiles"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    admin: { name: "admin", status: "running" },
  }));
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!" }));

  return root;
}

test("create command provisions in pending state without starting process", async () => {
  const root = await setupCreateFixture();
  const previousCwd = process.cwd();
  process.chdir(root);
  process.env.ProjectRoot = root;

  const sentMessages = [];
  const fakeApi = {
    sendMessage: async (payload) => {
      sentMessages.push(payload);
      return { message: { msgId: "1" } };
    },
  };

  const cookieJson = JSON.stringify({ token: "cookie_secret_1234567890" });
  const message = {
    threadId: "user-123",
    type: 0, // Direct message
    data: {
      uidFrom: "user-123",
      dName: "Alice User",
      content: `!mybot create imei_12345678_abcd_efgh ${cookieJson}`,
    },
  };

  try {
    await createBot(fakeApi, message, [], ["imei_12345678_abcd_efgh", cookieJson], "mybot", { verifyCredential: async () => ({ uid: "verified-account", displayName: "Alice User" }) });

    // Check mybots.json
    const myBots = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    const botKey = Object.keys(myBots).find(key => key !== "admin");
    assert.match(botKey, /^bot_/);
    assert.equal(myBots[botKey].accountUid, "verified-account");
    assert.equal(myBots[botKey].status, "stopped");
    assert.equal(myBots[botKey].trialStatus, "pending");

    // Check profile
    const profile = getProfile(botKey, { root });
    assert.equal(profile.trialStatus, "pending");
    assert.equal(profile.expiryAt, null);
    assert.equal(profile.enabled, true);

    // Check response message mentions pending / active instructions
    assert.ok(sentMessages.some((m) => typeof m === "object" && /active/i.test(m.msg || "")));

    // Test safe upsert on existing bot
    const newCookieJson = JSON.stringify({ token: "updated_token_999" });
    const updateMsg = {
      threadId: "user-123",
      type: 0,
      data: {
        uidFrom: "user-123",
        dName: "Alice Updated",
        content: `!mybot create imei_new_999 ${newCookieJson}`,
      },
    };
    await createBot(fakeApi, updateMsg, [], ["imei_new_999", newCookieJson], "mybot", { verifyCredential: async () => ({ uid: "verified-account", displayName: "Alice User" }) });

    const myBotsAfter = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    assert.equal(myBotsAfter[botKey].displayName, "Alice User");
    assert.equal(myBotsAfter[botKey].status, "stopped");

    // Verify credential was updated
    const credAfter = JSON.parse(await fs.readFile(path.join(root, "mybot", "credentials", `${botKey}.json`), "utf8"));
    assert.equal(credAfter.cookie?.cookies.find(cookie => cookie.name === "token")?.value, "updated_token_999");
  } finally {
    process.chdir(previousCwd);
  }
});

test("create command update failure preserves existing active credential data without losing config", async () => {
  const root = await setupCreateFixture();
  const previousCwd = process.cwd();
  process.chdir(root);
  process.env.ProjectRoot = root;

  const fakeApi = {
    sendMessage: async () => ({ message: { msgId: "1" } }),
  };

  const initialCookie = JSON.stringify({ token: "original_secure_token" });
  const msg1 = {
    threadId: "preserve-user",
    type: 0,
    data: { uidFrom: "preserve-user", dName: "Owner Preserve", content: `!mybot create imei_111 ${initialCookie}` },
  };

  try {
    await createBot(fakeApi, msg1, [], ["imei_111", initialCookie], "mybot", { verifyCredential: async () => ({ uid: "verified-account", displayName: "Alice User" }) });

    const bots = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    const botKey = Object.keys(bots).find(key => key !== "admin");
    const credPath = path.join(root, "mybot", "credentials", `${botKey}.json`);
    assert.ok(await fs.access(credPath).then(() => true).catch(() => false));

    // Simulate an invalid update attempt that errors during processing
    const invalidCookie = "not_json";
    const msg2 = {
      threadId: "preserve-user",
      type: 0,
      data: { uidFrom: "preserve-user", dName: "Owner Preserve", content: `!mybot create imei_222 ${invalidCookie}` },
    };

    await createBot(fakeApi, msg2, [], ["imei_222", invalidCookie], "mybot", { verifyCredential: async () => ({ uid: "verified-account", displayName: "Alice User" }) });

    // Verify original credentials still exist and are valid
    const credContent = JSON.parse(await fs.readFile(credPath, "utf8"));
    assert.equal(credContent.cookie?.cookies.find(cookie => cookie.name === "token")?.value, "original_secure_token");
  } finally {
    process.chdir(previousCwd);
  }
});
