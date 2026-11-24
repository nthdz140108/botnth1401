import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), `runtime-logger-${process.pid}-${Date.now()}`);

function makeLogsDir(name = 'logs') {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

test('logger: writes message, command, error, system to separate files', async () => {
  const logsDir = makeLogsDir('basic');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'test-bot' });

  logger.message({ threadId: 'g1', userId: 'u1', content: 'hello' });
  logger.command({ threadId: 'g1', userId: 'u1', command: 'ping', args: [] });
  logger.error({ scope: 'test', err: new Error('boom') });
  logger.system({ scope: 'test', level: 'info', message: 'started' });

  await logger.flush();
  await logger.close();

  const files = fs.readdirSync(logsDir);
  const kinds = files.map(f => f.split('-')[0]);
  assert.ok(kinds.includes('message'), `Expected message log file, got: ${files}`);
  assert.ok(kinds.includes('command'), `Expected command log file`);
  assert.ok(kinds.includes('error'), `Expected error log file`);
  assert.ok(kinds.includes('system'), `Expected system log file`);

  // Each file should be NDJSON
  for (const file of files) {
    const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.strictEqual(parsed.botKey, 'test-bot');
      assert.ok(parsed.ts, 'Entry must have ts');
    }
  }
});

test('logger: redactions cookies, tokens, imei', async () => {
  const logsDir = makeLogsDir('redact');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'redact-bot' });

  logger.message({ content: 'login cookie={"name":"session","value":"abc123"} now' });
  logger.message({ content: 'auth Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' });
  logger.error({ message: 'imei=12345678-abcdef failed' });

  await logger.flush();
  await logger.close();

  const files = fs.readdirSync(logsDir).filter(f => f.startsWith('message'));
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf8');
  assert.ok(content.includes('[REDACTED]'), `Should redact, got: ${content}`);
  assert.ok(!content.includes('abc123'), 'Original cookie value must not appear');
  assert.ok(!content.includes('eyJ'), 'JWT must not appear');
});

test('logger: backpressure drops oldest when queue full', async () => {
  const logsDir = makeLogsDir('backpressure');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'bp-bot', maxQueue: 10, batchSize: 100 });

  // Write 50 messages without flushing
  for (let i = 0; i < 50; i++) {
    logger.message({ content: `msg-${i}` });
  }
  const metrics = logger.getMetrics();
  assert.ok(metrics.queueSize <= 10, `Queue size must be capped at 10, got: ${metrics.queueSize}`);
  assert.ok(metrics.dropped >= 40, `Should have dropped at least 40, got: ${metrics.dropped}`);

  await logger.close();
});

test('logger: flush writes all queued entries', async () => {
  const logsDir = makeLogsDir('flush');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'flush-bot' });

  for (let i = 0; i < 25; i++) logger.message({ content: `entry-${i}` });
  await logger.flush();

  const before = logger.getMetrics();
  assert.equal(before.queueSize, 0);

  // Force close to write any remainder
  await logger.close();

  const after = logger.getMetrics();
  assert.ok(after.written >= 25, `Expected at least 25 written, got: ${after.written}`);
});

test('logger: cleanup 23:59 deletes only message/command of prior day, keeps today', async () => {
  const logsDir = makeLogsDir('cleanup-daily');
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 86400_000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const oldDay = new Date(today.getTime() - 10 * 86400_000);
  const oldDayStr = oldDay.toISOString().slice(0, 10);

  // Create fake log files
  fs.writeFileSync(path.join(logsDir, `message-${todayStr}.ndjson`), '{"ts":"x","content":"today"}\n');
  fs.writeFileSync(path.join(logsDir, `message-${yesterdayStr}.ndjson`), '{"ts":"x","content":"yesterday"}\n');
  fs.writeFileSync(path.join(logsDir, `command-${yesterdayStr}.ndjson`), '{"ts":"x","content":"y"}\n');
  fs.writeFileSync(path.join(logsDir, `error-${oldDayStr}.ndjson`), '{"ts":"x","content":"10d old"}\n');
  fs.writeFileSync(path.join(logsDir, `error-${yesterdayStr}.ndjson`), '{"ts":"x","content":"1d old"}\n');
  // Unrelated file
  fs.writeFileSync(path.join(logsDir, 'audit.log'), 'important data\n');
  fs.writeFileSync(path.join(logsDir, 'backup-2025.json'), '{}');

  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'cleanup-bot' });
  const result = await logger.cleanup();
  await logger.close();

  const remaining = fs.readdirSync(logsDir);
  // Yesterday's message and command: removed
  assert.ok(!remaining.includes(`message-${yesterdayStr}.ndjson`), `yesterday message should be removed: ${remaining}`);
  assert.ok(!remaining.includes(`command-${yesterdayStr}.ndjson`), `yesterday command should be removed`);
  // Today's message: kept
  assert.ok(remaining.includes(`message-${todayStr}.ndjson`), `today message should be kept: ${remaining}`);
  // 1-day old error: kept (< 7 days)
  assert.ok(remaining.includes(`error-${yesterdayStr}.ndjson`), `1-day old error should be kept`);
  // 10-day old error: removed
  assert.ok(!remaining.includes(`error-${oldDayStr}.ndjson`), `10-day old error should be removed`);
  // Unrelated files: kept untouched
  assert.ok(remaining.includes('audit.log'), 'audit.log must NOT be touched');
  assert.ok(remaining.includes('backup-2025.json'), 'backup must NOT be touched');

  assert.ok(result.removed >= 3, `Should remove at least 3 files, got ${result.removed}`);
});

test('logger: cleanup is idempotent within same day', async () => {
  const logsDir = makeLogsDir('cleanup-idem');
  fs.writeFileSync(path.join(logsDir, `message-2020-01-01.ndjson`), '{}');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'idem-bot' });

  const r1 = await logger.cleanup();
  const r2 = await logger.cleanup();
  await logger.close();

  // First call should remove; second should be skipped
  assert.ok(r1.removed >= 1 || r1.skipped === 'same_day');
  assert.equal(r2.skipped, 'same_day');
});

test('logger: respects per-bot isolation (logsDir per botKey)', async () => {
  const logsA = makeLogsDir('isolation/A');
  const logsB = makeLogsDir('isolation/B');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const loggerA = createRuntimeLogger({ logsDir: logsA, botKey: 'bot-a' });
  const loggerB = createRuntimeLogger({ logsDir: logsB, botKey: 'bot-b' });

  loggerA.message({ content: 'from A' });
  loggerB.message({ content: 'from B' });

  await Promise.all([loggerA.close(), loggerB.close()]);

  const filesA = fs.readdirSync(logsA);
  const filesB = fs.readdirSync(logsB);
  assert.ok(filesA.some(f => f.includes('message')), 'Bot A should have message log');
  assert.ok(filesB.some(f => f.includes('message')), 'Bot B should have message log');

  const contentA = fs.readFileSync(path.join(logsA, filesA.find(f => f.includes('message'))), 'utf8');
  const contentB = fs.readFileSync(path.join(logsB, filesB.find(f => f.includes('message'))), 'utf8');
  assert.ok(contentA.includes('from A'));
  assert.ok(contentA.includes('bot-a'));
  assert.ok(!contentA.includes('from B'), 'Bot A log must not contain B entries');
  assert.ok(contentB.includes('from B'));
  assert.ok(!contentB.includes('from A'), 'Bot B log must not contain A entries');
});

test('logger: closed logger rejects new entries', async () => {
  const logsDir = makeLogsDir('closed');
  const { createRuntimeLogger } = await import('../../src/runtime/logger.js');
  const logger = createRuntimeLogger({ logsDir, botKey: 'closed-bot' });
  await logger.close();
  logger.message({ content: 'after close' });
  await logger.flush();
  const m = logger.getMetrics();
  // Queue should remain empty
  assert.equal(m.queueSize, 0);
});

// Global cleanup
test.after?.(() => cleanup());
test('(cleanup global)', async () => { cleanup(); });
