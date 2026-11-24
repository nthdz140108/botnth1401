process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setEnvVars } from "../src/utils/env.js";
import {
  readGroupSettings,
  writeGroupSettings,
  clearGroupSettingsCache,
} from "../src/utils/group-settings-store.js";
import {
  SENDTASK_BROADCAST_DEFAULTS,
  broadcastSendtaskRecord,
  collectEnabledTargets,
  runWithConcurrency,
} from "../src/service-debug/scheduler/scheduler.js";
import { setLocalVideoMediaPreparer, listLocalVideoCandidates } from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";

// Pool local giả dùng đường dẫn không có thật: cài preparer stub cấp module
// (mỗi file test chạy trong process riêng) để mô phỏng ffprobe/ffmpeg.
setLocalVideoMediaPreparer(async (filePath) => ({
  filePath,
  thumbnailPath: `${filePath}.thumb.jpg`,
  metadata: { duration: 15000, width: 720, height: 1280, fileSize: 1048576 },
}));

const PROJECT_ROOT = path.resolve(process.cwd());

function setupRuntime(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sendtask-broadcast-"));
  const dataDir = path.join(runtimeRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsPath = path.join(dataDir, "group-settings.json");
  fs.writeFileSync(settingsPath, "{}", "utf8");
  const configPath = path.join(runtimeRoot, "admin.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath }),
    "utf8",
  );
  // Mọi pool video trong test phải có ít nhất một .mp4 để defaultSources
  // (chỉ LOCAL_DIRECTORY, không URL online) snapshot được candidate.
  // resolveVideoPoolRoot tự join thêm "video/" nên MYBOT_VIDEO_ROOT phải là thư mục cha.
  for (const pool of ["vdgirl", "vdsexy", "vdsex", "vdcos", "vdanime"]) {
    const poolDir = path.join(runtimeRoot, "video", pool);
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, "seed.mp4"), "fake-mp4");
  }
  setEnvVars({ CONFIG_PATH: configPath, PROJECT_ROOT });
  process.env.MYBOT_VIDEO_ROOT = runtimeRoot;
  clearGroupSettingsCache();
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    delete process.env.MYBOT_VIDEO_ROOT;
    clearGroupSettingsCache();
  });
  return settingsPath;
}

function seedSettings(threadStates) {
  const settings = {};
  for (const [threadId, state] of Object.entries(threadStates)) {
    settings[threadId] = { name: `Group ${threadId}`, ...state };
  }
  writeGroupSettings(settings);
  return settings;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRecordingApi({ failFor = {}, failUploadsFor = {}, hangFor = [], delayMs = 0 } = {}) {
  const calls = [];
  const uploads = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const api = {
    // Pool local: upload trước rồi mới sendVideo bằng URL Zalo trả về
    uploadAttachment: async ([filePath], threadId, threadType) => {
      uploads.push({ filePath, threadId, threadType });
      const behavior = failUploadsFor[threadId];
      if (typeof behavior === "number") {
        failUploadsFor[threadId] -= 1;
        if (failUploadsFor[threadId] <= 0) delete failUploadsFor[threadId];
        throw new Error(`transient upload failure for ${threadId}`);
      }
      if (behavior instanceof Error) throw behavior;
      if (typeof behavior === "string") throw new Error(behavior);
      return [{ fileUrl: `https://uploaded.example/${path.basename(String(filePath))}` }];
    },
    sendVideo: async (payload) => {
      calls.push(payload);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (hangFor.includes(payload.threadId)) {
          await new Promise(() => {});
        }
        if (delayMs > 0) await sleep(delayMs);
        const behavior = failFor[payload.threadId];
        if (typeof behavior === "number") {
          failFor[payload.threadId] -= 1;
          if (failFor[payload.threadId] <= 0) delete failFor[payload.threadId];
          throw new Error(`transient failure for ${payload.threadId}`);
        }
        if (behavior instanceof Error) throw behavior;
        if (typeof behavior === "string") throw new Error(behavior);
        return { success: true };
      } finally {
        inFlight -= 1;
      }
    },
  };
  api.__calls = calls;
  api.__uploads = uploads;
  api.__maxInFlight = () => maxInFlight;
  return api;
}

// Pool local giả lập: scheduler nhận qua inject sources.loadGirlPool (snapshot
// mỗi lượt broadcast), không phụ thuộc folder video thật trên máy chạy test.
const FAKE_LOCAL_POOL = [
  "C:/fake-video/vdsexy/a.mp4",
  "C:/fake-video/vdsexy/b.mp4",
];

function localPoolSources(pool = FAKE_LOCAL_POOL) {
  return {
    loadGirlPool: (category) => (category === "sex" ? [] : pool),
  };
}

test("collectEnabledTargets returns only threads with sendTask === true regardless of activeBot", () => {
  const targets = collectEnabledTargets({
    g1: { sendTask: true },
    g2: { sendTask: true, activeBot: false },
    g3: { sendTask: false },
    g4: { sendTask: "yes" },
    g5: {},
    g6: { activeBot: true },
  });
  assert.deepEqual(targets.sort(), ["g1", "g2"]);
});

test("runWithConcurrency processes every item and collects errors without rejecting", async () => {
  const processed = [];
  const results = await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    if (item === 3) throw new Error(`boom ${item}`);
    await sleep(5);
    processed.push(item);
    return item * 10;
  });
  assert.deepEqual(processed.sort(), [1, 2, 4]);
  assert.equal(results[2].ok, false);
  assert.equal(results[2].error.message, "boom 3");
  assert.equal(results[0].value, 10);
});

test("broadcast fans out to every enabled group exactly once and skips disabled groups", async () => {
  const settingsPath = setupRuntime(test);
  seedSettings({
    en1: { sendTask: true },
    en2: { sendTask: true },
    en3: { sendTask: true },
    off1: { sendTask: false },
    off2: {},
  });

  const api = createRecordingApi();
  const summary = await broadcastSendtaskRecord(api, {
    id: "hour-test",
    kind: "girl-video",
    category: "sex",
    caption: "> SendTask test <",
    ttlMinutes: 30,
    timezone: "Asia/Ho_Chi_Minh",
  });

  const threadIds = api.__calls.map((payload) => payload.threadId).sort();
  assert.deepEqual(threadIds, ["en1", "en2", "en3"], "each enabled group receives exactly one sender call");
  assert.equal(summary.enabledTargets, 3);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.sent, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.timedOut, 0);
  assert.equal(summary.disabledMissing, 0);
  assert.equal(summary.kind, "girl-video");
  assert.equal(summary.category, "sex");
  assert.equal(summary.settingsPath, settingsPath);

  for (const payload of api.__calls) {
    assert.equal(payload.ttl, 30 * 60 * 1000);
    assert.equal(payload.message.text, "> SendTask test <");
    assert.equal(payload.videoUrl.startsWith("http"), true);
  }
});

test("one group failing or hanging does not block the other groups", async () => {
  setupRuntime(test);
  seedSettings({
    ok1: { sendTask: true },
    broken: { sendTask: true },
    slowpoke: { sendTask: true },
  });

  const api = createRecordingApi({
    failFor: { broken: Error("Zalo API down") },
    hangFor: ["slowpoke"],
  });
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-fail", kind: "girl-video", category: "sexy", ttlMinutes: 60 },
    {
      timeoutMs: 80,
      concurrency: 3,
      retry: { maxRetries: 0, backoffMs: 0 },
      sources: localPoolSources(),
    },
  );

  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.timedOut, 1);
  const sentThread = api.__calls.find((p) => p.threadId === "ok1");
  assert.ok(sentThread, "healthy group must still be served");

  // Nhóm treo bị bỏ qua ở lượt sau nhưng không ảnh hưởng nhóm khác
  assert.ok(summary.failures.some((f) => f.status === "timedOut"));
});

test("per-group retry retries only the failing group, never re-sends to successful ones", async () => {
  setupRuntime(test);
  seedSettings({
    flaky: { sendTask: true },
    stable: { sendTask: true },
  });

  const api = createRecordingApi({ failFor: { flaky: 2 } });
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-retry", kind: "girl-video", category: "default", ttlMinutes: 60 },
    { retry: { maxRetries: 2, backoffMs: 1 }, timeoutMs: 5000, sources: localPoolSources() },
  );

  assert.equal(summary.sent, 2);
  const flakyCalls = api.__calls.filter((p) => p.threadId === "flaky").length;
  const stableCalls = api.__calls.filter((p) => p.threadId === "stable").length;
  assert.equal(flakyCalls, 3, "flaky group retried until success (initial + 2 retries)");
  assert.equal(stableCalls, 1, "successful group must not be retried at batch level");
});

test("girl-video scheduler stops at the first upload failure (common endpoint error)", async () => {
  setupRuntime(test);
  seedSettings({ budget: { sendTask: true } });
  // Main URL nhiều chunk: uploadAttachment lỗi từ endpoint là lỗi chung.
  // Chính sách mới: dừng NGAY, không đốt 12 candidate trên cùng endpoint.
  const api = createRecordingApi({ failUploadsFor: { budget: 100 } });

  const wideLocalPool = Array.from({ length: 30 }, (_, index) => `C:/fake-video/default/v${index}.mp4`);
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-budget", kind: "girl-video", category: "default", ttlMinutes: 60 },
    {
      retry: { maxRetries: 5, backoffMs: 0 },
      timeoutMs: 5000,
      sources: localPoolSources(wideLocalPool),
    },
  );

  assert.equal(summary.failed, 1);
  // Upload lỗi là lỗi chung của lượt gửi: chỉ một candidate được thử, pool
  // không bị quét lặp cùng endpoint lỗi.
  const uploadsForThread = api.__uploads.filter((u) => u.threadId === "budget");
  assert.ok(uploadsForThread.length < 12, "common upload failure must stop, not burn 12 attempts");
  assert.equal(api.__calls.length, 0, "no delivery may happen when uploads fail");
});

test("local pool randomizes per group from one shared snapshot", async () => {
  setupRuntime(test);
  seedSettings({
    r1: { sendTask: true },
    r2: { sendTask: true },
  });

  const api = createRecordingApi();
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-random", kind: "girl-video", category: "sexy", ttlMinutes: 60 },
    { sources: localPoolSources(), retry: { maxRetries: 0 }, timeoutMs: 5000 },
  );

  assert.equal(summary.sent, 2);
  assert.equal(summary.fallbackUsed, 0, "healthy primary pool must not trigger fallback");
  // Mỗi nhóm nhận đúng một video, chọn từ cùng một snapshot pool local
  const uploadsByThread = {};
  for (const upload of api.__uploads) {
    uploadsByThread[upload.threadId] = uploadsByThread[upload.threadId] || [];
    uploadsByThread[upload.threadId].push(upload.filePath);
  }
  for (const threadId of ["r1", "r2"]) {
    assert.equal(uploadsByThread[threadId].length, 2, `${threadId} receives exactly one video upload + one thumbnail upload`);
    assert.ok(FAKE_LOCAL_POOL.includes(uploadsByThread[threadId][0]), "uploaded file must come from the shared snapshot");
    assert.match(uploadsByThread[threadId][1], /\.thumb\.jpg$/, "thumbnail upload follows the video upload");
  }
  // URL gửi đi phải là URL Zalo trả về từ upload, không phải đường dẫn máy
  for (const payload of api.__calls) {
    assert.match(payload.videoUrl, /^https:\/\/uploaded\.example\//);
    assert.equal(payload.videoAlreadyUploaded, true);
  }
});

test("empty local primary pool triggers the configured fallback exactly once", async () => {
  setupRuntime(test);
  seedSettings({
    f1: { sendTask: true },
    f2: { sendTask: true },
  });

  const api = createRecordingApi();
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-empty-local", kind: "girl-video", category: "cosplay", ttlMinutes: 60 },
    {
      sources: {
        // Pool chính (cosplay local) rỗng -> source-empty; fallback default còn video
        loadGirlPool: (category) => (category === "cosplay" ? [] : ["C:/fake-video/default/fb.mp4"]),
      },
      retry: { maxRetries: 0 },
      timeoutMs: 5000,
    },
  );

  assert.equal(summary.sent, 2);
  assert.equal(summary.fallbackUsed, 2, "every group must fall back exactly once");
  assert.equal(api.__uploads.filter((u) => u.threadId === "f1").length, 2, "one video + one thumbnail");
  assert.equal(api.__uploads.filter((u) => u.threadId === "f2").length, 2, "one video + one thumbnail");
});

test("ambiguous primary delivery error does not trigger fallback", async () => {
  setupRuntime(test);
  seedSettings({ amb: { sendTask: true } });

  const api = createRecordingApi({ failFor: { amb: Error("Zalo 500 ambiguous") } });
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-ambigu", kind: "girl-video", category: "sexy", ttlMinutes: 60 },
    {
      sources: localPoolSources(),
      // Không retry: toàn bộ ngân sách primary cháy bằng lỗi gửi thật
      retry: { maxRetries: 0, backoffMs: 0 },
      timeoutMs: 30000,
    },
  );

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.fallbackUsed, 0, "must never fall back after an ambiguous delivery failure");
});

test("fan-out respects configured concurrency limit", async () => {
  setupRuntime(test);
  seedSettings({
    c1: { sendTask: true },
    c2: { sendTask: true },
    c3: { sendTask: true },
    c4: { sendTask: true },
  });

  const api = createRecordingApi({ delayMs: 25 });
  await broadcastSendtaskRecord(
    api,
    { id: "hour-conc", kind: "girl-video", category: "anime", ttlMinutes: 60 },
    { concurrency: 2, retry: { maxRetries: 0 }, timeoutMs: 5000, sources: localPoolSources() },
  );

  assert.equal(api.__calls.length, 4);
  assert.ok(api.__maxInFlight() <= 2, `max in-flight ${api.__maxInFlight()} must be <= concurrency 2`);
});

test("missing group is auto-disabled and persisted; temporary errors keep the flag", async () => {
  const settingsPath = setupRuntime(test);
  seedSettings({
    gone: { sendTask: true },
    tempfail: { sendTask: true },
    healthy: { sendTask: true },
  });

  const api = createRecordingApi({
    failFor: {
      gone: Error("Không tồn tại nhóm chat"),
      tempfail: Error("network hiccup"),
    },
  });
  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-missing", kind: "girl-video", category: "sex", ttlMinutes: 60 },
    { retry: { maxRetries: 1, backoffMs: 1 }, timeoutMs: 5000 },
  );

  assert.equal(summary.disabledMissing, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1);

  clearGroupSettingsCache();
  const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(persisted.gone.sendTask, false, "missing group must be disabled in canonical store");
  assert.equal(persisted.tempfail.sendTask, true, "temporary errors must not clear the flag");
  assert.equal(persisted.healthy.sendTask, true);
  assert.equal(readGroupSettings().gone.sendTask, false);
});

test("no enabled groups yields an explicit enabledTargets=0 summary instead of silence", async () => {
  setupRuntime(test);
  seedSettings({ quiet: { sendTask: false } });

  const warnings = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (line) => warnings.push(String(line));
  console.log = (line) => warnings.push(String(line));
  try {
    const api = createRecordingApi();
    const summary = await broadcastSendtaskRecord(api, {
      id: "hour-empty",
      kind: "girl-video",
      category: "sexy",
      ttlMinutes: 60,
    });
    assert.equal(summary.enabledTargets, 0);
    assert.equal(summary.attempted, 0);
    assert.equal(api.__calls.length, 0);
    assert.ok(warnings.some((line) => line.includes("enabledTargets=0")), "must log a warning when no group is enabled");
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("each target performs its own media selection inside the correct category pool", async () => {
  setupRuntime(test);
  seedSettings({
    m1: { sendTask: true },
    m2: { sendTask: true },
  });

  const api = createRecordingApi();
  // category "sex" đọc pool local vdsex — phải khớp snapshot quét từ video/vdsex.
  const sexLocalSnapshot = new Set(listLocalVideoCandidates("vdsex"));
  assert.ok(sexLocalSnapshot.size > 0, "local vdsex pool must have at least one candidate");

  const summary = await broadcastSendtaskRecord(
    api,
    { id: "hour-media", kind: "girl-video", category: "sex", ttlMinutes: 15 },
    {},
  );

  assert.equal(summary.sent, 2);
  const uploads = api.__uploads.filter((u) => u.filePath.endsWith(".mp4"));
  assert.equal(uploads.length, 2, "two groups get two independent media selections");
  for (const upload of uploads) {
    assert.ok(
      sexLocalSnapshot.has(upload.filePath),
      "every uploaded file must come from the local vdsex pool",
    );
  }
});

test("SENDTASK_BROADCAST_DEFAULTS exposes the locked fan-out contract", () => {
  assert.equal(SENDTASK_BROADCAST_DEFAULTS.concurrency, 3);
  assert.equal(SENDTASK_BROADCAST_DEFAULTS.timeoutMs, 180000);
  assert.equal(SENDTASK_BROADCAST_DEFAULTS.groupDelayMs, 0);
});
