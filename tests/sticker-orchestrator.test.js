import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { handleStickerCommand, __test } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/index.js";
import { StickerParseError } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/parser.js";

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABmJLR0QA/wD/AP+gvaeTAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const REAL_SYSTEM_TMP = os.tmpdir();
const ORIGINAL_TEMP = process.env.TEMP;
const ORIGINAL_TMP = process.env.TMP;

function makeTempDir() {
  return fs.mkdtempSync(path.join(REAL_SYSTEM_TMP, "stk-orch-"));
}

async function runWithTempDir(fn) {
  const tempDir = makeTempDir();
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;
  try {
    return await fn(tempDir);
  } finally {
    process.env.TEMP = ORIGINAL_TEMP;
    process.env.TMP = ORIGINAL_TMP;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handler = routes[url.pathname] || routes.default;
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createMockApi(overrides = {}) {
  const sent = {
    messages: [],
    uploads: [],
    customStickers: [],
  };

  const api = {
    sent,
    sendMessage: async (payload, threadId, type) => {
      const text = typeof payload === "string" ? payload : payload?.msg || "";
      sent.messages.push({ payload, threadId, type, text });
    },
    sendCustomSticker: async (msg, staticUrl, animationUrl, width, height, ttl, options = {}) => {
      sent.customStickers.push({ msg, staticUrl, animationUrl, width, height, ttl, options });
    },
    uploadAttachment: async (filePaths, targetId, type) => {
      sent.uploads.push({ filePaths, targetId, type });
      const isPng = filePaths[0].endsWith(".png");
      const url = isPng
        ? `https://cdn/preview_${path.basename(filePaths[0])}`
        : `https://cdn/sticker_${path.basename(filePaths[0])}`;
      return [{ fileUrl: url, normalUrl: url }];
    },
    getRecentMessages: async () => ({ groupMsgs: [] }),
    ...overrides,
  };
  return api;
}

test("classifyError returns category for known errors", () => {
  assert.equal(__test.classifyError({ code: "MISSING_DEPENDENCY" }), "missing-dependency");
  assert.equal(__test.classifyError({ code: "MEDIA_TOO_COMPLEX" }), "media-too-complex");
  assert.equal(__test.classifyError({ code: "AI_NO_IMAGE" }), "ai-no-image");
  assert.equal(__test.classifyError({ code: "HF_CONFIG_MISSING" }), "hf-config-missing");
  assert.equal(__test.classifyError({ code: "HF_UNAUTHENTICATED" }), "hf-unauthenticated");
  assert.equal(__test.classifyError({ code: "HF_RATE_LIMIT" }), "hf-rate-limit");
  assert.equal(__test.classifyError({ code: "HF_TIMEOUT" }), "hf-timeout");
  assert.equal(__test.classifyError(new StickerParseError("test")), "syntax");
  assert.equal(__test.classifyError({ message: "File không đọc được" }), "media-detection");
  assert.equal(__test.classifyError({ message: "Không tải được file" }), "media-download");
  assert.equal(__test.classifyError({ message: "upload thất bại" }), "upload");
});

test("handleStickerCommand sends usage guide for bare command with no source", async () => {
  const api = createMockApi();
  const message = {
    data: { dName: "Tester", quote: null, content: "!stk" },
    threadId: "t1",
    type: 1,
  };

  await handleStickerCommand(api, message, { aliasCommand: "stk" });
  assert.ok(api.sent.messages.length >= 1);
  assert.ok(
    api.sent.messages.some((m) => m.text.toLowerCase().includes("hướng dẫn") || m.text.includes("reply vào ảnh"))
  );
});

test("handleStickerCommand returns parse-error warning for invalid text color", async () => {
  const api = createMockApi();
  const message = {
    data: { dName: "Tester", quote: null, content: "!stk textvd magenta Hi" },
    threadId: "t1",
    type: 1,
  };

  await handleStickerCommand(api, message, { aliasCommand: "stk" });
  assert.ok(api.sent.messages.some((m) => m.text.includes("Màu")));
});

test("handleStickerCommand rejects speed on static text without spin", async () => {
  const api = createMockApi();
  const message = {
    data: { dName: "Tester", quote: null, content: "!stk sp(2) text Xin chào" },
    threadId: "t1",
    type: 1,
  };

  await handleStickerCommand(api, message, { aliasCommand: "stk" });
  assert.ok(api.sent.messages.some((m) => m.text.includes("speed (sp)")));
});

test("handleStickerCommand runs text mode end-to-end with dual upload and custom sticker", async () => {
  await runWithTempDir(async () => {
    const api = createMockApi();
    const message = {
      data: { dName: "Tester", quote: null, content: "!stk text Xin chào tiếng Việt" },
      threadId: "t1",
      type: 1,
    };

    await handleStickerCommand(api, message, { aliasCommand: "stk" });

    // Verify dual upload: preview PNG and sticker WebP
    assert.equal(api.sent.uploads.length, 2, "must upload both preview PNG and sticker WebP");
    assert.ok(api.sent.uploads[0].filePaths[0].endsWith(".png"), "first upload must be preview PNG");
    assert.ok(api.sent.uploads[1].filePaths[0].endsWith(".webp"), "second upload must be sticker WebP");

    // Verify sendCustomSticker arguments
    assert.equal(api.sent.customStickers.length, 1);
    const custom = api.sent.customStickers[0];
    assert.ok(custom.staticUrl.includes("preview_"), "staticUrl must be preview URL");
    assert.ok(custom.animationUrl.includes("sticker_"), "animationUrl must be sticker URL");
    assert.ok(custom.width > 0 && custom.height > 0, "dimensions must be positive");
    assert.equal(custom.ttl, 3600000);

    // Verify completion message sent
    assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
  });
});

test("handleStickerCommand runs text mode with full effect combo", async () => {
  await runWithTempDir(async () => {
    const api = createMockApi();
    const message = {
      data: { dName: "Tester", quote: null, content: "!sticker -r(20) z(1.2) rot(90) fh fv pixel(8) text Hiệu ứng đẹp" },
      threadId: "t1",
      type: 1,
    };

    await handleStickerCommand(api, message, { aliasCommand: "sticker" });
    assert.equal(api.sent.customStickers.length, 1);
    assert.equal(api.sent.uploads.length, 2);
    assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
  });
});

test("handleStickerCommand runs text mode with spin and speed animation", async () => {
  await runWithTempDir(async () => {
    const api = createMockApi();
    const message = {
      data: { dName: "Tester", quote: null, content: "!stk spin sp(2) text Quay tròn" },
      threadId: "t1",
      type: 1,
    };

    await handleStickerCommand(api, message, { aliasCommand: "stk" });
    assert.equal(api.sent.customStickers.length, 1);
    assert.equal(api.sent.uploads.length, 2);
    assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
  });
});

test("handleStickerCommand runs textvd mode end-to-end", async () => {
  await runWithTempDir(async () => {
    const api = createMockApi();
    const message = {
      data: { dName: "Tester", quote: null, content: "!stk textvd đỏ Rực lửa" },
      threadId: "t1",
      type: 1,
    };

    await handleStickerCommand(api, message, { aliasCommand: "stk" });
    assert.equal(api.sent.customStickers.length, 1);
    assert.equal(api.sent.uploads.length, 2);
    assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
  });
});

test("handleStickerCommand runs direct image URL mode end-to-end", async () => {
  await withServer(
    {
      "/sticker.png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      await runWithTempDir(async () => {
        const api = createMockApi();
        const message = {
          data: { dName: "Tester", quote: null, content: `!stk -r(15) ${baseUrl}/sticker.png` },
          threadId: "t1",
          type: 1,
        };

        await handleStickerCommand(api, message, { aliasCommand: "stk" });
        assert.equal(api.sent.customStickers.length, 1);
        assert.equal(api.sent.uploads.length, 2);
        assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
      });
    }
  );
});

test("handleStickerCommand runs reply image mode end-to-end", async () => {
  await withServer(
    {
      "/quoted.png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      await runWithTempDir(async () => {
        const api = createMockApi();
        const message = {
          data: {
            dName: "Tester",
            quote: {
              href: `${baseUrl}/quoted.png`,
              attach: JSON.stringify({ href: `${baseUrl}/quoted.png` }),
            },
            content: "!stk cat",
          },
          threadId: "t1",
          type: 1,
        };

        await handleStickerCommand(api, message, { aliasCommand: "stk" });
        assert.equal(api.sent.customStickers.length, 1);
        assert.equal(api.sent.uploads.length, 2);
        assert.ok(api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")));
      });
    }
  );
});

test("handleStickerCommand cleans up job directory even when send fails", async () => {
  await runWithTempDir(async (tempDir) => {
    const message = {
      data: { dName: "Tester", quote: null, content: "!stk text dọn dẹp" },
      threadId: "t1",
      type: 1,
    };

    const api = createMockApi({
      sendCustomSticker: async () => {
        throw new Error("simulated send failure");
      },
    });

    await handleStickerCommand(api, message, { aliasCommand: "stk" });
    assert.ok(
      !api.sent.messages.some((m) => m.text.includes("Sticker của bạn đây!")),
      "must NOT report success when sendCustomSticker fails"
    );
    assert.ok(
      api.sent.messages.some((m) => m.text.includes("Lỗi (process)")),
      "must report failure message"
    );

    const leftover = fs.readdirSync(tempDir).filter((f) => f.startsWith("sticker-job-"));
    assert.equal(leftover.length, 0, "temporary job directory must be completely removed");
  });
});

test("handleStickerCommand with bare direct image URL sends stickerKind 'photo'", async () => {
  await withServer(
    {
      "/plain.png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      await runWithTempDir(async () => {
        const api = createMockApi();
        const message = {
          data: { dName: "Tester", quote: null, content: `!stk ${baseUrl}/plain.png` },
          threadId: "t1",
          type: 1,
        };

        await handleStickerCommand(api, message, { aliasCommand: "stk" });
        assert.equal(api.sent.customStickers.length, 1);
        const custom = api.sent.customStickers[0];
        assert.equal(custom.options?.stickerKind, "photo", "bare command without effects must be photo");
      });
    }
  );
});

test("handleStickerCommand with effects sends stickerKind 'ai'", async () => {
  await withServer(
    {
      "/effect.png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      await runWithTempDir(async () => {
        const api = createMockApi();
        const message = {
          data: { dName: "Tester", quote: null, content: `!stk -r(20) ${baseUrl}/effect.png` },
          threadId: "t1",
          type: 1,
        };

        await handleStickerCommand(api, message, { aliasCommand: "stk" });
        assert.equal(api.sent.customStickers.length, 1);
        const custom = api.sent.customStickers[0];
        assert.equal(custom.options?.stickerKind, "ai", "sticker with effects must be ai");
      });
    }
  );
});

test("handleStickerCommand ai text-to-image calls free SDXL for Admin Tối Cao and sends stickerKind 'ai'", async () => {
  const { setMockClientForTests, resetSharedClientForTests } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js");
  await runWithTempDir(async () => {
    process.env.HF_TOKEN = "test-token";

    let sdxlCalled = false;
    const mockClient = {
      textToImage: async (args) => {
        sdxlCalled = true;
        assert.equal(args.model, "stabilityai/stable-diffusion-xl-base-1.0");
        assert.equal(args.inputs, "chú mèo phi hành gia");
        return new Blob([PNG_BUFFER], { type: "image/png" });
      },
      imageToImage: async () => {
        throw new Error("Should not be called");
      },
    };

    setMockClientForTests(mockClient);
    try {
      const api = createMockApi();
      const message = {
        data: { dName: "Tester", quote: null, content: "!stk ai chú mèo phi hành gia" },
        threadId: "t1",
        type: 1,
      };

      await handleStickerCommand(api, message, { aliasCommand: "stk", isAdminLevelHighest: true });
      assert.ok(sdxlCalled, "SDXL base must be called for text-to-image prompt");
      assert.equal(api.sent.customStickers.length, 1);
      assert.equal(api.sent.customStickers[0].options?.stickerKind, "ai");
    } finally {
      resetSharedClientForTests();
    }
  });
});

test("handleStickerCommand ai reply image-to-image calls free I2I for Admin Tối Cao and sends stickerKind 'ai'", async () => {
  await withServer(
    {
      "/reply.png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      const { setMockClientForTests, resetSharedClientForTests } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js");
      await runWithTempDir(async () => {
        process.env.HF_TOKEN = "test-token";

        let i2iCalled = false;
        const mockClient = {
          imageToImage: async (args) => {
            i2iCalled = true;
            assert.equal(args.model, "stabilityai/stable-diffusion-xl-refiner-1.0");
            assert.equal(args.parameters.prompt, "biến thành sticker chibi");
            assert.ok(args.inputs instanceof Blob);
            return new Blob([PNG_BUFFER], { type: "image/png" });
          },
          textToImage: async () => {
            throw new Error("Should not be called");
          },
        };

        setMockClientForTests(mockClient);
        try {
          const api = createMockApi();
          const message = {
            data: {
              dName: "Tester",
              quote: { href: `${baseUrl}/reply.png`, attach: JSON.stringify({ href: `${baseUrl}/reply.png` }) },
              content: "!stk ai biến thành sticker chibi",
            },
            threadId: "t1",
            type: 1,
          };

          await handleStickerCommand(api, message, { aliasCommand: "stk", isAdminLevelHighest: true });
          assert.ok(i2iCalled, "I2I model must be called for reply image-to-image");
          assert.equal(api.sent.customStickers.length, 1);
          assert.equal(api.sent.customStickers[0].options?.stickerKind, "ai");
        } finally {
          resetSharedClientForTests();
        }
      });
    }
  );
});

test("handleStickerCommand ai rejects non-admin with warning and does not call HF", async () => {
  const api = createMockApi();
  const message = {
    data: { dName: "MemberUser", quote: null, content: "!stk ai vẽ một con rồng" },
    threadId: "t1",
    type: 1,
  };

  await handleStickerCommand(api, message, { aliasCommand: "stk", isAdminLevelHighest: false });
  assert.equal(api.sent.customStickers.length, 0, "non-admin must not generate AI sticker");
  assert.ok(
    api.sent.messages.some((m) => m.text.includes("chỉ dành riêng cho Admin tối cao")),
    "must send Admin Tối Cao permission warning to non-admin"
  );
});

test("handleStickerCommand tryAiFallback is disabled for non-admin on local error", async () => {
  await runWithTempDir(async () => {
    const { setMockClientForTests, resetSharedClientForTests } = await import("../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js");
    process.env.HF_TOKEN = "test-token";

    let hfAttempted = false;
    const mockClient = {
      textToImage: async () => {
        hfAttempted = true;
        return new Blob([PNG_BUFFER], { type: "image/png" });
      },
    };
    setMockClientForTests(mockClient);

    try {
      const message = {
        data: { dName: "NormalUser", quote: null, content: "!stk text lỗi xử lý" },
        threadId: "t1",
        type: 1,
      };

      const api = createMockApi({
        sendCustomSticker: async () => {
          throw new Error("simulated local send failure");
        },
      });

      await handleStickerCommand(api, message, { aliasCommand: "stk", isAdminLevelHighest: false });
      assert.equal(hfAttempted, false, "AI fallback must NOT be attempted for non-admin");
      assert.ok(api.sent.messages.some((m) => m.text.includes("Lỗi (process)")));
    } finally {
      resetSharedClientForTests();
    }
  });
});

test("sendCustomSticker: payload contract correctly sets pStickerType and properties", async () => {
  const { sendCustomStickerFactory } = await import("../src/api-zalo/apis/sendCustomerSticker.js");
  const { appContext } = await import("../src/api-zalo/context.js");
  const { decodeAES } = await import("../src/api-zalo/utils.js");

  appContext.secretKey = "12345678901234567890123456789012";
  appContext.imei = "test-imei";
  appContext.cookie = "test-cookie";
  appContext.userAgent = "test-ua";

  const capturedParamsList = [];

  const routes = {
    default: (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const match = body.match(/params=([^&]+)/);
        if (match) {
          const encrypted = decodeURIComponent(match[1]);
          const decrypted = decodeAES(appContext.secretKey, encrypted);
          capturedParamsList.push(JSON.parse(decrypted));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error_code: 0, data: { msgId: "123" } }));
      });
    },
  };

  await withServer(routes, async (baseUrl) => {
    const mockApi = {
      zpwServiceMap: { file: [baseUrl] },
    };
    const sendFn = sendCustomStickerFactory(mockApi);

    // 1. Direct message - Bare photo sticker (stickerKind: "photo")
    const photoMsg = { type: 0, threadId: "user_123", data: { quote: null } };
    await sendFn(photoMsg, "https://cdn/prev.png", "https://cdn/stk.webp", 512, 512, 0, { stickerKind: "photo" });

    assert.equal(capturedParamsList.length, 1);
    const capturedParams1 = capturedParamsList[0];
    assert.equal(capturedParams1.pStickerType, undefined, "photo sticker must NOT have pStickerType");
    assert.equal(capturedParams1.thumb_height, 512, "thumb_height must equal height");
    assert.equal(capturedParams1.thumb_width, 512, "thumb_width must equal width");
    const photoProps = JSON.parse(capturedParams1.properties);
    assert.equal(photoProps.type, 3);
    const photoExt = JSON.parse(photoProps.ext);
    assert.equal(photoExt.sSrcStr, "@STICKER");
    assert.equal(photoExt.sSrcType, 0);

    // 2. Group message - AI sticker (stickerKind: "ai")
    const aiMsg = { type: 1, threadId: "group_456", data: { quote: null } };
    await sendFn(aiMsg, "https://cdn/prev.png", "https://cdn/stk.webp", 512, 512, 0, { stickerKind: "ai" });

    assert.equal(capturedParamsList.length, 2);
    const capturedParams2 = capturedParamsList[1];
    assert.equal(capturedParams2.pStickerType, 1, "AI sticker must have pStickerType: 1");
    assert.equal(capturedParams2.thumb_height, 512);
    assert.equal(capturedParams2.thumb_width, 512);
    const aiProps = JSON.parse(capturedParams2.properties);
    assert.equal(aiProps.type, 3);
    const aiExt = JSON.parse(aiProps.ext);
    assert.equal(aiExt.sSrcStr, "", "AI sticker sSrcStr must be empty");
    assert.equal(aiExt.sSrcType, -1, "AI sticker sSrcType must be -1");
    assert.equal(capturedParams2.grid, "group_456", "Group message must target grid");
  });
});
