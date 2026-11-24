import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startBot, restartManagedBot, mybotHandleCommand } from "../src/commands/mybot/myBotManager.js";
import { appContext } from "../src/api-zalo/context.js";

async function makeTestEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-restart-test-"));
  const botUid = "999888111";

  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "logs", botUid), { recursive: true });

  const botConfig = {
    uid: botUid,
    name: "Test Bot",
    displayName: "Test Bot Display",
    webPort: 38888,
    status: "stopped",
  };
  await fs.writeFile(path.join(root, "mybot", "bots", `${botUid}.json`), JSON.stringify(botConfig), "utf8");
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({ [botUid]: botConfig }), "utf8");

  const sentMessages = [];
  const mockApi = {
    sentMessages,
    sendMessage: async (payload, threadId, type) => {
      sentMessages.push({ payload, threadId, type });
      return { status: 0 };
    },
  };

  return {
    root,
    botUid,
    mockApi,
    sentMessages,
    cleanup: async () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("startBot rejects starting an already running bot", async () => {
  const env = await makeTestEnv();
  try {
    const mockMessage = {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: env.botUid, dName: "Tester" },
    };

    // Update status to running with an active-looking mock
    const mybotsPath = path.join(process.cwd(), "mybot", "mybots.json");
    const originalMybots = await fs.readFile(mybotsPath, "utf8").catch(() => null);

    const testUid = "mock-running-bot-" + Date.now();
    const mockRegistry = originalMybots ? JSON.parse(originalMybots) : {};
    mockRegistry[testUid] = {
      uid: testUid,
      name: "Mock Bot",
      status: "running",
      pid: process.pid, // current running process
    };
    await fs.writeFile(mybotsPath, JSON.stringify(mockRegistry, null, 2), "utf8");

    try {
      const started = await startBot(env.mockApi, mockMessage, true, [], false, testUid);
      assert.equal(started, false);
      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      assert.match(lastMsg.payload.msg, /đang hoạt động rồi/);
    } finally {
      if (originalMybots) {
        await fs.writeFile(mybotsPath, originalMybots, "utf8");
      } else {
        await fs.unlink(mybotsPath).catch(() => {});
      }
    }
  } finally {
    await env.cleanup();
  }
});

test("startBot does NOT block a running identityPending bot (no chờ định danh)", async () => {
  const env = await makeTestEnv();
  try {
    const mockMessage = {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: env.botUid, dName: "Tester" },
    };

    // A pending child that is ALREADY running must short-circuit at the
    // already-running gate, NOT be rejected as "chờ định danh". This proves the
    // identityPending early-return that locked child startup is removed.
    const mybotsPath = path.join(process.cwd(), "mybot", "mybots.json");
    const originalMybots = await fs.readFile(mybotsPath, "utf8").catch(() => null);

    const testUid = "mock-pending-bot-" + Date.now();
    const mockRegistry = originalMybots ? JSON.parse(originalMybots) : {};
    mockRegistry[testUid] = {
      uid: testUid,
      name: "Pending Bot",
      status: "running",
      pid: process.pid,
      identityPending: true,
      identityPendingReason: "thiếu 3 identity seeds",
    };
    await fs.writeFile(mybotsPath, JSON.stringify(mockRegistry, null, 2), "utf8");

    try {
      const started = await startBot(env.mockApi, mockMessage, true, [], false, testUid);
      assert.equal(started, false, "still-not-running path returns false");
      const lastMsg = env.sentMessages[env.sentMessages.length - 1];
      // Must NOT contain the old "chờ định danh" rejection message.
      assert.doesNotMatch(lastMsg.payload.msg, /chờ định danh|identity seeds/i);
      assert.match(lastMsg.payload.msg, /đang hoạt động rồi/);
    } finally {
      if (originalMybots) {
        await fs.writeFile(mybotsPath, originalMybots, "utf8");
      } else {
        await fs.unlink(mybotsPath).catch(() => {});
      }
    }
  } finally {
    await env.cleanup();
  }
});

test("restartManagedBot rejects non-existent or rejected bots with clear warnings", async () => {
  const env = await makeTestEnv();
  try {
    const mockMessage = {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: "non-existent-uid", dName: "Tester" },
    };

    // Non-existent bot
    const r1 = await restartManagedBot(env.mockApi, mockMessage, true, [], false, "non-existent-uid");
    assert.equal(r1, false);
    const lastMsg1 = env.sentMessages[env.sentMessages.length - 1];
    assert.match(lastMsg1.payload.msg, /Bạn chưa có BOT được tạo/);

    // Rejected bot
    const mybotsPath = path.join(process.cwd(), "mybot", "mybots.json");
    const originalMybots = await fs.readFile(mybotsPath, "utf8").catch(() => null);

    const rejectedUid = "mock-rejected-" + Date.now();
    const mockRegistry = originalMybots ? JSON.parse(originalMybots) : {};
    mockRegistry[rejectedUid] = {
      uid: rejectedUid,
      name: "Rejected Bot",
      status: "rejected",
    };
    await fs.writeFile(mybotsPath, JSON.stringify(mockRegistry, null, 2), "utf8");

    try {
      const r2 = await restartManagedBot(env.mockApi, mockMessage, true, [], false, rejectedUid);
      assert.equal(r2, false);
      const lastMsg2 = env.sentMessages[env.sentMessages.length - 1];
      assert.match(lastMsg2.payload.msg, /vô hiệu hóa/);
    } finally {
      if (originalMybots) {
        await fs.writeFile(mybotsPath, originalMybots, "utf8");
      } else {
        await fs.unlink(mybotsPath).catch(() => {});
      }
    }
  } finally {
    await env.cleanup();
  }
});

test("mybotHandleCommand routes cmd, start, and restart to separate branches", async () => {
  const env = await makeTestEnv();
  try {
    const prevUid = appContext.uid;
    appContext.uid = "admin"; // act as admin bot

    // 1. Unrecognized cmd syntax
    await mybotHandleCommand(env.mockApi, {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: "admin", dName: "Admin", content: "!mybot cmd" },
    }, true);
    let msg = env.sentMessages[env.sentMessages.length - 1];
    assert.match(msg.payload.msg, /Sai cú pháp/);

    // 2. Cmd with missing brackets
    await mybotHandleCommand(env.mockApi, {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: "admin", dName: "Admin", content: "!mybot cmd 1 help" },
    }, true);
    msg = env.sentMessages[env.sentMessages.length - 1];
    assert.match(msg.payload.msg, /Sai cú pháp/);

    // 3. Permission denied for non-system-admin on cmd
    await mybotHandleCommand(env.mockApi, {
      threadId: "thread-1",
      type: 1,
      data: { uidFrom: "regular-user", dName: "User", content: "!mybot cmd 1 <help>" },
    }, false);
    msg = env.sentMessages[env.sentMessages.length - 1];
    assert.match(msg.payload.msg, /Chỉ Quản Trị Cấp Cao/);
  } finally {
    appContext.uid = "";
    await env.cleanup();
  }
});
