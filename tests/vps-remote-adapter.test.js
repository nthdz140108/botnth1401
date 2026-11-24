import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAdapter } from '../deploy/remote-adapter.mjs';

test('wait ignores stale status and only returns the matching request', async () => {
  const id = 'a'.repeat(32); let calls = 0;
  const remote = createRemoteAdapter({ run: async command => {
    if (command.includes('systemctl show')) return 'active';
    calls++;
    return JSON.stringify({ current: 'b'.repeat(40), state: calls === 1 ? { requestId: 'c'.repeat(32), status: 'confirmed' } : { requestId: id, status: 'confirmed' } });
  }, archive: async () => Buffer.from('archive'), delay: async () => {}, maxPolls: 4 });
  assert.equal((await remote.wait(id)).status, 'confirmed'); assert.equal(calls, 2);
});

test('rejects unsafe upload paths before constructing a remote command', async () => {
  let calls = 0;
  const remote = createRemoteAdapter({ run: async () => { calls++; return ''; }, archive: async () => Buffer.alloc(0) });
  await assert.rejects(remote.launch('apply', '/tmp/x;touch /tmp/bad', 'a'.repeat(32)), /upload path/i);
  assert.equal(calls, 0);
});
