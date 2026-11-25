import crypto from 'node:crypto';
import {validateTenantCommandPatch} from './portal-command-studio.js';
import {validatePortalAssets} from './portal-assets.js';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import {readPortalPolicy,writePortalPolicy,portalError} from './portal-policy.js';

const IDENTIFIER=/^[a-zA-Z0-9_-]{1,100}$/;
const KINDS=new Set(['bind','lease','status','qr_start','qr_status','qr_cancel','start','stop','restart','unlink','configure','config','commands','groups','roster','send']);
function only(value,keys) {if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)))throw portalError('FIELD_NOT_ALLOWED',400);}
export function createPortalService({root,runtime,now=Date.now}) {
 const policyFile=path.join(root,'mybot','portal-bindings.json');
 let queue=Promise.resolve();
 async function locked(fn) {
  const prev=queue;let releaseQueue;queue=new Promise(r=>releaseQueue=r);await prev;
  fs.mkdirSync(path.dirname(policyFile),{recursive:true});if(!fs.existsSync(policyFile))writePortalPolicy(root,{version:1,bindings:{},operations:{}});
  let release;try{release=await lockfile.lock(policyFile,{retries:{retries:50,minTimeout:20,maxTimeout:100},stale:120000});return await fn();}finally{if(release)await release();releaseQueue();}
 }
 async function execute(input) {return locked(async()=>{
  only(input,['operation_id','tenant_id','slot_id','binding_revision','expires_at','kind','payload']);
  for(const k of ['operation_id','tenant_id','slot_id'])if(!IDENTIFIER.test(input[k]||''))throw portalError('INVALID_IDENTIFIER',400);
  if(!Number.isSafeInteger(input.binding_revision)||input.binding_revision<1||!KINDS.has(input.kind))throw portalError('INVALID_OPERATION',400);
  const deadline=Date.parse(input.expires_at);if(!Number.isFinite(deadline))throw portalError('INVALID_EXPIRY',400);
  let payload=input.payload||{};const policy=readPortalPolicy(root);let binding=policy.bindings[input.slot_id];
  if(binding && binding.tenant_id!==input.tenant_id)throw portalError('TENANT_MISMATCH',403);
  if(binding && input.binding_revision<binding.binding_revision)throw portalError('REVISION_CONFLICT');
  const digest=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const previous=policy.operations[input.operation_id];
  if(previous) {if(previous.digest!==digest)throw portalError('OPERATION_CONFLICT');return {...previous,status:previous.status==='dispatching'?'unknown':previous.status};}
  if(!['bind','lease'].includes(input.kind) && (!binding || binding.binding_revision!==input.binding_revision))throw portalError('REVISION_CONFLICT');
  if(deadline<=now() && !['stop','unlink','status','qr_cancel'].includes(input.kind))throw portalError('SLOT_EXPIRED',403);
  if(['bind','lease'].includes(input.kind)) {
   only(payload,[]);
   if(binding && binding.binding_revision===input.binding_revision) {
    binding.expires_at=input.expires_at;delete binding.expiry_enforced_at;writePortalPolicy(root,policy);await runtime.lease?.(binding);
   }else {
    if(binding) {await runtime.stop(binding);await runtime.remove(binding);}
    binding={tenant_id:input.tenant_id,slot_id:input.slot_id,binding_revision:input.binding_revision,expires_at:input.expires_at,runtime_id:`portal_${crypto.createHash('sha256').update(input.slot_id).digest('hex').slice(0,20)}_${input.binding_revision}`,uid:null,desired_status:'stopped'};
    policy.bindings[input.slot_id]=binding;writePortalPolicy(root,policy);await runtime.prepare(binding);
   }
  } else if(Date.parse(binding.expires_at)<=now() && !['stop','unlink','status','qr_cancel'].includes(input.kind))throw portalError('SLOT_EXPIRED',403);
  let result;
  if(['bind','lease'].includes(input.kind)) result={binding_revision:binding.binding_revision};
  else if(input.kind==='start'||input.kind==='restart') {
   only(payload,[]);if(input.kind==='restart')await runtime.stop(binding);
   const uid=String(await runtime.verify(binding));if(!/^[1-9]\d*$/.test(uid))throw portalError('UID_NOT_VERIFIED',403);
   if((await runtime.reservedUids()).includes(uid))throw portalError('RESERVED_ACCOUNT',403);
   if(Object.values(policy.bindings).some(b=>b.slot_id!==binding.slot_id&&b.uid===uid))throw portalError('ACCOUNT_ALREADY_BOUND');
   binding.uid=uid;binding.desired_status='running';writePortalPolicy(root,policy);
   try{result=await runtime.start(binding);}catch(e){binding.desired_status='stopped';writePortalPolicy(root,policy);throw e;}
  }else if(input.kind==='stop'||input.kind==='unlink') {
   only(payload,[]);binding.desired_status='stopped';writePortalPolicy(root,policy);await runtime.stop(binding);
   if(input.kind==='unlink'){await runtime.remove(binding);binding.uid=null;binding.requires_rebind=true;binding.runtime_id+=`_${crypto.randomBytes(5).toString('hex')}`;writePortalPolicy(root,policy);await runtime.prepare(binding);}result={status:'stopped'};
  }else if(input.kind.startsWith('qr_')){only(payload,[]);if(input.kind==='qr_start'&&(binding.uid||binding.requires_rebind))throw portalError('REVISION_CONFLICT');result=await runtime.qr(binding,input.kind.slice(3));}
  else if(input.kind==='status'){only(payload,[]);result=await runtime.status(binding);}
  else if(input.kind==='config'||input.kind==='commands'){only(payload,[]);result=await runtime.readConfig(binding,input.kind);}
  else if(input.kind==='configure') {
   if(payload.section!==undefined){only(payload,['section','config','revision']);if(!Number.isSafeInteger(payload.revision)||payload.revision<0)throw portalError('INVALID_CONFIG_REVISION',400);const section=payload.section;const config=payload.config;if(section==='config'){only(config,['prefix','label']);payload={...(config.prefix!==undefined?{prefix:config.prefix}:{}),...(config.label!==undefined?{display_name:config.label}:{})};}else if(['commands','groups'].includes(section)){payload={[section]:config};}else throw portalError('FIELD_NOT_ALLOWED',400);}
   only(payload,['prefix','display_name','commands','groups']);
   if(payload.prefix!==undefined && (typeof payload.prefix!=='string'||!payload.prefix.trim()||payload.prefix.length>8))throw portalError('INVALID_PREFIX',400);
   if(payload.display_name!==undefined && (typeof payload.display_name!=='string'||payload.display_name.length>100))throw portalError('INVALID_NAME',400);
   if(payload.commands)for(const [name,fields]of Object.entries(payload.commands)){if(typeof name!=='string'||name.length>100||!/^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9_-]+)*$/.test(name))throw portalError('INVALID_COMMAND',400);validateTenantCommandPatch(name,fields);}
   if(payload.groups)for(const [id,fields]of Object.entries(payload.groups)){if(!/^\d+$/.test(id))throw portalError('INVALID_GROUP',400);only(fields,['welcome','antiSpam','antiLink','autoReply']);if(Object.values(fields).some(v=>typeof v!=='boolean'))throw portalError('INVALID_GROUP',400);}
   result=await runtime.configure(binding,payload);
  }else {
   const state=await runtime.status(binding);
   if(binding.desired_status!=='running'||state.ready!==true||state.uid!==binding.uid)throw portalError('BOT_NOT_READY',503);
   if(input.kind==='send') {
    only(payload,['target_id','target_type','text','asset_ids','assets']);
    if(!/^\d+$/.test(payload.target_id)||!['group','dm'].includes(payload.target_type)||typeof payload.text!=='string'||(!payload.text.trim()&&!payload.assets?.length)||payload.text.length>2000)throw portalError('INVALID_MESSAGE',400);
    if(payload.asset_ids?.length && !payload.assets?.length)throw portalError('ASSET_NOT_RESOLVED',400);
    await validatePortalAssets(payload.assets||[]);
    const interval=payload.target_type==='group'?5000:10000;
    if(now()<(binding.next_send_at||0))throw portalError('RATE_LIMITED',429);
    binding.next_send_at=now()+interval;
    const op={operation_id:input.operation_id,tenant_id:input.tenant_id,slot_id:input.slot_id,digest,status:'dispatching',result:null};policy.operations[input.operation_id]=op;writePortalPolicy(root,policy);
    try {op.result=await runtime.request(binding,'send',payload);op.status='succeeded';}
    catch(error) {const skipped=['GROUP_NOT_ACCESSIBLE','ZALO_DELIVERY_REJECTED'];const rejected=['BOT_NOT_READY','REVISION_CONFLICT','SLOT_EXPIRED','PORTAL_UID_MISMATCH','INVALID_MESSAGE','INVALID_ASSETS','INVALID_IMAGE'];op.status=error.code==='RATE_LIMITED'?'rate_limited':skipped.includes(error.code)?'skipped':rejected.includes(error.code)?'failed':'unknown';op.result={code:op.status==='unknown'?'SEND_RESULT_UNKNOWN':error.code,...(op.status==='rate_limited'?{retry_after:error.retry_after||2}:{})};}
    writePortalPolicy(root,policy);return op;
   }
   if(input.kind==='roster'){only(payload,['group_id','group_ids']);const ids=payload.group_ids||[payload.group_id];if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>!/^\d+$/.test(id)))throw portalError('INVALID_GROUP',400);const rosters=[];for(const id of [...new Set(ids)])rosters.push(await runtime.request(binding,'roster',{group_id:id}));const members=new Map();for(const roster of rosters)for(const member of roster.members)members.set(member.uid,member);result={rosters,members:[...members.values()],completeness:rosters.some(r=>r.completeness==='partial')?'partial':rosters.some(r=>r.completeness==='unknown')?'unknown':'full',scanned_at:new Date(now()).toISOString()};}
   else {only(payload,[]);result=await runtime.request(binding,input.kind,payload);}
  }
  const op={operation_id:input.operation_id,tenant_id:input.tenant_id,slot_id:input.slot_id,digest,status:'succeeded',result};policy.operations[input.operation_id]=op;writePortalPolicy(root,policy);return op;
 });}
 async function sweep(){return locked(async()=>{const policy=readPortalPolicy(root);for(const b of Object.values(policy.bindings))if(Date.parse(b.expires_at)<=now()&&!b.expiry_enforced_at){b.desired_status='stopped';writePortalPolicy(root,policy);await runtime.qr(b,'cancel');await runtime.stop(b);b.expiry_enforced_at=new Date(now()).toISOString();writePortalPolicy(root,policy);}});}
 function get(id,tenant,slot){const op=readPortalPolicy(root).operations[id];if(!op||op.tenant_id!==tenant||op.slot_id!==slot)throw portalError('OPERATION_NOT_FOUND',404);return {...op,status:op.status==='dispatching'?'unknown':op.status};}
 return {execute,get,sweep};
}
