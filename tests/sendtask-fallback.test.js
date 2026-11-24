process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setEnvVars, resetCache } from "../src/utils/env.js";
import {
  readGroupSettings,
  writeGroupSettings,
  clearGroupSettingsCache,
  assertSafeGroupSettingsWritePath,
} from "../src/utils/group-settings-store.js";
import {
  SENDTASK_FALLBACK_KINDS,
  buildDefaultSendtaskSchedules,
} from "../src/commands/studio/sendtask-defaults.js";
import { SendTaskSchedulerManager } from "../src/service-debug/scheduler/sendtask-scheduler-manager.js";
import { crossFieldValidateSendtask } from "../src/commands/studio/runtime-adapters.js";
import { buildSendtaskSchedulesFromStudio } from "../src/commands/studio/runtime-apply.js";
import {
  broadcastSendtaskRecord,
} from "../src/service-debug/scheduler/scheduler.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(process.cwd());

function setupRuntime(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sendtask-fallback-"));
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
  setEnvVars({ CONFIG_PATH: configPath, PROJECT_ROOT });
  clearGroupSettingsCache();
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
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

function makeSources(behavior = {}) {
  const calls = {
    tiktokSearch: [],
    tikTokDelivers: [],
    girlSends: [],
    zingResolve: [],
    zingDelivers: [],
  };
  const sources = {
    searchTiktok: async (query) => {
      calls.tiktokSearch.push(query);
      if (behavior.searchTiktok) return behavior.searchTiktok(query);
      return [{ id: "tt-1" }, { id: "tt-2" }];
    },
    deliverTikTok: async (api, threadId, media) => {
      calls.tikTokDelivers.push({ threadId, media });
      if (behavior.deliverTikTok) return behavior.deliverTikTok(api, threadId, media);
      return true;
    },
    resolveZingTrack: async (api, threadId) => {
      calls.zingResolve.push({ threadId });
      if (behavior.resolveZingTrack) return behavior.resolveZingTrack(api, threadId);
      return { song: { encodeId: "z1", title: "Track" }, linkMusic: "https://stream/z1", randomIndex: 1 };
    },
    deliverZingTrack: async (api, threadId, track, extra) => {
      calls.zingDelivers.push({ threadId, track });
      if (behavior.deliverZingTrack) return behavior.deliverZingTrack(api, threadId, track, extra);
    },
    loadGirlPool: (category) => {
      if (behavior.loadGirlPool) return behavior.loadGirlPool(category);
      return [`http://pool/${category || "default"}/v1`, `http://pool/${category || "default"}/v2`];
    },
    sendGirlVideo: async (api, threadId, payload) => {
      calls.girlSends.push({ threadId, type: payload.type });
      if (behavior.sendGirlVideo) return behavior.sendGirlVideo(api, threadId, payload);
      return true;
    },
  };
  return { sources, calls };
}

function withCapturedConsole(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const push = (...args) => lines.push(args.join(" "));
  console.log = push;
  console.warn = push;
  console.error = push;
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      throw error;
    })
    .then((result) => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      return { result, lines };
    });
}

test("SENDTASK_FALLBACK_KINDS locks fallback to the girl-video pool", () => {
  assert.deepEqual([...SENDTASK_FALLBACK_KINDS], ["girl-video"]);
});

test("every default schedule carries fallbackKind=fallbackCategory=girl-video/default", () => {
  const schedules = buildDefaultSendtaskSchedules();
  assert.equal(schedules.length, 24);
  for (const row of schedules) {
    assert.equal(row.fallbackKind, "girl-video", `row ${row.id} must declare a fallback kind`);
    assert.equal(row.fallbackCategory, "default", `row ${row.id} must declare a fallback category`);
  }
  for (const id of ["hour-04", "hour-06", "hour-09", "hour-17", "hour-19"]) {
    assert.equal(schedules.find((row) => row.id === id).kind, "tiktok-search");
  }
  for (const id of ["hour-03", "hour-20", "hour-22"]) {
    assert.equal(schedules.find((row) => row.id === id).kind, "zing-chart");
  }
});

test("tiktok search throwing falls back to girl-video exactly once per group", async (t) => {
  setupRuntime(t);
  seedSettings({ g1: { sendTask: true }, g2: { sendTask: true } });
  const { sources, calls } = makeSources({
    searchTiktok: async () => {
      throw new Error("getaddrinfo ENOTFOUND tiktok");
    },
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-tt", kind: "tiktok-search", queryTemplate: "q {{timestamp}}", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sourceStatus, "error");
  assert.equal(summary.primaryKind, "tiktok-search");
  assert.equal(summary.fallbackKind, "girl-video");
  assert.equal(summary.fallbackCategory, "default");
  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.fallbackUsed, 2);
  assert.equal(calls.tiktokSearch.length, 1, "search retried per configured retry policy only");
  assert.equal(calls.girlSends.length, 2, "each group gets exactly one fallback video");
  assert.equal(calls.tikTokDelivers.length, 0);
  for (const delivery of summary.deliveries) {
    assert.equal(delivery.deliveredBy, "fallback");
    assert.equal(delivery.status, "sent");
    assert.equal(delivery.fallbackReason, "source-error");
  }
});

test("tiktok source timeout counts as source error and still falls back once", async (t) => {
  setupRuntime(t);
  seedSettings({ solo: { sendTask: true } });
  const { sources, calls } = makeSources({
    searchTiktok: () => new Promise(() => {}),
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-hang", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 1, backoffMs: 0 }, timeoutMs: 60 }),
  );

  assert.equal(summary.sourceStatus, "error");
  assert.equal(summary.sent, 1);
  assert.equal(summary.fallbackUsed, 1);
  assert.equal(calls.girlSends.length, 1);
});

test("tiktok search retries follow the configured retry policy before falling back", async (t) => {
  setupRuntime(t);
  seedSettings({ r: { sendTask: true } });
  let attempts = 0;
  const { sources, calls } = makeSources({
    searchTiktok: async () => {
      attempts += 1;
      throw new Error(`boom ${attempts}`);
    },
  });

  await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-retry-src", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 2, backoffMs: 1 }, timeoutMs: 2000 }),
  );

  assert.equal(calls.tiktokSearch.length, 3, "initial attempt + 2 configured retries");
  assert.equal(calls.girlSends.length, 1, "fallback happens once after the source is declared broken");
});

test("tiktok empty search result falls back with reason source-empty", async (t) => {
  setupRuntime(t);
  seedSettings({ e1: { sendTask: true } });
  const { sources, calls } = makeSources({
    searchTiktok: async () => [],
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-empty-src", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sourceStatus, "empty");
  assert.equal(summary.sent, 1);
  assert.equal(summary.fallbackUsed, 1);
  const delivery = summary.deliveries.find((d) => d.threadId === "e1");
  assert.equal(delivery.deliveredBy, "fallback");
  assert.equal(delivery.fallbackReason, "source-empty");
  assert.equal(calls.girlSends.length, 1);
});

test("successful tiktok delivery never invokes the fallback pool", async (t) => {
  setupRuntime(t);
  seedSettings({ happy: { sendTask: true } });
  const { sources, calls } = makeSources();

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-ok", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sourceStatus, "ok");
  assert.equal(summary.sent, 1);
  assert.equal(summary.fallbackUsed, 0);
  assert.equal(summary.deliveries[0].deliveredBy, "primary");
  assert.equal(summary.deliveries[0].fallbackReason, undefined);
  assert.equal(calls.girlSends.length, 0, "no fallback sends when primary works");
  assert.equal(calls.tikTokDelivers.length, 1);
});

test("ambiguous zalo delivery error never triggers a second send from another source", async (t) => {
  setupRuntime(t);
  seedSettings({ amb: { sendTask: true } });
  const { sources, calls } = makeSources({
    deliverTikTok: async () => {
      throw new Error("upload attachment failed midway");
    },
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-amb", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 1, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sent, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.fallbackUsed, 0);
  assert.equal(calls.girlSends.length, 0, "must not double-send after an ambiguous zalo failure");
  assert.equal(calls.tikTokDelivers.length, 2, "primary delivery retried per config");
  assert.equal(summary.deliveries[0].deliveredBy, null);
});

test("timed out primary delivery is not rescued by fallback", async (t) => {
  setupRuntime(t);
  seedSettings({ slow: { sendTask: true } });
  const { sources, calls } = makeSources({
    deliverTikTok: () => new Promise(() => {}),
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-slow", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 60 }),
  );

  assert.equal(summary.timedOut, 1);
  assert.equal(summary.fallbackUsed, 0);
  assert.equal(calls.girlSends.length, 0);
});

test("zing success reports deliveredBy=primary and no fallback usage", async (t) => {
  setupRuntime(t);
  seedSettings({ z1: { sendTask: true } });
  const { sources, calls } = makeSources();

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-zing", kind: "zing-chart", ttlMinutes: 120 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.primaryKind, "zing-chart");
  assert.equal(summary.sent, 1);
  assert.equal(summary.fallbackUsed, 0);
  assert.equal(summary.deliveries[0].deliveredBy, "primary");
  assert.equal(calls.zingResolve.length, 1);
  assert.equal(calls.zingDelivers.length, 1);
  assert.equal(calls.girlSends.length, 0);
});

test("zing source error and missing stream fall back to girl-video", async (t) => {
  setupRuntime(t);
  seedSettings({ zerr: { sendTask: true }, zempty: { sendTask: true } });
  const { sources, calls } = makeSources({
    resolveZingTrack: async (api, threadId) => {
      if (threadId === "zerr") throw new Error("Lỗi request Zing MP3");
      return null;
    },
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-zing-bad", kind: "zing-chart", ttlMinutes: 120 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sent, 2);
  assert.equal(summary.fallbackUsed, 2);
  const reasons = Object.fromEntries(summary.deliveries.map((d) => [d.threadId, d]));
  assert.equal(reasons.zerr.fallbackReason, "source-error");
  assert.equal(reasons.zempty.fallbackReason, "source-empty");
  assert.equal(calls.girlSends.length, 2);
  assert.equal(calls.zingDelivers.length, 0);
});

test("one group failing does not block or duplicate the other groups", async (t) => {
  setupRuntime(t);
  seedSettings({ okg: { sendTask: true }, badg: { sendTask: true } });
  const { sources, calls } = makeSources({
    resolveZingTrack: async (api, threadId) => {
      if (threadId === "badg") throw new Error("chart down");
      return { song: { encodeId: "z9" }, linkMusic: "https://stream/z9", randomIndex: 0 };
    },
    deliverZingTrack: async (api, threadId, track) => {
      if (threadId === "badg") throw new Error("should not be reached");
    },
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-mix", kind: "zing-chart", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.enabledTargets, 2);
  assert.equal(summary.attempted, 2);
  assert.equal(summary.sent, 2);
  const okCalls = calls.zingDelivers.filter((c) => c.threadId === "okg").length;
  assert.equal(okCalls, 1, "healthy group served exactly once");
  assert.ok(summary.deliveries.find((d) => d.threadId === "okg" && d.deliveredBy === "primary"));
  assert.ok(summary.deliveries.find((d) => d.threadId === "badg" && d.deliveredBy === "fallback"));
});

test("empty primary girl pool is a source-empty and can fall back to another category", async (t) => {
  setupRuntime(t);
  seedSettings({ gp: { sendTask: true } });
  const { sources, calls } = makeSources({
    loadGirlPool: (category) => (category === "sexy" ? [] : ["http://pool/default/v1"]),
  });

  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-girl", kind: "girl-video", category: "sexy", fallbackCategory: "default", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  assert.equal(summary.sent, 1);
  assert.equal(summary.fallbackUsed, 1);
  assert.deepEqual(calls.girlSends.map((c) => c.type), ["default"]);
});

test("broadcast log line carries primaryKind and fallbackUsed counters", async (t) => {
  setupRuntime(t);
  seedSettings({ lg: { sendTask: true } });
  const { sources } = makeSources({
    searchTiktok: async () => {
      throw new Error("tls handshake failed");
    },
  });

  const { lines } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-log", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );

  const mainLine = lines.find((line) => line.includes("[sendtask] broadcast") && line.includes("hour-log"));
  assert.ok(mainLine, "main broadcast log line expected");
  assert.match(mainLine, /primaryKind=tiktok-search/);
  assert.match(mainLine, /fallback=girl-video\/default/);
  assert.match(mainLine, /fallbackUsed=1/);
  assert.match(mainLine, /enabledTargets=1/);
  assert.match(mainLine, /sent=1/);
});

test("scheduler manager reschedules exactly one job when only fallback config changes", async (t) => {
  const manager = new SendTaskSchedulerManager({
    scheduleJob: (cron) => ({ cron, nextInvocation: () => null }),
    cancelJob: () => true,
    logger: { error: () => {} },
  });
  const schedules = buildDefaultSendtaskSchedules();
  await manager.sync(schedules);
  assert.equal(manager.handles.size, 24);

  const changed = schedules.map((row) =>
    row.id === "hour-09" ? { ...row, fallbackCategory: "cosplay" } : row,
  );
  const diff = manager.diff(changed.filter((row) => row.enabled !== false));
  assert.equal(diff.toSchedule.length, 1, "only the changed job reschedules");
  assert.equal(diff.toCancel.length, 0);

  await manager.sync(changed.filter((row) => row.enabled !== false));
  assert.equal(manager.handles.size, 24, "no duplicated handles after fallback hot-reload");
  assert.equal(manager.desired.get("hour-09").fallbackCategory, "cosplay");
  assert.equal(manager.desired.get("hour-04").fallbackCategory, "default");

  const kindChanged = changed.map((row) =>
    row.id === "hour-17" ? { ...row, fallbackKind: "" } : row,
  );
  const diff2 = manager.diff(kindChanged.filter((row) => row.enabled !== false));
  assert.equal(diff2.toSchedule.length, 1, "disabling fallback also reschedules");
});

test("validation rejects invalid fallback kind/category and accepts disabled fallback", () => {
  const base = buildDefaultSendtaskSchedules();
  const good = crossFieldValidateSendtask({ "schedules.items": base });
  assert.equal(good.ok, true, JSON.stringify(good.errors));

  const badKind = base.map((row) => (row.id === "hour-06" ? { ...row, fallbackKind: "tiktok-search" } : row));
  const kindCheck = crossFieldValidateSendtask({ "schedules.items": badKind });
  assert.equal(kindCheck.ok, false);
  assert.ok(kindCheck.errors.some((e) => e.path.endsWith("fallbackKind")));

  const badCategory = base.map((row) => (row.id === "hour-09" ? { ...row, fallbackCategory: "not-a-pool" } : row));
  const catCheck = crossFieldValidateSendtask({ "schedules.items": badCategory });
  assert.equal(catCheck.ok, false);
  assert.ok(catCheck.errors.some((e) => e.path.endsWith("fallbackCategory")));

  const disabled = base.map((row) => (row.id === "hour-19" ? { ...row, fallbackKind: "", fallbackCategory: "" } : row));
  const disabledCheck = crossFieldValidateSendtask({ "schedules.items": disabled });
  assert.equal(disabledCheck.ok, true, JSON.stringify(disabledCheck.errors));
});

test("studio schedule builder passes fallback fields through to runtime records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sendtask-studio-"));
  try {
    const studio = buildSendtaskSchedulesFromStudio({ root, botId: "admin" });
    assert.ok(studio.schedules.length > 0);
    for (const row of studio.schedules) {
      assert.equal(row.fallbackKind, "girl-video");
      assert.equal(row.fallbackCategory, "default");
    }
    const tiktokRow = studio.schedules.find((row) => row.kind === "tiktok-search");
    assert.ok(tiktokRow, "expected a tiktok row");
    assert.equal(tiktokRow.fallbackKind, "girl-video");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("guard blocks writes to the real workspace group settings under node --test", (t) => {
  const realStore = path.join(PROJECT_ROOT, "assets", "data", "group_settings.json");
  assert.throws(() => assertSafeGroupSettingsWritePath(realStore), /real group settings/);
  assert.throws(() => assertSafeGroupSettingsWritePath(path.join(PROJECT_ROOT, "groupSettings.json")), /real group settings/);

  const tmpTarget = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "guard-ok-")), "group-settings.json");
  assert.doesNotThrow(() => assertSafeGroupSettingsWritePath(tmpTarget));

  // writeGroupSettings must hard-fail when the canonical store resolves inside the workspace
  const previousConfigPath = process.env.CONFIG_PATH;
  const runtimeRoot = path.join(os.tmpdir(), `sendtask-guard-${Date.now()}`);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const evilConfig = path.join(runtimeRoot, "evil.json");
  fs.writeFileSync(
    evilConfig,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: realStore }),
    "utf8",
  );
  setEnvVars({ CONFIG_PATH: evilConfig });
  clearGroupSettingsCache();
  t.after(() => {
    setEnvVars({ CONFIG_PATH: previousConfigPath });
    clearGroupSettingsCache();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  assert.throws(() => writeGroupSettings({ boom: true }), /real group settings/);
  assert.equal(readGroupSettings().boom, undefined);
});

test("runtime group settings files stay byte-identical across this suite", async (t) => {
  const paths = [
    path.join(PROJECT_ROOT, "assets", "data", "group_settings.json"),
    path.join(PROJECT_ROOT, "groupSettings.json"),
  ];
  const before = new Map(paths.map((p) => [p, sha256File(p)]));
  t.after(() => {
    for (const p of paths) {
      assert.equal(sha256File(p), before.get(p), `${p} must remain untouched by tests`);
    }
  });

  // Chạy một lượt broadcast đầy đủ trên fixture để chứng minh không chạm store thật
  setupRuntime(t);
  seedSettings({ hx: { sendTask: true } });
  const { sources } = makeSources();
  const { result: summary } = await withCapturedConsole(() =>
    broadcastSendtaskRecord({}, { id: "hour-hash", kind: "tiktok-search", queryTemplate: "q", ttlMinutes: 60 }, { sources, retry: { maxRetries: 0, backoffMs: 0 }, timeoutMs: 2000 }),
  );
  assert.equal(summary.sent, 1);
});

test("!sendtask on/off persists across a simulated restart", { timeout: 180000 }, async () => {
  const runtimeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sendtask-persist-"));
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  const configPath = path.join(runtimeRoot, "admin.json");
  await fs.promises.writeFile(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath }),
    "utf8",
  );

  const runPhase = async (phaseScript) => {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", phaseScript], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        SKIP_ENV_VALIDATION: "1",
        PROJECT_ROOT: PROJECT_ROOT,
        CONFIG_PATH: configPath,
        BOT_ID: "admin",
      },
      timeout: 60000,
    });
    const match = stdout.match(/__PH__(.*?)__HE__/s);
    assert.ok(match, `phase output missing: ${stdout.slice(-800)}`);
    return JSON.parse(match[1]);
  };

  try {
    const moduleUrl = `pathToFileURL:${path.join(PROJECT_ROOT, "src", "commands", "bot-manager", "utilities.js")}`;
    const ioUrl = `pathToFileURL:${path.join(PROJECT_ROOT, "src", "utils", "io-json.js")}`;
    const toUrl = (p) => p.replace("pathToFileURL:", "file:///").replace(/\\/g, "/");

    const onResult = await runPhase(`
      const utilities = await import("${toUrl(moduleUrl)}");
      const { readGroupSettings, writeGroupSettings } = await import("${toUrl(ioUrl)}");
      const settings = readGroupSettings();
      const api = { sendMessage: async () => ({ status: 0 }) };
      const message = {
        threadId: "persist-thread",
        type: "group",
        data: { content: "!sendtask on", mentions: [], dName: "Admin", uidFrom: "admin-1" },
      };
      await utilities.handleSendTaskCommand(api, message, settings, null);
      writeGroupSettings(settings);
      process.stdout.write("__PH__" + JSON.stringify({ flag: settings["persist-thread"].sendTask }) + "__HE__");
      setTimeout(() => process.exit(0), 20);
    `);
    assert.equal(onResult.flag, true);

    const restartRead = await runPhase(`
      const { readGroupSettings } = await import("${toUrl(ioUrl)}");
      const settings = readGroupSettings();
      process.stdout.write("__PH__" + JSON.stringify({ flag: Boolean(settings["persist-thread"] && settings["persist-thread"].sendTask) }) + "__HE__");
      setTimeout(() => process.exit(0), 20);
    `);
    assert.equal(restartRead.flag, true, "flag must survive restart");

    const offResult = await runPhase(`
      const utilities = await import("${toUrl(moduleUrl)}");
      const { readGroupSettings, writeGroupSettings } = await import("${toUrl(ioUrl)}");
      const settings = readGroupSettings();
      const api = { sendMessage: async () => ({ status: 0 }) };
      const message = {
        threadId: "persist-thread",
        type: "group",
        data: { content: "!sendtask off", mentions: [], dName: "Admin", uidFrom: "admin-1" },
      };
      await utilities.handleSendTaskCommand(api, message, settings, null);
      writeGroupSettings(settings);
      process.stdout.write("__PH__" + JSON.stringify({ flag: settings["persist-thread"].sendTask }) + "__HE__");
      setTimeout(() => process.exit(0), 20);
    `);
    assert.equal(offResult.flag, false);

    const finalRead = await runPhase(`
      const { readGroupSettings } = await import("${toUrl(ioUrl)}");
      const settings = readGroupSettings();
      process.stdout.write("__PH__" + JSON.stringify({ flag: Boolean(settings["persist-thread"] && settings["persist-thread"].sendTask) }) + "__HE__");
      setTimeout(() => process.exit(0), 20);
    `);
    assert.equal(finalRead.flag, false);
  } finally {
    await fs.promises.rm(runtimeRoot, { recursive: true, force: true });
  }
});

function sha256File(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "missing";
  }
}
