import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandRegistry } from '../src/commands/command-registry.js';
import { executeCommand, resolveCommand } from '../src/commands/command-router.js';
import { COMMAND_PERMISSION_POLICY } from '../src/commands/command-permission-policy.js';
import { withReleaseCommandDefaults } from '../src/utils/release-command-catalog.js';
import { buildGenericContract } from '../src/commands/studio/contracts.js';
import { CommandScanner } from '../src/dashboard/command-scanner.js';
import { CommandService } from '../src/dashboard/command-service.js';

test('qc registration, manifests, release defaults, and Studio expose high-admin command in both scopes',async()=>{
  const resolved=resolveCommand(['qc'],commandRegistry);
  assert.equal(resolved.code,'RESOLVED');
  const def=resolved.definition;
  assert.equal(def.permission,'adminLevelHigh');assert.equal(def.scope,'both');assert.equal(def.countdown,0);
  assert.equal(def.executionLane,'control');
  assert.equal(COMMAND_PERMISSION_POLICY.qc.requiredRole,'adminLevelHigh');
  for(const filename of ['assets/json-data/command.json','mybot/defaultCommand.json']){
    const doc=JSON.parse(fs.readFileSync(new URL(`../${filename}`,import.meta.url),'utf8'));
    const entry=doc.commands.find(c=>c.name==='qc'); assert.equal(entry.permission,'adminLevelHigh');assert.equal(entry.active,true);
  }
  const contract=buildGenericContract(def);
  assert.equal(contract.commandName,'qc');assert.equal(contract.handlerRef.export,'qcCommand');
  const old={prefix:'$',commands:[{name:'help',active:false,countdown:100}]};
  const release=withReleaseCommandDefaults(old,{MYBOT_CODE_COMMIT:'test'});
  assert.equal(release.commands.find(c=>c.name==='qc').scope,'both');
  assert.deepEqual(release.commands[0],old.commands[0]);assert.equal(old.commands.length,1);
  const denied=await executeCommand({permissionLevel:'adminBot',scope:'group'},def);
  assert.equal(denied.code,'PERMISSION_DENIED');
});

test('qc appears in release dashboard and bot listings without modifying existing catalog settings',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qc-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'assets','json-data'),{recursive:true});
  const file=path.join(root,'assets','json-data','command.json');
  const bytes=JSON.stringify({prefix:'$',commands:[{name:'help',active:false,countdown:123}]});fs.writeFileSync(file,bytes);
  const previous=process.env.MYBOT_CODE_COMMIT;process.env.MYBOT_CODE_COMMIT='test-qc-release';
  t.after(()=>{if(previous===undefined)delete process.env.MYBOT_CODE_COMMIT;else process.env.MYBOT_CODE_COMMIT=previous;});
  const scanner=new CommandScanner({root,registry:commandRegistry,dependencyChecker:async()=>true});
  const scan=await scanner.scan();assert.equal(scan.commands.find(c=>c.name==='qc').handlerAvailable,true);
  const service=new CommandService({root,registry:{async list(){return[];}},scanner});
  const bot=await service.listForBot('child');assert.ok(bot.commands.find(c=>c.name==='qc'));
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
});
