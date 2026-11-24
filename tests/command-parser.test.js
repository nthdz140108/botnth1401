import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandContent } from "../src/commands/command-parser.js";

test("normalizes leading whitespace and preserves argument casing", () => {
  assert.deepEqual(parseCommandContent("   !  GeMiNi   MaKe  Cat", "!"), {
    command: "gemini",
    commandParts: ["GeMiNi", "MaKe", "Cat"],
  });
});

test("keeps special underscore commands compatible after leading whitespace", () => {
  assert.deepEqual(parseCommandContent("  !TODO_answer", "!"), {
    command: "todo",
    commandParts: ["!TODO", "answer"],
  });
});

test("returns null when the content does not use the configured prefix", () => {
  assert.equal(parseCommandContent("help", "!"), null);
});

test("matches an alphabetic prefix case-insensitively", () => {
  assert.deepEqual(parseCommandContent("  p   INFO", "P"), {
    command: "info",
    commandParts: ["INFO"],
  });
});
