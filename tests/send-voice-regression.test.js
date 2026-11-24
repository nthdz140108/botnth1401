import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("voice TTS falls back to direct upload when text is a single language segment", () => {
  const source = readFileSync(
    path.join(projectRoot, "src/service-debug/chat-zalo/chat-special/send-voice/send-voice.js"),
    "utf8"
  );

  assert.match(source, /if \(parts\.length === 1\) \{\s+return await textToSpeech\(parts\[0\]\.text, api, message, parts\[0\]\.lang\);\s+\}/s);
});

test("voice TTS emphasizes repeated words before splitting by language", () => {
  const source = readFileSync(
    path.join(projectRoot, "src/service-debug/chat-zalo/chat-special/send-voice/send-voice.js"),
    "utf8"
  );

  assert.match(source, /function emphasizeRepeatedWords\(text\) \{/);
  assert.match(source, /const normalizedText = emphasizeRepeatedWords\(text\);\s+const parts = splitByLanguage\(normalizedText\);/s);
  assert.doesNotMatch(source, /expandRepeatedCharacters/);
});
