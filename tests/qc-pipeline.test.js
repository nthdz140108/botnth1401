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
