import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { downloadWithRetry } from "../src/service-debug/chat-zalo/chat-special/send-sticker/sticker/download.js";

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABmJLR0QA/wD/AP+gvaeTAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sticker-download-test-"));
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

const fakeFileTypeFromBuffer = async (buffer) => {
  const head = buffer.subarray(0, 8);
  if (head[0] === 0x89 && head[1] === 0x50) return { ext: "png", mime: "image/png" };
  if (head.subarray(0, 3).toString() === "GIF") return { ext: "gif", mime: "image/gif" };
  return null;
};

test("downloadWithRetry retries on ECONNRESET-like network errors", async () => {
  let attempts = 0;
  await withServer(
    {
      "/flaky": (req, res) => {
        attempts += 1;
        if (attempts < 3) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      const result = await downloadWithRetry(
        [{ url: `${baseUrl}/flaky`, source: "test" }],
        { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch, timeoutMs: 5000 }
      );
      assert.equal(result.mediaType, "image/png");
      assert.equal(attempts, 3);
    }
  );
});

test("downloadWithRetry does not retry on HTTP 404", async () => {
  let attempts = 0;
  await withServer(
    {
      "/missing": (req, res) => {
        attempts += 1;
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing");
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      await assert.rejects(
        downloadWithRetry(
          [{ url: `${baseUrl}/missing`, source: "test" }],
          { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch }
        )
      );
      assert.equal(attempts, 1);
    }
  );
});

test("downloadWithRetry does not retry on HTML response", async () => {
  let attempts = 0;
  await withServer(
    {
      "/html": (req, res) => {
        attempts += 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      await assert.rejects(
        downloadWithRetry(
          [{ url: `${baseUrl}/html`, source: "test" }],
          { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch }
        )
      );
      assert.equal(attempts, 1);
    }
  );
});

test("downloadWithRetry falls back to next candidate when first fails", async () => {
  await withServer(
    {
      "/html": (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html></html>");
      },
      "/png": (req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BUFFER);
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      const result = await downloadWithRetry(
        [
          { url: `${baseUrl}/html`, source: "first" },
          { url: `${baseUrl}/png`, source: "second" },
        ],
        { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch }
      );
      assert.equal(result.source, "second");
    }
  );
});

test("downloadWithRetry enforces max bytes cap", async () => {
  await withServer(
    {
      "/big": (req, res) => {
        res.writeHead(200, { "content-type": "image/png", "content-length": "999999999" });
        res.end(Buffer.alloc(1024));
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      await assert.rejects(
        downloadWithRetry(
          [{ url: `${baseUrl}/big`, source: "test" }],
          { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch, maxBytes: 10 }
        )
      );
    }
  );
});

test("downloadWithRetry rejects when MIME detection returns non-media", async () => {
  await withServer(
    {
      "/raw": (req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from("raw data"));
      },
    },
    async (baseUrl) => {
      const tempDir = makeTempDir();
      await assert.rejects(
        downloadWithRetry(
          [{ url: `${baseUrl}/raw`, source: "test" }],
          { tempDir, fileTypeFromBuffer: fakeFileTypeFromBuffer, fetchImpl: globalThis.fetch }
        )
      );
    }
  );
});
