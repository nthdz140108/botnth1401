import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Tests for the runtime memory-pressure listener.
 * Verifies the bot can receive flag files from the guardian, run a hook,
 * write the ACK, and remove the flag.
 */

async function makeTempDir() {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mybot-pressure-'));
}

test('MemoryPressureListener: processes flag file and writes ACK', async () => {
  const { MemoryPressureListener } = await import('../../src/runtime/memory-pressure-listener.js');
  const projectRoot = await makeTempDir();
  const pm2Name = 'test-bot';
  const pressureDir = path.join(projectRoot, '.runtime', 'pressure');
  await fs.promises.mkdir(pressureDir, { recursive: true });
  const flagPath = path.join(pressureDir, `${pm2Name}.flag`);
  const ackPath = path.join(pressureDir, `${pm2Name}.ack`);

  // Write a flag
  await fs.promises.writeFile(flagPath, JSON.stringify({
    reason: 'gc',
    at: new Date().toISOString(),
    requestId: 'test-1',
    ackPath,
  }), 'utf8');

  let pruneCalled = false;
  const listener = new MemoryPressureListener({
    pm2Name,
    projectRoot,
    pressureDir,
    pruneHooks: [async () => { pruneCalled = true; }],
  });
  listener.start();
  // Wait for poll
  await new Promise((r) => setTimeout(r, 2200));
  listener.stop();

  assert.ok(pruneCalled, 'prune hook should have been called');
  // ACK should exist, flag should be gone
  assert.ok(fs.existsSync(ackPath), 'ACK file should be written');
  assert.ok(!fs.existsSync(flagPath), 'flag should be removed after handling');
  const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
  assert.strictEqual(ack.requestId, 'test-1');
  assert.ok(ack.before, 'ACK should include before metrics');
  assert.ok(ack.after, 'ACK should include after metrics');
  // Cleanup
  await fs.promises.rm(projectRoot, { recursive: true, force: true });
});

test('MemoryPressureListener: runs GC if available and reports it', async () => {
  const { MemoryPressureListener } = await import('../../src/runtime/memory-pressure-listener.js');
  const projectRoot = await makeTempDir();
  const pm2Name = 'gc-bot';
  const pressureDir = path.join(projectRoot, '.runtime', 'pressure');
  await fs.promises.mkdir(pressureDir, { recursive: true });
  const flagPath = path.join(pressureDir, `${pm2Name}.flag`);
  const ackPath = path.join(pressureDir, `${pm2Name}.ack`);

  await fs.promises.writeFile(flagPath, JSON.stringify({
    reason: 'gc',
    at: new Date().toISOString(),
    requestId: 'gc-1',
    ackPath,
  }), 'utf8');

  // Simulate --expose-gc
  global.gc = () => {};

  const listener = new MemoryPressureListener({ pm2Name, projectRoot, pressureDir, pruneHooks: [] });
  listener.start();
  await new Promise((r) => setTimeout(r, 2200));
  listener.stop();

  assert.ok(fs.existsSync(ackPath));
  const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
  assert.strictEqual(ack.ranGc, true, 'should report ranGc=true when global.gc available');
  await fs.promises.rm(projectRoot, { recursive: true, force: true });
});

test('MemoryPressureListener: handles invalid flag gracefully', async () => {
  const { MemoryPressureListener } = await import('../../src/runtime/memory-pressure-listener.js');
  const projectRoot = await makeTempDir();
  const pm2Name = 'invalid-bot';
  const pressureDir = path.join(projectRoot, '.runtime', 'pressure');
  await fs.promises.mkdir(pressureDir, { recursive: true });
  const flagPath = path.join(pressureDir, `${pm2Name}.flag`);

  // Write invalid JSON
  await fs.promises.writeFile(flagPath, 'not-json', 'utf8');

  const listener = new MemoryPressureListener({ pm2Name, projectRoot, pressureDir, pruneHooks: [] });
  listener.start();
  await new Promise((r) => setTimeout(r, 2000));
  listener.stop();

  // Invalid flag should be removed without throwing
  assert.ok(!fs.existsSync(flagPath), 'invalid flag should be removed');
  await fs.promises.rm(projectRoot, { recursive: true, force: true });
});
