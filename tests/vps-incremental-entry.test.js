import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Windows entry delegates all arguments to the incremental client', () => {
  const text = fs.readFileSync(new URL('../DAY_LEN_VPS.bat', import.meta.url), 'utf8');
  assert.match(text, /node\s+deploy\\incremental-vps\.mjs\s+%\*/i);
  assert.doesNotMatch(text, /BOT DA DUOC CAP NHAT VA KHOI DONG LAI/i);
});
