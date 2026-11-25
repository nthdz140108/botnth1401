import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../src/dashboard/portal-service.js').catch(() => ({}));
const base = {operation_id:'op-1',tenant_id:'tenant-a',slot_id:'slot-a',binding_revision:1,expires_at:'2030-01-01T00:00:00Z',kind:'bind',payload:{}};
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'portal-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let sends=0, ready=true, clock=Date.parse('2026-01-01');
 const runtime={prepare:async()=>{},stop:async()=>{},remove:async()=>{},status:async()=>({ready,uid:'123'}),verify:async()=> '123',start:async()=>({}),qr:async()=>({state:'waiting_scan'}),request:async()=>{sends++;return {message_id:'m1'};},reservedUids:async()=>['999']};
 const service=mod.createPortalService?.({root,runtime,now:()=>clock});
 return {root,runtime,service,sends:()=>sends,setReady:v=>ready=v,setClock:v=>clock=v};
}
test('portal adapter exists',()=>assert.equal(typeof mod.createPortalService,'function'));
test('ownership and stale revisions cannot cross the runtime boundary',async t=>{
 const {service}=setup(t); await service.execute(base);
 await assert.rejects(service.execute({...base,operation_id:'x',tenant_id:'tenant-b',kind:'status'}),{code:'TENANT_MISMATCH'});
 await service.execute({...base,operation_id:'b2',binding_revision:2});
 await assert.rejects(service.execute({...base,operation_id:'x',kind:'status'}),{code:'REVISION_CONFLICT'});
});
test('at most once send persists success and ambiguous result across restarts',async t=>{
 const f=setup(t); await f.service.execute(base);
 const send={...base,operation_id:'send1',kind:'send',payload:{target_id:'456',target_type:'dm',text:'hi'}};
 await f.service.execute({...base,operation_id:'start',kind:'start'});
 await f.service.execute(send);await f.service.execute(send);assert.equal(f.sends(),1);
 const restarted=mod.createPortalService({root:f.root,runtime:f.runtime,now:()=>Date.parse('2026-01-01T00:00:20Z')});
 await restarted.execute(send);assert.equal(f.sends(),1);
 f.runtime.request=async()=>{throw new Error('lost response');};
 const unknown=await restarted.execute({...send,operation_id:'send2',payload:{...send.payload,target_type:'group'}});assert.equal(unknown.status,'unknown');
 assert.equal((await restarted.execute({...send,operation_id:'send2',payload:{...send.payload,target_type:'group'}})).status,'unknown');
});
test('expiry, readiness, unknown keys, and reservation fail closed',async t=>{
 const f=setup(t);await f.service.execute(base);
 await assert.rejects(f.service.execute({...base,operation_id:'cfg',kind:'configure',payload:{admins:['123']}}),{code:'FIELD_NOT_ALLOWED'});
 f.runtime.verify=async()=> '999';
 await assert.rejects(f.service.execute({...base,operation_id:'start',kind:'start'}),{code:'RESERVED_ACCOUNT'});
 f.setClock(Date.parse('2031-01-01'));
 await assert.rejects(f.service.execute({...base,operation_id:'expired',kind:'start'}),{code:'SLOT_EXPIRED'});
});
test('caller controlled runtime coordinates rejected and independent slots use fresh namespaces',async t=>{
 const f=setup(t);await assert.rejects(f.service.execute({...base,payload:{port:2000}}),{code:'FIELD_NOT_ALLOWED'});
 await f.service.execute(base);
 await f.service.execute({...base,slot_id:'slot-b',tenant_id:'tenant-b',operation_id:'bind-b'});
 const policy=JSON.parse(fs.readFileSync(path.join(f.root,'mybot','portal-bindings.json')));
 assert.notEqual(policy.bindings['slot-a'].runtime_id,policy.bindings['slot-b'].runtime_id);
});
test('section config envelopes normalize safe fields and reject hidden privilege injection',async t=>{
 const f=setup(t);await f.service.execute(base);let captured;
 f.runtime.configure=async(b,p)=>{captured=p;return {applied:true};};
 await f.service.execute({...base,operation_id:'cfg1',kind:'configure',payload:{section:'config',config:{prefix:'?',label:'Shop'},revision:1}});
 assert.deepEqual(captured,{prefix:'?',display_name:'Shop'});
 await assert.rejects(f.service.execute({...base,operation_id:'cfg2',kind:'configure',payload:{section:'commands',config:{help:{active:true,handlerRef:'/secret'}},revision:2}}),{code:'FIELD_NOT_ALLOWED'});
});
test('UID uniqueness and stopped/expired engine state block queued sends',async t=>{
 const f=setup(t);await f.service.execute(base);await f.service.execute({...base,operation_id:'start1',kind:'start'});
 await f.service.execute({...base,slot_id:'slot-b',operation_id:'bind2'});
 await assert.rejects(f.service.execute({...base,slot_id:'slot-b',operation_id:'start2',kind:'start'}),{code:'ACCOUNT_ALREADY_BOUND'});
 f.setReady(false);await assert.rejects(f.service.execute({...base,operation_id:'send-offline',kind:'send',payload:{target_id:'456',target_type:'dm',text:'hi'}}),{code:'BOT_NOT_READY'});
 assert.equal(f.sends(),0);
});
test('failed stop prevents account replacement and successful replacement stops before preparing',async t=>{
 const f=setup(t);await f.service.execute(base);let effects=[];
 f.runtime.stop=async()=>{effects.push('stop');throw Error('cannot stop');};
 await assert.rejects(f.service.execute({...base,operation_id:'replace',binding_revision:2}));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'mybot','portal-bindings.json'))).bindings['slot-a'].binding_revision,1);
 f.runtime.stop=async()=>effects.push('stopped');f.runtime.remove=async()=>effects.push('removed');f.runtime.prepare=async()=>effects.push('prepared');
 await f.service.execute({...base,operation_id:'replace',binding_revision:2});assert.deepEqual(effects,['stop','stopped','removed','prepared']);
});
test('restart stops before re-starting and stranger DM rejection records as skipped',async t=>{
 const f=setup(t);const steps=[];await f.service.execute(base);await f.service.execute({...base,operation_id:'s1',kind:'start'});
 f.runtime.stop=async()=>steps.push('stop');f.runtime.verify=async()=>{steps.push('verify');return '123';};f.runtime.start=async()=>{steps.push('start');return {};};
 await f.service.execute({...base,operation_id:'rst1',kind:'restart'});assert.deepEqual(steps,['stop','verify','start']);
 f.runtime.request=async()=>{const err=new Error('blocked');err.code='ZALO_DELIVERY_REJECTED';throw err;};
 const out=await f.service.execute({...base,operation_id:'send-skip',kind:'send',payload:{target_id:'789',target_type:'dm',text:'hello'}});
 assert.equal(out.status,'skipped');assert.equal(out.result.code,'ZALO_DELIVERY_REJECTED');
});
