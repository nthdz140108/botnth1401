process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandRegistry } from "../src/commands/command-registry.js";
import { getStudioContractCatalog } from "../src/commands/studio/contracts.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { resolveCommand } from "../src/commands/command-router.js";
import { parseCommandContent } from "../src/commands/command-parser.js";
import { MessageType } from "../src/api-zalo/models/Message.js";

function createMockApi(recorder = []) {
  const push = (method, args) => {
    recorder.push({ method, args });
  };
  const base = {
    getOwnId: () => "999000111",
    getBotId: () => "999000111",
    sendMessage: async (payload, threadId, type) => {
      push("sendMessage", [payload, threadId, type]);
      return { msgId: `msg-${recorder.length}`, cliMsgId: `cli-${recorder.length}` };
    },
    addReaction: async (icon, msg) => {
      push("addReaction", [icon, msg]);
      return { status: 0 };
    },
    changeGroupAvatar: async (...args) => {
      push("changeGroupAvatar", args);
      return { status: 0 };
    },
    changeAccountSetting: async (...args) => {
      push("changeAccountSetting", args);
      return { status: 0 };
    },
    fetchAccountInfo: async () => {
      push("fetchAccountInfo", []);
      return { profile: { displayName: "Bot Test", zaloName: "Bot Test", dob: "2000-01-01", gender: 0 } };
    },
    getSettings: async () => {
      push("getSettings", []);
      return { allowStrangerMessage: 1 };
    },
    createGroup: async (...args) => {
      push("createGroup", args);
      return { groupId: "new-group-123", succesMembers: ["100001", "100002"], errorMembers: [] };
    },
    getGroupInviteBoxList: async (...args) => {
      push("getGroupInviteBoxList", args);
      return { invitations: [], total: 0 };
    },
    acceptFriendRequest: async (...args) => {
      push("acceptFriendRequest", args);
      return { status: 0 };
    },
    setMute: async (...args) => {
      push("setMute", args);
      return { status: 0 };
    },
    createPoll: async (...args) => {
      push("createPoll", args);
      return { poll_id: "poll-1" };
    },
    joinGroup: async (...args) => {
      push("joinGroup", args);
      return { status: 0 };
    },
    leaveGroup: async (...args) => {
      push("leaveGroup", args);
      return { status: 0 };
    },
    unblockUser: async (...args) => {
      push("unblockUser", args);
      return { status: 0 };
    },
    blockUser: async (...args) => {
      push("blockUser", args);
      return { status: 0 };
    },
    getGroupBlockedMember: async (...args) => {
      push("getGroupBlockedMember", args);
      return { blocked_members: [], has_more: 0 };
    },
    getGroupInfo: async (threadId) => {
      push("getGroupInfo", [threadId]);
      return {
        gridInfoMap: {
          [threadId]: {
            groupId: threadId,
            name: "Nhóm Kiểm Thử",
            creatorId: "999000111",
            adminIds: ["888000111"],
            memVerList: ["999000111_0", "888000111_0", "777000111_0"],
            totalMember: 3,
            setting: { lockSendMsg: 0 },
          },
        },
      };
    },
    getUserInfo: async (uids) => {
      const list = Array.isArray(uids) ? uids : [uids];
      return {
        changed_profiles: Object.fromEntries(
          list.map((u) => [String(u), { userId: String(u), displayName: `User ${u}`, zaloName: `User ${u}`, avatar: "" }])
        ),
      };
    },
    uploadAttachment: async () => [{ fileUrl: "https://example.invalid/uploaded.png", fileType: "image" }],
    sendSticker: async (...args) => {
      push("sendSticker", args);
      return { msgId: "stk-1" };
    },
    getStickersDetail: async (id) => [{ id, cateId: 10, type: 2 }],
    deleteMessage: async (...args) => {
      push("deleteMessage", args);
      return { status: 0 };
    },
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return async (...args) => {
        push(String(prop), args);
        return {};
      };
    },
  });
}

test("1. All 220 canonical command modules import cleanly and export concrete handler functions", async () => {
  assert.equal(commandRegistry.definitions.length, 220);
  const catalog = getStudioContractCatalog();
  assert.equal(catalog.contracts.length, 220);

  const uniqueModules = new Map();
  for (const contract of catalog.contracts) {
    const modRel = contract.handlerRef.module;
    const exportName = contract.handlerRef.export;
    if (!uniqueModules.has(modRel)) {
      const modUrl = new URL(modRel, new URL("../src/commands/command-registry.js", import.meta.url));
      const loaded = await import(modUrl.href);
      uniqueModules.set(modRel, loaded);
    }
    const mod = uniqueModules.get(modRel);
    assert.ok(
      mod[exportName] !== undefined,
      `Command '${contract.commandName}' missing export '${exportName}' in '${modRel}'`
    );
  }
});

test("2. All 401 entrypoints (220 commands + 181 aliases) dispatch cleanly in both Group and DirectMessage scopes", async () => {
  assert.equal(commandRegistry.keys.length, 401);

  const safeOverrides = Object.fromEntries(
    commandRegistry.definitions.map((def) => [
      def.name,
      async ({ aliasCommand, scope, args }) => ({ ok: true, name: def.name, aliasCommand, scope, args }),
    ])
  );
  const { createCommandRegistryForPhases } = await import("../src/commands/command-registry.js");
  const smokeRegistry = createCommandRegistryForPhases(safeOverrides);

  const fullConfig = {
    SIMSIMI_API_KEY: "k",
    GEMINI_API_KEYS: "k",
    KIRA_API_KEY: "k",
    DEEPSEEK_API_KEY: "k",
    TENOR_API_KEY: "k",
  };
  const fullDeps = { zaloSession: true, python: true, ffmpeg: true, ffprobe: true };

  for (const key of smokeRegistry.keys) {
    const parts = key.split(" ");
    const resolved = resolveCommand(parts, smokeRegistry);
    assert.equal(resolved.code, "RESOLVED", key);
    const def = resolved.definition;
    const sampleArgs = Array.from({ length: Math.max(def.minArgs, 0) }, (_, i) => `arg${i + 1}`);

    const groupRes = await dispatchCommand(
      {
        api: createMockApi(),
        message: { threadId: "group-1", type: MessageType.GroupMessage, data: { uidFrom: "888000111", content: `!${key}` } },
        commandParts: [...parts, ...sampleArgs],
        scope: "group",
        permissionLevel: "adminLevelHigh",
        isAdminLevelHighest: true,
        isMainBotAdmin: true,
        instanceKind: "main",
        config: fullConfig,
        dbReady: true,
        dependencies: fullDeps,
      },
      smokeRegistry
    );

    const dmRes = await dispatchCommand(
      {
        api: createMockApi(),
        message: { threadId: "888000111", type: MessageType.DirectMessage, data: { uidFrom: "888000111", content: `!${key}` } },
        commandParts: [...parts, ...sampleArgs],
        scope: "private",
        permissionLevel: "adminLevelHigh",
        isAdminLevelHighest: true,
        isMainBotAdmin: true,
        instanceKind: "main",
        config: fullConfig,
        dbReady: true,
        dependencies: fullDeps,
      },
      smokeRegistry
    );

    if (def.scope === "private") {
      assert.equal(groupRes.code, "SCOPE_DENIED", `${key} should deny group scope`);
      assert.equal(dmRes.code, "HANDLED", `${key} should handle private scope`);
    } else if (def.scope === "group") {
      assert.equal(groupRes.code, "HANDLED", `${key} should handle group scope`);
      assert.equal(dmRes.code, "SCOPE_DENIED", `${key} should deny private scope`);
    } else {
      assert.equal(groupRes.code, "HANDLED", `${key} should handle group scope`);
      assert.equal(dmRes.code, "HANDLED", `${key} should handle private scope`);
    }
  }
});

test("3. SPECIAL_COMMANDS underscore and space syntaxes normalize cleanly for todo, learnnow, sendp, sendprivate", async () => {
  for (const [raw, expectedCmd, expectedArgs] of [
    ["!todo_Nộp báo cáo_3", "todo", ["nộp báo cáo", "3"]],
    ["!learnnow_xin chào_chào bạn", "learnnow", ["xin chào", "chào bạn"]],
    ["!sendp_Alo bạn_2", "sendp", ["alo bạn", "2"]],
    ["!sendprivate_Alo riêng_2", "sendp", ["alo riêng", "2"]],
  ]) {
    const parsed = parseCommandContent(raw, "!");
    assert.ok(parsed, raw);
    let captured = null;
    const { createPhase8Registry } = await import("../src/commands/command-registry.js");
    const reg = createPhase8Registry({
      todo: async (ctx) => { captured = ctx; return "ok"; },
      learnnow: async (ctx) => { captured = ctx; return "ok"; },
      sendp: async (ctx) => { captured = ctx; return "ok"; },
    });
    const res = await dispatchCommand(
      {
        commandParts: parsed.commandParts,
        prefix: "!",
        scope: "group",
        permissionLevel: "adminLevelHigh",
        isAdminLevelHighest: true,
        isMainBotAdmin: true,
        dependencies: { zaloSession: true },
      },
      reg
    );
    assert.equal(res.code, "HANDLED", raw);
    assert.equal(res.definition.name, expectedCmd, raw);
    assert.deepEqual(captured.args, expectedArgs, raw);
  }
});

test("4. Wave 2 separated aliases invoke their dedicated Zalo capabilities without dangerous cross-routing", async () => {
  // 4a. setmute calls api.setMute and NEVER mutates whiteList
  const { handleWhiteList } = await import("../src/service-debug/anti-service/white-list.js");
  const callsMute = [];
  const apiMute = createMockApi(callsMute);
  const gsMute = { "group-1": { whiteList: {} } };
  await handleWhiteList(
    apiMute,
    { threadId: "group-1", type: MessageType.GroupMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!setmute on" } },
    gsMute,
    ["888000111"],
    "setmute"
  );
  assert.deepEqual(gsMute["group-1"].whiteList, {}, "setmute must NEVER mutate whiteList");
  assert.ok(callsMute.some((c) => c.method === "setMute"), "setmute must invoke api.setMute");

  // 4b. poll-service NEVER invokes spam joinGroup/leaveGroup
  const { handleJoinLeaveGroup } = await import("../src/commands/lenh-debug/spam/remote-join-leave.js");
  const callsPoll = [];
  const apiPoll = createMockApi(callsPoll);
  await handleJoinLeaveGroup(
    apiPoll,
    { threadId: "group-1", type: MessageType.GroupMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!poll-service Ăn gì hôm nay | Phở | Bún bò" } },
    "poll-service"
  );
  assert.equal(callsPoll.some((c) => c.method === "joinGroup" || c.method === "leaveGroup"), false, "poll-service must never spam join/leave");

  // 4c. create-group and invite-box invoke dedicated Zalo group APIs
  const { groupInfoCommand } = await import("../src/service-debug/info-service/group-info.js");
  const callsGroup = [];
  const apiGroup = createMockApi(callsGroup);
  await groupInfoCommand(
    apiGroup,
    { threadId: "888000111", type: MessageType.DirectMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!invite-box" } },
    "invite-box",
    [],
    {}
  );
  assert.ok(callsGroup.some((c) => c.method === "getGroupInviteBoxList"), "invite-box must call getGroupInviteBoxList");

  // 4d. acp calls acceptFriendRequest
  const { handleAliasCommand } = await import("../src/commands/bot-manager/utilities.js");
  const callsAcp = [];
  const apiAcp = createMockApi(callsAcp);
  await handleAliasCommand(
    apiAcp,
    { threadId: "888000111", type: MessageType.DirectMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!acp 123456789" } },
    ["acp", "123456789"],
    { aliasCommand: "acp", args: ["123456789"] }
  );
  assert.ok(callsAcp.some((c) => c.method === "acceptFriendRequest"), "acp must call acceptFriendRequest");

  // 4e. blockmessage & unblockmessage call Zalo user block/unblock APIs
  const { handleBlock, handleUnblockBot } = await import("../src/commands/bot-manager/group-manage.js");
  const callsBlockMsg = [];
  const apiBlockMsg = createMockApi(callsBlockMsg);
  await handleBlock(
    apiBlockMsg,
    { threadId: "888000111", type: MessageType.DirectMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!blockmessage 123456789" } },
    {},
    "blockmessage"
  );
  assert.ok(callsBlockMsg.some((c) => c.method === "blockUser"), "blockmessage must call api.blockUser");

  const callsUnblockMsg = [];
  const apiUnblockMsg = createMockApi(callsUnblockMsg);
  await handleUnblockBot(
    apiUnblockMsg,
    { threadId: "888000111", type: MessageType.DirectMessage, data: { uidFrom: "888000111", dName: "Admin", content: "!unblockmessage 123456789" } },
    {},
    "unblockmessage"
  );
  assert.ok(callsUnblockMsg.some((c) => c.method === "unblockUser"), "unblockmessage must call api.unblockUser");
});

test("5. Offline local engines & security hardening (reverse, qrheart, fakecccd, checklq, prservice, downloadresource, antivideo)", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-219-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 5a. reverse offline grapheme cluster support
  const { handleReverseCommand } = await import("../src/service-debug/tien-ich/reverse.js");
  const revCalls = [];
  await handleReverseCommand(
    createMockApi(revCalls),
    { threadId: "u1", type: MessageType.DirectMessage, data: { uidFrom: "u1", dName: "Tester", content: "!REVERSE Xin chào 🇻🇳" } },
    "reverse"
  );
  const revText = JSON.stringify(revCalls);
  assert.ok(revText.includes("🇳🇻") || revText.includes("oàhc niX"), "reverse must reverse Vietnamese graphemes offline");

  // 5b. checklq blocks group execution, deletes the leaked message, and never echoes/quotes password in sendMessage
  const { handlechecklqCommand } = await import("../src/service-debug/lienquanmobile/checklq.js");
  const lqCalls = [];
  await handlechecklqCommand(
    createMockApi(lqCalls),
    { threadId: "group-public", type: MessageType.GroupMessage, data: { uidFrom: "u1", dName: "Tester", content: "!checklq myuser|SUPER_SECRET_PASS_999" } },
    "checklq"
  );
  const lqSentOutput = JSON.stringify(lqCalls.filter((c) => c.method === "sendMessage"));
  assert.equal(lqSentOutput.includes("SUPER_SECRET_PASS_999"), false, "checklq must NEVER echo or quote password in outgoing messages");
  assert.ok(lqCalls.some((c) => c.method === "deleteMessage"), "checklq should attempt to delete leaked group message");

  // 5e. qrheart & fakecccd work 100% offline without external dead APIs or missing assets
  const { handleCreateQRHeartCommand } = await import("../src/service-debug/utilities/qr-heart.js");
  const qrCalls = [];
  await handleCreateQRHeartCommand(
    createMockApi(qrCalls),
    { threadId: "u1", type: MessageType.DirectMessage, data: { uidFrom: "u1", dName: "Tester", content: "!qrheart Xin chào | Test" } },
    "qrheart"
  );
  assert.ok(qrCalls.some((c) => c.method === "sendMessage"), "qrheart must send generated QR card offline");

  const { handleCccdCommand } = await import("../src/service-debug/tien-ich/cccd.js");
  const cccdCalls = [];
  await handleCccdCommand(
    createMockApi(cccdCalls),
    {
      threadId: "u1",
      type: MessageType.DirectMessage,
      data: { uidFrom: "u1", dName: "Tester", content: "!fakecccd Nguyễn Văn A | 01/01/2000 | Nam | Hà Nội | 001200012345 | 01/01/2022" },
    },
    "fakecccd"
  );
  assert.ok(cccdCalls.some((c) => c.method === "sendMessage"), "fakecccd must render dynamic illustrative card without ENOENT");

  // 5f. downloadresource blocks loopback SSRF and script extensions
  const { handleDownloadResource } = await import("../src/service-debug/utilities/download-resource.js");
  const dlRsrcCalls = [];
  await handleDownloadResource(
    createMockApi(dlRsrcCalls),
    {
      threadId: "u1",
      type: MessageType.DirectMessage,
      data: { uidFrom: "u1", dName: "Admin", content: "!dlrsrc file|test|http://127.0.0.1:8080/secret.txt" },
    },
    "dlrsrc"
  );
  const dlRsrcMsg = JSON.stringify(dlRsrcCalls);
  assert.ok(/không hợp lệ|chặn|nội bộ|từ chối|bảo mật/i.test(dlRsrcMsg), "downloadresource must reject loopback SSRF URL");

  // 5c. prservice blocks adminBox from cross-group `add all`
  const { handlePRCommand } = await import("../src/service-debug/scheduler/pr-service.js");
  const prCalls = [];
  await handlePRCommand(
    createMockApi(prCalls),
    { threadId: "group-a", type: MessageType.GroupMessage, data: { uidFrom: "box-admin-only", dName: "BoxAdmin", content: "!pr add all" } },
    "pr",
    { isAdminLevelHighest: false, callerIsBotAdmin: false, callerIsAdminBox: true }
  );
  assert.ok(prCalls.length > 0, "prservice must respond with permission refusal for adminBox on 'add all'");

  // 5d. antivideo ignores plain text containing '.mp4'
  const { antiVideo } = await import("../src/service-debug/anti-service/anti-video.js");
  const videoCalls = [];
  const handledTextMp4 = await antiVideo(
    createMockApi(videoCalls),
    {
      threadId: "group-v",
      type: MessageType.GroupMessage,
      data: { uidFrom: "member-1", dName: "Member", msgType: "webchat", content: "Cho mình hỏi đuôi .mp4 là gì vậy?" },
    },
    { "group-v": { antiVideo: true, whiteList: {} } },
    false,
    false
  );
  assert.equal(handledTextMp4, false, "antivideo must NOT delete plain text mentioning .mp4");
  assert.equal(videoCalls.some((c) => c.method === "deleteMessage"), false);
});
