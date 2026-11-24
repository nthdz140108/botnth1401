import test from "node:test";
import assert from "node:assert/strict";

import {
  formatCalendarDate,
  handleCalendarCommand,
} from "../src/commands/lich-command.js";

const message = (content) => ({
  threadId: "calendar-thread",
  type: 1,
  data: { content, uidFrom: "user" },
});

test("calendar formatting includes Gregorian and lunar date fields", () => {
  const result = formatCalendarDate(new Date(2026, 7, 8));

  assert.equal(result.solar, "08/08/2026");
  assert.match(result.lunar, /Am|Âm|lunar/i);
  assert.ok(result.details);
});

test("calendar command sends a local date response without network access", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
    },
  };

  await handleCalendarCommand(api, message("!lich"), []);

  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.msg, /08\/|2026|Am|Âm|lunar/i);
});

test("calendar command rejects an invalid month argument safely", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload) {
      sent.push(payload);
    },
  };

  await assert.doesNotReject(() => handleCalendarCommand(api, message("!lich month 2026-99"), ["month", "2026-99"]));
  assert.equal(sent.length, 1);
  assert.match(sent[0].msg, /không hợp lệ|invalid/i);
});
