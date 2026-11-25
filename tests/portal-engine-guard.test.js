import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {writePortalPolicy,assertPortalRuntimeAllowed,assertNotPortalManaged} from '../src/dashboard/portal-policy.js';
import {wrapWithLimiter} from '../src/api-zalo/transport-limiter.js';
test('engine transport rejects expired portal policy even outside portal HTTP path',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'portal-engine-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const oldRoot=process.env.PROJECT_ROOT,oldKey=process.env.BOT_KEY;process.env.PROJECT_ROOT=root;process.env.BOT_KEY='portal_test';t.after(()=>{if(oldRoot===undefined)delete process.env.PROJECT_ROOT;else process.env.PROJECT_ROOT=oldRoot;if(oldKey===undefined)delete process.env.BOT_KEY;else process.env.BOT_KEY=oldKey;});
 const binding={runtime_id:'portal_test',uid:'123',expires_at:new Date(Date.now()-1000).toISOString(),desired_status:'running'};writePortalPolicy(root,{bindings:{slot:binding},operations:{}});
 let sent=0;const api={getOwnId:()=> '123',sendMessage:async()=>{sent++;}};wrapWithLimiter(api);
 await assert.rejects(api.sendMessage('hello','1'),{code:'SLOT_EXPIRED'});assert.equal(sent,0);
 assert.throws(()=>assertNotPortalManaged(root,'portal_test'),{code:'PORTAL_MANAGED_SLOT'});
 assert.throws(()=>assertPortalRuntimeAllowed(root,'portal_missing'),{code:'PORTAL_BINDING_MISSING'});
});
