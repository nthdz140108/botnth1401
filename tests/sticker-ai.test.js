import test from "node:test";
import assert from "node:assert/strict";

import * as ai from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/ai.js";
import * as hf from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js";

const { generateStickerImage, hasHuggingFaceConfig, getHuggingFaceConfig, HfInferenceError, __test } = ai;

const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABmJLR0QA/wD/AP+gvaeTAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  hf.resetSharedClientForTests();
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    hf.resetSharedClientForTests();
  }
}

test("sticker-ai: hasHuggingFaceConfig reflects HF_TOKEN presence", () => {
  withEnv({ HF_TOKEN: "hf_test12345" }, () => {
    assert.equal(hasHuggingFaceConfig(), true);
  });
  withEnv({ HF_TOKEN: "" }, () => {
    assert.equal(hasHuggingFaceConfig(), false);
  });
});

test("sticker-ai: getHuggingFaceConfig reads custom models and provider", () => {
  withEnv(
    {
      HF_TOKEN: "hf_test",
      HF_STICKER_T2I_MODEL: "custom/t2i-model",
      HF_STICKER_I2I_MODEL: "custom/i2i-model",
      HF_STICKER_PROVIDER: "together",
      HF_STICKER_TIMEOUT_MS: "60000",
    },
    () => {
      const cfg = getHuggingFaceConfig();
      assert.equal(cfg.t2iModel, "custom/t2i-model");
      assert.equal(cfg.i2iModel, "custom/i2i-model");
      assert.equal(cfg.provider, "together");
      assert.equal(cfg.timeoutMs, 60000);
      assert.equal(cfg.enabled, true);
    }
  );
});

test("sticker-ai: generateStickerImage throws HF_CONFIG_MISSING when HF_TOKEN is absent", async () => {
  await withEnv({ HF_TOKEN: "" }, async () => {
    await assert.rejects(
      () => generateStickerImage({ prompt: "con mèo" }),
      (err) => err instanceof HfInferenceError && err.code === "HF_CONFIG_MISSING"
    );
  });
});

test("sticker-ai: calls free SDXL (textToImage) when no reference image is provided", async () => {
  let calledWith = null;
  const mockClient = {
    textToImage: async (args) => {
      calledWith = args;
      return new Blob([FAKE_PNG], { type: "image/png" });
    },
    imageToImage: async () => {
      throw new Error("Should not be called");
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    const result = await generateStickerImage({ prompt: "mèo đội nón" });

    assert.ok(calledWith);
    assert.equal(calledWith.model, "stabilityai/stable-diffusion-xl-base-1.0");
    assert.equal(calledWith.inputs, "mèo đội nón");
    assert.ok(Buffer.isBuffer(result.imageBuffer));
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.model, "stabilityai/stable-diffusion-xl-base-1.0");
  });
});

test("sticker-ai: calls free I2I model (imageToImage) when reference image is provided", async () => {
  let calledWith = null;
  const mockClient = {
    textToImage: async () => {
      throw new Error("Should not be called");
    },
    imageToImage: async (args) => {
      calledWith = args;
      return new Blob([FAKE_PNG], { type: "image/png" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    const result = await generateStickerImage({
      prompt: "biến thành sticker dễ thương",
      referenceBuffer: FAKE_PNG,
      referenceMimeType: "image/png",
    });

    assert.ok(calledWith);
    assert.equal(calledWith.model, "stabilityai/stable-diffusion-xl-refiner-1.0");
    assert.equal(calledWith.parameters.prompt, "biến thành sticker dễ thương");
    assert.ok(calledWith.inputs instanceof Blob);
    assert.ok(Buffer.isBuffer(result.imageBuffer));
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.model, "stabilityai/stable-diffusion-xl-refiner-1.0");
  });
});

test("sticker-ai: falls back to free text-to-image when image-to-image requires paid provider", async () => {
  let t2iCalled = false;
  const mockClient = {
    imageToImage: async () => {
      const err = new Error("Your account does not have access to provider 'fal-ai'");
      err.status = 403;
      throw err;
    },
    textToImage: async (args) => {
      t2iCalled = true;
      assert.equal(args.model, "stabilityai/stable-diffusion-xl-base-1.0");
      assert.ok(args.inputs.includes("chú chó"));
      return new Blob([FAKE_PNG], { type: "image/png" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    const result = await generateStickerImage({
      prompt: "chú chó",
      referenceBuffer: FAKE_PNG,
      referenceMimeType: "image/png",
    });

    assert.ok(t2iCalled, "Must fall back to free text-to-image when paid provider error is encountered");
    assert.ok(Buffer.isBuffer(result.imageBuffer));
    assert.equal(result.model, "stabilityai/stable-diffusion-xl-base-1.0");
  });
});

test("sticker-ai: retries once on HTTP 429 rate limit and respects Retry-After", async () => {
  let callCount = 0;
  const mockClient = {
    textToImage: async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error("429 Too Many Requests");
        err.status = 429;
        err.response = {
          headers: new Map([["retry-after", "0.05"]]),
        };
        throw err;
      }
      return new Blob([FAKE_PNG], { type: "image/png" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    const result = await generateStickerImage({ prompt: "thử retry 429" });
    assert.equal(callCount, 2, "must retry exactly once");
    assert.ok(Buffer.isBuffer(result.imageBuffer));
  });
});

test("sticker-ai: retries once on HTTP 503 service unavailable", async () => {
  let callCount = 0;
  const mockClient = {
    textToImage: async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error("503 Model is loading");
        err.status = 503;
        err.response = { headers: new Map([["retry-after", "0.05"]]) };
        throw err;
      }
      return new Blob([FAKE_PNG], { type: "image/png" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    const result = await generateStickerImage({ prompt: "thử retry 503" });
    assert.equal(callCount, 2);
    assert.ok(Buffer.isBuffer(result.imageBuffer));
  });
});

test("sticker-ai: does NOT retry on HTTP 401 unauthenticated and throws HF_UNAUTHENTICATED", async () => {
  let callCount = 0;
  const mockClient = {
    textToImage: async () => {
      callCount += 1;
      const err = new Error("401 Unauthorized");
      err.status = 401;
      throw err;
    },
  };

  await withEnv({ HF_TOKEN: "hf_invalid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    await assert.rejects(
      () => generateStickerImage({ prompt: "test" }),
      (err) => err instanceof HfInferenceError && err.code === "HF_UNAUTHENTICATED"
    );
    assert.equal(callCount, 1, "must NOT retry on 401");
  });
});

test("sticker-ai: rejects when HF response is JSON error returned as bytes", async () => {
  const jsonPayload = Buffer.from(JSON.stringify({ error: "Input prompt contains blocked keywords" }));
  const mockClient = {
    textToImage: async () => {
      return new Blob([jsonPayload], { type: "application/json" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    await assert.rejects(
      () => generateStickerImage({ prompt: "test json error" }),
      (err) => err instanceof HfInferenceError && err.code === "HF_INVALID_RESPONSE"
    );
  });
});

test("sticker-ai: rejects when HF response is HTML error page", async () => {
  const htmlPayload = Buffer.from("<html><body>502 Bad Gateway</body></html>");
  const mockClient = {
    textToImage: async () => {
      return new Blob([htmlPayload], { type: "text/html" });
    },
  };

  await withEnv({ HF_TOKEN: "hf_valid_token" }, async () => {
    hf.setMockClientForTests(mockClient);
    await assert.rejects(
      () => generateStickerImage({ prompt: "test html" }),
      (err) => err instanceof HfInferenceError && err.code === "HF_INVALID_RESPONSE"
    );
  });
});
