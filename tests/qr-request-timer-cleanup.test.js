import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitingScan } from '../src/commands/mybot/Credentials/qr-login.js';

test('successful QR scan releases deadline timers and allows the process to exit', async () => {
  const moduleUrl = new URL('../src/commands/mybot/Credentials/qr-login.js', import.meta.url).href;
  const script = `import { waitingScan } from ${JSON.stringify(moduleUrl)};
    const result = await waitingScan('code', { headers:{}, fetchWithCookies:async()=>({ok:true,json:async()=>({error_code:0,data:{chatUid:'account'}})}) }, undefined, {expiresAt:Date.now()+60000});
    if (!result) throw new Error('scan failed');`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, windowsHide: true });
  assert.equal(result.stderr, '');
});

test('QR request deadline aborts the actual network request and returns expired', async () => {
  let requestSignal;
  let expired = false;
  const result = await waitingScan('code', {
    headers: {},
    fetchWithCookies: (_url, options) => { requestSignal = options.signal; return new Promise(() => {}); },
  }, undefined, { expiresAt: Date.now() + 20, onExpired: () => { expired = true; } });
  assert.equal(result, false);
  assert.equal(requestSignal.aborted, true);
  assert.equal(expired, true);
});
