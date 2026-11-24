import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { DiskCleanupService } from "../src/runtime/disk-cleanup-service.js";
import {
  acquireTempLease,
  releaseTempLease,
  sweepUnleasedTempFiles,
  withTempFile,
  clearAllProcessLeasesForTest,
} from "../src/utils/temp-lease-manager.js";
import { createMessageCacheStore } from "../src/utils/message-cache.js";
import { LocmemStore, getConsecutiveCalendarDays } from "../src/service-debug/locmem/index.js";

test("Zero-Conflict 4-Tier Storage: DiskCleanupService + TempFileLease protect Tier 1, Tier 2, and leased Tier 3 while cleaning stale Tier 3 & Tier 4", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zero-conflict-root-"));
  const sysTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-conflict-systemp-"));

  t.after(() => {
    clearAllProcessLeasesForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(sysTempDir, { recursive: true, force: true });
  });

  // --- TIER 1 (Permanent Stateful Command Data — MUST NEVER BE DELETED) ---
  const tier1Files = [
    path.join(tmpRoot, "mybot", "mybots.json"),
    path.join(tmpRoot, "mybot", "credentials", "admin.json"),
    path.join(tmpRoot, "mybot", "bots", "admin.json"),
    path.join(tmpRoot, "mybot", "instances", "admin", "data", "group-settings.json"),
    path.join(tmpRoot, "mybot", "instances", "admin", "data", "anti-config.json"),
    path.join(tmpRoot, "mybot", "instances", "admin", "data", "reminders.json"),
    path.join(tmpRoot, "mybot", "instances", "admin", "data", "scheduled-assets", "welcome-banner.png"),
    path.join(tmpRoot, "assets", "data", "list_admin.json"),
    path.join(tmpRoot, "assets", "json-data", "data-training.json"),
    path.join(tmpRoot, "assets", "resources", "sticker", "sample.webp"),
  ];

  for (const filePath of tier1Files) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ tier: 1, protected: true, path: path.basename(filePath) }), "utf8");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(filePath, thirtyDaysAgo, thirtyDaysAgo);
  }

  // --- TIER 2 (Stateful Retention Data — !antiundo message.json & !locmem 35d partitions MUST NOT be wiped by DiskCleanupService) ---
  const messageJsonPath = path.join(tmpRoot, "mybot", "instances", "admin", "data", "message.json");
  const locmemPartitionPath = path.join(tmpRoot, "mybot", "instances", "admin", "data", "locmem-activity-days", "2026-10-25.json");
  fs.mkdirSync(path.dirname(locmemPartitionPath), { recursive: true });
  fs.writeFileSync(messageJsonPath, JSON.stringify({ msg1: { msgId: "1", content: "keep-for-antiundo", timestamp: Date.now() } }), "utf8");
  fs.writeFileSync(locmemPartitionPath, JSON.stringify({ dateKey: "2026-10-25", activities: {}, snapshots: {}, coverage: {} }), "utf8");

  // --- TIER 3 (Ephemeral Media Temp — Active Lease vs Expired Unleased) ---
  const runtimeTempDir = path.join(tmpRoot, ".runtime", "temp", "admin");
  const assetsTempDir = path.join(tmpRoot, "assets", "temp");
  fs.mkdirSync(runtimeTempDir, { recursive: true });
  fs.mkdirSync(assetsTempDir, { recursive: true });

  const leasedMediaFile = path.join(assetsTempDir, "active-yt-download.mp4");
  const staleUnleasedFile = path.join(assetsTempDir, "abandoned-video.mp4");
  const leasedRuntimeFile = path.join(runtimeTempDir, "active-sticker-render.webp");
  const staleRuntimeFile = path.join(runtimeTempDir, "orphan-frame.png");

  fs.writeFileSync(leasedMediaFile, "in-flight-youtube-stream");
  fs.writeFileSync(staleUnleasedFile, "crashed-download-leftover");
  fs.writeFileSync(leasedRuntimeFile, "in-flight-sticker");
  fs.writeFileSync(staleRuntimeFile, "stale-frame");

  // Backdate ALL four temp files to 4 hours ago so age alone would qualify them for deletion!
  const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000);
  for (const f of [leasedMediaFile, staleUnleasedFile, leasedRuntimeFile, staleRuntimeFile]) {
    fs.utimesSync(f, fourHoursAgo, fourHoursAgo);
  }

  // Acquire active leases on the 2 in-flight files
  acquireTempLease(leasedMediaFile, 10 * 60 * 1000, { flushImmediate: true });
  acquireTempLease(leasedRuntimeFile, 10 * 60 * 1000, { flushImmediate: true });

  // --- TIER 4 (Logs — Routine logs truncated, >10MB active audit rotated) ---
  const logsDir = path.join(tmpRoot, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const routineLog = path.join(logsDir, "message.txt");
  const oversizedAuditLog = path.join(logsDir, "dashboard-audit.jsonl");
  fs.writeFileSync(routineLog, "chat log line\n".repeat(200), "utf8");
  fs.writeFileSync(oversizedAuditLog, "x".repeat(10 * 1024 * 1024 + 512), "utf8");

  const cleanupService = new DiskCleanupService({
    projectRoot: tmpRoot,
    tempDir: sysTempDir,
    adapter: { listProcesses: async () => [] },
  });

  // Pass 1 + Pass 2 of DiskCleanupService (2-observation stale temp safety)
  await cleanupService.run({ trigger: "pass_1" });
  await cleanupService.run({ trigger: "pass_2" });

  // Also run sweepUnleasedTempFiles directly (continuous 15-min sweep)
  const sweepResult = await sweepUnleasedTempFiles({
    projectRoot: tmpRoot,
    maxUnleasedAgeMs: 30 * 60 * 1000,
  });

  // 1. Verify EVERY Tier 1 file is 100% untouched
  for (const filePath of tier1Files) {
    assert.equal(fs.existsSync(filePath), true, `Tier 1 file MUST survive cleanup: ${filePath}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.protected, true);
  }

  // 2. Verify Tier 2 files were NOT deleted by DiskCleanupService or temp sweep
  assert.equal(fs.existsSync(messageJsonPath), true, "message.json (!antiundo) MUST survive DiskCleanupService");
  assert.equal(fs.existsSync(locmemPartitionPath), true, "locmem partition MUST survive DiskCleanupService");

  // 3. Verify leased Tier 3 files survived BOTH DiskCleanupService (2 passes) AND sweepUnleasedTempFiles!
  assert.equal(fs.existsSync(leasedMediaFile), true, "Actively leased media download MUST NOT be deleted mid-command");
  assert.equal(fs.existsSync(leasedRuntimeFile), true, "Actively leased runtime render MUST NOT be deleted mid-command");
  assert.ok(sweepResult.skippedLeased >= 2, "Sweep must record leased skips");

  // 4. Verify unleased stale Tier 3 files WERE deleted cleanly
  assert.equal(fs.existsSync(staleUnleasedFile), false, "Stale unleased temp file in assets/temp must be deleted");
  assert.equal(fs.existsSync(staleRuntimeFile), false, "Stale unleased temp file in .runtime/temp must be deleted");

  // 5. Once lease is released, subsequent sweep cleans up the former leased file
  releaseTempLease(leasedMediaFile, { flushImmediate: true });
  releaseTempLease(leasedRuntimeFile, { flushImmediate: true });
  const afterReleaseSweep = await sweepUnleasedTempFiles({
    projectRoot: tmpRoot,
    maxUnleasedAgeMs: 30 * 60 * 1000,
  });
  assert.equal(afterReleaseSweep.deletedFiles, 2);
  assert.equal(fs.existsSync(leasedMediaFile), false);
  assert.equal(fs.existsSync(leasedRuntimeFile), false);

  // 6. Verify Tier 4 routine log was truncated & >10MB active audit log was rotated (.1)
  assert.equal(fs.statSync(routineLog).size, 0, "Routine log must be truncated to 0 bytes");
  assert.equal(fs.existsSync(`${oversizedAuditLog}.1`), true, "Oversized audit log must rotate to .1");
  assert.equal(fs.statSync(oversizedAuditLog).size, 0, "Fresh audit log after rotation must be 0 bytes");
});

test("Zero-Conflict Tier 2 Self-Pruning: !antiundo keeps <24h & drops >24h; !locmem keeps 35d & drops >35d; withTempFile auto-cleans", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-conflict-tier2-"));
  t.after(() => {
    clearAllProcessLeasesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A. MessageCache (!antiundo / !undo): 24h retention window, zero unbounded growth
  const msgJsonPath = path.join(tmpDir, "data", "message.json");
  const now = Date.now();
  const msgStore = createMessageCacheStore({
    uid: "tier2-bot",
    botName: "tier2-bot",
    rootDir: tmpDir,
    dataDir: path.join(tmpDir, "data"),
    tempDir: path.join(tmpDir, "temp"),
    logsDir: path.join(tmpDir, "logs"),
    stateDir: path.join(tmpDir, "state"),
    messageJsonPath: msgJsonPath,
    maxEntries: 100,
  });

  // Recent message (2 hours ago) vs expired message (26 hours ago)
  msgStore.update({
    threadId: "g-1",
    type: 1,
    data: {
      cliMsgId: "cli-recent",
      msgId: "msg-recent",
      uidFrom: "u-1",
      dName: "Alice",
      content: "recent undoable message",
      ts: now - 2 * 3600 * 1000,
    },
  });
  msgStore.update({
    threadId: "g-1",
    type: 1,
    data: {
      cliMsgId: "cli-expired",
      msgId: "msg-expired",
      uidFrom: "u-2",
      dName: "Bob",
      content: "old message >24h",
      ts: now - 26 * 3600 * 1000,
    },
  });
  msgStore.flush(now);
  msgStore.prune(now);

  assert.ok(msgStore.getByMsgId("msg-recent"), "Recent (<24h) message must remain available for !antiundo");
  assert.equal(msgStore.getByMsgId("msg-expired"), null, "Expired (>24h) message must be pruned from RAM and disk");

  // B. LocmemStore (!locmem): 35-day rolling retention keeps 7d/30d windows intact
  const locStore = new LocmemStore({
    dbPath: path.join(tmpDir, "data", "locmem-activity"),
    botUid: "tier2-bot",
  });
  const todayKey = "2026-10-30";
  const valid35Days = getConsecutiveCalendarDays(todayKey, 35);
  for (const d of ["2026-09-01", "2026-09-15", ...valid35Days, todayKey]) {
    locStore.markCoverage("g-1", d, { isComplete: true, coverageStatus: "complete", snapshotSuccess: true });
    locStore.saveMemberSnapshot("g-1", ["u-1", "u-2"], d);
  }
  const removed = locStore.pruneOlderThanDays(35, todayKey);
  assert.equal(removed, 2);
  assert.equal(locStore.getQualified7DayWindow("g-1", todayKey).qualified, true, "7-day !locmem window must remain 100% qualified after 35d prune");
  locStore.close();

  // C. withTempFile helper leases during execution and deletes immediately on exit
  let capturedTempPath = null;
  await withTempFile(".png", async (tempPath) => {
    capturedTempPath = tempPath;
    fs.writeFileSync(tempPath, "render-bytes");
    const midSweep = await sweepUnleasedTempFiles({ projectRoot: tmpDir, maxUnleasedAgeMs: 0 });
    assert.equal(midSweep.deletedFiles, 0, "withTempFile path must be protected by lease while callback runs");
    assert.equal(fs.existsSync(tempPath), true);
  }, { botId: "tier2-bot", projectRoot: tmpDir });

  assert.equal(fs.existsSync(capturedTempPath), false, "withTempFile must delete temp file immediately in finally");
});
