import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safePath, buildPreview } from '../deploy/patch-preview.mjs';
import { planRuntimeActions } from '../deploy/runtime-actions.mjs';
import { prepareRelease } from '../deploy/patch-build.mjs';
import { execFileSync } from 'node:child_process';
import { createRuntimeController } from '../deploy/runtime-controller.mjs';

test('portal changes build and restart only portal services', () => {
  const actions=planRuntimeActions(['rust/portal/crates/server/src/api.rs']);
  assert.equal(actions.restartPortal,true);
  assert.equal(actions.restartRust,false);
  assert.equal(actions.restartNode,false);
  assert.equal(actions.buildPortal,true);
});

test('only numbered portal migrations enter incremental packages', () => {
  assert.equal(safePath('rust/portal/crates/server/migrations/0001_portal.sql'),true);
  assert.equal(safePath('rust/crates/mybot-storage/migrations/0001.sql'),false);
  assert.equal(safePath('rust/portal/crates/server/migrations/down.sql'),false);
});

test('released portal migrations cannot be modified or deleted', t => {
  const repo=fs.mkdtempSync(path.join(os.tmpdir(),'portal-migration-'));
  t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'}).toString().trim();
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Portal test');
  fs.writeFileSync(path.join(repo,'index.js'),'// baseline');git('add','.');git('commit','-m','base');
  const base=git('rev-parse','HEAD');
  const dir=path.join(repo,'rust/portal/crates/server/migrations');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'0001_portal.sql');fs.writeFileSync(file,'CREATE TABLE demo(id integer);');
  fs.writeFileSync(path.join(repo,'CAI_DAT_PORTAL.bat'),'@echo off\r\n');
  fs.writeFileSync(path.join(repo,'.gitignore'),'rust/portal/target/\n');
  git('add','.');git('commit','-m','add');
  const added=git('rev-parse','HEAD');
  assert.equal(buildPreview({repo,base,target:added}).files.length,1);
  fs.appendFileSync(file,'DROP TABLE demo;');git('add','.');git('commit','-m','modify');
  assert.throws(()=>buildPreview({repo,base:added,target:'HEAD'}),/immutable/i);
});

test('portal build is isolated and copies native and WASM artifacts before ready', t => {
  const stageDir=fs.mkdtempSync(path.join(os.tmpdir(),'portal-build-'));
  t.after(()=>fs.rmSync(stageDir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(stageDir,'rust/portal'),{recursive:true});
  fs.writeFileSync(path.join(stageDir,'.mybot-release.json'),JSON.stringify({status:'staged',files:[{path:'rust/portal/crates/server/src/api.rs'}]}));
  const calls=[];
  prepareRelease({stageDir,run(command,args,cwd,env){
    calls.push({command,args,cwd,env});
    if(command==='bash'){
      fs.mkdirSync(path.join(stageDir,'bin'),{recursive:true});
      fs.writeFileSync(path.join(stageDir,'bin/mybot-portal'),'server');
      fs.writeFileSync(path.join(stageDir,'bin/mybot-portal-worker'),'worker');
      fs.mkdirSync(path.join(stageDir,'portal-site/pkg'),{recursive:true});
      fs.writeFileSync(path.join(stageDir,'portal-site/pkg/mybot-portal_bg.wasm'),'wasm');
    }
  }});
  assert.equal(calls.length,1);
  assert.equal(calls[0].command,'bash');
  assert.ok(calls[0].args.some(arg=>arg.includes('build-portal.sh')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stageDir,'.mybot-release.json'))).status,'ready');
});

test('portal restart is included in transaction and health gates', async () => {
  const calls=[];
  const controller=await createRuntimeController({root:'/opt/mybot',paths:['rust/portal/crates/server/src/api.rs'],snapshot:[],restartService:async()=>calls.push('dashboard'),restartPortal:async target=>calls.push(`portal:${target}`),checkHealth:async()=>true,checkPortalHealth:async()=>false,delay:async()=>{}});
  await controller.restart('a'.repeat(40));
  assert.deepEqual(calls,[`portal:${'a'.repeat(40)}`]);
  assert.equal(await controller.health(),false);
});
