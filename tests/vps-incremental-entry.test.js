import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows entry delegates all arguments to the incremental client', () => {
  const text = fs.readFileSync(new URL('../DAY_LEN_VPS.bat', import.meta.url), 'utf8');
  assert.match(text, /node\s+deploy\\incremental-vps\.mjs\s+%\*/i);
  assert.doesNotMatch(text, /BOT DA DUOC CAP NHAT VA KHOI DONG LAI/i);
});

test('Windows batch returns success after the client exits', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mybot-bat-'));
  try {
    fs.writeFileSync(path.join(dir, 'node.cmd'), '@echo off\r\nexit /b 0\r\n');
    const script = fileURLToPath(new URL('../DAY_LEN_VPS.bat', import.meta.url));
    const result = spawnSync('cmd.exe', ['/d', '/c', script, '--status'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir};${process.env.PATH}` }, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /\[OK\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
