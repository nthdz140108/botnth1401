import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import {
  createTempVideoPaths,
  removeTemporaryFile,
} from "../src/api-zalo/media/video-temp-file.js";

test("createTempVideoPaths returns paired part and mp4 paths", () => {
  const { partPath, finalPath } = createTempVideoPaths("sample");
  assert.match(partPath, /sample_[0-9a-f-]+\.part$/);
  assert.match(finalPath, /sample_[0-9a-f-]+\.mp4$/);
  assert.notEqual(partPath, finalPath);
});

test("removeTemporaryFile ignores missing files", async () => {
  await removeTemporaryFile(path.join(tmpdir(), `missing-${Date.now()}.tmp`));
});

test("sendVideo source now routes remote URLs through local-first helpers", () => {
  const source = readFileSync(
    path.resolve("src/api-zalo/apis/sendVideo.js"),
    "utf8",
  );

  assert.match(source, /downloadVideoToTempFile\(videoUrl\)/);
  // Thumbnail ưu tiên nguồn local (localThumbnailSource) rồi mới tới localVideoPath
  assert.match(source, /const thumbnailSource = localThumbnailSource \|\| localVideoPath;/);
  assert.match(source, /execFileAsync\((?:ffmpegBin|"ffmpeg"), \["-i", thumbnailSource/);
  assert.match(source, /cleanupPaths\.push\(localVideoPath\)/);
  assert.match(source, /finally \{/);
  assert.match(source, /removeTemporaryFile\(filePath\)/);
});

test("temporary video helper module exists alongside the sendVideo API", () => {
  assert.equal(
    fs.existsSync(path.resolve("src/api-zalo/media/video-temp-file.js")),
    true,
  );
});
