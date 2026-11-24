import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_PRIORITY,
  generateContentWithModelFallback,
  isRetryableGeminiModelError,
} from "../src/service-debug/api-crawl/assistant-ai/gemini-models.js";

test("Gemini defaults start with a model that supports generateContent", () => {
  assert.equal(DEFAULT_MODEL_PRIORITY[0], "gemini-2.5-flash");
  assert.equal(DEFAULT_MODEL_PRIORITY.includes("gemini-1.5-flash"), false);
});

test("404 model errors are retryable", () => {
  assert.equal(isRetryableGeminiModelError({ status: 404 }), true);
  assert.equal(isRetryableGeminiModelError({ status: 429 }), true);
  assert.equal(isRetryableGeminiModelError({ status: 400 }), false);
});

test("model fallback continues after an unavailable model", async () => {
  const attemptedModels = [];
  const result = await generateContentWithModelFallback(
    ["retired-model", "gemini-2.5-flash"],
    async (model) => {
      attemptedModels.push(model);
      if (model === "retired-model") {
        throw { status: 404 };
      }
      return { text: "ok" };
    }
  );

  assert.deepEqual(attemptedModels, ["retired-model", "gemini-2.5-flash"]);
  assert.deepEqual(result, { model: "gemini-2.5-flash", response: { text: "ok" } });
});
