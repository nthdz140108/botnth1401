import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveVideoPoolRoot,
  sanitizeLocalPoolDir,
  listLocalVideoCandidates,
  sendLocalVideoWithFallback,
  shuffleList,
  VideoSourceEmptyError,
  VideoToolMissingError,
  VideoFileUnreadableError,
  LOCAL_VIDEO_POOL_DIRS,
} from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "video-local-pool-"));
  for (const dir of LOCAL_VIDEO_POOL_DIRS) {
    fs.mkdirSync(path.join(root, "video", dir), { recursive: true });
  }
  process.env.MYBOT_VIDEO_ROOT = root;
  t.after(() => {
    delete process.env.MYBOT_VIDEO_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("sanitizeLocalPoolDir only allows simple pool names and blocks traversal", () => {
  assert.equal(sanitizeLocalPoolDir("vdgirl"), "vdgirl");
  assert.equal(sanitizeLocalPoolDir("VDGIRL"), "vdgirl");
  assert.equal(sanitizeLocalPoolDir(" vdsexy "), "vdsexy");
  assert.equal(sanitizeLocalPoolDir("pool_2"), "pool_2");

  assert.equal(sanitizeLocalPoolDir("../evil"), null);
  assert.equal(sanitizeLocalPoolDir(".."), null);
  assert.equal(sanitizeLocalPoolDir("."), null);
  assert.equal(sanitizeLocalPoolDir("foo/bar"), null);
  assert.equal(sanitizeLocalPoolDir("a\\b"), null);
  assert.equal(sanitizeLocalPoolDir(""), null);
  assert.equal(sanitizeLocalPoolDir(null), null);
  assert.equal(sanitizeLocalPoolDir(undefined), null);
  assert.equal(sanitizeLocalPoolDir(42), null);
});

test("resolveVideoPoolRoot anchors under the provided project root and honors MYBOT_VIDEO_ROOT", () => {
  const saved = process.env.MYBOT_VIDEO_ROOT;
  try {
    delete process.env.MYBOT_VIDEO_ROOT;
    assert.equal(resolveVideoPoolRoot("C:/bot-root"), path.join("C:/bot-root", "video"));

    process.env.MYBOT_VIDEO_ROOT = "C:/env-root";
    assert.equal(resolveVideoPoolRoot(), path.join("C:/env-root", "video"));
  } finally {
    if (saved === undefined) delete process.env.MYBOT_VIDEO_ROOT;
    else process.env.MYBOT_VIDEO_ROOT = saved;
  }
});

test("scanner accepts nested mp4 files case-insensitively and sorts output", (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdgirl");
  fs.mkdirSync(path.join(poolDir, "season-02"), { recursive: true });
  fs.writeFileSync(path.join(poolDir, "b.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, "a.MP4"), "x");
  fs.writeFileSync(path.join(poolDir, "season-02", "c.mp4"), "x");

  const files = listLocalVideoCandidates("vdgirl");
  assert.equal(files.length, 3);
  const basenames = files.map((f) => path.basename(f).toLowerCase()).sort();
  assert.deepEqual(basenames, ["a.mp4", "b.mp4", "c.mp4"]);
  for (const file of files) {
    assert.ok(path.isAbsolute(file), "candidates must be absolute paths");
  }
});

test("scanner skips audio, partials, non-media files, symlinks, node_modules and hidden entries", (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdanime");
  fs.mkdirSync(path.join(poolDir, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(poolDir, ".hidden"));
  fs.mkdirSync(path.join(poolDir, "nested"), { recursive: true });

  fs.writeFileSync(path.join(poolDir, "keep.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, "song.mp3"), "x");
  fs.writeFileSync(path.join(poolDir, "audio.m4a"), "x");
  fs.writeFileSync(path.join(poolDir, "download.part"), "x");
  fs.writeFileSync(path.join(poolDir, "notes.txt"), "x");
  fs.writeFileSync(path.join(poolDir, "yt-dlp.exe"), "x");
  fs.writeFileSync(path.join(poolDir, ".DS_STORE.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, "node_modules", "pkg", "nested.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, ".hidden", "h.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, "nested", "inner.mp4"), "x");

  // Symlink tới file và thư mục ngoài (bỏ qua trên mọi platform có hỗ trợ)
  try {
    fs.symlinkSync(path.join(root, "video", "vdsad"), path.join(poolDir, "sym-dir"), "junction");
    fs.symlinkSync(path.join(poolDir, "notes.txt"), path.join(poolDir, "sym-file.mp4"), "file");
  } catch {
    // Một số môi trường Windows không cho tạo symlink: bỏ qua phần này
  }

  const basenames = listLocalVideoCandidates("vdanime").map((f) => path.basename(f));
  assert.deepEqual(basenames.sort(), ["inner.mp4", "keep.mp4"]);
});

test("scanner returns an empty list for missing or empty pools without throwing", (t) => {
  makeTempRoot(t);
  assert.deepEqual(listLocalVideoCandidates("vdcos"), []);
  assert.deepEqual(listLocalVideoCandidates("khongtonai"), []);
  assert.deepEqual(listLocalVideoCandidates("../outside"), []);
});

test("newly added files appear in the very next scan without any cache or restart", (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdchill");
  assert.deepEqual(listLocalVideoCandidates("vdchill"), []);

  fs.writeFileSync(path.join(poolDir, "fresh.mp4"), "x");
  const files = listLocalVideoCandidates("vdchill");
  assert.equal(files.length, 1);
  assert.equal(path.basename(files[0]), "fresh.mp4");
});

const STUB_METADATA = Object.freeze({ duration: 3000, width: 640, height: 360, fileSize: 12345 });

// randomFn giữ nguyên thứ tự input sau shuffle (mỗi lần tự swap với chính mình):
// dùng khi test cần biết chính xác candidate nào được thử đầu tiên.
const identityShuffle = () => 0.999999;

/**
 * Preparer injectable cho test luồng dispatcher:
 * - toolMissing: mô phỏng máy thiếu ffmpeg/ffprobe (lỗi dừng cả lượt).
 * - failFor[path]: mô phỏng MP4 hỏng/không đọc được (bỏ qua đúng file đó).
 */
function stubPrepareMedia({ failFor = {}, toolMissing = false } = {}) {
  const calls = [];
  const prepare = async (filePath) => {
    calls.push(filePath);
    if (toolMissing) throw new VideoToolMissingError("ffprobe");
    if (failFor[filePath]) {
      throw new VideoFileUnreadableError(`unreadable: ${path.basename(String(filePath))}`, { stage: "probe" });
    }
    const thumbnailPath = `${filePath}.thumb.jpg`;
    return { filePath, thumbnailPath, metadata: { ...STUB_METADATA } };
  };
  prepare.__calls = calls;
  return prepare;
}

function createLocalApi({ uploadFailures = {}, sendFailures = {}, uploadResults = {} } = {}) {
  const uploads = [];
  const sends = [];
  let uploadCount = 0;
  let sendCount = 0;
  const api = {
    uploadAttachment: async ([filePath], threadId, threadType) => {
      uploadCount += 1;
      uploads.push({ filePath, threadId, threadType });
      if (uploadFailures[filePath] || uploadFailures["*"]) {
        throw new Error(`upload failed for ${path.basename(String(filePath))}`);
      }
      if (uploadResults[filePath] || uploadResults["*"]) {
        return uploadResults[filePath] || uploadResults["*"];
      }
      return [{ fileUrl: `https://up.example/${path.basename(String(filePath))}` }];
    },
    sendVideo: async (payload) => {
      sendCount += 1;
      sends.push(payload);
      if (sendFailures[payload.videoUrl] || sendFailures["*"]) {
        throw sendFailures[payload.videoUrl] instanceof Error
          ? sendFailures[payload.videoUrl]
          : sendFailures["*"] instanceof Error
            ? sendFailures["*"]
            : new Error(`send failed for ${payload.videoUrl}`);
      }
      return { success: true };
    },
  };
  api.__uploads = uploads;
  api.__sends = sends;
  api.__counts = () => ({ uploadCount, sendCount });
  return api;
}

test("local sender uploads video + thumbnail then delivers with real metadata", async (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdboy");
  fs.writeFileSync(path.join(poolDir, "only-one.mp4"), "x");

  const api = createLocalApi();
  const message = { threadId: "thread-boy", type: 1 };
  const ok = await sendLocalVideoWithFallback({
    api,
    message,
    videoFiles: listLocalVideoCandidates("vdboy"),
    caption: "[ Boy ]",
    ttl: 12345,
    pool: "vdboy",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, true);
  // Đúng hai lần upload: video rồi thumbnail
  assert.equal(api.__uploads.length, 2);
  assert.match(api.__uploads[0].filePath, /only-one\.mp4$/);
  assert.match(api.__uploads[1].filePath, /only-one\.mp4\.thumb\.jpg$/);
  assert.equal(api.__uploads[0].threadId, "thread-boy");
  assert.equal(api.__uploads[0].threadType, 1);

  assert.equal(api.__sends.length, 1);
  const payload = api.__sends[0];
  assert.equal(payload.videoUrl, "https://up.example/only-one.mp4");
  assert.equal(payload.thumbnail, "https://up.example/only-one.mp4.thumb.jpg");
  assert.ok(/^https?:\/\//.test(payload.thumbnail), "thumbUrl sent to Zalo must be a real URL");
  assert.equal(payload.videoAlreadyUploaded, true);
  // Metadata thật lấy từ file gốc (stub), không còn mặc định 1280x720/size 0
  assert.equal(payload.duration, STUB_METADATA.duration);
  assert.equal(payload.width, STUB_METADATA.width);
  assert.equal(payload.height, STUB_METADATA.height);
  assert.equal(payload.fileSize, STUB_METADATA.fileSize);
  assert.equal(payload.ttl, 12345);
  assert.equal(payload.message.text, "[ Boy ]");
  assert.equal(payload.message.type, 1);
});

test("prepare stage runs exactly once per candidate before any upload", async (t) => {
  makeTempRoot(t);
  const prepare = stubPrepareMedia();
  const api = createLocalApi();

  await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-order", type: 1 },
    videoFiles: ["C:/p/a.mp4"],
    pool: "vdgirl",
    prepareMedia: prepare,
  });

  assert.equal(prepare.__calls.length, 1);
  assert.equal(api.__counts().uploadCount, 2, "video upload + thumbnail upload");
  assert.ok(api.__uploads.every((u) => u.threadId === "t-order"));
});

test("broken first file is skipped during prepare and the next candidate delivers", async () => {
  const files = ["C:/p/broken.mp4", "C:/p/good.mp4"];
  const prepare = stubPrepareMedia({ failFor: { [files[0]]: true } });
  const api = createLocalApi();

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-skip-broken", type: 1 },
    videoFiles: files,
    pool: "vdsexy",
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });

  assert.equal(ok, true);
  assert.deepEqual(prepare.__calls, files, "both candidates were prepared in order");
  assert.equal(api.__counts().sendCount, 1);
  assert.equal(api.__sends[0].videoUrl, "https://up.example/good.mp4");
  assert.equal(api.__sends[0].thumbnail, "https://up.example/good.mp4.thumb.jpg");
});

test("video upload failure is common to the send and stops the turn without scanning the pool", async () => {
  const files = ["C:/p/a.mp4", "C:/p/b.mp4"];
  const api = createLocalApi({ uploadFailures: { [files[0]]: true } });

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-upload-retry", type: 1 },
    videoFiles: files,
    pool: "vdgirl",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, false);
  // a.mp4 upload fails -> the endpoint/transport error is common to the whole
  // turn: the pool is NOT scanned further (b.mp4 must never be uploaded).
  assert.equal(api.__counts().sendCount, 0);
  const attemptedVideos = api.__uploads.map((u) => u.filePath).filter((f) => f.endsWith(".mp4"));
  assert.deepEqual(attemptedVideos, [files[0]]);
});

test("Zalo rejecting delivery (code 114) after upload stops the whole turn", async () => {
  const files = ["C:/p/a.mp4", "C:/p/b.mp4", "C:/p/c.mp4"];
  const zaloError = new Error("Tham số không hợp lệ");
  zaloError.code = 114;
  const api = createLocalApi({ sendFailures: { "*": zaloError } });

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-114", type: 1 },
    videoFiles: files,
    pool: "vdsad",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, false);
  // Chỉ đúng MỘT video được upload (kèm thumbnail của nó), không cạn pool
  assert.equal(api.__counts().sendCount, 1);
  assert.equal(api.__uploads.length, 2, "one video upload + one thumbnail upload, nothing more");
  assert.match(api.__uploads[0].filePath, /a\.mp4$/);

  // propagateErrors: lỗi gốc (code 114) phải nổi lên nguyên trạng
  await assert.rejects(
    sendLocalVideoWithFallback({
      api: createLocalApi({ sendFailures: { "*": zaloError } }),
      message: { threadId: "t-114-propagate", type: 1 },
      videoFiles: files,
      pool: "vdsad",
      randomFn: identityShuffle,
      prepareMedia: stubPrepareMedia(),
      propagateErrors: true,
    }),
    (error) => error.code === 114 && /Tham số không hợp lệ/.test(error.message),
  );
});

test("thumbnail upload failure stops the turn without delivering anything", async () => {
  const files = ["C:/p/a.mp4", "C:/p/b.mp4"];
  const api = createLocalApi({ uploadFailures: { [`${files[0]}.thumb.jpg`]: true } });

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-thumb-fail", type: 1 },
    videoFiles: files,
    pool: "vdgirl",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, false);
  assert.equal(api.__counts().sendCount, 0, "never deliver with an invalid thumbnail");
  assert.equal(
    api.__uploads.filter((u) => u.filePath.endsWith(".mp4")).length,
    1,
    "must not upload another video after a thumbnail failure",
  );
});

test("upload result violating the contract (no usable URL) stops the turn immediately", async () => {
  const files = ["C:/p/a.mp4", "C:/p/b.mp4"];
  const api = createLocalApi({ uploadResults: { "*": [{}] } });
  let sendCalled = false;
  api.sendVideo = async () => {
    sendCalled = true;
    return { success: true };
  };

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-contract", type: 1 },
    videoFiles: files,
    pool: "vdgirl",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, false);
  assert.equal(sendCalled, false);
  assert.equal(api.__uploads.length, 1, "stops right after the malformed upload result");
});

test("missing ffmpeg/ffprobe aborts the turn without scanning further files", async () => {
  const files = ["C:/p/a.mp4", "C:/p/b.mp4"];
  const prepare = stubPrepareMedia({ toolMissing: true });
  const api = createLocalApi();

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-tool-missing", type: 1 },
    videoFiles: files,
    pool: "vdgirl",
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });

  assert.equal(ok, false);
  assert.equal(prepare.__calls.length, 1, "no point probing the rest of the pool without tools");
  assert.equal(api.__counts().uploadCount, 0);

  await assert.rejects(
    sendLocalVideoWithFallback({
      api,
      message: { threadId: "t-tool-missing-2", type: 1 },
      videoFiles: files,
      pool: "vdgirl",
      randomFn: identityShuffle,
      prepareMedia: stubPrepareMedia({ toolMissing: true }),
      propagateErrors: true,
    }),
    (error) => error instanceof VideoToolMissingError && error.code === "VIDEO_TOOL_MISSING",
  );
});

test("every candidate unreadable during prepare ends as source-empty (safe for scheduler fallback)", async () => {
  const files = ["C:/p/x.mp4", "C:/p/y.mp4"];
  const prepare = stubPrepareMedia({ failFor: { [files[0]]: true, [files[1]]: true } });
  const api = createLocalApi();

  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-all-unreadable", type: 1 },
    videoFiles: files,
    pool: "vdgirl",
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });
  assert.equal(ok, false);
  assert.equal(api.__counts().uploadCount, 0);

  await assert.rejects(
    sendLocalVideoWithFallback({
      api,
      message: { threadId: "t-all-unreadable-2", type: 1 },
      videoFiles: files,
      pool: "vdgirl",
      randomFn: identityShuffle,
      prepareMedia: stubPrepareMedia({ failFor: { [files[0]]: true, [files[1]]: true } }),
      propagateErrors: true,
    }),
    (error) => error instanceof VideoSourceEmptyError && error.code === "VIDEO_SOURCE_EMPTY",
  );
});

test("temporary thumbnails are always cleaned up, even when the turn stops early", async (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdchill");
  fs.writeFileSync(path.join(poolDir, "real-a.mp4"), "x");
  fs.writeFileSync(path.join(poolDir, "real-b.mp4"), "x");
  const files = listLocalVideoCandidates("vdchill");

  // Preparer thật sự tạo file JPEG tạm trên đĩa như ffmpeg sẽ làm
  const prepare = async (filePath) => {
    const thumbnailPath = `${filePath}.thumb.jpg`;
    fs.writeFileSync(thumbnailPath, "jpeg-bytes");
    return { filePath, thumbnailPath, metadata: { ...STUB_METADATA } };
  };

  const okApi = createLocalApi();
  const ok = await sendLocalVideoWithFallback({
    api: okApi,
    message: { threadId: "t-cleanup-ok", type: 1 },
    videoFiles: files,
    pool: "vdchill",
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });
  assert.equal(ok, true);
  for (const file of files) {
    assert.equal(fs.existsSync(`${file}.thumb.jpg`), false, "thumbnail must be removed after success");
  }

  const failApi = createLocalApi({ sendFailures: { "*": new Error("delivery rejected") } });
  await sendLocalVideoWithFallback({
    api: failApi,
    message: { threadId: "t-cleanup-stop", type: 1 },
    videoFiles: files,
    pool: "vdchill",
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });
  for (const file of files) {
    assert.equal(fs.existsSync(`${file}.thumb.jpg`), false, "thumbnail must be removed after an early stop");
  }
});

test("local sender never repeats a candidate within one turn and stops at the first upload failure", async (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdsad");
  const names = ["s1.mp4", "s2.mp4", "s3.mp4"];
  for (const name of names) fs.writeFileSync(path.join(poolDir, name), "x");

  const api = createLocalApi({ uploadFailures: { "*": true } });
  const files = listLocalVideoCandidates("vdsad");
  const ok = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-no-repeat", type: 1 },
    videoFiles: files,
    pool: "vdsad",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });

  assert.equal(ok, false);
  const uploadedBasenames = api.__uploads.map((u) => path.basename(u.filePath)).sort();
  assert.equal(new Set(uploadedBasenames).size, uploadedBasenames.length, "no candidate may repeat in one turn");
  // Upload failure is common to the whole send (same endpoint): exactly one
  // video attempt, the pool is never scanned further.
  assert.equal(api.__uploads.length, 1);
});

test("local sender caps attempts at min(12, pool size) and stops early on success", async (t) => {
  const root = makeTempRoot(t);
  const poolDir = path.join(root, "video", "vdtet");
  const total = 20;
  for (let i = 0; i < total; i += 1) fs.writeFileSync(path.join(poolDir, `tet-${String(i).padStart(2, "0")}.mp4`), "x");

  const api = createLocalApi();
  // sendVideo thành công ngay lần đầu -> 1 upload video + 1 upload thumbnail
  const firstOk = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-cap", type: 1 },
    videoFiles: listLocalVideoCandidates("vdtet"),
    pool: "vdtet",
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });
  assert.equal(firstOk, true);
  assert.equal(api.__counts().uploadCount, 2);

  // Upload failure on the first file stops the whole turn (common endpoint
  // error): only that one video upload is attempted, the 12-attempt cap still
  // trivially holds.
  const failingApi = createLocalApi({ uploadFailures: { "*": true } });
  await sendLocalVideoWithFallback({
    api: failingApi,
    message: { threadId: "t-cap-fail", type: 1 },
    videoFiles: listLocalVideoCandidates("vdtet"),
    pool: "vdtet",
    maxAttempts: 999,
    randomFn: identityShuffle,
    prepareMedia: stubPrepareMedia(),
  });
  assert.ok(failingApi.__counts().uploadCount <= 12, "hard cap of 12 attempts must hold");
  assert.equal(failingApi.__counts().uploadCount, 1, "common upload failure stops the turn after one candidate");
});

test("local sender respects the shared attempt budget across primary and fallback", async () => {
  // Per-file PREPARE failures still advance candidates and consume the shared
  // budget; upload failures stop the turn. Use prepare failures here.
  const prepare = (filePath) => {
    if (String(filePath).endsWith("a.mp4") || String(filePath).endsWith("b.mp4")) {
      const err = new Error(`unreadable ${filePath}`);
      err.code = "VIDEO_PREPARE_FAILED";
      throw err;
    }
    return stubPrepareMedia()(filePath);
  };
  const api = createLocalApi();
  const budget = { remaining: 3 };
  await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-budget", type: 1 },
    videoFiles: ["C:/p/a.mp4", "C:/p/b.mp4", "C:/p/c.mp4", "C:/p/d.mp4", "C:/p/e.mp4"],
    pool: "vdgirl",
    attemptBudget: budget,
    propagateErrors: true,
    randomFn: identityShuffle,
    prepareMedia: prepare,
  });
  assert.equal(budget.remaining, 0);
  // a+b consumed budget via prepare failures; c.mp4 delivered (1 video + 1
  // thumbnail upload) = 2 upload calls total.
  assert.equal(api.__counts().uploadCount, 2);
});

test("local sender does not call upload when the pool is empty and throws VideoSourceEmptyError when propagating", async () => {
  const api = createLocalApi();
  let uploadCalled = false;
  api.uploadAttachment = async () => {
    uploadCalled = true;
    return [{ fileUrl: "https://up.example/x.mp4" }];
  };

  const result = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t-empty", type: 1 },
    videoFiles: [],
    pool: "vdcos",
  });
  assert.equal(result, false);
  assert.equal(uploadCalled, false);

  await assert.rejects(
    sendLocalVideoWithFallback({
      api,
      message: { threadId: "t-empty-2", type: 1 },
      videoFiles: [],
      pool: "vdvuto",
      propagateErrors: true,
    }),
    (error) => error instanceof VideoSourceEmptyError && error.code === "VIDEO_SOURCE_EMPTY",
  );
  assert.equal(uploadCalled, false);
});

test("uploaded URL extraction prefers fileUrl, then hdUrl, then normalUrl; thumbnail accepts thumbUrl too", async () => {
  const seen = [];
  const seenThumbs = [];
  const mkApi = (videoUploadResult, thumbUploadResult) => ({
    uploadAttachment: async ([filePath]) =>
      String(filePath).endsWith(".jpg") ? thumbUploadResult : videoUploadResult,
    sendVideo: async (payload) => {
      seen.push(payload.videoUrl);
      seenThumbs.push(payload.thumbnail);
      return { success: true };
    },
  });

  await sendLocalVideoWithFallback({
    api: mkApi([{ normalUrl: "https://n.example/v.mp4" }], [{ hdUrl: "", normalUrl: "", thumbUrl: "https://t.example/n.jpg" }]),
    message: { threadId: "t-url-order", type: 1 },
    videoFiles: ["C:/p/a.mp4"],
    pool: "vdgirl",
    prepareMedia: stubPrepareMedia(),
  });
  await sendLocalVideoWithFallback({
    api: mkApi([{ hdUrl: "https://h.example/v.mp4", normalUrl: "https://n.example/v.mp4" }], [{ fileUrl: "https://f.example/t.jpg" }]),
    message: { threadId: "t-url-order", type: 1 },
    videoFiles: ["C:/p/b.mp4"],
    pool: "vdgirl",
    prepareMedia: stubPrepareMedia(),
  });
  await sendLocalVideoWithFallback({
    api: mkApi([{ fileUrl: "https://f.example/v.mp4", hdUrl: "https://h.example/v.mp4" }], [{ hdUrl: "https://h.example/t.jpg" }]),
    message: { threadId: "t-url-order", type: 1 },
    videoFiles: ["C:/p/c.mp4"],
    pool: "vdgirl",
    prepareMedia: stubPrepareMedia(),
  });
  // Kết quả upload sai contract -> dừng ngay, không gửi
  await sendLocalVideoWithFallback({
    api: mkApi([{}], [{ thumbUrl: "https://t.example/t.jpg" }]),
    message: { threadId: "t-url-order", type: 1 },
    videoFiles: ["C:/p/d.mp4"],
    pool: "vdgirl",
    prepareMedia: stubPrepareMedia(),
  });

  assert.deepEqual(seen, [
    "https://n.example/v.mp4",
    "https://h.example/v.mp4",
    "https://f.example/v.mp4",
  ]);
  // Thumbnail chấp nhận đủ schema: thumbUrl, fileUrl, hdUrl
  assert.deepEqual(seenThumbs, [
    "https://t.example/n.jpg",
    "https://f.example/t.jpg",
    "https://h.example/t.jpg",
  ]);
});

test("shuffleList is deterministic with an injected randomFn and keeps all items", () => {
  const input = ["a", "b", "c", "d", "e"];
  const out1 = shuffleList(input, () => 0);
  assert.deepEqual([...out1].sort(), input, "shuffle must keep every item exactly once");
  assert.notEqual(out1, input, "shuffle must return a copy");

  const fixedSequence = [0.9, 0.1, 0.5, 0.3];
  let cursor = 0;
  const out2 = shuffleList(input, () => fixedSequence[cursor++ % fixedSequence.length]);
  assert.deepEqual([...out2].sort(), input);
});
