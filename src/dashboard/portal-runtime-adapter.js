import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {applyTenantCommandPatches,readTenantCommand,tenantCommandNames,tenantCommandSummary,validateTenantCommandPatch} from './portal-command-studio.js';
import {writeJsonAtomic} from '../commands/mybot/System/json-state.js';
import {defaultIdentityFetcher} from './runtime-status-resolver.js';
import {portalError} from './portal-policy.js';

function read(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function freePort(start){for(let p=start;p<65000;p++){if(await new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(p,'127.0.0.1',()=>server.close(()=>resolve(true)));}))return p;}throw portalError('NO_RUNTIME_PORT',503);}
export function createPortalRuntimeAdapter({root,registry,actions,qrManager,secret,prefixService}) {
 const inventoryFile=path.join(root,'mybot','mybots.json');
 async function prepare(b){
  const inventory=read(inventoryFile);if(inventory[b.runtime_id])return;
  const used=new Set(Object.values(inventory).map(x=>Number(x.webPort)));let port=22000;while(used.has(port))port++;port=await freePort(port);
  const configFilePath=`mybot/credentials/${b.runtime_id}.json`;const groupSettingsPath=`mybot/instances/${b.runtime_id}/data/group-settings.json`;const commandFilePath=`mybot/instances/${b.runtime_id}/data/command.json`;
  const info={id:b.runtime_id,uid:b.runtime_id,name:'MYBOT Cloud',displayName:'MYBOT Cloud',ownerUid:'',admins:[],webPort:port,configFilePath,groupSettingsPath,commandFilePath,expiryAt:b.expires_at,trialStatus:'active',enabled:true,status:'stopped',portalManaged:true};
  writeJsonAtomic(path.join(root,configFilePath),{prefix:'!',cookie:{},imei:'',userAgent:'',active:false});writeJsonAtomic(path.join(root,groupSettingsPath),{});writeJsonAtomic(path.join(root,commandFilePath),read(path.join(root,'mybot','defaultCommand.json'),{prefix:'!',commands:[]}));
  writeJsonAtomic(path.join(root,'mybot','bots',`${b.runtime_id}.json`),info);inventory[b.runtime_id]=info;writeJsonAtomic(inventoryFile,inventory);
 }
 async function reservedUids(){
  const values=new Set((process.env.PORTAL_RESERVED_UIDS||'').split(',').filter(Boolean));const inventory=read(inventoryFile);const roles=read(path.join(root,'mybot','role-registry.json'));const config=read(path.join(root,'assets','config.json'));
  for(const [id,bot]of Object.entries(inventory))if(!id.startsWith('portal_'))for(const value of [id,bot.uid,bot.ownerUid,...(bot.admins||[])])if(/^\d+$/.test(String(value)))values.add(String(value));
  for(const value of [roles.adminBotId,roles.primaryBotId,roles.adminUid,roles.primaryUid,config.uid,config.adminUid,...(Array.isArray(config.admins)?config.admins:[])])if(/^\d+$/.test(String(value)))values.add(String(value));
  for(const id of ['admin',roles.adminBotId,roles.primaryBotId].filter(Boolean)) {const bot=await registry.describe(String(id)).catch(()=>null);if(bot?.port){const identity=await defaultIdentityFetcher(bot.port);if(identity?.liveZaloUid)values.add(String(identity.liveZaloUid));}}
  const collect=value=>{if(Array.isArray(value))value.forEach(collect);else if(value&&typeof value==='object')Object.values(value).forEach(collect);else if(/^[1-9]\d*$/.test(String(value)))values.add(String(value));};
  for(const file of ['list_admin.json','list_admin_high.json'])collect(read(path.join(root,'assets','data',file),[]));
  return [...values];
 }
 async function status(b){const bot=await registry.describe(b.runtime_id);if(!bot)return {ready:false,authenticated:false,listenerReady:false,uid:null};const info=read(path.join(root,'mybot','bots',`${b.runtime_id}.json`),null);const identity=bot.port?await defaultIdentityFetcher(bot.port):null;const authenticated=Boolean(identity?.liveZaloUid&&identity.botKey===b.runtime_id);const listenerReady=authenticated&&identity.listenerConnected===true&&b.desired_status==='running'&&Date.parse(b.expires_at)>Date.now()&&String(identity.liveZaloUid)===b.uid;return {ready:listenerReady,authenticated,listenerReady,uid:authenticated?String(identity.liveZaloUid):null,displayName:info?.zaloName||null,avatar:info?.zaloAvatar||null,status:bot.status,started_at:identity?.listenerConnectedAt||identity?.startupStartedAt||null};}
 async function verify(b){
  // Login probes run in a separate process: Zalo's implementation has process-global appContext.
  const credential=path.join(root,'mybot','credentials',`${b.runtime_id}.json`);
  const program=`import fs from 'node:fs';import {Zalo} from './src/api-zalo/zalo.js';import {getZaloRuntimeConfig} from './src/api-zalo/zalo-config.js';const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));c.userAgent ||= getZaloRuntimeConfig().userAgent;const api=await new Zalo(c).login();let meta={};try{const acc=await api.fetchAccountInfo?.();const p=acc?.profile||acc||{};meta={name:p.displayName||p.zaloName||null,avatar:p.avatar||null};}catch{}process.stdout.write('PORTAL_VERIFY='+JSON.stringify({uid:String(api.getOwnId()),...meta})+'\\n');process.exit(0);`;
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',program,credential],{cwd:root,windowsHide:true,stdio:['ignore','pipe','ignore']});let output='';const timer=setTimeout(()=>{child.kill();reject(portalError('UID_VERIFICATION_TIMEOUT',504));},45000);child.stdout.on('data',c=>{output=(output+c).slice(-4096);});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);const raw=output.match(/PORTAL_VERIFY=(\{[^\n]+\})/)?.[1];let parsed=null;try{if(raw)parsed=JSON.parse(raw);}catch{}const uid=parsed?.uid;if(code===0&&uid&&/^\d+$/.test(uid)){try{const botFile=path.join(root,'mybot','bots',`${b.runtime_id}.json`);if(fs.existsSync(botFile)){const info=read(botFile);if(parsed.name)info.zaloName=String(parsed.name).slice(0,120);if(parsed.avatar)info.zaloAvatar=String(parsed.avatar).slice(0,500);writeJsonAtomic(botFile,info);}}catch{}resolve(uid);}else reject(portalError('UID_NOT_VERIFIED',403));});});
 }
 async function request(b,kind,payload){
  const bot=await registry.describe(b.runtime_id);if(!bot?.port)throw portalError('BOT_NOT_READY',503);
  const body=JSON.stringify({tenant_id:b.tenant_id,slot_id:b.slot_id,binding_revision:b.binding_revision,expires_at:b.expires_at,kind,payload,operation_id:crypto.randomUUID()});const ts=Date.now();const signature=crypto.createHmac('sha256',secret).update(`${ts}.${body}`).digest('hex');
  const response=await fetch(`http://127.0.0.1:${Number(bot.port)}/internal/portal/execute`,{method:'POST',headers:{'content-type':'application/json','x-internal-timestamp':String(ts),'x-internal-signature':signature},body,signal:AbortSignal.timeout(60000)});const data=await response.json();if(!response.ok||!data.success){const error=portalError(data.error?.code||'RUNTIME_REQUEST_FAILED',response.status);error.retry_after=data.error?.retry_after;throw error;}if(kind==='send')return {api_acknowledged:true,message_id:data.data?.message?.msgId||data.data?.message?.[0]?.msgId||data.data?.msgId||null};return data.data;
 }
 async function remove(b){
  await qrManager.cancel(b.runtime_id);const inventory=read(inventoryFile);delete inventory[b.runtime_id];writeJsonAtomic(inventoryFile,inventory);
  const targets=[path.join(root,'mybot','credentials',`${b.runtime_id}.json`),path.join(root,'mybot','bots',`${b.runtime_id}.json`),path.join(root,'mybot','bots',`group_settings_${b.runtime_id}.json`),path.join(root,'mybot','state',`${b.runtime_id}.json`)];
  for(const target of targets)fs.rmSync(target,{force:true});
  // Retained instance data is never mounted again: every account replacement increments revision.
 }
 async function lease(b){
  const file=path.join(root,'mybot','bots',`${b.runtime_id}.json`);const info=read(file);info.expiryAt=b.expires_at;writeJsonAtomic(file,info);
  const inventory=read(inventoryFile);if(inventory[b.runtime_id]){inventory[b.runtime_id].expiryAt=b.expires_at;writeJsonAtomic(inventoryFile,inventory);}
 }
 async function configure(b,p){
  const botFile=path.join(root,'mybot','bots',`${b.runtime_id}.json`);const info=read(botFile);
  const commandsFile=path.join(root,'mybot','instances',b.runtime_id,'data','command.json');const commands=read(commandsFile,{prefix:'!',commands:[]});
  const overridesFile=path.join(root,'mybot','command-overrides',`${b.runtime_id}.json`);const overrides=read(overridesFile);
  // Resolve every command before writing any file; unknown names must not leave partial config.
  const selected=Object.entries(p.commands||{}).map(([name,value])=>{validateTenantCommandPatch(name,value);let command=commands.commands.find(c=>c.name===name);if(!command){command=tenantCommandSummary(name);commands.commands.push(command);}return [name,value,command];});
  if(p.commands)await applyTenantCommandPatches(root,b.runtime_id,p.commands);
  if(p.prefix && !/^\S{1,3}$/.test(p.prefix))throw portalError('INVALID_PREFIX',400);
  if(p.prefix){await prefixService.update(b.runtime_id,p.prefix);commands.prefix=p.prefix;}
  if(p.display_name)info.displayName=p.display_name;
  for(const [name,value,command]of selected){
   if(value.active!==undefined)command.active=value.active;
   if(value.countdown!==undefined)command.countdown=value.countdown;
   const override=overrides[name]||{};
   if(value.active!==undefined)override.active=value.active;
   if(value.countdown!==undefined)override.countdown=value.countdown;
   if(value.response!==undefined)override.behavior={...(override.behavior||{}),responses:{...(override.behavior?.responses||{}),useCustomTemplates:true,templates:{...(override.behavior?.responses?.templates||{}),onSuccess:value.response}}};
   overrides[name]=override;
  }
  writeJsonAtomic(botFile,info);writeJsonAtomic(commandsFile,commands);writeJsonAtomic(overridesFile,overrides);
  if(p.groups){const groupsFile=path.join(root,'mybot','instances',b.runtime_id,'data','group-settings.json');const groups=read(groupsFile);const map={welcome:'welcomeGroup',antiSpam:'antiSpam',antiLink:'removeLinks',autoReply:'autoReplyCommand'};for(const [id,fields]of Object.entries(p.groups)){groups[id]||={};for(const [key,value]of Object.entries(fields))groups[id][map[key]]=value;}writeJsonAtomic(groupsFile,groups);}
  let apply_mode='on-next-start';if((p.prefix||p.commands)&&b.desired_status==='running'){const state=await status(b);if(state.ready){await request(b,'reload',{});apply_mode='hot-reload';}}
  return {applied:true,restart_required:false,apply_mode,group_refresh_seconds:5};
 }

 async function readConfig(b,kind){
  const info=read(path.join(root,'mybot','bots',`${b.runtime_id}.json`));const config=read(path.join(root,'mybot','instances',b.runtime_id,'data','command.json'),{prefix:'!',commands:[]});const overrides=read(path.join(root,'mybot','command-overrides',`${b.runtime_id}.json`));
  if(kind==='config')return {prefix:config.prefix,label:info.displayName};
  const rows=[];for(const name of tenantCommandNames()){const fallback=tenantCommandSummary(name);const stored=config.commands.find(c=>c.name===name)||fallback;const studio=await readTenantCommand(root,b.runtime_id,name);rows.push({...fallback,active:studio.studio_values['operation.enabled']!==false&&stored.active!==false,countdown:studio.studio_values['operation.cooldownSeconds']??stored.countdown??0,response:studio.studio_values['responses.templates.onSuccess']||overrides[name]?.behavior?.responses?.templates?.onSuccess||'',tenant_editable_fields:['active','countdown','response','permission','values'],...studio});}return {prefix:config.prefix,commands:rows};
 }
 async function qr(b,action){const result=action==='start'?await qrManager.start(b.runtime_id):action==='cancel'?await qrManager.cancel(b.runtime_id):await qrManager.get(b.runtime_id);return result&&typeof result==='object'?{...result,qrImage:typeof result.qrImage==='string'&&result.qrImage.startsWith('data:image/')?result.qrImage:null,qr_data_url:typeof result.qrImage==='string'&&result.qrImage.startsWith('data:image/')?result.qrImage:null,status:result.state==='configured'?'success':result.state,credential_ready:result.state==='configured',error:result.error?'QR_LOGIN_FAILED':null}:result;}
 return {prepare,lease,readConfig,reservedUids,status,verify,request,remove,configure,start:async b=>actions.start(b.runtime_id,{portalAuthorized:true}),stop:async b=>{const result=await actions.stop(b.runtime_id,{portalAuthorized:true});if(result?.status==='failed')throw portalError('STOP_FAILED',503);return result;},qr};
}
