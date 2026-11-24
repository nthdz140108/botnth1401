import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validatePatchPackage } from '../deploy/patch-validate.mjs';

test('package verification detects corruption and rejects path traversal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-verify-'));
  try {
    const bytes = Buffer.from('patch');
    fs.mkdirSync(path.join(dir, 'files', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'files', 'src', 'x.js'), bytes);
    const file = { status: 'modify', path: 'src/x.js', mode: '100644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const manifest = { schema: 1, base: 'a'.repeat(40), target: 'b'.repeat(40), files: [file] };
    const save = () => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    save(); assert.equal(validatePatchPackage(dir).target, manifest.target);
    fs.writeFileSync(path.join(dir, 'files', 'src', 'x.js'), 'wrong');
    assert.throws(() => validatePatchPackage(dir), /hash/i);
    file.path = 'src/../../escape'; save();
    assert.throws(() => validatePatchPackage(dir), /path/i);
    file.path = 'rust/crates/storage/migrations/0002.sql'; save();
    assert.throws(() => validatePatchPackage(dir), /path/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
