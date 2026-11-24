import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { orchestrateIncremental } from '../deploy/incremental-orchestrator.mjs';

test('Deno preflight is skipped for preview and must succeed before upload or release launch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-media-preflight-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(dir, 'src/service-debug/api-crawl/youtube'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/service-debug/api-crawl/youtube/runtime.js'), 'export const runtime="deno";');
    git('add', '.'); git('commit', '-qm', 'media patch');
    const calls = [];
    const remote = {
      status: async () => ({ current: base }),
      prepareDownloadRuntime: async () => { calls.push('preflight'); throw new Error('Deno installation failed'); },
      upload: async () => assert.fail('must not upload after preflight failure'),
      launch: async () => assert.fail('must not switch after preflight failure'),
    };
    await orchestrateIncremental({ args: ['--dry-run'], repo: dir, remote });
    assert.deepEqual(calls, []);
    await assert.rejects(() => orchestrateIncremental({ args: ['--apply'], repo: dir, remote }), /Deno installation failed/);
    assert.deepEqual(calls, ['preflight']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
