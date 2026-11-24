import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('incremental flags cannot silently trigger the full VPS installer', () => {
  for (const flag of ['--dry-run', '--dry-run=yes', '--apply', '--status', '--rollback', '--target']) {
    const result = spawnSync(process.execPath, ['deploy/push-to-vps.mjs', flag, 'HEAD'], { encoding: 'utf8', input: '', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incremental update is not available/i);
    assert.doesNotMatch(result.stdout, /Đóng gói source/);
  }
});
