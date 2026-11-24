import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateImage } from "../src/service-debug/api-crawl/assistant-ai/genai.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("image generation fails clearly when Gemini configuration is missing", async () => {
  const previous = process.env.GEMINI_API_KEYS;
  delete process.env.GEMINI_API_KEYS;
  try {
    await assert.rejects(
      () => generateImage("test"),
      (error) => error.code === "MISSING_DEPENDENCY" && error.message.includes("GEMINI_API_KEYS")
    );
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEYS;
    else process.env.GEMINI_API_KEYS = previous;
  }
});

test("Phase 1 source contains no embedded Gemini API key", () => {
  const sourceFiles = [
    "src/commands/command-registry.js",
    "src/commands/gemini-make-command.js",
    "src/service-debug/api-crawl/assistant-ai/genai.js",
  ];
  for (const relativePath of sourceFiles) {
    const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false, relativePath);
  }
});

test("Phase 3 provider handlers contain no embedded API keys", () => {
  const sourceFiles = [
    "src/service-debug/chat-zalo/chat-special/send-sticker/stkmeme-utils.js",
    "src/service-debug/chat-zalo/chat-special/send-gif/send-gif.js",
    "src/service-debug/chat-zalo/chat-special/send-sticker/enhance-image.js",
    "src/service-debug/api-crawl/assistant-ai/gemini.js",
    "src/service-debug/api-crawl/api-hoangdev/aio-downlink.js",
    "src/service-debug/api-crawl/download/aio-downlink.js",
  ];
  for (const relativePath of sourceFiles) {
    const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.equal(/AIza[0-9A-Za-z_-]{20,}/.test(source), false, relativePath);
  }
  assert.match(
    readFileSync(path.join(projectRoot, sourceFiles[0]), "utf8"),
    /process\.env\.TENOR_API_KEY/
  );
  assert.match(
    readFileSync(path.join(projectRoot, sourceFiles[1]), "utf8"),
    /process\.env\.TENOR_API_KEY/
  );
  assert.match(
    readFileSync(path.join(projectRoot, sourceFiles[3]), "utf8"),
    /process\.env\.GEMINI_API_KEYS/
  );
  for (const relativePath of sourceFiles.slice(4)) {
    assert.match(
      readFileSync(path.join(projectRoot, relativePath), "utf8"),
      /process\.env\.HOANGDEV_API_KEY/
    );
  }
});
