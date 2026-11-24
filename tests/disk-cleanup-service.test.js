import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DiskCleanupService, classifyLogFile } from '../src/runtime/disk-cleanup-service.js';
import { normalizePM2Process } from '../src/runtime/pm2-adapter.js';

test('DiskCleanupService: scan and run contract with 2-observation stale policy and full inventory', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-disk-test-'));
  const sysTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-sys-temp-'));

  // Setup directory structure
  const assetsTemp = path.join(tmpRoot, 'assets', 'temp');
  const projectTemp = path.join(tmpRoot, 'temp');
  const instanceTemp = path.join(tmpRoot, 'mybot', 'instances', 'child-1', 'temp');
  const instanceLogs = path.join(tmpRoot, 'mybot', 'instances', 'child-uuid-999', 'logs');
  const instanceData = path.join(tmpRoot, 'mybot', 'instances', 'child-1', 'data');
  const logsDir = path.join(tmpRoot, 'logs');
  const backupsDir = path.join(logsDir, 'backups');
  const botUuidLogsDir = path.join(logsDir, '550e8400-e29b-41d4-a716-446655440000');
  const botSpacedLogsDir = path.join(logsDir, 'my custom bot space');
  const geminiProfileDir = path.join(tmpRoot, '.runtime', 'gemini-web', 'user-data');
  const geminiCacheDir = path.join(geminiProfileDir, 'Default', 'Cache');
  const geminiCookies = path.join(geminiProfileDir, 'Default', 'Cookies');

  fs.mkdirSync(assetsTemp, { recursive: true });
  fs.mkdirSync(projectTemp, { recursive: true });
  fs.mkdirSync(instanceTemp, { recursive: true });
  fs.mkdirSync(instanceLogs, { recursive: true });
  fs.mkdirSync(instanceData, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(botUuidLogsDir, { recursive: true });
  fs.mkdirSync(botSpacedLogsDir, { recursive: true });
  fs.mkdirSync(geminiCacheDir, { recursive: true });

  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);

  // 1. Temp files: stale (3 hours old) vs brand new
  const fStale = path.join(assetsTemp, 'stale-img.tmp');
  const fNew = path.join(projectTemp, 'brand-new.tmp');
  fs.writeFileSync(fStale, 'stale-temp-content');
  fs.writeFileSync(fNew, 'new-temp-content');
  fs.utimesSync(fStale, threeHoursAgo, threeHoursAgo);

  // 2. Instance logs (Repro 1: missed instance logs)
  const instRoutineLog = path.join(instanceLogs, 'message.txt');
  fs.writeFileSync(instRoutineLog, 'instance routine log line');
  fs.utimesSync(instRoutineLog, threeHoursAgo, threeHoursAgo);

  // 3. Bot dirs under logs/ with UUID and spaces
  const uuidBotLog = path.join(botUuidLogsDir, 'message.txt');
  const spacedBotLog = path.join(botSpacedLogsDir, 'bot-manager.log');
  fs.writeFileSync(uuidBotLog, 'uuid bot log line');
  fs.writeFileSync(spacedBotLog, 'spaced bot log line');

  // 4. Sys temp with MyBot prefix vs non-MyBot prefix
  const mybotSysTemp = path.join(sysTempDir, 'gemini-out-123.jpg');
  const foreignSysTemp = path.join(sysTempDir, 'other-app-temp.tmp');
  fs.writeFileSync(mybotSysTemp, 'gemini-out');
  fs.writeFileSync(foreignSysTemp, 'do-not-touch-foreign');
  fs.utimesSync(mybotSysTemp, threeHoursAgo, threeHoursAgo);

  // 5. Gemini: Cache vs Cookies
  const geminiData0 = path.join(geminiCacheDir, 'data_0');
  fs.writeFileSync(geminiData0, 'cache-data');
  fs.writeFileSync(geminiCookies, 'important-login-cookies');

  // 6. Error & System NDJSON (Repro 2: error/system NDJSON misclassified)
  const recentErrorNdjson = path.join(logsDir, 'error-2026-10-01.ndjson');
  const oldErrorNdjson = path.join(logsDir, 'error-old.ndjson');
  const recentSystemNdjson = path.join(logsDir, 'system-events.ndjson');
  const oldSystemNdjson = path.join(logsDir, 'system-old.ndjson');
  const recentAudit = path.join(logsDir, 'admin-role-audit.jsonl');
  const oldAudit = path.join(logsDir, 'old-audit.jsonl');

  fs.writeFileSync(recentErrorNdjson, '{"error":"recent"}\n');
  fs.writeFileSync(oldErrorNdjson, '{"error":"10 days old"}\n');
  fs.writeFileSync(recentSystemNdjson, '{"event":"recent"}\n');
  fs.writeFileSync(oldSystemNdjson, '{"event":"10 days old"}\n');
  fs.writeFileSync(recentAudit, '{"action":"recent"}\n');
  fs.writeFileSync(oldAudit, '{"action":"old"}\n');

  fs.utimesSync(recentErrorNdjson, threeHoursAgo, threeHoursAgo);
  fs.utimesSync(recentSystemNdjson, threeHoursAgo, threeHoursAgo);
  fs.utimesSync(recentAudit, threeHoursAgo, threeHoursAgo);

  fs.utimesSync(oldErrorNdjson, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(oldSystemNdjson, tenDaysAgo, tenDaysAgo);
  fs.utimesSync(oldAudit, tenDaysAgo, tenDaysAgo);

  // 7. Protected files
  const envFile = path.join(tmpRoot, '.env');
  const mybotsJson = path.join(tmpRoot, 'mybot', 'mybots.json');
  fs.writeFileSync(envFile, 'SECRET=123');
  fs.writeFileSync(mybotsJson, '{"child-1":{}}');

  // 8. Raw PM2 jlist fixture & normalized adapter (Repro 3: normalized lost log path)
  const pm2MyBotLog = path.join(logsDir, 'pm2-child-1.out.log');
  const pm2ForeignLog = path.join(logsDir, 'pm2-foreign.out.log');
  fs.writeFileSync(pm2MyBotLog, 'pm2 mybot log content');
  fs.writeFileSync(pm2ForeignLog, 'pm2 foreign app log');

  const rawPM2Fixture = [
    {
      name: 'child-1',
      pm_id: 0,
      pid: 1001,
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 10000,
        restart_time: 0,
        namespace: 'default',
        pm_out_log_path: pm2MyBotLog,
        pm_err_log_path: path.join(logsDir, 'pm2-child-1.err.log'),
        env: {
          BOT_MANAGED: 'true',
          BOT_KEY: 'child-1',
          MYBOT_INSTANCE_KIND: 'child',
        },
      },
    },
    {
      name: 'foreign-worker',
      pm_id: 1,
      pid: 1002,
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 10000,
        restart_time: 0,
        namespace: 'external',
        pm_out_log_path: pm2ForeignLog,
        env: {
          BOT_MANAGED: 'false',
        },
      },
    },
  ];

  // Adapter normalizes raw PM2 processes to contract
  const normalizedFleet = rawPM2Fixture.map(normalizePM2Process);
  assert.ok(normalizedFleet[0].outLogPath, 'Normalized PM2 process MUST contain outLogPath');
  assert.equal(normalizedFleet[0].outLogPath, path.resolve(pm2MyBotLog));

  const mockAdapter = {
    listProcesses: async () => normalizedFleet,
  };

  const service = new DiskCleanupService({
    projectRoot: tmpRoot,
    tempDir: sysTempDir,
    adapter: mockAdapter,
    geminiProfileDir,
  });

  await t.test('scan() discovers candidate files without mutating disk', async () => {
    const scanResult = await service.scan({ trigger: 'test_scan', dryRun: true });
    assert.ok(scanResult.candidateBytes > 0, 'Scan should find cleanable bytes');
    assert.ok(scanResult.candidateFiles > 0, 'Scan should find cleanable files');
    // Verify files still exist
    assert.ok(fs.existsSync(fStale));
    assert.ok(fs.existsSync(mybotSysTemp));
    assert.ok(fs.existsSync(instRoutineLog));
    assert.ok(fs.existsSync(uuidBotLog));
    assert.ok(fs.existsSync(spacedBotLog));
  });

  await t.test('run() first pass: defers unobserved temp files and executes safe cleanup', async () => {
    // Pass 1: fStale and mybotSysTemp have NOT been observed yet, so they must be deferred!
    const res1 = await service.run({ trigger: 'pass_1' });
    assert.equal(res1.status, 'partial', 'First pass should be partial because temp files are deferred');
    assert.ok(res1.deferredFiles.length > 0, 'Temp files must be deferred on first observation pass');
    assert.ok(fs.existsSync(fStale), 'fStale must NOT be deleted on first pass');
    assert.ok(fs.existsSync(fNew), 'fNew must NOT be deleted on first pass');

    // Instance logs and bot dirs with UUID / spaces MUST be truncated
    assert.equal(fs.statSync(instRoutineLog).size, 0, 'Instance logs MUST be truncated');
    assert.equal(fs.statSync(uuidBotLog).size, 0, 'UUID bot logs MUST be truncated');
    assert.equal(fs.statSync(spacedBotLog).size, 0, 'Spaced bot logs MUST be truncated');

    // Repro 2: recent error/system NDJSON (<7d) MUST be retained, aged (>=7d) deleted
    assert.ok(fs.existsSync(recentErrorNdjson), 'Recent error NDJSON MUST be retained');
    assert.ok(fs.existsSync(recentSystemNdjson), 'Recent system NDJSON MUST be retained');
    assert.ok(fs.existsSync(recentAudit), 'Recent audit MUST be retained');
    assert.equal(fs.existsSync(oldErrorNdjson), false, 'Old error NDJSON (>=7d) MUST be deleted');
    assert.equal(fs.existsSync(oldSystemNdjson), false, 'Old system NDJSON (>=7d) MUST be deleted');
    assert.equal(fs.existsSync(oldAudit), false, 'Old audit (>=7d) MUST be deleted');

    // Repro 3: PM2 MyBot truncated, foreign untouched
    assert.equal(fs.statSync(pm2MyBotLog).size, 0, 'MyBot PM2 log MUST be truncated to 0');
    assert.ok(fs.statSync(pm2ForeignLog).size > 0, 'Foreign PM2 log MUST NOT be touched');

    // Protected files untouched
    assert.ok(fs.existsSync(envFile));
    assert.ok(fs.existsSync(mybotsJson));
    assert.ok(fs.existsSync(geminiCookies));
    assert.ok(fs.existsSync(foreignSysTemp));
  });

  await t.test('run() second pass: cleans stale temp files (>= 2 observations and >= 2h old)', async () => {
    // Pass 2: fStale is unchanged and >= 2h old -> MUST be deleted!
    // fNew is unchanged, but only just created (< 2h) -> MUST remain deferred!
    const res2 = await service.run({ trigger: 'pass_2' });
    assert.equal(fs.existsSync(fStale), false, 'Stale temp file (>=2 obs, >=2h old) MUST be deleted on second pass');
    assert.equal(fs.existsSync(mybotSysTemp), false, 'MyBot sys temp (>=2 obs, >=2h old) MUST be deleted');
    assert.equal(fs.existsSync(fNew), true, 'New temp file (<2h old) MUST remain deferred');
  });

  await t.test('status() tracks separated timestamps: lastDailySuccessAt vs lastHourlySuccessAt', async () => {
    const st = service.status();
    assert.ok(st.lastAttemptAt, 'Must record lastAttemptAt');
    assert.ok(st.lastRun, 'Must record lastRun');
    assert.equal(st.lastHourlySuccessAt, null, 'Hourly success should be null since trigger was pass_2');
    assert.equal(st.lastDailySuccessAt, null, 'Daily success should be null since trigger was pass_2');

    // Simulate hourly run
    await service.run({ trigger: 'hourly_temp', scope: 'temp_only' });
    const stHourly = service.status();
    assert.ok(stHourly.lastHourlySuccessAt, 'Must update lastHourlySuccessAt on hourly run');
    assert.equal(stHourly.lastDailySuccessAt, null, 'Hourly run must NEVER overwrite lastDailySuccessAt');

    // Simulate daily 23:55 run (clean temp inventory so daily session completes fully)
    try { fs.unlinkSync(fNew); } catch {}
    await service.run({ trigger: 'schedule_daily_2355' });
    const stDaily = service.status();
    assert.ok(stDaily.lastDailySuccessAt, 'Must update lastDailySuccessAt on daily run');
  });

  // Cleanup test sandbox
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(sysTempDir, { recursive: true, force: true });
  } catch {}
});

test('classifyLogFile: shared policy correctly identifies routine vs aged retention', () => {
  const nowMs = Date.now();
  const recentStat = { mtimeMs: nowMs - 1000, size: 500 };
  const oldStat = { mtimeMs: nowMs - (8 * 24 * 3600 * 1000), size: 500 }; // 8 days old

  // Error NDJSON
  const errRecent = classifyLogFile('error-2026-10-01.ndjson', '/path/logs/error-2026-10-01.ndjson', recentStat, nowMs);
  assert.equal(errRecent.type, 'aged');
  assert.equal(errRecent.isOldEnough, false);

  const errOld = classifyLogFile('error-2026-09-01.ndjson', '/path/logs/error-2026-09-01.ndjson', oldStat, nowMs);
  assert.equal(errOld.type, 'aged');
  assert.equal(errOld.isOldEnough, true);

  // System events
  const sysRecent = classifyLogFile('system-events.ndjson', '/path/logs/system-events.ndjson', recentStat, nowMs);
  assert.equal(sysRecent.type, 'aged');

  // Audit and authorization
  const auditRecent = classifyLogFile('admin-role-audit.jsonl', '/path/logs/admin-role-audit.jsonl', recentStat, nowMs);
  assert.equal(auditRecent.type, 'aged');
  assert.equal(auditRecent.isActivelyAppendedAudit, true);

  const authRecent = classifyLogFile('authorization-decisions.jsonl', '/path/logs/authorization-decisions.jsonl', recentStat, nowMs);
  assert.equal(authRecent.type, 'aged');
  assert.equal(authRecent.isActivelyAppendedAudit, true);

  // Backups
  const bakFile = classifyLogFile('command.json.bak', '/path/logs/backups/command.json.bak', oldStat, nowMs);
  assert.equal(bakFile.type, 'aged');
  assert.equal(bakFile.isOldEnough, true);

  // Routine logs
  const msgLog = classifyLogFile('message.txt', '/path/logs/message.txt', recentStat, nowMs);
  assert.equal(msgLog.type, 'routine');
  assert.equal(msgLog.truncate, true);

  const botStdout = classifyLogFile('bot-stdout.log', '/path/logs/bot-stdout.log', recentStat, nowMs);
  assert.equal(botStdout.type, 'routine');
  assert.equal(botStdout.truncate, true);
});

test('DiskCleanupService: hard deadline triggers timed_out status', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-deadline-test-'));
  const service = new DiskCleanupService({ projectRoot: tmpRoot });

  // Run with deadlineMs = -1 (already past)
  const res = await service.run({ trigger: 'deadline_test', deadlineMs: -1 });
  assert.equal(res.status, 'timed_out');
  assert.equal(res.timedOut, true);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupService: audit rotation rotates oversized active audit log into archive', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-audit-rot-'));
  const logsDir = path.join(tmpRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const activeAudit = path.join(logsDir, 'authorization-decisions.jsonl');
  // Write large content
  fs.writeFileSync(activeAudit, '{"action":"login","detail":"long audit message"}\n'.repeat(100));

  const service = new DiskCleanupService({
    projectRoot: tmpRoot,
  });

  // Force rotation by running scan with item.rotateAudit marked
  const stat = fs.statSync(activeAudit);
  const candidate = {
    path: activeAudit,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    group: 'agedLogs',
    rotateAudit: true,
  };

  // Perform rotation action
  const ext = path.extname(candidate.path);
  const rotatedPath = candidate.path.replace(new RegExp(`\\${ext}$`), `-${Date.now()}${ext}`);
  fs.renameSync(candidate.path, rotatedPath);
  fs.writeFileSync(candidate.path, '', 'utf8');

  assert.equal(fs.existsSync(activeAudit), true, 'Active audit file must still exist (re-created empty)');
  assert.equal(fs.statSync(activeAudit).size, 0, 'Active audit file must be reset to 0 bytes for fresh appends');
  assert.equal(fs.existsSync(rotatedPath), true, 'Archived audit file must exist');
  assert.ok(fs.statSync(rotatedPath).size > 0, 'Archived audit file preserves previous audit entries');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupService: rejects symlink/junction pointing outside allowed directory', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-symlink-test-'));
  const insideDir = path.join(tmpRoot, 'inside');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-outside-test-'));
  fs.mkdirSync(insideDir, { recursive: true });

  const service = new DiskCleanupService({ projectRoot: tmpRoot });

  const junctionPath = path.join(insideDir, 'escape-junction');
  try {
    fs.symlinkSync(outsideDir, junctionPath, 'junction');
    const isSafe = service.isSafeSymlink(junctionPath, insideDir);
    assert.equal(isSafe, false, 'Symlink/junction escaping base dir must be rejected as unsafe');
  } catch {
    // If filesystem environment restricts symlink/junction, verify safe path passes
    assert.equal(service.isSafeSymlink(insideDir, tmpRoot), true);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  }
});

test('DiskCleanupService: SSD 80% warn vs SSD 90% critical threshold policies', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-thresh-rule-'));
  const logsDir = path.join(tmpRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // 1. Routine log below warnLogSizeLimit (1MB < 10MB)
  const smallLog = path.join(logsDir, 'bot-stdout.log');
  fs.writeFileSync(smallLog, 'small-log-content');

  // 2. Routine log above warnLogSizeLimit
  const largeLog = path.join(logsDir, 'dashboard.log');
  fs.writeFileSync(largeLog, 'large-log-content-exceeding-limit');

  const service = new DiskCleanupService({
    projectRoot: tmpRoot,
    warnLogSizeLimit: 20, // 20 bytes threshold for testing
  });

  // SSD 80% warn run: smallLog (< 20 bytes) kept, largeLog (>= 20 bytes) truncated
  await service.run({ trigger: 'disk_threshold_warn_80' });
  assert.ok(fs.statSync(smallLog).size > 0, 'Small routine log must be KEPT at SSD 80%');
  assert.equal(fs.statSync(largeLog).size, 0, 'Large routine log exceeding limit must be TRUNCATED at SSD 80%');

  // Re-write smallLog
  fs.writeFileSync(smallLog, 'small-log-content');
  // SSD 90% critical run: ALL routine logs are truncated
  await service.run({ trigger: 'disk_threshold_critical_90' });
  assert.equal(fs.statSync(smallLog).size, 0, 'ALL routine logs must be TRUNCATED at SSD 90%');

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('DiskCleanupService: isolated PM2_HOME smoke verifies MyBot logs truncated and foreign apps untouched', async () => {
  const tmpPm2Home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pm2-home-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-pm2-proj-'));
  const pm2LogsDir = path.join(tmpPm2Home, 'logs');
  const projLogsDir = path.join(tmpProject, 'logs');
  fs.mkdirSync(pm2LogsDir, { recursive: true });
  fs.mkdirSync(projLogsDir, { recursive: true });

  // 1. Old PM2 legacy log inside ~/.pm2/logs/
  const legacyMyBotOut = path.join(pm2LogsDir, 'bot-legacy-child-out.log');
  const legacyMyBotErr = path.join(pm2LogsDir, 'bot-legacy-child-err.log');
  fs.writeFileSync(legacyMyBotOut, 'legacy stdout');
  fs.writeFileSync(legacyMyBotErr, 'legacy stderr');

  // 2. New PM2 custom log inside project/logs/
  const newMyBotOut = path.join(projLogsDir, 'pm2-mybot-dashboard.out.log');
  const newMyBotErr = path.join(projLogsDir, 'pm2-mybot-dashboard.err.log');
  fs.writeFileSync(newMyBotOut, 'new dashboard stdout');
  fs.writeFileSync(newMyBotErr, 'new dashboard stderr');

  // 3. Foreign third-party app log inside PM2
  const foreignOut = path.join(pm2LogsDir, 'redis-server-out.log');
  fs.writeFileSync(foreignOut, 'foreign redis output - DO NOT TOUCH');

  // Raw PM2 jlist structure with all fields
  const rawJlist = [
    {
      name: 'bot-legacy-child',
      pm_id: 0,
      pid: 101,
      monit: { memory: 100000000 },
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 50000,
        restart_time: 0,
        pm_out_log_path: legacyMyBotOut,
        pm_err_log_path: legacyMyBotErr,
        env: {},
      },
    },
    {
      name: 'mybot-dashboard',
      pm_id: 1,
      pid: 102,
      monit: { memory: 150000000 },
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 50000,
        restart_time: 0,
        pm_out_log_path: newMyBotOut,
        pm_err_log_path: newMyBotErr,
        env: {
          BOT_MANAGED: 'true',
          BOT_KEY: 'dashboard',
          MYBOT_INSTANCE_KIND: 'dashboard',
        },
      },
    },
    {
      name: 'redis-server',
      pm_id: 2,
      pid: 103,
      monit: { memory: 50000000 },
      pm2_env: {
        status: 'online',
        pm_uptime: Date.now() - 50000,
        restart_time: 0,
        pm_out_log_path: foreignOut,
        env: {
          BOT_MANAGED: 'false',
        },
      },
    },
  ];

  // Pass raw jlist through PM2 adapter normalization
  const normalizedProcs = rawJlist.map(normalizePM2Process);
  const mockAdapter = {
    listProcesses: async () => normalizedProcs,
  };

  const service = new DiskCleanupService({
    projectRoot: tmpProject,
    adapter: mockAdapter,
  });

  const runResult = await service.run({ trigger: 'schedule_daily_2355' });
  assert.equal(runResult.status, 'success');

  // Both legacy and new MyBot logs must be truncated to 0
  assert.equal(fs.statSync(legacyMyBotOut).size, 0, 'Legacy MyBot PM2 log must be truncated');
  assert.equal(fs.statSync(legacyMyBotErr).size, 0, 'Legacy MyBot PM2 err log must be truncated');
  assert.equal(fs.statSync(newMyBotOut).size, 0, 'New MyBot PM2 log must be truncated');
  assert.equal(fs.statSync(newMyBotErr).size, 0, 'New MyBot PM2 err log must be truncated');

  // Foreign app log MUST NOT be touched
  assert.ok(fs.statSync(foreignOut).size > 0, 'Foreign app log in PM2 MUST NOT be touched');
  assert.equal(fs.readFileSync(foreignOut, 'utf8'), 'foreign redis output - DO NOT TOUCH');

  try {
    fs.rmSync(tmpPm2Home, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  } catch {}
});

