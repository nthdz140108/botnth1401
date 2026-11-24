import test from "node:test";
import assert from "node:assert/strict";
import { findUndoOriginalMessage } from "../src/service-debug/anti-service/anti-undo-utils.js";

const cachedMessage = {
  cliMsgId: "cli-1",
  threadId: "group-1",
  idTo: "group-1",
  uidFrom: "user-1",
  isUndo: false,
};

test("antiundo resolves cached messages by cliMsgId for the same group and sender", () => {
  const result = findUndoOriginalMessage(
    { "cli-1": cachedMessage },
    {
      threadId: "group-1",
      data: {
        idTo: "group-1",
        uidFrom: "user-1",
        content: { cliMsgId: "cli-1" },
      },
    }
  );

  assert.equal(result.reason, null);
  assert.equal(result.message, cachedMessage);
});

test("antiundo rejects cache entries from another group or sender", () => {
  const wrongGroup = findUndoOriginalMessage(
    { "cli-1": cachedMessage },
    {
      threadId: "group-2",
      data: {
        idTo: "group-2",
        uidFrom: "user-1",
        content: { cliMsgId: "cli-1" },
      },
    }
  );
  const wrongSender = findUndoOriginalMessage(
    { "cli-1": cachedMessage },
    {
      threadId: "group-1",
      data: {
        idTo: "group-1",
        uidFrom: "user-2",
        content: { cliMsgId: "cli-1" },
      },
    }
  );

  assert.equal(wrongGroup.message, null);
  assert.equal(wrongGroup.reason, "thread-mismatch");
  assert.equal(wrongSender.message, null);
  assert.equal(wrongSender.reason, "sender-mismatch");
});
