import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLocmemCommand } from '../src/service-debug/locmem/locmem-service.js';
test('a hung Zalo read releases the scan within its deadline', { timeout: 500 }, async () => {
  const result = await handleLocmemCommand({
    api: { sendMessage: async () => ({ msgId: 'ack' }), getGroupInfo: () => new Promise(() => {}) },
    threadId: 'deadline-group', senderId: 'admin', authorization: { isAdminLevelHigh: true }, scanDeadlineMs: 30,
  });
  assert.equal(result.code, 'TIMEOUT');
});
