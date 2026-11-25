import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createPortalRuntimeAdapter} from '../src/dashboard/portal-runtime-adapter.js';
test('runtime provisioning and scoped config stay in server-generated namespace',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'portal-adapter-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'mybot'),{recursive:true});fs.writeFileSync(path.join(root,'mybot','defaultCommand.json'),JSON.stringify({prefix:'!',commands:[{name:'help',permission:'all',active:true,countdown:2}]}));
 const adapter=createPortalRuntimeAdapter({root,secret:'test',registry:{describe:async()=>null},actions:{},qrManager:{get:()=>({state:'configured',qrImage:'data:image/png;base64,a',error:null})},prefixService:{update:async()=>{}}});
 const binding={runtime_id:'portal_fixture_1',slot_id:'s',tenant_id:'t',binding_revision:1,expires_at:'2030-01-01'};
 await adapter.prepare(binding);await adapter.configure(binding,{commands:{help:{active:false,countdown:30,response:'custom'}},groups:{'123':{welcome:true,antiLink:true}}});
 const commandFile=path.join(root,'mybot','instances',binding.runtime_id,'data','command.json');const config=JSON.parse(fs.readFileSync(commandFile));
 assert.equal(config.commands[0].permission,'all');assert.equal(config.commands[0].active,false);assert.equal(config.commands[0].countdown,30);
 assert.equal(fs.existsSync(path.join(root,'assets','json-data','command.json')),false);
 const groups=JSON.parse(fs.readFileSync(path.join(root,'mybot','instances',binding.runtime_id,'data','group-settings.json')));assert.equal(groups['123'].welcomeGroup,true);assert.equal(groups['123'].removeLinks,true);
 const contract=await adapter.readConfig(binding,'commands');const help=contract.commands.find(c=>c.name==='help');assert.deepEqual(help.tenant_editable_fields,['active','countdown','response','permission','values']);assert.ok(help.contract.tabs.flatMap(t=>t.fields).some(f=>f.key==='operation.maxUsesPerHour'&&f.tenantEditable));
 assert.equal((await adapter.qr(binding,'status')).credential_ready,true);
 assert.deepEqual(await adapter.status(binding),{ready:false,authenticated:false,listenerReady:false,uid:null});
});
