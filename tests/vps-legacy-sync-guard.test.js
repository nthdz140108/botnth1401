import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('legacy fixed-file sync scripts refuse to change a versioned deployment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-legacy-guard-'));
  try {
    for (const name of ['vps-deploy-config.mjs', 'sync-js-to-vps.mjs', 'sync-all-to-vps.mjs']) fs.copyFileSync(fileURLToPath(new URL(`../deploy/${name}`, import.meta.url)), path.join(dir, name));
    for (const name of ['sync-js-to-vps.mjs', 'sync-all-to-vps.mjs']) {
      const result = spawnSync(process.execPath, [path.join(dir, name)], { encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /incremental/i);
      assert.doesNotMatch(result.stdout, /Copying/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
