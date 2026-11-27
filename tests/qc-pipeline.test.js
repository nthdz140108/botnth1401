import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('QC pipeline receives group/DM media and text before prefix/uid/scold/command side effects',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qc-pipeline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'assets','data'),{recursive:true});
  fs.mkdirSync(path.join(root,'mybot'),{recursive:true});
  const config=path.join(root,'assets','config.json');
  fs.writeFileSync(config,JSON.stringify({uid:'99',name:'admin',groupSettingsPath:path.join(root,'groups.json')}));
  fs.writeFileSync(path.join(root,'groups.json'),'{}');
  const script=`
    import assert from 'node:assert/strict';
    const {messagesUser,eventSendMsgHooks}=await import(${JSON.stringify(new URL('../src/automations/event-send-msg.js',import.meta.url).href)});
    const captured=[],sent=[];
    const api={getOwnId:()=> '99',async getGroupInfo(id){return {gridInfoMap:{[id]:{name:'Test',creatorId:'99',adminIds:[],totalMember:2,memVerList:['99_0','1_0']}}};},async sendMessage(...args){sent.push(args);return {msgId:'ack'};}};
    eventSendMsgHooks.handleQcInput=async(ctx)=>{captured.push(ctx.message);return true;};
    eventSendMsgHooks.handleCommand=async()=>assert.fail('QC consumed content must not dispatch');
    eventSendMsgHooks.handleScoldFreeChat=async()=>assert.fail('QC must get content before free-chat scold');
    for(const type of [0,1])for(const content of [{href:'https://example.com/image.jpg',title:'caption'},'prefix','uid test']){
      await messagesUser(api,{type,threadId:type===1?'test-group':'1',data:{uidFrom:'1',msgType:typeof content==='string'?'webchat':'chat.photo',content,dName:'Test'}});
    }
    assert.equal(captured.length,6);assert.equal(sent.length,0);
    console.log('QC_PIPELINE_OK');
  `;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{
    encoding:'utf8',timeout:30000,env:{...process.env,PROJECT_ROOT:root,CONFIG_PATH:config,SKIP_ENV_VALIDATION:'1',NODE_ENV:'test'},stdio:['ignore','pipe','pipe'],
  });
  assert.match(output,/QC_PIPELINE_OK/);
});

test('QC real group pipeline accepts numbers typed from the logged-in bot account',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qc-self-pipeline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'assets','data'),{recursive:true});fs.mkdirSync(path.join(root,'mybot'),{recursive:true});
  const config=path.join(root,'assets','config.json');
  fs.writeFileSync(config,JSON.stringify({uid:'99',name:'admin',groupSettingsPath:path.join(root,'groups.json')}));
  fs.writeFileSync(path.join(root,'groups.json'),'{}');
  const script=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const {appContext}=await import(${JSON.stringify(new URL('../src/api-zalo/context.js',import.meta.url).href)});appContext.uid='99';
    const {GroupMessage}=await import(${JSON.stringify(new URL('../src/api-zalo/models/Message.js',import.meta.url).href)});
    const {qcCommand}=await import(${JSON.stringify(new URL('../src/service-debug/qc/index.js',import.meta.url).href)});
    const {messagesUser}=await import(${JSON.stringify(new URL('../src/automations/event-send-msg.js',import.meta.url).href)});
    const {setBotId}=await import(${JSON.stringify(new URL('../src/index.js',import.meta.url).href)});setBotId('99');
    const sent=[];
    const api={getOwnId:()=> '99',async getAllGroups(){return {gridVerMap:Object.fromEntries(Array.from({length:58},(_,i)=>['g'+(i+1),1]))};},async getGroupInfo(id){return {gridInfoMap:{[id]:{name:'Group '+id,creatorId:'99',adminIds:[],totalMember:2,memVerList:['99_0','1_0']}}};},async sendMessage(payload){sent.push(payload.msg);return {message:{msgId:'notice-'+sent.length}};}};
    const command=new GroupMessage({uidFrom:'0',idTo:'self-origin',msgId:'manual-command',cliMsgId:'manual-command-client',msgType:'webchat',content:'!qc',dName:'Owner'});
    await qcCommand({api,message:command,runtimeContext:{dataDir:process.env.PROJECT_ROOT},permissionLevel:'adminLevelHigh',args:[]});
    while(sent.length<3)await new Promise(r=>setTimeout(r,10));await new Promise(setImmediate);
    const selected=new GroupMessage({uidFrom:'0',idTo:'self-origin',msgId:'manual-selection',cliMsgId:'manual-selection-client',msgType:'webchat',content:'28 32',dName:'Owner'});
    assert.equal(selected.isSelf,true);
    await messagesUser(api,selected);
    assert.ok(sent.some(msg=>msg.startsWith('Đã chọn:')&&msg.includes('Group g28')&&msg.includes('Group g32')),'real pipeline must respond to the self-account selection');
    const checkpoint=JSON.parse(fs.readFileSync(process.env.PROJECT_ROOT+'/qc/99.json'));assert.equal(checkpoint.status,'content');
    assert.equal(checkpoint.recipients.length,0);console.log('QC_SELF_PIPELINE_OK');
  `;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000,env:{...process.env,PROJECT_ROOT:root,CONFIG_PATH:config,SKIP_ENV_VALIDATION:'1',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  assert.match(output,/QC_SELF_PIPELINE_OK/);
});
