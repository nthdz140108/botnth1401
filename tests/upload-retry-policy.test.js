import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { appContext } from "../src/api-zalo/context.js";
import { ZaloApiError } from "../src/api-zalo/Errors/ZaloApiError.js";
import { encodeAES } from "../src/api-zalo/utils.js";
import {
  getUploadConcurrency,
  isRetryableUploadError,
  isNonRetryableAuthOrAppError,
  redactEndpoint,
  resolveChunkSize,
  uploadAttachmentFactory,
} from "../src/api-zalo/apis/uploadAttachment.js";

function readyContext(overrides = {}) {
  Object.assign(appContext, {
    secretKey: "k",
    imei: "imei",
    cookie: "c=1",
    userAgent: "ua",
    ...overrides,
  });
  appContext.uploadCallbacks = new Map();
}

/** Build a protocol-valid encrypted Zalo upload response body. */
function zaloBody(payload, { error = false } = {}) {
  const inner = error
    ? JSON.stringify({ error_code: payload.error_code, error_message: payload.error_message })
    : JSON.stringify({ error_code: 0, data: payload });
  return JSON.stringify({ data: encodeAES("k", inner) });
}

/** Register a fake ws upload callback so file_id responses resolve. */
function deliverCallback(fileId, wsData) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const cb = appContext.uploadCallbacks.get(String(fileId));
      if (cb) {
        clearInterval(timer);
        void cb(wsData).then(resolve);
      }
    }, 20);
  });
}

test("chunk-level retry policy classifies retryable vs fatal failures", () => {
  const timeout = new ZaloApiError("timed out", "HTTP_REQUEST_FAILED");
  timeout.retryable = true;
  assert.equal(isRetryableUploadError(timeout), true, "transport timeout is retryable");
  assert.equal(isRetryableUploadError(new ZaloApiError("bad gateway", 502, 502)), true);
  assert.equal(isRetryableUploadError(new ZaloApiError("too many", 429, 429)), true);
  assert.equal(isRetryableUploadError(new ZaloApiError("timeout", 408, 408)), true);

  assert.equal(isRetryableUploadError(new ZaloApiError("bad request", 400, 400)), false);
  assert.equal(isRetryableUploadError(new ZaloApiError("forbidden", 403, 403)), false);

  // Zalo app error codes (e.g. 114) are never retried.
  assert.equal(isNonRetryableAuthOrAppError(new ZaloApiError("tham số", 114, 200)), true);
  assert.equal(isNonRetryableAuthOrAppError(new ZaloApiError("decrypt failed", "DECRYPT_FAILED")), true);
  assert.equal(isNonRetryableAuthOrAppError(new ZaloApiError("server", 500, 500)), false);
});

test("redactEndpoint strips the query string", () => {
  const url = "https://files.zalo.me/api/message/asyncfile/upload?zpw_ver=671&secret=abc";
  assert.equal(redactEndpoint(url), "https://files.zalo.me/api/message/asyncfile/upload");
});

test("chunk size comes from settings with a 3 MiB fallback", () => {
  appContext.settings = { features: { sharefile: { chunk_size_file: 5 * 1024 * 1024 } } };
  assert.equal(resolveChunkSize(), 5 * 1024 * 1024);
  appContext.settings = { features: { sharefile: {} } };
  assert.equal(resolveChunkSize(), 3 * 1024 * 1024);
  appContext.settings = undefined;
  assert.equal(resolveChunkSize(), 3 * 1024 * 1024);
});

test("VPS default concurrency is 2 (env-configurable, capped at 8)", () => {
  assert.equal(getUploadConcurrency(100), 2);
  assert.equal(getUploadConcurrency(100, "4"), 4);
  assert.equal(getUploadConcurrency(100, "99"), 8);
});

test("upload retries a transient failure with a bounded number of HTTP attempts", async () => {
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-retry-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 1));

  let postCount = 0;
  const server = http.createServer((req, res) => {
    postCount += 1;
    if (postCount === 1) {
      res.writeHead(502);
      res.end("bad gateway");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    // fileId response + a registered ws callback resolves the upload.
    res.end(zaloBody({ fileId: "9001" }));
    deliverCallback("9001", { fileUrl: "https://cdn.example/clip.mp4" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = uploadAttachmentFactory({ zpwServiceMap: appContext.zpwServiceMap });
  const result = await upload([filePath], "thread-1");
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1, "the delivered callback result is surfaced");
  assert.equal(result[0].fileUrl, "https://cdn.example/clip.mp4");
  assert.equal(postCount, 2, "one 5xx followed by one successful attempt (bounded retry, no nested loops)");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a fatal 4xx stops immediately with the original error metadata", async () => {
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-4xx-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 1));

  let postCount = 0;
  const server = http.createServer((req, res) => {
    postCount += 1;
    res.writeHead(403);
    res.end("forbidden");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = uploadAttachmentFactory({ zpwServiceMap: appContext.zpwServiceMap });
  await assert.rejects(
    upload([filePath], "thread-1"),
    (error) => {
      assert.equal(error.status, 403, "original HTTP status is preserved");
      assert.equal(error.chunk, 1, "chunk index is attached");
      assert.match(String(error.file), /clip\.mp4$/, "file name is attached");
      assert.equal(error.attempt, 1, "attempt index is attached");
      assert.doesNotMatch(String(error.endpoint), /\?/, "endpoint query is redacted");
      assert.match(String(error.endpoint), /\/api\/message\//);
      return true;
    },
  );
  assert.equal(postCount, 1, "4xx is never retried");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a Zalo app error code stops immediately and is never retried", async () => {
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-app-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 1));

  let postCount = 0;
  const server = http.createServer((req, res) => {
    postCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(zaloBody({ error_code: 114, error_message: "Tham số không hợp lệ" }, { error: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = uploadAttachmentFactory({ zpwServiceMap: appContext.zpwServiceMap });
  await assert.rejects(
    upload([filePath], "thread-1"),
    (error) => error.code === 114 && /Tham số không hợp lệ/.test(error.message),
  );
  assert.equal(postCount, 1, "Zalo app-code rejection is never retried");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a server-wide 404-style endpoint failure surfaces the original status", async () => {
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-404-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 1));

  let postCount = 0;
  const server = http.createServer((req, res) => {
    postCount += 1;
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = uploadAttachmentFactory({ zpwServiceMap: appContext.zpwServiceMap });
  await assert.rejects(
    upload([filePath], "thread-1"),
    (error) => error.status === 404 && error.chunk === 1 && error.attempt === 1,
  );
  assert.equal(postCount, 1, "404 is never retried");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a lost upload callback rejects within the deadline instead of hanging", async (t) => {
  process.env.ZALO_UPLOAD_CALLBACK_DEADLINE_MS = "300";
  t.after(() => { delete process.env.ZALO_UPLOAD_CALLBACK_DEADLINE_MS; });
  // Re-import with the short deadline for this test.
  const { uploadAttachmentFactory: freshFactory } = await import(
    `../src/api-zalo/apis/uploadAttachment.js?cbdeadline=${Date.now()}`
  );
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-cb-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 1));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // fileId present -> the promise waits for a ws callback that never comes.
    res.end(zaloBody({ fileId: "42" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = freshFactory({ zpwServiceMap: appContext.zpwServiceMap });
  await assert.rejects(
    upload([filePath], "thread-1"),
    (error) => error.code === "UPLOAD_CALLBACK_TIMEOUT",
  );
  assert.equal(appContext.uploadCallbacks.size, 0, "the stale callback is cleaned up");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test("a delivered upload callback resolves with checksum and file URL", async () => {
  readyContext();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-ok-"));
  const filePath = path.join(tmp, "clip.mp4");
  await fs.writeFile(filePath, Buffer.alloc(64 * 1024, 7));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(zaloBody({ fileId: "77" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  appContext.zpwServiceMap = { file: [`http://127.0.0.1:${port}`] };

  const upload = uploadAttachmentFactory({ zpwServiceMap: appContext.zpwServiceMap });
  const pending = upload([filePath], "thread-1");
  // Give the request a beat to register the callback, then deliver it.
  await new Promise((r) => setTimeout(r, 120));
  const cb = appContext.uploadCallbacks.get("77");
  assert.ok(cb, "callback must be registered for the returned fileId");
  await cb({ fileUrl: "https://cdn.example/clip.mp4" });
  const results = await pending;
  assert.equal(results.length, 1);
  assert.equal(results[0].fileUrl, "https://cdn.example/clip.mp4");
  assert.equal(typeof results[0].checksum, "string");

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});
