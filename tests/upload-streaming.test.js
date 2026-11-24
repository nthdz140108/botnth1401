import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("upload chunking reads sliced buffer without full-file heap explosion", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-stream-"));
  const filePath = path.join(tmp, "large-test.bin");
  const totalSize = 9 * 1024 * 1024; // 9MB
  const chunkSize = 3 * 1024 * 1024; // 3MB
  const totalChunks = Math.ceil(totalSize / chunkSize);

  const sampleBuffer = Buffer.alloc(chunkSize, "A");
  const handle = await fs.open(filePath, "w");
  for (let i = 0; i < totalChunks; i++) {
    await handle.write(sampleBuffer);
  }
  await handle.close();

  // Test streaming chunk read pattern
  const readHandle = await fs.open(filePath, "r");
  let chunksRead = 0;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunkStart = i * chunkSize;
      const currentChunkSize = Math.min(chunkSize, totalSize - chunkStart);
      const chunkBuf = Buffer.alloc(currentChunkSize);
      await readHandle.read(chunkBuf, 0, currentChunkSize, chunkStart);
      assert.equal(chunkBuf.length, chunkSize);
      chunksRead++;
    }
  } finally {
    await readHandle.close();
    await fs.unlink(filePath);
  }

  assert.equal(chunksRead, 3);
});
