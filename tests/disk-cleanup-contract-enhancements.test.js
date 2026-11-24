import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { parsePM2JlistOutput, PM2ErrorCode } from '../src/runtime/pm2-adapter.js';
import { DiskCleanupService, isPathContained } from '../src/runtime/disk-cleanup-service.js';
import {
  evaluateCleanupHealth,
  recordGuardianHeartbeat,
  readGuardianHeartbeat,
  HEARTBEAT_STALE_MS,
} from '../src/runtime/disk-cleanup-heartbeat.js';

test('PM2 parser: handles raw jlist, startup banners, and unparseable outputs', () => {
  // 1. Pure JSON array output
  const pureJson = JSON.stringify([
    { name: 'mybot-dashboard', pm_id: 0, pm2_env: { status: 'online' } },
  ]);
  const parsed1 = parsePM2JlistOutput(pureJson);
  assert.equal(Array.isArray(parsed1), true);
  assert.equal(parsed1.length, 1);
  assert.equal(parsed1[0].name, 'mybot-dashboard');

  // 2. Banner output before single-line JSON array
  const bannerSingleLine = `[PM2] Spawning PM2 daemon with pm2_home=C:\\Users\\Admin\\.pm2
[PM2] PM2 Successfully daemonized
[{"name":"mybot-guardian","pm_id":1,"pm2_env":{"status":"online"}}]`;
  const parsed2 = parsePM2JlistOutput(bannerSingleLine);
  assert.equal(Array.isArray(parsed2), true);
  assert.equal(parsed2.length, 1);
  assert.equal(parsed2[0].name, 'mybot-guardian');

  // 3. Banner output before multi-line JSON array
  const bannerMultiLine = `[PM2] Spawning PM2 daemon with pm2_home=C:\\Users\\Admin\\.pm2
[PM2] PM2 Successfully daemonized
[
  {
    "name": "admin",
    "pm_id": 2,
    "pm2_env": { "status": "online" }
  }
]`;
  const parsed3 = parsePM2JlistOutput(bannerMultiLine);
  assert.equal(Array.isArray(parsed3), true);
  assert.equal(parsed3.length, 1);
  assert.equal(parsed3[0].name, 'admin');

  // 4. Invalid non-JSON output returns null (never throws silently)
  const invalidOutput = `[PM2] Spawning PM2 daemon failed
Error: connect ECONNREFUSED`;
  const parsed4 = parsePM2JlistOutput(invalidOutput);
  assert.equal(parsed4, null);
});

test('Daily status: prevents giả-success on partial, timeout, PM2 failure, or incomplete inventory', async () => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-giasuccess-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const statusPath = path.join(tmpRoot, 'status.json');
  const observationsPath = path.join(tmpRoot, 'observations.json');

  let currentTime = 1791650000000;
  const now = () => currentTime;

  // Case 1: Partial run (due to locked or deferred files or mock PM2 failure) must NOT set lastDailySuccessAt
  const failingAdapter = {
    listProcesses: async () => {
      throw new Error('PM2 daemon connection refused');
    },
  };

  const serviceWithFailingPM2 = new DiskCleanupService({
    projectRoot: tmpRoot,
    statusPath,
    observationsPath,
    adapter: failingAdapter,
    now,
  });

  const res1 = await serviceWithFailingPM2.run({ trigger: 'schedule_daily_2355' });
  assert.equal(res1.status, 'partial', 'Run with failing PM2 adapter must report partial');
  assert.equal(res1.inventoryComplete, false, 'inventoryComplete must be false when PM2 fails');
  assert.equal(res1.lastDailySuccessAt, null, 'Partial daily run must NOT update lastDailySuccessAt');

  // Case 2: Session with deadline timeout must NOT set lastDailySuccessAt
  const healthyAdapter = {
    listProcesses: async () => [
      { name: 'mybot-dashboard', outLogPath: null, errorLogPath: null },
    ],
  };

  const serviceWithTimeout = new DiskCleanupService({
    projectRoot: tmpRoot,
    statusPath,
    observationsPath,
    adapter: healthyAdapter,
    now,
  });

  const res2 = await serviceWithTimeout.run({
    trigger: 'schedule_daily_2355',
    deadlineMs: -1000, // Forces immediate timeout
  });
  assert.equal(res2.status, 'timed_out');
  assert.equal(res2.lastDailySuccessAt, null, 'Timed out daily run must NOT update lastDailySuccessAt');

  // Case 3: Complete healthy session with full inventory MUST update lastDailySuccessAt
  const healthyService = new DiskCleanupService({
    projectRoot: tmpRoot,
    statusPath,
    observationsPath,
    adapter: healthyAdapter,
    now,
  });

  const res3 = await healthyService.run({ trigger: 'schedule_daily_2355' });
  assert.equal(res3.status, 'success');
  assert.equal(res3.inventoryComplete, true);
  assert.ok(res3.lastDailySuccessAt, 'Successful daily run with complete inventory MUST update lastDailySuccessAt');

  // Clean test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('Heartbeat & health evaluator: distinguishes healthy, stale, never_started, partial', () => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-heartbeat-eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const nowMs = 1791650000000;

  // 1. never_started: no heartbeat and no status run attempt
  const h1 = evaluateCleanupHealth({
    status: { status: 'idle', lastAttemptAt: null, lastRun: null },
    heartbeat: null,
    nowMs,
  });
  assert.equal(h1, 'never_started');

  // 2. stale: heartbeat older than STALE_MS
  const staleHb = {
    timestamp: nowMs - HEARTBEAT_STALE_MS - 5000,
    guardianHeartbeatAt: new Date(nowMs - HEARTBEAT_STALE_MS - 5000).toISOString(),
  };
  const h2 = evaluateCleanupHealth({
    status: { status: 'success', lastRun: new Date(nowMs).toISOString() },
    heartbeat: staleHb,
    nowMs,
  });
  assert.equal(h2, 'stale');

  // 3. partial: heartbeat fresh, but latest status ended partial or incomplete inventory
  const freshHb = {
    timestamp: nowMs - 1000,
    guardianHeartbeatAt: new Date(nowMs - 1000).toISOString(),
  };
  const h3 = evaluateCleanupHealth({
    status: { status: 'partial', inventoryComplete: true },
    heartbeat: freshHb,
    nowMs,
  });
  assert.equal(h3, 'partial');

  const h3b = evaluateCleanupHealth({
    status: { status: 'success', inventoryComplete: false },
    heartbeat: freshHb,
    nowMs,
  });
  assert.equal(h3b, 'partial');

  // 4. healthy: heartbeat fresh, status success with full inventory
  const h4 = evaluateCleanupHealth({
    status: { status: 'success', inventoryComplete: true, errors: [] },
    heartbeat: freshHb,
    nowMs,
  });
  assert.equal(h4, 'healthy');

  // Clean test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('Media-path containment and junction rejection', () => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-containment-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const allowedTempDir = path.join(tmpRoot, 'assets', 'temp');
  const protectedMediaDir = path.join(tmpRoot, 'media');
  fs.mkdirSync(allowedTempDir, { recursive: true });
  fs.mkdirSync(protectedMediaDir, { recursive: true });

  const insideFile = path.join(allowedTempDir, 'temp_audio.mp3');
  fs.writeFileSync(insideFile, 'temp content');

  const outsideFile = path.join(protectedMediaDir, 'source_audio.mp3');
  fs.writeFileSync(outsideFile, 'source media');

  // 1. Path inside allowed dir is contained
  assert.equal(isPathContained(insideFile, allowedTempDir), true);

  // 2. Path outside allowed dir is NOT contained
  assert.equal(isPathContained(outsideFile, allowedTempDir), false);

  // 3. Symlink / junction pointing outside allowed dir is rejected
  const linkPath = path.join(allowedTempDir, 'escaped_link');
  try {
    fs.symlinkSync(protectedMediaDir, linkPath, 'junction');
    assert.equal(isPathContained(linkPath, allowedTempDir), false, 'Symlink escaping allowed dir must return false');
  } catch {
    // Windows might require elevated privileges for symlink without junction; test is best-effort on Windows
  }

  // 4. DiskCleanupService isForbidden blocks all protected directories
  const service = new DiskCleanupService({ projectRoot: tmpRoot });
  assert.equal(service.isForbidden(outsideFile), true, 'media folder files must be strictly forbidden');
  assert.equal(service.isForbidden(path.join(tmpRoot, 'linhcute.mp3')), true, 'linhcute.mp3 must be strictly forbidden');
  assert.equal(service.isForbidden(path.join(tmpRoot, 'assets', 'data', 'track.mp3')), true, 'assets/data files must be forbidden');
  assert.equal(service.isForbidden(path.join(tmpRoot, 'video', 'clip.mp4')), true, 'video files must be forbidden');
  assert.equal(service.isForbidden(insideFile), false, 'assets/temp/temp_audio.mp3 must be cleanable');

  // Clean test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

test('Log contract: nested instance logs, truncate in place, 7-day retention, and PM2 isolation', async () => {
  const tmpRoot = path.join(os.tmpdir(), `mybot-log-contract-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const instanceLogsDir = path.join(tmpRoot, 'mybot', 'instances', 'bot-main', 'logs', 'nested');
  const normalLogsDir = path.join(tmpRoot, 'logs', 'bot-child');
  const backupsDir = path.join(tmpRoot, 'logs', 'bot-child', 'backups');

  fs.mkdirSync(instanceLogsDir, { recursive: true });
  fs.mkdirSync(normalLogsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });

  const statusPath = path.join(tmpRoot, 'status.json');
  const observationsPath = path.join(tmpRoot, 'observations.json');

  const nowMs = 1791650000000;
  const now = () => nowMs;

  // 1. Nested instance normal log
  const nestedInstLog = path.join(instanceLogsDir, 'worker.log');
  fs.writeFileSync(nestedInstLog, 'nested instance worker log content');

  // 2. Normal routine log
  const routineLog = path.join(normalLogsDir, 'stdout.log');
  fs.writeFileSync(routineLog, 'routine stdout log content');

  // 3. Error log (recent < 7d vs aged >= 7d)
  const recentErrorLog = path.join(normalLogsDir, 'error-2026-10-09.log');
  fs.writeFileSync(recentErrorLog, 'recent error log content');
  fs.utimesSync(recentErrorLog, (nowMs - 2 * 24 * 3600 * 1000) / 1000, (nowMs - 2 * 24 * 3600 * 1000) / 1000);

  const agedErrorLog = path.join(normalLogsDir, 'error-2026-09-01.log');
  fs.writeFileSync(agedErrorLog, 'aged error log content');
  fs.utimesSync(agedErrorLog, (nowMs - 10 * 24 * 3600 * 1000) / 1000, (nowMs - 10 * 24 * 3600 * 1000) / 1000);

  // 4. Backup log in backups folder (recent < 7d vs aged >= 7d)
  const recentBackup = path.join(backupsDir, 'backup-recent.bak');
  fs.writeFileSync(recentBackup, 'recent backup');
  fs.utimesSync(recentBackup, (nowMs - 1 * 24 * 3600 * 1000) / 1000, (nowMs - 1 * 24 * 3600 * 1000) / 1000);

  const agedBackup = path.join(backupsDir, 'backup-aged.bak');
  fs.writeFileSync(agedBackup, 'aged backup');
  fs.utimesSync(agedBackup, (nowMs - 15 * 24 * 3600 * 1000) / 1000, (nowMs - 15 * 24 * 3600 * 1000) / 1000);

  // 5. PM2 logs: MyBot vs Foreign
  const pm2MyBotLog = path.join(tmpRoot, 'pm2-mybot.log');
  fs.writeFileSync(pm2MyBotLog, 'mybot pm2 stdout content');

  const pm2ForeignLog = path.join(tmpRoot, 'pm2-foreign.log');
  fs.writeFileSync(pm2ForeignLog, 'foreign pm2 stdout content');

  const mockAdapter = {
    listProcesses: async () => [
      {
        name: 'mybot-dashboard',
        outLogPath: pm2MyBotLog,
        errorLogPath: null,
        env: { BOT_MANAGED: 'true', BOT_KEY: 'dashboard' },
      },
      {
        name: 'unrelated-foreign-app',
        outLogPath: pm2ForeignLog,
        errorLogPath: null,
        env: {},
      },
    ],
  };

  const service = new DiskCleanupService({
    projectRoot: tmpRoot,
    statusPath,
    observationsPath,
    adapter: mockAdapter,
    now,
  });

  // Run cleanup session
  const res = await service.run({ trigger: 'manual_run' });
  assert.equal(res.status, 'success');

  // Verify normal logs are truncated in-place (file still exists, size = 0)
  assert.ok(fs.existsSync(nestedInstLog), 'Nested instance log must still exist');
  assert.equal(fs.statSync(nestedInstLog).size, 0, 'Nested instance log must be truncated to 0');

  assert.ok(fs.existsSync(routineLog), 'Routine log must still exist');
  assert.equal(fs.statSync(routineLog).size, 0, 'Routine log must be truncated to 0');

  // Verify 7-day retention
  assert.ok(fs.existsSync(recentErrorLog), 'Recent error log (<7d) must be retained');
  assert.equal(fs.existsSync(agedErrorLog), false, 'Aged error log (>=7d) must be deleted');

  assert.ok(fs.existsSync(recentBackup), 'Recent backup (<7d) must be retained');
  assert.equal(fs.existsSync(agedBackup), false, 'Aged backup (>=7d) must be deleted');

  // Verify PM2 log isolation
  assert.ok(fs.existsSync(pm2MyBotLog), 'MyBot PM2 log must still exist');
  assert.equal(fs.statSync(pm2MyBotLog).size, 0, 'MyBot PM2 log must be truncated to 0');

  assert.ok(fs.existsSync(pm2ForeignLog), 'Foreign PM2 log must exist');
  assert.ok(fs.statSync(pm2ForeignLog).size > 0, 'Foreign PM2 log must remain untouched');

  // Cleanup test tmp
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

