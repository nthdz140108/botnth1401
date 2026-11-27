import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { qcCommand,handleQcInput } from '../src/service-debug/qc/index.js';

test('QC control returns while list request is pending and stop prevents stale list output',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let release;const sent=[];
  const api={getOwnId:()=> '88112233',getAllGroups:()=>new Promise(r=>{release=r;}),async sendMessage(payload){sent.push(payload.msg);return {message:{msgId:'out'}};}};
  const context={api,runtimeContext:{dataDir:dir},args:[],prefix:'!',permissionLevel:'adminLevelHigh',message:{type:0,threadId:'1',data:{uidFrom:'1',content:'!qc'}}};
  assert.equal(await qcCommand(context),'opening');
  while(!release)await new Promise(setImmediate);
  await qcCommand({...context,args:['status']});assert.match(sent.at(-1),/selecting/);
  await qcCommand({...context,args:['stop']});release({gridVerMap:{}});await new Promise(setImmediate);
  assert.equal(sent.some(text=>text.includes('chưa tham gia')),false);
  const state=JSON.parse(fs.readFileSync(path.join(dir,'qc','88112233.json')));assert.equal(state.status,'stopped');
});

test('QC does not claim unrelated high-admin messages or inspect a broken inactive checkpoint',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-inactive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'qc'));fs.writeFileSync(path.join(dir,'qc','99112233.json'),'{broken');
  const context={api:{getOwnId:()=> '99112233'},runtimeContext:{dataDir:dir},prefix:'!',permissionLevel:'adminLevelHigh',message:{type:0,threadId:'1',data:{uidFrom:'1',content:'!help'}}};
  assert.equal(await handleQcInput(context),false);assert.equal(context.message.qcHandled,undefined);
});
