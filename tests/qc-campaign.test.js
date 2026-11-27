import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QcCheckpoint, classifyQcReceipt, runQcCampaign } from '../src/service-debug/qc/campaign.js';
import { createWorkloadBroker } from '../src/core/workload-broker.js';

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new QcCheckpoint(path.join(dir, 'qc.json'));
  const reports = [], sent = [];
  const api = {
    getOwnId: () => '99',
    async getGroupInfo(id) { return { gridInfoMap: { [id]: { name: id, totalMember: 3, memberIds: ['99', '11', id === 'a' ? '12' : '13'] } } }; },
  };
  const run = (options = {}) => runQcCampaign({
    api, store, groups: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    actor: '1', chat: { threadId: 'c', type: 1 },
    content: { async send(uid) { sent.push(uid); return { msgId: 'ack' }; }, async cleanup() {} },
    notify: async (msg) => reports.push(msg), ...extra, ...options,
  });
  return { api, store, reports, sent, run, dir };
}

test('QC receipts require server message IDs and reject nested errors before ACKs', () => {
  for (const receipt of [undefined, {}, { clientId: '1' }, { message: null, attachment: [] }]) assert.equal(classifyQcReceipt(receipt), 'unconfirmed');
  for (const receipt of [{ msgId: '12' }, { message: { msgId: '12' }, attachment: [], link: null }, { attachment: [{ msgId: '12' }] }]) assert.equal(classifyQcReceipt(receipt), 'success');
  for (const receipt of [{ error_code: 5, msgId: '12' }, { error: { code: 4 } }, { attachment: [{ msgId: '12' }, { error_code: 5 }] }]) assert.equal(classifyQcReceipt(receipt), 'failed');
});

async function finish(t, pending) {
  let done = false, value, error;
  pending.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let i = 0; i < 1500 && !done; i++) { await new Promise(setImmediate); t.mock.timers.tick(1000); }
  assert.ok(done);
  if (error) throw error;
  return value;
}

test('QC deduplicates across selected groups, skips bot and paces real sends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const f = fixture(t), times = [];
  const result = await finish(t, f.run({ content: { async send(uid) { f.sent.push(uid); times.push(Date.now()); return { msgId: 'ack' }; }, cleanup() {} } }));
  assert.deepEqual(f.sent, ['11', '12', '13']);
  assert.ok(times[1] - times[0] >= 1000 && times[2] - times[1] >= 1000);
  assert.equal(result.success, 3);
  assert.equal(result.total, 3);
  assert.match(f.reports[0], /Bắt đầu.*3.*2 nhóm.*A.*B/s);
  assert.match(f.reports.at(-1), /Thành công: 3/);
});

test('QC records refusal and ambiguous receipts without retry; stop preserves unsent count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const f = fixture(t);
  const result = await finish(t, f.run({ content: { async send(uid) {
    if (uid === '11') throw Object.assign(new Error('denied'), { code: 403 });
    f.store.requestStop(); return { clientId: 'local-only' };
  }, cleanup() {} } }));
  assert.equal(result.failed, 1); assert.equal(result.unconfirmed, 1); assert.equal(result.unsent, 1);
  assert.equal(result.status, 'stopped');
  assert.equal(f.store.state.recipients[0].status, 'failed');
});

test('QC preserves paginated hidden roster completeness and isolates group scan errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const f = fixture(t);
  f.api.getGroupInfo = async (id) => { if (id === 'b') throw new Error('denied'); return { totalMember: 4, memberIds: ['99'], hasMoreMember: 1 }; };
  f.api.getGroupInfoV2 = async () => ({ totalMember: 4, memberIds: ['11', '12'], hasMoreMember: 1 });
  const result = await finish(t, f.run());
  assert.equal(result.total, 2); assert.equal(result.scans[0].completeness, 'partial');
  assert.equal(result.scans[1].completeness, 'error');
  assert.match(f.reports.at(-1), /B.*lỗi|lỗi.*B/s);
});

test('QC checkpoints in-flight before calling transport, restart interrupts without auto sending', async (t) => {
  const f = fixture(t);
  await f.run({ groups: [{ id: 'a', name: 'A' }], content: { async send() {
    const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'qc.json')));
    assert.equal(saved.recipients[0].status, 'inflight');
    f.store.requestStop(); return { msgId: 'ok' };
  }, cleanup() {} } });
  const file = path.join(f.dir, 'qc.json');
  const saved = JSON.parse(fs.readFileSync(file)); saved.status = 'sending'; saved.recipients[1].status = 'inflight';
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = new QcCheckpoint(file);
  assert.equal(restarted.state.status, 'interrupted');
  assert.equal(restarted.state.recipients[0].status, 'success');
  assert.equal(restarted.state.recipients[1].status, 'unconfirmed');
});

test('QC stops on session loss and treats ordinary network failure as unconfirmed', async (t) => {
  const f = fixture(t);
  const result = await f.run({ content: { async send() { throw Object.assign(new Error('Session expired'), { status: 401 }); }, cleanup() {} } });
  assert.equal(result.status, 'session_lost'); assert.equal(result.unsent, 2);
});

test('QC can run beyond the broker default deadline with explicit no-timeout option', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const f = fixture(t), broker = createWorkloadBroker();
  f.api.getGroupInfo = async () => ({name:'Large',totalMember:65,memberIds:Array.from({length:65},(_,i)=>String(1000+i))});
  const job = broker.submitBroadcast({}, () => f.run(), { timeoutMs: 0 });
  await finish(t, job.promise);
  assert.equal(f.store.state.recipients.length,65);
  assert.ok(f.store.state.endedAt-f.store.state.startedAt>60000);
  assert.equal(broker.snapshot().counters.broadcastFailed, 0);
  await broker.shutdown();
});

test('QC stops on pagination session loss before any recipient send',async(t)=>{
  const f=fixture(t);f.api.getGroupInfo=async()=>({totalMember:10,memberIds:['11'],hasMoreMember:1});
  f.api.getGroupInfoV2=async()=>{throw Object.assign(new Error('Session expired'),{code:401,status:200});};
  const result=await f.run();assert.equal(result.status,'session_lost');assert.equal(f.sent.length,0);
});

test('QC retains completed outcome even if final origin report is rejected',async(t)=>{
  const f=fixture(t);let reports=0;
  const result=await f.run({groups:[{id:'a',name:'A'}],notify:async()=>{reports++;if(reports>1)throw new Error('origin denied');}});
  assert.equal(result.status,'completed');assert.equal(result.success,2);assert.equal(f.store.state.status,'completed');
});

test('QC transport and decode errors are unconfirmed even when wrapped as ZaloApiError',async(t)=>{
  const f=fixture(t);const result=await f.run({groups:[{id:'a',name:'A'}],content:{async send(){throw Object.assign(new Error('HTTP failed'),{name:'ZaloApiError',code:'HTTP_REQUEST_FAILED'});},cleanup(){}}});
  assert.equal(result.unconfirmed,2);assert.equal(result.failed,0);
});

test('QC application refusals on HTTP 200 remain failed even for large error codes',async(t)=>{
  const f=fixture(t);const result=await f.run({groups:[{id:'a',name:'A'}],content:{async send(){throw Object.assign(new Error('application denied'),{name:'ZaloApiError',status:200,code:1501});},cleanup(){}}});
  assert.equal(result.failed,2);assert.equal(result.unconfirmed,0);
});

test('QC refuses corrupt checkpoints rather than silently forgetting recipients', (t) => {
  const f = fixture(t), file = path.join(f.dir, 'broken.json');
  fs.writeFileSync(file, '{bad');
  assert.throws(() => new QcCheckpoint(file), /checkpoint/i);
});

test('QC timeout reports unconfirmed, forbids subsequent sends and holds task until late transport settles',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1700000000000});
  const f=fixture(t);let release;let sends=0;let done=false;
  const pending=f.run({sendTimeoutMs:2000,content:{send(){sends++;return new Promise(r=>{release=r;});},cleanup(){}}}).then(v=>{done=true;return v;});
  while(!release) await new Promise(setImmediate);
  t.mock.timers.tick(2001);await new Promise(setImmediate);
  assert.equal(f.store.state.status,'send_timeout');assert.equal(done,false);assert.equal(sends,1);
  assert.equal(f.store.state.recipients[0].status,'unconfirmed');
  release({msgId:'late'});const result=await pending;
  assert.equal(result.unconfirmed,1);assert.equal(result.unsent,2);assert.equal(sends,1);
});
