import test from "node:test";
import assert from "node:assert/strict";
import { runMessageProtection } from "../src/automations/message-protection.js";

test("message protection stops after the first handled rule", async () => {
  const calls = [];
  const result = await runMessageProtection(
    {
      context: {
        threadId: "group-1",
        message: { id: "msg-1" },
      },
      rules: [
        {
          name: "first",
          run: async () => {
            calls.push("first");
            return { handled: true, rule: "first", action: "delete" };
          },
        },
        {
          name: "second",
          run: async () => {
            calls.push("second");
            return { handled: true, rule: "second", action: "block" };
          },
        },
      ],
    }
  );

  assert.deepEqual(calls, ["first"]);
  assert.deepEqual(result, { handled: true, rule: "first", action: "delete" });
});
