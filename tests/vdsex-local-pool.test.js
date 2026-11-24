process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageMention } from "../src/api-zalo/models/Message.js";
import {
  VIDEO_TYPES,
  VIDEO_SOURCE_KINDS,
  LOCAL_VIDEO_POOL_DIRS,
  resolveVideoPoolConfig,
  handleVideoCommand,
  sendLocalVideoWithFallback,
  setLocalVideoMediaPreparer,
  VideoSourceEmptyError,
} from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";
import { SENDTASK_GIRL_CATEGORIES } from "../src/commands/studio/sendtask-defaults.js";

function setupTempRoot(t, { pools = ["vdsex", "vdsexy"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdsex-local-pool-"));
  const videoRoot = path.join(root, "video");
  for (const pool of pools) {
    const poolDir = path.join(videoRoot, pool);
    fs.mkdirSync(poolDir, { recursive: true });
  }
  process.env.MYBOT_VIDEO_ROOT = root;
  t.after(() => {
    delete process.env.MYBOT_VIDEO_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, videoRoot };
}

const stubPrepareMedia = () => async (filePath) => ({
  filePath,
  thumbnailPath: `${filePath}.thumb.jpg`,
  metadata: { duration: 12000, width: 720, height: 1280, fileSize: 524288 },
});

test("VIDEO_TYPES: every command maps to LOCAL_DIRECTORY (no URL pool remains)", () => {
  const offenders = [];
  for (const [name, typeConfig] of Object.entries(VIDEO_TYPES)) {
    for (const [variantName, variant] of Object.entries(typeConfig.variants)) {
      if (variant.kind !== VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY) {
        offenders.push(`${name}.${variantName}=${variant.kind}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `no VIDEO_TYPES variant may use remote sources, got: ${offenders}`);
});

test("VIDEO_TYPES: sex -> vdsex with 1h TTL", () => {
  const sex = VIDEO_TYPES.sex?.variants?.default;
  assert.ok(sex, "sex default variant must exist");
  assert.equal(sex.kind, VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY);
  assert.equal(sex.source, "vdsex");
  assert.equal(sex.ttl, 3600000);
});

test("LOCAL_VIDEO_POOL_DIRS includes vdsex (sex pool moved to local)", () => {
  assert.ok(LOCAL_VIDEO_POOL_DIRS.includes("vdsex"));
  // Sanity: các pool khác vẫn local
  for (const pool of ["vdgirl", "vdsexy", "vdanime", "vdsex"]) {
    assert.ok(LOCAL_VIDEO_POOL_DIRS.includes(pool), `${pool} must remain in local pool list`);
  }
});

test("SENDTASK_GIRL_CATEGORIES vẫn chứa 'sex' (giữ enum để tương thích)", () => {
  assert.ok(SENDTASK_GIRL_CATEGORIES.includes("sex"));
});

test("resolveVideoPoolConfig: sex đọc LOCAL_DIRECTORY với source 'vdsex'", () => {
  const cfg = resolveVideoPoolConfig({ type: "sex" });
  assert.deepEqual(cfg, {
    kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY,
    source: "vdsex",
    ttl: 3600000,
    variant: "default",
  });
});

test("resolveVideoPoolConfig: sexy đọc LOCAL_DIRECTORY với source 'vdsexy' (không chéo sang vdsex)", () => {
  const cfg = resolveVideoPoolConfig({ type: "sexy" });
  assert.deepEqual(cfg, {
    kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY,
    source: "vdsexy",
    ttl: 3600000,
    variant: "default",
  });
});

test("vdsex và vdsexy không đọc chéo pool của nhau", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex", "vdsexy"] });
  const vdsexClip = path.join(videoRoot, "vdsex", "clip.mp4");
  const vdsexyClip = path.join(videoRoot, "vdsexy", "clip.mp4");
  fs.writeFileSync(vdsexClip, "vdsex-content");
  fs.writeFileSync(vdsexyClip, "vdsexy-content");

  const vdsexCfg = resolveVideoPoolConfig({ type: "sex" });
  const vdsexyCfg = resolveVideoPoolConfig({ type: "sexy" });

  const { listLocalVideoCandidates } = await import(
    "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js"
  );
  const vdsexFiles = listLocalVideoCandidates("vdsex");
  const vdsexyFiles = listLocalVideoCandidates("vdsexy");

  assert.equal(vdsexCfg.source, "vdsex");
  assert.equal(vdsexyCfg.source, "vdsexy");
  assert.equal(vdsexFiles.length, 1);
  assert.equal(vdsexyFiles.length, 1);
  assert.notEqual(vdsexFiles[0], vdsexyFiles[0]);
});

test("handleVideoCommand: !vdsex trong thread thiếu pool gửi đúng 1 thông báo source-empty", async (t) => {
  // Không setupTempRoot -> MYBOT_VIDEO_ROOT trỏ về repo, video/vdsex/ không tồn tại
  delete process.env.MYBOT_VIDEO_ROOT;
  const messages = [];
  const api = {
    uploadAttachment: async () => [{ fileUrl: "https://u/x.mp4" }],
    sendVideo: async () => ({ success: true }),
    sendMessage: async (payload, threadId, threadType) => {
      messages.push({ payload, threadId, threadType });
    },
  };
  const message = {
    threadId: "thread-vdsex-empty",
    type: 1,
    data: { uidFrom: "u1", dName: "Alice" },
  };

  await handleVideoCommand(api, message, "sex");

  assert.equal(messages.length, 1, "phải gửi đúng một thông báo source-empty");
  const reply = messages[0].payload.msg;
  assert.match(reply, /video\/vdsex/);
  assert.match(reply, /thiếu hoặc trống/i);
});

test("handleVideoCommand: !vdsex upload video + thumbnail rồi gọi sendVideo với videoAlreadyUploaded: true", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  const clipPath = path.join(videoRoot, "vdsex", "clip.mp4");
  fs.writeFileSync(clipPath, "fake-mp4-bytes");

  setLocalVideoMediaPreparer(stubPrepareMedia());

  const uploads = [];
  const sendVideoCalls = [];
  let threadSeenByUpload = null;
  const api = {
    uploadAttachment: async ([filePath], threadId, threadType) => {
      uploads.push({ filePath, threadId, threadType });
      threadSeenByUpload = threadId;
      return [{ fileUrl: `https://uploaded.example/${path.basename(String(filePath))}` }];
    },
    sendVideo: async (payload) => {
      sendVideoCalls.push(payload);
      return { success: true };
    },
    sendMessage: async () => {
      throw new Error("no failure message expected on success path");
    },
  };

  const message = {
    threadId: "thread-vdsex-ok",
    type: 1,
    data: { uidFrom: "u42", dName: "Bob" },
  };

  await handleVideoCommand(api, message, "sex");

  // Hai lần upload: 1 cho video gốc, 1 cho thumbnail tạm
  assert.equal(uploads.length, 2, "phải upload đúng video và thumbnail");
  assert.equal(uploads[0].filePath, clipPath, "lần upload đầu phải là file video trong vdsex");
  assert.match(uploads[1].filePath, /\.thumb\.jpg$/, "lần upload thứ hai phải là thumbnail");

  assert.equal(sendVideoCalls.length, 1, "chỉ gửi đúng một video");
  const sent = sendVideoCalls[0];
  assert.equal(sent.videoAlreadyUploaded, true);
  assert.equal(sent.threadId, "thread-vdsex-ok");
  assert.equal(sent.threadType, 1);
  assert.match(sent.videoUrl, /^https:\/\/uploaded\.example\/clip\.mp4$/);
  assert.match(sent.thumbnail, /^https:\/\/uploaded\.example\//);
  assert.equal(sent.ttl, 3600000, "TTL theo VIDEO_TYPES.sex.default.ttl");
  // Caption format hiện hành: '[ <senderName> ]' + khoảng trắng cố định giữa ']' và biến thể
  // (variant=default nên không có phần '( ... )').
  assert.equal(sent.message.text, "[ Bob ] ");
  assert.equal(sent.message.type, 1);
  assert.ok(Array.isArray(sent.message.mentions) && sent.message.mentions.length === 1);
  // MessageMention uidFrom = "u42", length = senderName.length = 3 ("Bob")
  const expectedMention = MessageMention("u42", 3, 2, false);
  assert.deepEqual(sent.message.mentions[0], expectedMention);
  assert.equal(threadSeenByUpload, "thread-vdsex-ok");
});

test("handleVideoCommand: vdsex độc lập với vdsexy, không lẫn pool", async (t) => {
  // Chỉ seed vdsex; vdsexy trống -> nếu dispatcher nhầm pool sẽ trả source-empty.
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  const clip = path.join(videoRoot, "vdsex", "only-vdsex.mp4");
  fs.writeFileSync(clip, "x");

  setLocalVideoMediaPreparer(stubPrepareMedia());

  let sendVideoCount = 0;
  const api = {
    uploadAttachment: async ([filePath]) => [{ fileUrl: `https://u/${path.basename(String(filePath))}` }],
    sendVideo: async () => {
      sendVideoCount += 1;
      return { success: true };
    },
    sendMessage: async (payload) => {
      throw new Error(`should not message on success: ${payload?.msg}`);
    },
  };

  await handleVideoCommand(api, { threadId: "t", type: 1, data: { uidFrom: "u", dName: "U" } }, "sex");
  assert.equal(sendVideoCount, 1);
});

test("sendLocalVideoWithFallback: pool rỗng trả false và KHÔNG throw nếu không propagateErrors", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  // Không ghi file nào vào vdsex
  const api = {
    uploadAttachment: async () => [{ fileUrl: "x" }],
    sendVideo: async () => ({ success: true }),
  };
  const out = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t", type: 1 },
    videoFiles: [], // rỗng: thư mục vdsex không có .mp4
    pool: "vdsex",
  });
  assert.equal(out, false);
});

test("sendLocalVideoWithFallback: pool thiếu file .mp4 vẫn ném VideoSourceEmptyError với propagateErrors=true", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  // Tạo file không phải .mp4
  fs.writeFileSync(path.join(videoRoot, "vdsex", "note.txt"), "noise");
  await assert.rejects(
    sendLocalVideoWithFallback({
      api: {
        uploadAttachment: async () => [{ fileUrl: "x" }],
        sendVideo: async () => ({ success: true }),
      },
      message: { threadId: "t", type: 1 },
      videoFiles: [], // không có candidate MP4
      pool: "vdsex",
      propagateErrors: true,
    }),
    (error) =>
      error instanceof VideoSourceEmptyError &&
      error.code === "VIDEO_SOURCE_EMPTY" &&
      /vdsex/.test(error.message),
  );
});

test("sendLocalVideoWithFallback: file không phải MP4 bị listLocalVideoCandidates lọc bỏ", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  fs.writeFileSync(path.join(videoRoot, "vdsex", "photo.jpg"), "jpg");
  fs.writeFileSync(path.join(videoRoot, "vdsex", "doc.pdf"), "pdf");
  fs.writeFileSync(path.join(videoRoot, "vdsex", "real.mp4"), "ok");
  // Import qua require tránh vòng lặp; listLocalVideoCandidates đã được re-export
  const { listLocalVideoCandidates } = await import(
    "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js"
  );
  const found = listLocalVideoCandidates("vdsex");
  assert.equal(found.length, 1, "chỉ giữ file .mp4");
  assert.match(found[0], /real\.mp4$/);
});

test("sendLocalVideoWithFallback: MP4 hỏng (prepare lỗi) -> skip file đó và thử tiếp", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  const broken = path.join(videoRoot, "vdsex", "broken.mp4");
  const ok = path.join(videoRoot, "vdsex", "ok.mp4");
  fs.writeFileSync(broken, "broken");
  fs.writeFileSync(ok, "ok");

  // Stub prepare: fail cho file broken, success cho các file khác.
  setLocalVideoMediaPreparer(async (filePath) => {
    if (filePath === broken) {
      const err = new Error("ffprobe: invalid data found");
      err.code = "VIDEO_FILE_UNREADABLE";
      throw err;
    }
    return {
      filePath,
      thumbnailPath: `${filePath}.thumb.jpg`,
      metadata: { duration: 5000, width: 720, height: 1280, fileSize: 1024 },
    };
  });

  const uploads = [];
  const api = {
    uploadAttachment: async ([filePath]) => {
      uploads.push(filePath);
      return [{ fileUrl: `https://u/${path.basename(String(filePath))}` }];
    },
    sendVideo: async () => ({ success: true }),
  };
  const out = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t", type: 1 },
    videoFiles: [broken, ok],
    pool: "vdsex",
    randomFn: (() => {
      // Identity shuffle: giữ nguyên thứ tự
      return () => 0;
    })(),
  });
  assert.equal(out, true);
  // Video upload = ok.mp4; thumbnail upload = ok.mp4.thumb.jpg
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0], ok);
  assert.match(uploads[1], /ok\.mp4\.thumb\.jpg$/);
});

test("sendLocalVideoWithFallback: upload lỗi dừng ngay (không đốt hết attempt)", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  const files = Array.from({ length: 5 }, (_, i) => {
    const p = path.join(videoRoot, "vdsex", `v${i}.mp4`);
    fs.writeFileSync(p, "x");
    return p;
  });
  setLocalVideoMediaPreparer(stubPrepareMedia());
  let uploadCalls = 0;
  const api = {
    uploadAttachment: async () => {
      uploadCalls += 1;
      throw new Error("endpoint down");
    },
    sendVideo: async () => ({ success: true }),
  };
  const out = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t", type: 1 },
    videoFiles: files,
    pool: "vdsex",
  });
  assert.equal(out, false);
  assert.equal(uploadCalls, 1, "upload lỗi chung phải dừng ngay");
});

test("sendLocalVideoWithFallback: delivery bị từ chối dừng ngay, không upload thêm", async (t) => {
  const { videoRoot } = setupTempRoot(t, { pools: ["vdsex"] });
  const files = Array.from({ length: 5 }, (_, i) => {
    const p = path.join(videoRoot, "vdsex", `v${i}.mp4`);
    fs.writeFileSync(p, "x");
    return p;
  });
  setLocalVideoMediaPreparer(stubPrepareMedia());
  let uploadCalls = 0;
  let sendVideoCalls = 0;
  const api = {
    uploadAttachment: async () => {
      uploadCalls += 1;
      return [{ fileUrl: "https://u/x.mp4" }];
    },
    sendVideo: async () => {
      sendVideoCalls += 1;
      const err = new Error("Zalo từ chối: Tham số không hợp lệ");
      err.code = 114;
      throw err;
    },
  };
  const out = await sendLocalVideoWithFallback({
    api,
    message: { threadId: "t", type: 1 },
    videoFiles: files,
    pool: "vdsex",
  });
  assert.equal(out, false);
  assert.equal(sendVideoCalls, 1, "chỉ gọi sendVideo 1 lần rồi dừng");
  assert.equal(uploadCalls, 2, "1 video + 1 thumbnail, không upload thêm");
});
