import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

/**
 * Runs `handleMute` in a child Node process with the same validation/test
 * env used by `tests/all-group-commands.test.js`, so importing
 * `src/index.js` (transitive of `mute-user.js`) does not spin up the QR
 * recovery flow.
 *
 * The child returns a JSON result describing whether the message was
 * treated as muted and which `api.deleteMessage` calls (if any) happened.
 */
async function runMuteCase({
  threadId = "group-1",
  senderId = "user-1",
  content = "hello world",
  mentions = [],
  messageType = "group",
  muteList = {},
  flags = {},
  deleteThrows = false,
  deleteOnlyMe = false,
} = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mute-key-test-"));
  const configPath = path.join(runtimeRoot, "test-bot.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "test-bot", name: "test-bot" })
  );

  const moduleUrl = pathToFileURL(
    path.join(projectRoot, "src/service-debug/anti-service/mute-user.js")
  ).href;

  const script = `
    const module = await import(${JSON.stringify(moduleUrl)});
    const groupSettings = {
      ${JSON.stringify(threadId)}: {
        nameGroup: "Test Group",
        activeBot: true,
        muteList: ${JSON.stringify(muteList)},
        whiteList: {},
        adminList: {}
      }
    };
    const message = {
      threadId: ${JSON.stringify(threadId)},
      type: ${JSON.stringify(messageType)},
      data: {
        content: ${JSON.stringify(content)},
        mentions: ${JSON.stringify(mentions)},
        dName: "Sender",
        uidFrom: ${JSON.stringify(senderId)},
        cliMsgId: "cli-${Math.random().toString(36).slice(2, 8)}",
        msgId: "msg-" + Date.now(),
        idTo: ${JSON.stringify(threadId)}
      }
    };
    const deleteCalls = [];
    const api = {
      deleteMessage: async (m, onlyMe) => {
        deleteCalls.push({
          cliMsgId: m.data.cliMsgId,
          msgId: m.data.msgId,
          uidFrom: m.data.uidFrom,
          threadId: m.threadId,
          type: m.type,
          onlyMe: onlyMe === undefined ? null : onlyMe,
        });
        if (${deleteThrows ? "true" : "false"}) {
          throw new Error("simulated zalo api 404");
        }
      }
    };
    try {
      const muted = await module.handleMute(
        api,
        message,
        groupSettings,
        ${JSON.stringify(flags)}
      );
      process.stdout.write("__RESULT__" + JSON.stringify({
        ok: true,
        muted,
        deleteCalls,
      }) + "__END__");
    } catch (err) {
      process.stdout.write("__RESULT__" + JSON.stringify({
        ok: false,
        error: err.stack || err.message,
      }) + "__END__");
    }
    process.exit(0);
  `;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        SKIP_ENV_VALIDATION: "1",
        PROJECT_ROOT: projectRoot,
        CONFIG_PATH: configPath,
        BOT_ID: "test-bot",
      },
      timeout: 15000,
    }
  );

  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `Subprocess output did not match expected structure: ${stdout}`);
  const result = JSON.parse(match[1]);
  if (!result.ok) {
    assert.fail(`Subprocess reported error: ${result.error}`);
  }
  return result;
}

// --- 1. Bot là trưởng nhóm (key vàng) — mute user, nhiều tin, mỗi tin
// phải bị gọi deleteMessage với ID chính tin đó.
test("gold key (creator) deletes each muted message with its own IDs", async () => {
  for (let i = 0; i < 3; i++) {
    const r = await runMuteCase({
      senderId: "spammer",
      content: `spam ${i}`,
      muteList: { spammer: { name: "Spammer", timeMute: -1 } },
      flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
    });
    assert.equal(r.muted, true, `iter ${i}: muted should be true`);
    assert.equal(r.deleteCalls.length, 1, `iter ${i}: exactly one delete`);
    assert.equal(r.deleteCalls[0].uidFrom, "spammer");
    assert.equal(r.deleteCalls[0].threadId, "group-1");
    assert.equal(r.deleteCalls[0].type, "group");
    // cliMsgId must be the one from the current message, not a cached one.
    assert.match(r.deleteCalls[0].cliMsgId, /^cli-/);
    // onlyMe:false => bot xóa cho cả nhóm.
    assert.equal(r.deleteCalls[0].onlyMe, false);
  }
});

// --- 2. Bot là phó nhóm (key bạc) — hành vi tương tự trưởng nhóm.
test("silver key (adminIds contains bot) deletes each muted message", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "spam",
    muteList: { spammer: { name: "Spammer", timeMute: -1 } },
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, true);
  assert.equal(r.deleteCalls.length, 1);
  assert.equal(r.deleteCalls[0].uidFrom, "spammer");
});

// --- 3. Bot chỉ là adminBox nhưng không có key vàng/bạc — KHÔNG gọi API xóa.
test("adminBox without gold/silver key must NOT call deleteMessage", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "spam",
    muteList: { spammer: { name: "Spammer", timeMute: -1 } },
    flags: { isAdminBox: true, botCanDeleteGroupMessages: false, isSelf: false },
  });
  // Message vẫn bị block khỏi chat/command/protection, nhưng API xóa
  // không được gọi vì bot thiếu key vàng/bạc.
  assert.equal(r.muted, true);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 4a. mute all áp dụng cho mọi người, kể cả adminBox thường.
test("mute all applies to adminBox users (non-unmute content)", async () => {
  const r = await runMuteCase({
    senderId: "adminbox-1",
    content: "just chatting",
    muteList: { "-1": { name: "All Users", timeMute: -1 } },
    flags: { isAdminBox: true, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, true);
  assert.equal(r.deleteCalls.length, 1);
});

// --- 4b. mute all vẫn cho phép !unmute all từ adminBox đi qua.
test("mute all lets adminBox !unmute all pass through", async () => {
  const r = await runMuteCase({
    senderId: "adminbox-1",
    content: "!unmute all",
    muteList: { "-1": { name: "All Users", timeMute: -1 } },
    flags: { isAdminBox: true, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, false, "unmute must be allowed through");
  assert.equal(r.deleteCalls.length, 0);
});

// --- 4c. adminBox bị mute cá nhân vẫn dùng được !unmute (kèm mention).
test("individually-muted adminBox can !unmute themselves with mention", async () => {
  const r = await runMuteCase({
    senderId: "adminbox-1",
    content: "@adminbox-1 !unmute",
    mentions: [{ uid: "adminbox-1", pos: 0, len: 13 }],
    muteList: { "adminbox-1": { name: "Admin", timeMute: -1 } },
    flags: { isAdminBox: true, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, false);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 5. Sau unmute (muteList rỗng) — tin mới không bị block.
test("no-mute state never returns muted and never calls delete", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "hello",
    muteList: {},
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, false);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 5b. Mute tạm hết hạn — isMuted() tự xóa entry; tin mới đi qua.
test("expired mute lets the next message through", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "hello",
    muteList: { spammer: { name: "Spammer", timeMute: 1 } }, // đã hết hạn
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, false);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 6. Bot tự gửi tin — không tự xóa.
test("bot's own messages are never muted or deleted", async () => {
  const r = await runMuteCase({
    senderId: "test-bot",
    content: "I am the bot",
    muteList: { "test-bot": { name: "Bot", timeMute: -1 } },
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: true },
  });
  assert.equal(r.muted, false);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 7. API xóa lỗi — listener không crash, tin vẫn bị block khỏi
// chat/command/protection (muted=true để caller skip phần còn lại).
test("delete API error does not crash and still blocks the message", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "spam",
    muteList: { spammer: { name: "Spammer", timeMute: -1 } },
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
    deleteThrows: true,
  });
  assert.equal(r.muted, true, "muted must remain true so pipeline short-circuits");
  assert.equal(r.deleteCalls.length, 1, "delete was attempted once");
});

// --- 8. Không có key vàng/bạc + API lỗi — vẫn không gọi delete và vẫn block.
test("no gold/silver key + no API call + still blocks muted message", async () => {
  const r = await runMuteCase({
    senderId: "spammer",
    content: "spam",
    muteList: { spammer: { name: "Spammer", timeMute: -1 } },
    flags: { isAdminBox: true, botCanDeleteGroupMessages: false, isSelf: false },
  });
  assert.equal(r.muted, true);
  assert.equal(r.deleteCalls.length, 0);
});

// --- 9. Sanity: non-muted sender is never deleted regardless of capability.
test("non-muted sender is never deleted even with delete capability", async () => {
  const r = await runMuteCase({
    senderId: "innocent",
    content: "just talking",
    muteList: { spammer: { name: "Spammer", timeMute: -1 } }, // người khác bị mute
    flags: { isAdminBox: false, botCanDeleteGroupMessages: true, isSelf: false },
  });
  assert.equal(r.muted, false);
  assert.equal(r.deleteCalls.length, 0);
});
