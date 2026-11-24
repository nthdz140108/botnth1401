import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIncrementalArgs } from '../deploy/incremental-args.mjs';

test('parses commit preview, apply and status without conflating modes', () => {
  assert.deepEqual(parseIncrementalArgs(['--target', 'HEAD~1', '--dry-run']), { mode: 'dry-run', target: 'HEAD~1', base: null });
  assert.deepEqual(parseIncrementalArgs(['--apply', '--base', 'abc', '--target', 'HEAD']), { mode: 'apply', target: 'HEAD', base: 'abc' });
  assert.deepEqual(parseIncrementalArgs(['--status']), { mode: 'status', target: null, base: null });
  assert.throws(() => parseIncrementalArgs(['--dry-run', '--apply']), /mode/i);
  assert.throws(() => parseIncrementalArgs(['--status', '--target', 'HEAD']), /not allowed/i);
  assert.throws(() => parseIncrementalArgs(['--unknown']), /unknown/i);
});
