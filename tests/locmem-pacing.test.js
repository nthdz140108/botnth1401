import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacedSender } from '../src/service-debug/locmem/locmem-send.js';
test('concurrent messages are serialized with one second between sends, including failures', async () => {
  let time = 0;
  const times = [];
  const send = createPacedSender(async value => { times.push(time); if (value === 2) throw new Error('failed'); return value; }, {
    now: () => time, sleep: async ms => { time += ms; },
  });
  const results = await Promise.allSettled([send([1]), send([2]), send([3])]);
  assert.deepEqual(times, [0, 1000, 2000]);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 3);
});
