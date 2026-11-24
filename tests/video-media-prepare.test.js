import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareLocalVideoMedia,
  VideoToolMissingError,
  VideoFileUnreadableError,
} from "../src/service-debug/chat-zalo/chat-special/send-video/video-media-prepare.js";

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd-prepare-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function probePayload({ durationSec = 15, width = 720, height = 1280, size = 2048 } = {}) {
  return JSON.stringify({
    streams: [{ codec_type: "video", width, height }],
    format: { duration: String(durationSec), size: String(size) },
  });
}

/**
 * Fake runTool mô phỏng cặp ffprobe/ffmpeg thật:
 * - ffprobe trả JSON metadata theo `probe`.
 * - ffmpeg ghi file JPEG ở đối số cuối; `frameMode` điều khiển kết quả frame.
 */
function makeFakeTools({ probe = {}, frameMode = "ok" } = {}) {
  const invoked = [];
  return {
    invoked,
    runTool: async (binary, args) => {
      invoked.push({ binary, args });
      if (binary === "ffprobe") {
        if (probe.missing) {
          const err = new Error(`spawn ${binary} ENOENT`);
          err.code = "ENOENT";
          throw err;
        }
        if (probe.corrupt) throw new Error("Invalid data found when processing input");
        return { stdout: probePayload(probe.payload), stderr: "" };
      }
      if (binary === "ffmpeg") {
        if (probe.frameToolMissing) {
          const err = new Error(`spawn ${binary} ENOENT`);
          err.code = "ENOENT";
          throw err;
        }
        const outputPath = args[args.length - 1];
        if (frameMode === "ok") fs.writeFileSync(outputPath, "jpeg-bytes");
        else if (frameMode === "empty") fs.writeFileSync(outputPath, "");
        else if (frameMode === "missing") {
          // Không ghi gì: ffmpeg chạy xong nhưng không có frame nào được xuất
        }
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected binary: ${binary}`);
    },
  };
}

test("prepare reads real metadata and extracts a non-empty JPEG frame", async (t) => {
  const tempDir = makeTempDir(t);
  const videoPath = path.join(tempDir, "clip.mp4");
  fs.writeFileSync(videoPath, "mp4-bytes");

  const tools = makeFakeTools();
  const prepared = await prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: tempDir });

  assert.equal(prepared.filePath, videoPath);
  assert.equal(prepared.metadata.duration, 15000);
  assert.equal(prepared.metadata.width, 720);
  assert.equal(prepared.metadata.height, 1280);
  assert.equal(prepared.metadata.fileSize, 2048);
  assert.match(path.basename(prepared.thumbnailPath), /^vd-thumb_.+\.jpg$/);
  assert.ok(fs.existsSync(prepared.thumbnailPath), "thumbnail must exist on disk");
});

test("a very short video still prepares because the first frame is extracted without seeking", async (t) => {
  const tempDir = makeTempDir(t);
  const videoPath = path.join(tempDir, "short.mp4");
  fs.writeFileSync(videoPath, "mp4-bytes");

  // 0.4s: đủ metadata (>0) và frame đầu luôn tồn tại dù video cực ngắn
  const tools = makeFakeTools({ probe: { payload: { durationSec: 0.4 } } });
  const prepared = await prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: tempDir });

  assert.equal(prepared.metadata.duration, 400);
  assert.ok(fs.existsSync(prepared.thumbnailPath));
});

test("a corrupt/unreadable MP4 is reported as an unreadable candidate, not a tool problem", async (t) => {
  const videoPath = makeTempRootFile(t, "broken.mp4");
  const tools = makeFakeTools({ probe: { corrupt: true } });

  await assert.rejects(
    prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) => error instanceof VideoFileUnreadableError && error.code === "VIDEO_FILE_UNREADABLE",
  );
});

test("missing ffprobe aborts with VIDEO_TOOL_MISSING", async (t) => {
  const videoPath = makeTempRootFile(t, "clip.mp4");
  const tools = makeFakeTools({ probe: { missing: true } });

  await assert.rejects(
    prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) => error instanceof VideoToolMissingError && error.code === "VIDEO_TOOL_MISSING" && error.tool === "ffprobe",
  );
  assert.equal(tools.invoked.length, 1, "no ffmpeg call may follow a missing ffprobe");
});

test("missing ffmpeg during frame extraction aborts with VIDEO_TOOL_MISSING", async (t) => {
  const videoPath = makeTempRootFile(t, "clip2.mp4");
  const tools = makeFakeTools({ probe: { frameToolMissing: true } });

  await assert.rejects(
    prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) => error instanceof VideoToolMissingError && error.tool === "ffmpeg",
  );
});

test("an empty thumbnail is rejected instead of being uploaded to Zalo", async (t) => {
  const videoPath = makeTempRootFile(t, "clip3.mp4");
  const tools = makeFakeTools({ frameMode: "empty" });

  await assert.rejects(
    prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) =>
      error instanceof VideoFileUnreadableError && /thumbnail/i.test(error.message),
  );
  assert.equal(tools.invoked.length, 2);
});

test("incomplete metadata (zero duration or dimensions) marks the file unreadable", async (t) => {
  const videoPath = makeTempRootFile(t, "clip4.mp4");
  const tools = makeFakeTools({ probe: { payload: { durationSec: 0 } } });

  await assert.rejects(
    prepareLocalVideoMedia(videoPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) => error instanceof VideoFileUnreadableError && /metadata/i.test(error.message),
  );
});

test("a vanished file fails fast as unreadable without invoking any tool", async (t) => {
  const missingPath = path.join(os.tmpdir(), `vd-gone-${Date.now()}.mp4`);
  const tools = makeFakeTools();

  await assert.rejects(
    prepareLocalVideoMedia(missingPath, { runTool: tools.runTool, tempDirectory: os.tmpdir() }),
    (error) => error instanceof VideoFileUnreadableError,
  );
  assert.equal(tools.invoked.length, 0);
});

function makeTempRootFile(t, name) {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "mp4-bytes");
  return filePath;
}
