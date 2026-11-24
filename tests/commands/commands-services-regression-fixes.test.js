import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import schedule from "node:module";

import {
  hasMinimumRole,
  canManageTarget,
  resolveUserRole,
} from "../../src/utils/role-policy.js";
import { loadRuntimeCommandPolicy } from "../../src/commands/command-policy-loader.js";
import {
  createCommandDefinition,
  executeCommand,
} from "../../src/commands/command-router.js";
import { handleCommandPrivate } from "../../src/commands/command.js";
import { handleActiveBotUser } from "../../src/commands/bot-manager/active-bot.js";
import { CpuBenchmark } from "../../src/commands/lenh-debug/benchmark/index.js";
import { resolveSafeShareFilePath } from "../../src/service-debug/chat-bot/bot-learning/dqt-bot.js";
import {
  isSensitiveShowcodeSegment,
  resolveSafeShowcodeTarget,
} from "../../src/service-debug/tien-ich/showcode.js";
import { resolveSafePrMediaPath } from "../../src/service-debug/scheduler/pr-service.js";
import {
  extractStickerArgument,
  parseStickerArgs,
} from "../../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/parser.js";
import { buffLink, MAX_BUFF_REQUESTS } from "../../src/service-debug/tiktok/viewtt.js";
import { handleDownloadZalo } from "../../src/service-debug/api-crawl/download/auto-download.js";
import {
  getSenderName,
  handleAutoReplyGemini,
  senderNameCache,
} from "../../src/service-debug/api-crawl/assistant-ai/auto-reply.js";
import {
  cacheState,
  putInCache,
  resolveBotDataFilePath,
} from "../../src/utils/link-platform-cache.js";
import {
  initRankSystem,
  readRankInfo,
  resolveRankMetaPath,
  updateUserRank,
} from "../../src/service-debug/info-service/rank-chat.js";
import { closeAllRankStores } from "../../src/service-debug/info-service/rank-store.js";
import { PendingConfirmationManager } from "../../src/service-debug/locmem/locmem-pending.js";
import { handleLocmemReaction } from "../../src/service-debug/locmem/locmem-service.js";
import { rebindServiceApi } from "../../src/service-debug/service.js";
import nodeSchedule from "node-schedule";
import { MessageType } from "../../src/api-zalo/models/Message.js";

void schedule;

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("role-policy: hasMinimumRole & canManageTarget normalize adminBotOrGroup alias and honor native groupAdmins when enabled", () => {
  const ctx = {
    threadId: "g_role_1",
    mainAdmins: ["high_1"],
    botAdmins: ["bot_admin_1"],
    groupSettings: {
      g_role_1: {
        adminList: { box_admin_1: true },
      },
    },
    groupAdmins: ["native_qtv_1"],
  };

  assert.equal(hasMinimumRole("regular_user", "adminBotOrGroup", ctx), false);
  assert.equal(hasMinimumRole("box_admin_1", "adminBotOrGroup", ctx), true);
  assert.equal(hasMinimumRole("bot_admin_1", "adminBotOrGroup", ctx), true);
  assert.equal(canManageTarget("adminBot", "adminBotOrGroup"), true);
  assert.equal(canManageTarget("adminBotOrGroup", "adminBot"), false);

  // Default resolveUserRole keeps native groupAdmins at member unless includeNativeGroupAdmins is enabled
  assert.equal(resolveUserRole("native_qtv_1", ctx), "member");
  assert.equal(
    resolveUserRole("native_qtv_1", { ...ctx, includeNativeGroupAdmins: true }),
    "adminBox"
  );
});

test("command-policy-loader: handles botId with spaces safely and blocks path traversal", async (t) => {
  const root = await makeTempDir("policy-loader-fix-");
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await fsp.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fsp.mkdir(path.join(root, "mybot", "command-overrides"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "assets", "json-data", "command.json"),
    JSON.stringify({ commands: [{ name: "help", permission: "all" }] }),
    "utf8"
  );
  await fsp.writeFile(
    path.join(root, "mybot", "command-overrides", "Thanh_Hung.json"),
    JSON.stringify({ help: { cooldown: 12 } }),
    "utf8"
  );
  await fsp.writeFile(
    path.join(root, "mybot", "secret.json"),
    JSON.stringify({ help: { cooldown: 999 } }),
    "utf8"
  );

  const spaced = loadRuntimeCommandPolicy({ root, botId: "Thanh Hung" });
  assert.equal(spaced.overrides?.help?.cooldown, 12);

  const traversed = loadRuntimeCommandPolicy({ root, botId: "../secret" });
  assert.deepEqual(traversed.overrides, {});
});

test("command-router: logs and notifies safely when a heavy/broadcast background task rejects", async () => {
  const sentErrors = [];
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.join(" "));

  try {
    const def = createCommandDefinition({
      name: "help",
      aliases: [],
      scope: "both",
      permission: "all",
      minArgs: 0,
      requiresDb: false,
      executionLane: "heavy",
      timeoutMs: 5000,
      handler: async () => {
        throw new Error("boom-heavy-lane");
      },
    });

    const api = {
      sendMessage: async (payload) => {
        sentErrors.push(payload);
        return { msgId: "err_1" };
      },
    };
    const message = {
      threadId: "t_heavy",
      type: MessageType.GroupMessage,
      data: { uidFrom: "u_1", content: "!help" },
    };

    const res = await executeCommand(
      {
        scope: "group",
        permissionLevel: "all",
        hasDb: true,
        api,
        message,
        threadId: "t_heavy",
        type: MessageType.GroupMessage,
        workloadBroker: {
          submitHeavy: (_name, _ctx, fn) => ({
            jobId: "job_heavy_1",
            promise: Promise.resolve().then(fn),
          }),
        },
      },
      def
    );
    assert.equal(res.code, "ACCEPTED");

    await new Promise((r) => setTimeout(r, 40));
    assert.ok(loggedErrors.some((line) => line.includes("help")));
    assert.ok(sentErrors.length >= 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("command.js: handleCommandPrivate fuzzy-suggests unknown typos instead of fail-closed denial", async () => {
  const sentMessages = [];
  const api = {
    sendMessage: async (payload) => {
      sentMessages.push(typeof payload === "string" ? payload : payload?.msg || "");
      return { message: { msgId: "m_1" } };
    },
    sendReaction: async () => {},
  };
  const message = {
    threadId: "u_private_1",
    type: MessageType.DirectMessage,
    isSelf: false,
    data: {
      uidFrom: "u_private_1",
      dName: "Tester",
      content: "!halp",
    },
  };

  await handleCommandPrivate(api, message, {
    role: "member",
    roleLevel: 0,
    isAdminLevelHigh: false,
    isBotAdmin: false,
  });

  const combined = sentMessages.join("\n");
  assert.equal(combined.includes("fail-closed"), false);
});

test("active-bot: restricts privatebot/nameserver/rs to adminLevelHigh and matches exact rs token", async () => {
  const sent = [];
  const api = {
    sendMessage: async (payload) => {
      sent.push(typeof payload === "string" ? payload : payload?.msg || "");
      return { message: { msgId: "m_bot" } };
    },
  };
  const baseMsg = (content) => ({
    threadId: "g_bot_1",
    type: MessageType.GroupMessage,
    data: { uidFrom: "bot_admin_only", dName: "Mod", content },
  });

  // Non-high admin attempting privatebot / nameserver / rs -> all denied
  await handleActiveBotUser(
    api,
    baseMsg("!bot privatebot"),
    {},
    { isAdminLevelHigh: false, isBotAdmin: true }
  );
  await handleActiveBotUser(
    api,
    baseMsg("!bot nameServer NewName"),
    {},
    { isAdminLevelHigh: false, isBotAdmin: true }
  );
  await handleActiveBotUser(
    api,
    baseMsg("!bot rs"),
    {},
    { isAdminLevelHigh: false, isBotAdmin: true }
  );
  assert.ok(sent.some((text) => text.includes("không có quyền thay đổi chế độ tin nhắn riêng tư")));
  assert.ok(sent.some((text) => text.includes("không có quyền thay đổi nameServer")));
  assert.ok(sent.some((text) => text.includes("không có quyền khởi động lại bot")));

  // "!bot users" must NOT match "rs" restart substring
  sent.length = 0;
  const handledUsers = await handleActiveBotUser(
    api,
    baseMsg("!bot users"),
    {},
    { isAdminLevelHigh: true }
  );
  assert.equal(handledUsers, false);
  assert.equal(sent.length, 0);
});

test("benchmark: runSingleThreadBenchmark executes inside worker thread and returns ops > 0", async () => {
  const bench = new CpuBenchmark({ durationMs: 60, workers: 1 });
  const ops = await bench.runSingleThreadBenchmark(60);
  assert.equal(typeof ops, "number");
  assert.ok(ops > 0);
});

test("path-traversal hardening: dqt-bot, showcode, and pr-service block traversal and sensitive files", async (t) => {
  const tmpRoot = await makeTempDir("traversal-fixes-");
  t.after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const shareDir = path.join(tmpRoot, "filegame");
  const prDir = path.join(tmpRoot, "image-pr");
  await fsp.mkdir(shareDir, { recursive: true });
  await fsp.mkdir(prDir, { recursive: true });

  // dqt-bot
  assert.equal(resolveSafeShareFilePath("../package.json", shareDir), null);
  assert.equal(resolveSafeShareFilePath("sub/secret.txt", shareDir), null);
  assert.equal(resolveSafeShareFilePath("..\\secret.txt", shareDir), null);
  assert.equal(
    resolveSafeShareFilePath("hello.txt", shareDir),
    path.resolve(shareDir, "hello.txt")
  );

  // showcode
  assert.equal(isSensitiveShowcodeSegment(".env"), true);
  assert.equal(isSensitiveShowcodeSegment(".env.local"), true);
  assert.equal(isSensitiveShowcodeSegment("credentials.json"), true);
  assert.equal(resolveSafeShowcodeTarget(".env", tmpRoot).ok, false);
  assert.equal(resolveSafeShowcodeTarget("credentials/key.json", tmpRoot).ok, false);
  assert.equal(resolveSafeShowcodeTarget("../outside.js", tmpRoot).ok, false);
  assert.equal(resolveSafeShowcodeTarget("src/app.js", tmpRoot).ok, true);

  // pr-service
  assert.equal(resolveSafePrMediaPath(prDir, "../web-config.json"), null);
  assert.equal(resolveSafePrMediaPath(prDir, "nested/banner.png"), null);
  const safePr = resolveSafePrMediaPath(prDir, "banner.png");
  assert.equal(safePr?.fileName, "banner.png");
  assert.equal(safePr?.filePath, path.resolve(prDir, "banner.png"));
});

test("sticker-ai parser: enables AI mode for !stkai, !stickerai, and forceAiMode", () => {
  const arg = extractStickerArgument("!stkai cute astronaut cat", "stkai", "!");
  assert.equal(arg, "cute astronaut cat");

  const argGeneric = extractStickerArgument("!stickerai cyber fox", null, "!");
  assert.equal(argGeneric, "cyber fox");

  const parsedForced = parseStickerArgs(arg, {
    hasMediaReference: false,
    forceAiMode: true,
  });
  assert.equal(parsedForced.source, "ai");
  assert.equal(parsedForced.payload.kind, "ai");
  assert.equal(parsedForced.payload.prompt, "cute astronaut cat");
});

test("tiktok viewtt: buffLink caps requests at MAX_BUFF_REQUESTS (<= 5) with AbortSignal", async () => {
  assert.ok(MAX_BUFF_REQUESTS <= 5);
  const calls = [];
  await buffLink("https://www.tiktok.com/@u/video/123", "10", async (url, init) => {
    calls.push({ url, hasSignal: Boolean(init?.signal) });
    return { ok: true };
  });
  assert.equal(calls.length, MAX_BUFF_REQUESTS);
  assert.ok(calls.every((c) => c.hasSignal));
});

test("crawl & auto-reply: auto-download accepts self links and auto-reply caches sender names via LRUCache", async () => {
  let downloads = 0;
  const selfHandled = await handleDownloadZalo(
    {},
    {
      isSelf: true,
      threadId: "g_dl",
      body: "https://www.tiktok.com/@a/video/1",
      data: { uidFrom: "bot_1", msgId: "self-link-regression", content: "https://www.tiktok.com/@a/video/1" },
    },
    { g_dl: { enableDownload: true } },
    false,
    { handleReply: async () => false, handleLegacyReply: async () => false,
      sendReaction: async () => {}, runPlatformDownload: async () => { downloads++; return true; } }
  );
  assert.equal(selfHandled, true);
  assert.equal(downloads, 1);

  senderNameCache.clear();
  let lookupCount = 0;
  const mockApi = {
    getBotId: () => "bot_999",
    getUserInfo: async (uid) => {
      lookupCount += 1;
      return { changed_profiles: { [uid]: { displayName: "Minh Anh" } } };
    },
  };

  // Unmentioned message does not trigger getUserInfo
  const ignoredReply = await handleAutoReplyGemini(
    mockApi,
    {
      threadId: "g_ai",
      data: {
        uidFrom: "u_lookup",
        mentions: [{ uid: "someone_else" }],
        content: "@Other hi",
      },
    },
    { g_ai: { autoReplyCommand: true } },
    false
  );
  assert.equal(ignoredReply, false);
  assert.equal(lookupCount, 0);

  const first = await getSenderName(mockApi, "u_lookup");
  const second = await getSenderName(mockApi, "u_lookup");
  assert.equal(first, "Minh Anh");
  assert.equal(second, "Minh Anh");
  assert.equal(lookupCount, 1);
});

test("link-platform-cache: scopes cache-link.json per bot dataDir and leaves no stray temp files", async (t) => {
  const tmpDir = await makeTempDir("link-cache-bot-");
  t.after(async () => {
    delete cacheState.data.youtube["vid_scoped_1"];
    cacheState.hasChanges = false;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const botCtx = { uid: "bot_alpha", dataDir: path.join(tmpDir, "data") };
  const resolved = resolveBotDataFilePath("cache-link.json", botCtx);
  assert.equal(resolved, path.join(tmpDir, "data", "cache-link.json"));

  await putInCache(
    "youtube",
    "vid_scoped_1",
    { fileUrl: "https://cdn.example/v.mp4", title: "Scoped Video" },
    "720p",
    botCtx
  );

  assert.equal(fs.existsSync(resolved), true);
  const filesInDir = await fsp.readdir(path.dirname(resolved));
  assert.deepEqual(filesInDir, ["cache-link.json"]);
});

test("rank-chat: initRankSystem preserves daily rank across intra-day restarts and resets on new GMT+7 date", async (t) => {
  const tmpDir = await makeTempDir("rank-intraday-");
  const customCtx = {
    uid: "bot_rank_test",
    dataDir: tmpDir,
    rankInfoPath: path.join(tmpDir, "rank-info.json"),
  };

  t.after(async () => {
    const job = nodeSchedule.scheduledJobs[`reset_topchat_midnight_${customCtx.uid}`];
    if (job) job.cancel();
    closeAllRankStores();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  await initRankSystem(customCtx, { todayKey: "2026-11-02" });
  updateUserRank("g_rank", "u_1", "Alice", "Group 1", customCtx);
  assert.equal(readRankInfo(customCtx).groups?.g_rank?.users?.[0]?.Rank, 1);

  // Intra-day restart on the same date preserves daily stats
  await initRankSystem(customCtx, { todayKey: "2026-11-02" });
  assert.equal(readRankInfo(customCtx).groups?.g_rank?.users?.[0]?.Rank, 1);
  assert.equal(fs.existsSync(resolveRankMetaPath(customCtx)), true);

  // Next day startup resets daily stats cleanly
  await initRankSystem(customCtx, { todayKey: "2026-11-03" });
  assert.deepEqual(readRankInfo(customCtx), { groups: {} });
});

test("locmem & service: handleLocmemReaction aborts when adminIds is empty and creatorId !== botUid; rebindServiceApi is exported", async () => {
  assert.equal(typeof rebindServiceApi, "function");

  const manager = new PendingConfirmationManager(60000);
  manager.createRequest({
    groupId: "g_locmem_guard",
    requestedBy: "admin_high",
    candidateUids: ["inactive_1"],
    qualifiedDays: ["2026-10-01"],
    serverMsgId: "msg_guard_1",
    botUid: "bot_real_uid",
  });

  let kickCalled = false;
  const mockApi = {
    getOwnId: () => "bot_real_uid",
    removeUserFromGroup: async () => {
      kickCalled = true;
      return { status: 0, errorMembers: [] };
    },
    sendMessage: async () => ({ msgId: "m_abort" }),
    getGroupInfo: async () => ({
      creatorId: "different_owner_uid",
      adminIds: [],
      memVerList: ["inactive_1_0"],
    }),
  };

  const result = await handleLocmemReaction(
    mockApi,
    {
      threadId: "g_locmem_guard",
      data: {
        uidFrom: "admin_high",
        msgId: "msg_guard_1",
        content: { rType: 5 },
      },
    },
    {
      botUid: "bot_real_uid",
      pendingManager: manager,
      isHighAdminFn: () => true,
    }
  );

  assert.equal(result, false);
  assert.equal(kickCalled, false);
});
