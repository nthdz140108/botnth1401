import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalLogger, stripAnsi } from "../src/utils/terminal-log.js";

function createStream({ isTTY = false, columns = 100 } = {}) {
  let output = "";
  return {
    isTTY,
    columns,
    write(value) {
      output += value;
    },
    output() {
      return output;
    },
  };
}

const fixedNow = () => new Date("2026-08-07T13:34:16.000Z");

test("renders group and private events as plain ASCII event stream with fixed local timestamp", () => {
  const stream = createStream({ columns: 100 });
  const logger = createTerminalLogger({ stream, now: fixedNow, width: 100, colorLevel: 0 });

  logger.write({
    scope: "group",
    fields: [
      { label: "GROUP", value: "Team Alpha", meta: "Group ID: g-1" },
      { label: "FROM", value: "Linh", meta: "Sender ID: u-9" },
      { label: "CONTENT", value: "hello https://example.com/a/b" },
    ],
    countAsMessage: true,
  });
  logger.write({
    scope: "private",
    fields: [
      { label: "FROM", value: "Minh", meta: "Sender ID: u-2" },
      { label: "CONTENT", value: "private note" },
    ],
    countAsMessage: true,
  });

  assert.equal(stream.output(), [
    "[GROUP] 2026-08-07 20:34:16",
    "+-- GROUP   Team Alpha (Group ID: g-1)",
    "+-- FROM    Linh (Sender ID: u-9)",
    "`-- CONTENT hello https://example.com/a/b",
    "[PRIVATE] 2026-08-07 20:34:16",
    "+-- FROM    Minh (Sender ID: u-2)",
    "`-- CONTENT private note",
    "",
  ].join("\n"));
  assert.deepEqual(logger.getStats(), { messages: 2, retries: 0 });
});

test("wraps multiline captions and long urls without dropping characters", () => {
  const stream = createStream({ columns: 52 });
  const logger = createTerminalLogger({ stream, now: fixedNow, width: 52, colorLevel: 0 });
  const url = "https://example.com/" + "a".repeat(70);
  const content = `Caption: line one\nLink: ${url}`;

  logger.write({
    scope: "group",
    fields: [{ label: "CONTENT", value: content }],
  });

  const plain = stream.output();
  assert.match(plain, /Caption: line one/);
  assert.equal(plain.includes(url), true);
  assert.equal(stripAnsi(plain).replace(/\n/g, "").includes(url), true);
});

test("uses ansi colors only when enabled and never when NO_COLOR or redirected", () => {
  const colored = createStream({ isTTY: true });
  createTerminalLogger({ stream: colored, now: fixedNow, colorLevel: 1 }).write({
    scope: "listener",
    fields: [{ label: "STATUS", value: "connected" }],
  });
  assert.match(colored.output(), /\u001b\[/);

  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const noColor = createStream({ isTTY: true });
  createTerminalLogger({ stream: noColor, now: fixedNow, colorLevel: 1 }).write({
    scope: "listener",
    fields: [{ label: "STATUS", value: "connected" }],
  });
  if (previousNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = previousNoColor;
  }
  assert.doesNotMatch(noColor.output(), /\u001b\[/);

  const redirected = createStream({ isTTY: false });
  createTerminalLogger({ stream: redirected, now: fixedNow }).write({
    scope: "listener",
    fields: [{ label: "STATUS", value: "connected" }],
  });
  assert.doesNotMatch(redirected.output(), /\u001b\[/);
});

test("allows managed listener pipes to color when the supervising terminal opted in", () => {
  const previousManagedColor = process.env.MYBOT_FORCE_COLOR;
  process.env.MYBOT_FORCE_COLOR = "1";
  const managedPipe = createStream({ isTTY: false });
  createTerminalLogger({ stream: managedPipe, now: fixedNow }).write({
    scope: "group",
    fields: [{ label: "GROUP", value: "BangBang Light" }],
  });
  if (previousManagedColor === undefined) {
    delete process.env.MYBOT_FORCE_COLOR;
  } else {
    process.env.MYBOT_FORCE_COLOR = previousManagedColor;
  }

  assert.match(managedPipe.output(), /\u001b\[/);
});

test("colors event branches and labels by field tone for easier scanning", () => {
  const stream = createStream({ isTTY: true, columns: 100 });
  createTerminalLogger({ stream, now: fixedNow, colorLevel: 1 }).write({
    scope: "group",
    fields: [
      { label: "GROUP", value: "BangBang Light", meta: "Group ID: 1", tone: "cyan" },
      { label: "FROM", value: "Thanh Hung", meta: "Sender ID: 2", tone: "yellow" },
      { label: "CONTENT", value: "Sticker ID: 50615 | 12658 | 7", tone: "green" },
    ],
  });

  const output = stream.output();
  assert.match(output, /\u001b\[36m\+-- GROUP/);
  assert.match(output, /\u001b\[33m\+-- FROM/);
  assert.match(output, /\u001b\[32m`-- CONTENT/);
  assert.equal(stripAnsi(output).includes("Sticker ID: 50615 | 12658 | 7"), true);
});

test("redraws status after each tty event and keeps status as the final line", () => {
  const stream = createStream({ isTTY: true, columns: 100 });
  const logger = createTerminalLogger({ stream, now: fixedNow, width: 100, colorLevel: 0 });

  logger.writeBanner({ name: "BOT LISTENER", botName: "admin", status: "ONLINE" });
  logger.write({
    scope: "group",
    fields: [{ label: "CONTENT", value: "first event" }],
    countAsMessage: true,
  });
  logger.write({
    scope: "listener",
    level: "warn",
    fields: [{ label: "RETRY", value: "socket failed" }],
    countAsRetry: true,
  });

  const output = stream.output();
  assert.match(output, /\u001b\[1A\u001b\[2K\[GROUP\]/);
  assert.match(output, /\u001b\[1A\u001b\[2K\[LISTENER\]/);
  assert.equal(output.endsWith("ONLINE | messages: 1 | retries: 1\n"), true);
});

test("sanitizes escape and control characters from event data", () => {
  const stream = createStream();
  const logger = createTerminalLogger({ stream, now: fixedNow, colorLevel: 0 });

  logger.write({
    scope: "private",
    fields: [{ label: "CONTENT", value: "safe\u001b[2J\u0007 text" }],
  });

  assert.doesNotMatch(stream.output(), /\u001b\[2J|\u0007/);
  assert.match(stream.output(), /safe text/);
});
