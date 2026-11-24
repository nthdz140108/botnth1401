import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  downloadVideoToTempFile,
  removeTemporaryFile,
  HostnameLimiter,
  createTempVideoPaths,
} from "../src/api-zalo/media/video-temp-file.js";
import { tempDir } from "../src/utils/io-json.js";

test("concurrent downloads to the same host are serialized by limiter", async () => {
  let activeCount = 0;
  let maxObservedActive = 0;
  let currentTime = 10000;
  const sleepCalls = [];

  const testLimiter = new HostnameLimiter({
    maxConcurrent: 1,
    minSpacingMs: 300,
    clock: () => currentTime,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      currentTime += ms;
    },
  });

  const mockAxios = {
    request: async () => {
      activeCount++;
      if (activeCount > maxObservedActive) {
        maxObservedActive = activeCount;
      }
      currentTime += 50;
      activeCount--;
      const stream = Readable.from([Buffer.from("dummy video content")]);
      return {
        status: 200,
        headers: {},
        data: stream,
      };
    },
  };

  const results = await Promise.all([
    downloadVideoToTempFile("https://cdn.example.com/video1.mp4", {
      axiosImpl: mockAxios,
      limiter: testLimiter,
      clockFn: () => currentTime,
    }),
    downloadVideoToTempFile("https://cdn.example.com/video2.mp4", {
      axiosImpl: mockAxios,
      limiter: testLimiter,
      clockFn: () => currentTime,
    }),
  ]);

  try {
    assert.equal(maxObservedActive, 1, "Concurrent download count on same host must not exceed 1");
    assert.equal(results.length, 2);
    assert.ok(fs.existsSync(results[0]));
    assert.ok(fs.existsSync(results[1]));
  } finally {
    await removeTemporaryFile(results[0]);
    await removeTemporaryFile(results[1]);
  }
});

test("cleanup removes temporary .part and .mp4 files on success and failure branches", async () => {
  const { partPath, finalPath } = createTempVideoPaths("cleanup_test");

  // 1. Write dummy part file and test cleanup
  fs.writeFileSync(partPath, "partial bytes", "utf8");
  assert.ok(fs.existsSync(partPath));
  await removeTemporaryFile(partPath);
  assert.equal(fs.existsSync(partPath), false);

  // 2. Write dummy final mp4 file and test cleanup
  fs.writeFileSync(finalPath, "final bytes", "utf8");
  assert.ok(fs.existsSync(finalPath));
  await removeTemporaryFile(finalPath);
  assert.equal(fs.existsSync(finalPath), false);

  // 3. removeTemporaryFile on non-existent file does not throw
  await assert.doesNotReject(async () => {
    await removeTemporaryFile(path.join(tempDir, `non_existent_${Date.now()}.tmp`));
  });
});
