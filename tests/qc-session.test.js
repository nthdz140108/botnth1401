import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QcSession } from '../src/service-debug/qc/session.js';
import { QcCheckpoint } from '../src/service-debug/qc/campaign.js';

function fixture(t, count = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replies = [], sent = [], jobs = [];
  let now = 1000;
  const api = {
    getOwnId: () => '99',
    async getAllGroups() { return { gridVerMap: Object.fromEntries(Array.from({length:count}, (_,i) => [`g${i+1}`, 1])) }; },
    async getGroupInfo(id) { return { name: `Nhóm ${id}`, totalMember: 2, memberIds: ['99', '11'] }; },
    async sendMessage(payload, id, type) { const msgId = String(replies.length+1); replies.push({msg:payload.msg,id,type,msgId}); return { message:{msgId} }; },
  };
  const store = new QcCheckpoint(path.join(dir, 'qc.json'));
  const manager = new QcSession({ api, store, now:()=>now, wait:async()=>{},
    prepare: async (_api, message) => {
      if (message.data.content === 'bad') throw new Error('Loại chưa hỗ trợ');
      return { kind:'test', async send(uid) { sent.push({uid, content:message.data.content}); return {msgId:'ack'}; }, cleanup(){} };
    },
    broker: { submitBroadcast(payload, task, opts) { assert.equal(opts.timeoutMs, 0); jobs.push(task); return {jobId:'test',promise:Promise.resolve()}; } },
  });
  const ctx = (content = '!qc', extra = {}) => ({ prefix:'!', permissionLevel:'adminLevelHigh', api,
    message: { type:1,threadId:'origin',data:{uidFrom:'1',msgId:`in-${Math.random()}`,content}, ...extra } });
  const select = (text='all', page=0) => { const c = ctx(text); c.message.data.quote={globalMsgId:replies[page].msgId}; return c; };
  return {manager,store,ctx,select,replies,sent,jobs,advance:(ms)=>{now+=ms;}};
}

test('QC requires high admin and reserves one bot before group fetch completes', async (t) => {
  const f = fixture(t);
  assert.equal(await f.manager.command({...f.ctx(),permissionLevel:'adminBot'}), 'denied');
  await Promise.all([f.manager.command(f.ctx()), f.manager.command(f.ctx())]);
  assert.equal(f.replies.filter(r=>r.msg.includes('1. Nhóm')).length,1);
  assert.ok(f.replies.some(r=>/đang.*QC|QC.*đang/i.test(r.msg)));
});

test('QC accepts only owner/origin and reply to a stable list page; validates every index', async (t) => {
  const f=fixture(t,45); await f.manager.command(f.ctx());
  assert.ok(f.replies.length>=3); assert.match(f.replies[1].msg,/21\. Nhóm g21/);
  assert.equal(await f.manager.input(f.ctx('all')),false);
  const wrong=f.select(); wrong.message.data.uidFrom='2'; assert.equal(await f.manager.input(wrong),false);
  const elsewhere=f.select(); elsewhere.message.threadId='other'; assert.equal(await f.manager.input(elsewhere),false);
  await f.manager.input(f.select('1 46')); assert.equal(f.manager.session.phase,'selecting');
  await f.manager.input(f.select('1 1 21',1));
  assert.equal(f.manager.session.phase,'content');
  assert.deepEqual(f.manager.session.selected.map(g=>g.id),['g1','g21']);
});

test('QC auto-captures next content, lets commands through, and permits command text replying to prompt', async (t) => {
  const f=fixture(t); await f.manager.command(f.ctx()); await f.manager.input(f.select());
  assert.equal(await f.manager.input(f.ctx('!help')),false);
  assert.equal(await f.manager.input(f.ctx('bad')),true); assert.equal(f.manager.session.phase,'content');
  const ad=f.ctx('!help original ad'); ad.message.data.quote={globalMsgId:f.manager.session.promptIds[0]};
  assert.equal(await f.manager.input(ad),true);
  assert.equal(f.jobs.length,1);
  await f.jobs[0]();
  assert.deepEqual(f.sent,[{uid:'11',content:'!help original ad'}]);
  assert.equal(f.manager.session,null);
});

test('QC atomically captures one media message and ignores bot echoes/revoked admins', async (t) => {
  const f=fixture(t); await f.manager.command(f.ctx()); await f.manager.input(f.select());
  const echo=f.ctx('echo'); echo.message.data.uidFrom='99'; assert.equal(await f.manager.input(echo),false);
  assert.equal(await f.manager.input({...f.ctx('ad'),permissionLevel:'member'}),false);
  const media={href:'https://example.com/p.jpg',title:'caption'};
  const a=f.ctx(media), b=f.ctx('second');
  await Promise.all([f.manager.input(a),f.manager.input(b)]);
  assert.equal(f.jobs.length,1);
  await f.jobs[0](); assert.equal(f.sent.length,1); assert.deepEqual(f.sent[0].content,media);
});

test('QC expires selection and content after five minutes, stop/status require originator', async (t) => {
  const f=fixture(t); await f.manager.command(f.ctx()); f.advance(300001);
  assert.equal(await f.manager.input(f.select()),true); assert.equal(f.manager.session,null);
  await f.manager.command(f.ctx()); await f.manager.input(f.select('all',f.replies.length-1));
  f.advance(300001); await f.manager.input(f.ctx('late')); assert.equal(f.jobs.length,0);
  await f.manager.command(f.ctx());
  const other=f.ctx();other.message.data.uidFrom='2';other.args=['stop']; await f.manager.command(other);
  assert.ok(f.manager.session);
  await f.manager.command({...f.ctx(),args:['stop']}); assert.equal(f.manager.session,null);
});

test('QC never captures the same selection message again as advertisement content', async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());const selected=f.select();
  await f.manager.input(selected);await f.manager.input(selected);
  assert.equal(f.jobs.length,0);assert.equal(f.manager.session.phase,'content');
});

test('QC stop during unsuccessful preparation releases the session',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());await f.manager.input(f.select());
  let reject;f.manager.prepare=()=>new Promise((_,r)=>{reject=r;});
  const pending=f.manager.input(f.ctx('ad'));
  while(!reject) await new Promise(setImmediate);
  await f.manager.command({...f.ctx(),args:['stop']});reject(new Error('unsupported'));
  await pending;assert.equal(f.manager.session,null);assert.equal(f.jobs.length,0);
});

test('QC keeps unrelated traffic and expired commands available to their normal handlers',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());await f.manager.input(f.select());
  f.advance(300001);assert.equal(await f.manager.input(f.ctx('!help')),false);
  await f.manager.command(f.ctx());await f.manager.input(f.select('all',f.replies.length-1));
  await f.manager.input(f.ctx('ad'));
  assert.equal(await f.manager.input(f.ctx('ordinary during campaign')),false);
  await f.jobs[0]();
});

test('QC late prompt failure never cancels a replacement session',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());
  const notify=f.manager.notify.bind(f.manager);let reject;
  f.manager.notify=(chat,text)=>text.startsWith('Đã chọn')?new Promise((_,r)=>{reject=r;}):notify(chat,text);
  const old=f.manager.input(f.select());while(!reject)await new Promise(setImmediate);
  await f.manager.command({...f.ctx(),args:['stop']});await f.manager.command(f.ctx());
  const replacement=f.manager.session;reject(new Error('late send error'));await old;
  assert.equal(f.manager.session,replacement);assert.equal(f.store.state.status,'selecting');
});

test('QC successful preparation after stop persists stopped instead of leaving content checkpoint',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());await f.manager.input(f.select());
  let release;f.manager.prepare=()=>new Promise(r=>{release=r;});const pending=f.manager.input(f.ctx('ad'));
  while(!release)await new Promise(setImmediate);
  await f.manager.command({...f.ctx(),args:['stop']});release({send(){assert.fail('stopped');},cleanup(){}});
  await pending;assert.equal(f.manager.session,null);assert.equal(f.store.state.status,'stopped');assert.equal(f.jobs.length,0);
});

test('QC checkpoint queue failure cleans prepared content and releases an unscheduled session',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());await f.manager.input(f.select());let cleaned=false;
  f.manager.prepare=async()=>({send(){assert.fail('must not send');},cleanup(){cleaned=true;}});
  const save=f.store.save.bind(f.store);f.store.save=()=>{if(f.store.state.status==='queued')throw new Error('disk full');save();};
  await f.manager.input(f.ctx('ad'));assert.equal(f.manager.session,null);assert.equal(cleaned,true);assert.equal(f.jobs.length,0);
});

test('QC falls back to client ID when global message ID is zero',async(t)=>{
  const f=fixture(t);await f.manager.command(f.ctx());const selected=f.select();selected.message.data.msgId='0';selected.message.data.cliMsgId='10';
  await f.manager.input(selected);const ad=f.ctx('ad');ad.message.data.msgId='0';ad.message.data.cliMsgId='11';
  await f.manager.input(ad);assert.equal(f.jobs.length,1);await f.jobs[0]();assert.equal(f.sent.length,1);
});
