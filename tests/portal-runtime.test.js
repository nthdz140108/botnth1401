import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import {registerPortalRuntimeRoute} from '../src/dashboard/portal-runtime.js';
import {writePortalPolicy} from '../src/dashboard/portal-policy.js';
test('runtime portal endpoint authenticates scope, readiness and group membership before sending',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'portal-http-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const expires_at=new Date(Date.now()+60000).toISOString();const binding={tenant_id:'t',slot_id:'s',binding_revision:1,runtime_id:'portal_test',uid:'123',desired_status:'running',expires_at};
 const policy={bindings:{s:binding},operations:{}};writePortalPolicy(root,policy);
 const app=express();app.use(express.json({verify:(req,res,b)=>{req.portalRawBody=b.toString();}}));let sends=0,connected=true,attachmentFile;
 registerPortalRuntimeRoute(app,{root,secret:'test-secret',getDescriptor:()=>({botKey:'portal_test'}),getListener:()=>({listenerConnected:connected}),getApi:()=>({getOwnId:()=> '123',getAllGroups:async()=>({gridVerMap:{'456':'v1'}}),sendMessage:async message=>{sends++;if(message.attachments){attachmentFile=message.attachments[0];assert.equal(fs.existsSync(attachmentFile),true);assert.equal(path.extname(attachmentFile),'.png');}return {msgId:'m1',attachment:[{msgId:'image1'}]};}})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const input={tenant_id:'t',slot_id:'s',binding_revision:1,expires_at,kind:'send',operation_id:'send-1',payload:{target_id:'456',target_type:'group',text:'hello',assets:[{id:'img1',mime:'image/png',data_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='}]}};
 async function request(value,sign=true){const body=JSON.stringify(value),ts=Date.now();return fetch(`http://127.0.0.1:${server.address().port}/internal/portal/execute`,{method:'POST',headers:{'content-type':'application/json',...(sign?{'x-internal-timestamp':String(ts),'x-internal-signature':crypto.createHmac('sha256','test-secret').update(`${ts}.${body}`).digest('hex')}:{})},body});}
 assert.equal((await request(input,false)).status,401);assert.equal(sends,0);
 assert.equal((await request({...input,tenant_id:'other'})).status,409);assert.equal(sends,0);
 connected=false;assert.equal((await request(input)).status,503);assert.equal(sends,0);connected=true;
 assert.equal((await request({...input,payload:{...input.payload,target_id:'999'}})).status,403);assert.equal(sends,0);
 assert.equal((await request(input)).status,200);assert.equal(sends,1);assert.ok(attachmentFile);assert.equal(fs.existsSync(attachmentFile),false);
 assert.equal((await request({...input,operation_id:'send-2'})).status,429);assert.equal(sends,1);
 const grpRes=await request({...input,kind:'groups',operation_id:'grp-1',payload:{}});assert.equal(grpRes.status,200);const grpBody=await grpRes.json();assert.equal(grpBody.data.synced,true);assert.equal(grpBody.data.groups[0].id,'456');
 binding.expires_at=new Date(Date.now()-1000).toISOString();writePortalPolicy(root,policy);assert.equal((await request(input)).status,403);assert.equal(sends,1);
});
