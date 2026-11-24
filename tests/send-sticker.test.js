import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { MessageType } from "../src/api-zalo/models/Message.js";
import {
  collectMediaCandidates,
  convertMediaToWebp,
  downloadFirstValidCandidate,
  normalizeMediaUrl,
  resolveMediaUrlFromQuote,
} from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker-media.js";
import { buildWebpFfmpegOptions } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker-ffmpeg.js";

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABmJLR0QA/wD/AP+gvaeTAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const GIF_BUFFER = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64"
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "send-sticker-test-"));
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url] || routes.default;
    if (!handler) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    handler(req, res);
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createFfmpegStub(outputBuffer = PNG_BUFFER) {
  return (inputPath) => {
    const state = {
      inputPath,
      outputPath: null,
      options: [],
      format: null,
      handlers: {},
    };

    return {
      outputOptions(options) {
        state.options = options;
        return this;
      },
      toFormat(format) {
        state.format = format;
        return this;
      },
      on(event, handler) {
        state.handlers[event] = handler;
        return this;
      },
      save(outputPath) {
        state.outputPath = outputPath;
        fs.writeFileSync(outputPath, outputBuffer);
        state.handlers.start?.(`ffmpeg ${inputPath} -> ${outputPath}`);
        state.handlers.end?.();
        return this;
      },
      state,
    };
  };
}

test("normalizeMediaUrl unwraps escaped slashes", () => {
  assert.equal(
    normalizeMediaUrl("https:\\/\\/example.com\\/a.webp"),
    "https://example.com/a.webp"
  );
});

test("normalizeMediaUrl rewrites Zalo JXL media URLs to JPG variants", () => {
  assert.equal(
    normalizeMediaUrl("https://photo-stal-14.zdn.vn/gr/jxl/abc123/sticker.jxl?token=1"),
    "https://photo-stal-14.zdn.vn/gr/jpg/abc123/sticker.jpg?token=1"
  );
});

test("normalizeMediaUrl rewrites Zalo HEIC media URLs to JPG variants", () => {
  assert.equal(
    normalizeMediaUrl("https://photo-stal-14.zdn.vn/gr/heic/abc123/sticker.heic?token=1"),
    "https://photo-stal-14.zdn.vn/gr/jpg/abc123/sticker.jpg?token=1"
  );
});

test("collectMediaCandidates prefers high-quality URLs and deduplicates repeats", () => {
  const message = {
    data: {
      quote: {
        attach: JSON.stringify({
          thumbUrl: "https://example.com/thumb.webp",
          attachUrl: "https://example.com/preview.webp",
          href: "https://example.com/full.jpg",
        }),
        hdUrl: "https:\\/\\/example.com\\/full.jpg",
      },
    },
  };

  const candidates = collectMediaCandidates(
    message,
    { content: "https://example.com/full.jpg" },
    [{ attach: { href: "https://example.com/preview.webp" } }]
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.url),
    [
      "https://example.com/full.jpg",
      "https://example.com/preview.webp",
      "https://example.com/thumb.webp",
    ]
  );
  assert.equal(candidates[0].source.includes("hdUrl"), true);
});

test("collectMediaCandidates tolerates malformed quote JSON", () => {
  const candidates = collectMediaCandidates(
    {
      data: {
        quote: {
          attach: "{\"href\":\"https://example.com/broken.webp\"",
          href: "https://example.com/fallback.webp",
        },
      },
    },
    null,
    []
  );

  assert.equal(candidates[0].url, "https://example.com/fallback.webp");
});

test("resolveMediaUrlFromQuote uses group history when quote attachment is missing", async () => {
  let called = 0;
  const api = {
    getRecentMessages: async () => {
      called += 1;
      return JSON.stringify({
        groupMsgs: [
          {
            msgId: "456",
            attach: JSON.stringify({ href: "https://example.com/group.webp" }),
          },
        ],
      });
    },
  };

  const message = {
    type: MessageType.GroupMessage,
    threadId: "thread-1",
    data: {
      quote: {
        msgId: "456",
      },
    },
  };

  const url = await resolveMediaUrlFromQuote(api, message);
  assert.equal(url, "https://example.com/group.webp");
  assert.equal(called, 1);
});

test("resolveMediaUrlFromQuote does not query group history for private quotes", async () => {
  let called = 0;
  const api = {
    getRecentMessages: async () => {
      called += 1;
      return JSON.stringify({ groupMsgs: [] });
    },
  };

  const message = {
    type: MessageType.DirectMessage,
    threadId: "thread-1",
    data: {
      quote: {
        href: "https://example.com/private.webp",
      },
    },
  };

  const url = await resolveMediaUrlFromQuote(api, message);
  assert.equal(url, "https://example.com/private.webp");
  assert.equal(called, 0);
});

test("downloadFirstValidCandidate skips html and empty responses before media", async () => {
  await withServer(
    {
      "/html": (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not media</html>");
      },
      "/empty": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end();
      },
      "/image": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      const result = await downloadFirstValidCandidate(
        [
          { url: `${baseUrl}/html`, source: "html", quality: 3 },
          { url: `${baseUrl}/empty`, source: "empty", quality: 2 },
          { url: `${baseUrl}/image`, source: "image", quality: 1 },
        ],
        { tempDir }
      );

      assert.equal(result.source, "image");
      assert.equal(fs.existsSync(result.filePath), true);
      assert.ok(result.mediaType.startsWith("image/"));
    }
  );
});

test("downloadFirstValidCandidate uses unique temp files when called twice in the same millisecond", async () => {
  await withServer(
    {
      "/image": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      const options = {
        tempDir,
        now: () => 123456789,
      };

      const first = await downloadFirstValidCandidate(
        [{ url: `${baseUrl}/image`, source: "first", quality: 1 }],
        { ...options, createId: () => "alpha" }
      );
      const second = await downloadFirstValidCandidate(
        [{ url: `${baseUrl}/image`, source: "second", quality: 1 }],
        { ...options, createId: () => "beta" }
      );

      assert.notEqual(first.filePath, second.filePath);
      assert.ok(first.filePath.includes("123456789_alpha"));
      assert.ok(second.filePath.includes("123456789_beta"));
    }
  );
});

test("convertMediaToWebp resolves relative paths before conversion", async () => {
  const tempDir = makeTempDir();
  const inputPath = path.join(tempDir, "input.png");
  const outputPath = path.join(tempDir, "output.webp");
  fs.writeFileSync(inputPath, PNG_BUFFER);

  const cwd = process.cwd();
  process.chdir(tempDir);
  try {
    await convertMediaToWebp("input.png", "output.webp");
  } finally {
    process.chdir(cwd);
  }

  assert.equal(fs.existsSync(outputPath), true);
});

test("convertMediaToWebp uses FFmpeg for GIF input", async () => {
  const tempDir = makeTempDir();
  const inputPath = path.join(tempDir, "input.gif");
  const outputPath = path.join(tempDir, "output.webp");
  fs.writeFileSync(inputPath, GIF_BUFFER);

  const ffmpegStub = createFfmpegStub();
  let sharpCalled = false;

  await convertMediaToWebp(inputPath, outputPath, {
    fileTypeFromFileImpl: async () => ({ mime: "image/gif", ext: "gif" }),
    sharpImpl: () => {
      sharpCalled = true;
      throw new Error("sharp should not be used for GIF");
    },
    ffmpegImpl: ffmpegStub,
  });

  assert.equal(sharpCalled, false);
  assert.equal(fs.existsSync(outputPath), true);
});

test("convertMediaToWebp uses FFmpeg for JXL input", async () => {
  const tempDir = makeTempDir();
  const inputPath = path.join(tempDir, "input.jxl");
  const outputPath = path.join(tempDir, "output.webp");
  fs.writeFileSync(inputPath, Buffer.from("jxlfake"));

  const ffmpegStub = createFfmpegStub();
  let sharpCalled = false;

  await convertMediaToWebp(inputPath, outputPath, {
    fileTypeFromFileImpl: async () => ({ mime: "image/jxl", ext: "jxl" }),
    sharpImpl: () => {
      sharpCalled = true;
      throw new Error("sharp should not be used for JXL");
    },
    ffmpegImpl: ffmpegStub,
  });

  assert.equal(sharpCalled, false);
  assert.equal(fs.existsSync(outputPath), true);
});

test("buildWebpFfmpegOptions uses a single-frame path for static images", () => {
  const options = buildWebpFfmpegOptions(".png");

  assert.ok(options.includes("-frames:v"));
  assert.ok(options.includes("1"));
  assert.ok(options.includes("-vf"));
  assert.ok(options.includes("scale=512:-2:flags=fast_bilinear"));
  assert.ok(options.includes("-y"));
});

test("buildWebpFfmpegOptions keeps animated media on the frame extraction path", () => {
  const options = buildWebpFfmpegOptions(".gif");

  assert.ok(options.includes("-vf"));
  assert.ok(options.includes("fps=10,scale=512:-2:flags=fast_bilinear"));
  assert.ok(!options.includes("-frames:v"));
});
