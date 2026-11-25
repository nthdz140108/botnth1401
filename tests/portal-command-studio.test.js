import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const portal=await import('../src/dashboard/portal-command-studio.js').catch(()=>({}));
test('tenant contracts expose actual safe V2 metadata without runtime paths or secrets',()=>{
 assert.equal(typeof portal.tenantCommandContract,'function');const c=portal.tenantCommandContract('help');assert.equal(c.commandName,'help');const fields=c.tabs.flatMap(t=>t.fields);assert.ok(fields.find(f=>f.key==='operation.maxUsesPerHour'&&f.tenantEditable));assert.ok(fields.find(f=>f.key==='restrictions.allowedUsers'));
 assert.equal(JSON.stringify(c).includes('handlerRef'),false);assert.equal(fields.some(f=>f.key.startsWith('secrets.')),false);
 const scheduler=portal.tenantCommandContract('sendtask');assert.equal(scheduler.tabs.flatMap(t=>t.fields).some(f=>f.apply==='scheduler'||f.key.startsWith('schedules.')),false);
});
test('permission changes cannot lower actual platform floor and V2 rejects source/path writes',()=>{
 assert.throws(()=>portal.validateTenantCommandPatch('restart',{permission:'all'}),{code:'PERMISSION_ELEVATION'});
 assert.throws(()=>portal.validateTenantCommandPatch('help',{permission:3}),{code:'INVALID_PERMISSION'});
 assert.doesNotThrow(()=>portal.validateTenantCommandPatch('help',{permission:'adminBox',values:{'operation.cooldownMode':'perThread','restrictions.allowedUsers':[{userId:'123'}]}}));
 for(const key of ['handler.module','secrets.KEY','schedules.enabled','operation.retry.maxRetries','__proto__.admin'])assert.throws(()=>portal.validateTenantCommandPatch('help',{values:{[key]:'bad'}}),{code:'FIELD_NOT_ALLOWED'});
 assert.throws(()=>portal.validateTenantCommandPatch('help',{values:{'restrictions.allowedUsers':[{userId:'123',path:'/etc/passwd'}]}}),{code:'INVALID_STUDIO_VALUE'});
});
test('safe V2 writes merge per-bot sparse overrides, bump revision, and enforce additive permissions',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'portal-studio-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const id='portal_test';
 await portal.applyTenantCommandPatches(root,id,{help:{permission:'adminBox',values:{'operation.maxUsesPerHour':12}}});
 await portal.applyTenantCommandPatches(root,id,{help:{values:{'responses.templates.onError':'Try later'}}});
 const row=await portal.readTenantCommand(root,id,'help');assert.equal(row.studio_values['operation.maxUsesPerHour'],12);assert.equal(row.studio_values['responses.templates.onError'],'Try later');assert.equal(row.studio_revision,2);assert.equal(row.permission,'adminBox');
 assert.equal(portal.tenantCommandPermission(root,id,'help','member').allowed,false);assert.equal(portal.tenantCommandPermission(root,id,'help','adminBox').allowed,true);assert.equal(portal.tenantCommandPermission(root,id,'restart','adminBox').allowed,false);
 assert.equal(fs.existsSync(path.join(root,'assets','json-data','command-studio','global.json')),false);
});
