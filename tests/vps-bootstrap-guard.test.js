import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assertBootstrapTarget } from '../deploy/bootstrap-guard.mjs';

test('full installer refuses an already versioned VPS and unknown probe results', () => {
  assert.doesNotThrow(() => assertBootstrapTarget('legacy'));
  assert.throws(() => assertBootstrapTarget('versioned'), /versioned/i);
  assert.throws(() => assertBootstrapTarget('unexpected'), /unknown/i);
  const script = fs.readFileSync(new URL('../deploy/ubuntu/install-ubuntu.sh', import.meta.url), 'utf8');
  assert.ok(script.indexOf('/opt/mybot/current') < script.indexOf('apt-get update'));
});
