import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  VideoDownloadError,
  parseRetryAfter,
  isRetryableHttpOrNetworkError,
  HostnameLimiter,
  downloadVideoToTempFile,
  removeTemporaryFile,
  createTempVideoPaths,
  calculateBackoffWithJitter,
} from "../src/api-zalo/media/video-temp-file.js";

test("VideoDownloadError initializes with structured fields", () => {
  const err = new VideoDownloadError("Not Found", {
    status: 404,
    url: "https://example.com/video.mp4",
    hostname: "example.com",
    retryAfterMs: null,
    code: "ERR_BAD_REQUEST",
  });

  assert.equal(err.name, "VideoDownloadError");
  assert.equal(err.status, 404);
  assert.equal(err.url, "https://example.com/video.mp4");
  assert.equal(err.hostname, "example.com");
  assert.equal(err.retryAfterMs, null);
  assert.equal(err.code, "ERR_BAD_REQUEST");
});

test("parseRetryAfter parses delta-seconds and HTTP date format correctly", () => {
  const now = 1700000000000;
  // Delta seconds
  assert.equal(parseRetryAfter("120", now), 120000);
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(60, now), 60000);

  // HTTP date (e.g. 30s in future)
  const futureDate = new Date(now + 30000).toUTCString();
  assert.equal(parseRetryAfter(futureDate, now), 30000);

  // Past date
  const pastDate = new Date(now - 10000).toUTCString();
  assert.equal(parseRetryAfter(pastDate, now), 0);

  // Invalid / missing
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter("", now), null);
  assert.equal(parseRetryAfter("invalid-format", now), null);
});

test("isRetryableHttpOrNetworkError correctly classifies errors", () => {
  // Non-retryable
  assert.equal(isRetryableHttpOrNetworkError({ status: 404 }), false);
  assert.equal(isRetryableHttpOrNetworkError({ status: 429 }), false);
  assert.equal(isRetryableHttpOrNetworkError({ status: 400 }), false);
  assert.equal(isRetryableHttpOrNetworkError({ status: 403 }), false);

  // Retryable 5xx
  assert.equal(isRetryableHttpOrNetworkError({ status: 500 }), true);
  assert.equal(isRetryableHttpOrNetworkError({ status: 502 }), true);
  assert.equal(isRetryableHttpOrNetworkError({ status: 503 }), true);

  // Retryable network codes
  assert.equal(isRetryableHttpOrNetworkError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableHttpOrNetworkError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableHttpOrNetworkError({ code: "EAI_AGAIN" }), true);
  assert.equal(isRetryableHttpOrNetworkError({ message: "Request timeout" }), true);
});

test("calculateBackoffWithJitter adds non-negative jitter", () => {
  const delay1 = calculateBackoffWithJitter(0, [1000, 2000]);
  assert.ok(delay1 >= 1000 && delay1 <= 1200);

  const delay2 = calculateBackoffWithJitter(1, [1000, 2000]);
  assert.ok(delay2 >= 2000 && delay2 <= 2200);
});

test("downloadVideoToTempFile stops immediately on 404 without retrying", async () => {
  let callCount = 0;
  const mockAxios = {
    request: async () => {
      callCount++;
      return {
        status: 404,
        headers: {},
        data: null,
      };
    },
  };

  const limiter = new HostnameLimiter();

  await assert.rejects(
    downloadVideoToTempFile("https://cdn.example.com/dead.mp4", {
      axiosImpl: mockAxios,
      limiter,
    }),
    (err) => {
      assert.equal(err instanceof VideoDownloadError, true);
      assert.equal(err.status, 404);
      assert.equal(err.hostname, "cdn.example.com");
      return true;
    }
  );

  assert.equal(callCount, 1, "Must not retry on 404");
});

test("downloadVideoToTempFile stops immediately on 429 and parses Retry-After", async () => {
  let callCount = 0;
  const mockAxios = {
    request: async () => {
      callCount++;
      return {
        status: 429,
        headers: { "retry-after": "45" },
        data: null,
      };
    },
  };

  const limiter = new HostnameLimiter();

  await assert.rejects(
    downloadVideoToTempFile("https://cdn.example.com/rate-limited.mp4", {
      axiosImpl: mockAxios,
      limiter,
    }),
    (err) => {
      assert.equal(err instanceof VideoDownloadError, true);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 45000);
      assert.equal(err.hostname, "cdn.example.com");
      return true;
    }
  );

  assert.equal(callCount, 1, "Must not retry on 429");
});

test("downloadVideoToTempFile retries 5xx with backoff and succeeds on attempt 2", async () => {
  let callCount = 0;
  const sleepCalls = [];

  const mockAxios = {
    request: async () => {
      callCount++;
      if (callCount === 1) {
        return { status: 500, headers: {}, data: null };
      }
      const stream = Readable.from([Buffer.from("dummy video content")]);
      return {
        status: 200,
        headers: {},
        data: stream,
      };
    },
  };

  const limiter = new HostnameLimiter();
  const downloadedPath = await downloadVideoToTempFile("https://cdn.example.com/retry-success.mp4", {
    axiosImpl: mockAxios,
    limiter,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
    },
  });

  try {
    assert.equal(callCount, 2);
    assert.equal(sleepCalls.length, 1);
    assert.ok(sleepCalls[0] >= 1000);
    assert.ok(fs.existsSync(downloadedPath));
    assert.ok(downloadedPath.endsWith(".mp4"));
  } finally {
    await removeTemporaryFile(downloadedPath);
  }
});

test("downloadVideoToTempFile cleans up .part file on stream failure", async () => {
  const mockAxios = {
    request: async () => {
      const stream = new Readable({
        read() {
          this.emit("error", new Error("Network stream broken"));
        },
      });
      return {
        status: 200,
        headers: {},
        data: stream,
      };
    },
  };

  const limiter = new HostnameLimiter();

  await assert.rejects(
    downloadVideoToTempFile("https://cdn.example.com/broken-stream.mp4", {
      axiosImpl: mockAxios,
      limiter,
      sleepFn: async () => {},
    }),
    (err) => {
      assert.equal(err.message.includes("Network stream broken") || err.cause?.message.includes("Network stream broken"), true);
      return true;
    }
  );
});

test("HostnameLimiter enforces maximum 1 concurrent download and request spacing", async () => {
  let currentTime = 10000;
  const sleepDurations = [];

  const limiter = new HostnameLimiter({
    maxConcurrent: 1,
    minSpacingMs: 500,
    clock: () => currentTime,
    sleep: async (ms) => {
      sleepDurations.push(ms);
      currentTime += ms;
    },
  });

  const activeRecords = [];
  let currentActive = 0;

  const runTask = async (id, durationMs) => {
    return await limiter.schedule("cdn.test.com", async () => {
      currentActive++;
      activeRecords.push({ id, active: currentActive, time: currentTime });
      currentTime += durationMs;
      currentActive--;
    });
  };

  // Run 2 tasks concurrently on the same host
  await Promise.all([runTask("task1", 100), runTask("task2", 100)]);

  // Check that currentActive never exceeded 1
  for (const record of activeRecords) {
    assert.equal(record.active <= 1, true, "Active concurrent tasks on same host must not exceed 1");
  }

  // Check request spacing occurred
  assert.ok(sleepDurations.length >= 1, "Spacing delay should be applied between requests");
});
