import test from "node:test";
import assert from "node:assert/strict";
import { handleUndoMessage } from "../src/commands/bot-manager/undo-message.js";

const baseMessage = (overrides = {}) => ({
  threadId: "thread-undo",
  type: 1,
  data: {
    msgId: "undo-command-msg",
    cliMsgId: "undo-command-cli",
    uidFrom: "admin-1",
    dName: "Admin",
  },
  ...overrides,
});

function apiStub({ undoMessage = async () => {}, sendMessage = async () => {} } = {}) {
  return { undoMessage, sendMessage };
}

test("undo command targets quoted message, never command IDs", async () => {
  const calls = [];
  const api = apiStub({ undoMessage: async (target) => calls.push(target) });
  const message = baseMessage({
    data: {
      ...baseMessage().data,
      quote: { globalMsgId: "target-server-msg", cliMsgId: "target-client-msg" },
    },
  });

  await handleUndoMessage(api, message);

  assert.deepEqual(calls, [{
    threadId: "thread-undo",
    type: 1,
    data: {
      msgId: "target-server-msg",
      globalMsgId: "target-server-msg",
      cliMsgId: "target-client-msg",
    },
  }]);
  assert.equal(calls[0].data.msgId, "target-server-msg");
  assert.equal(calls[0].data.cliMsgId, "target-client-msg");
  assert.notEqual(calls[0].data.msgId, "undo-command-msg");
  assert.notEqual(calls[0].data.cliMsgId, "undo-command-cli");
});

test("undo command supports top-level quote and preserves direct routing", async () => {
  const calls = [];
  const api = apiStub({ undoMessage: async (target) => calls.push(target) });
  await handleUndoMessage(api, {
    ...baseMessage({ type: 0 }),
    quote: { msgId: "target-msg", cliMsgId: "target-cli" },
  });
  assert.deepEqual(calls[0], {
    threadId: "thread-undo", type: 0,
    data: { msgId: "target-msg", globalMsgId: "target-msg", cliMsgId: "target-cli" },
  });
});

for (const [name, message] of [
  ["without quote", baseMessage()],
  ["without target msg ID", baseMessage({ data: { ...baseMessage().data, quote: { cliMsgId: "target-client-msg" } } })],
  ["without target client ID", baseMessage({ data: { ...baseMessage().data, quote: { globalMsgId: "target-server-msg" } } })],
]) {
  test(`undo command ${name} only sends guidance`, async () => {
    const undoCalls = [];
    const sent = [];
    const api = apiStub({ undoMessage: async () => undoCalls.push(true), sendMessage: async (payload) => sent.push(payload) });
    await handleUndoMessage(api, message);
    assert.deepEqual(undoCalls, []);
    assert.ok(sent.some((payload) => payload.msg?.includes("Hãy reply tin nhắn bot cần thu hồi rồi dùng !undo.")));
  });
}

test("undo command reports API errors once without retry", async () => {
  const sent = [];
  let calls = 0;
  const api = apiStub({
    undoMessage: async () => { calls += 1; throw new Error("transport failed"); },
    sendMessage: async (payload) => sent.push(payload),
  });
  await handleUndoMessage(api, baseMessage({ data: { ...baseMessage().data, quote: { globalMsgId: "target", cliMsgId: "target-cli" } } }));
  assert.equal(calls, 1);
  assert.ok(sent.some((payload) => payload.msg?.includes("Lỗi khi xử lý lệnh undo: transport failed")));
});
