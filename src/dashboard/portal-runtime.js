import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {validatePortalAssets} from './portal-assets.js';
import {isDeliveryRejection} from '../api-zalo/transport-limiter.js';
import { scanRoster } from '../service-debug/info-service/roster-service.js';
import { assertPortalRuntimeAllowed,portalError } from './portal-policy.js';

export function registerPortalRuntimeRoute(app,{root,getApi,getDescriptor,getListener,getReloadHandler,secret}) {
 const inFlight=new Set();let nextSendAt=0;
 app.post('/internal/portal/execute',async(req,res)=>{
  let sending=false;let assetDir;
  try {
   const ip=req.socket.remoteAddress;if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip))throw portalError('LOOPBACK_REQUIRED',403);
   const timestamp=String(req.headers['x-internal-timestamp']||'');const sig=String(req.headers['x-internal-signature']||'');
   if(!secret||!/^\d+$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>30000||!/^[a-f0-9]{64}$/i.test(sig))throw portalError('UNAUTHORIZED_HMAC',401);
   const expected=crypto.createHmac('sha256',secret).update(`${Number(timestamp)}.${req.portalRawBody||''}`).digest();
   if(!crypto.timingSafeEqual(expected,Buffer.from(sig,'hex')))throw portalError('UNAUTHORIZED_HMAC',401);
   const input=req.body;const desc=getDescriptor();const api=getApi();const uid=String(api?.getOwnId?.()||'');
   const binding=assertPortalRuntimeAllowed(root,desc.botKey||desc.configuredUid,{uid});
   if(!binding||binding.tenant_id!==input.tenant_id||binding.slot_id!==input.slot_id||binding.binding_revision!==input.binding_revision||Date.parse(input.expires_at)!==Date.parse(binding.expires_at))throw portalError('REVISION_CONFLICT');
   if(getListener().listenerConnected!==true)throw portalError('BOT_NOT_READY',503);
   const payload=input.payload||{};let result;
   const groupMap=async()=>{const all=await api.getAllGroups();return all?.gridVerMap||all?.groups||all||{};};
   if(input.kind==='reload'){const handler=getReloadHandler?.();if(typeof handler!=='function')throw portalError('RELOAD_UNAVAILABLE',503);result=await handler({reloadType:'command-config',uid:desc.botKey,requestedAt:new Date().toISOString()});}
   else if(input.kind==='groups'){
    const map=await groupMap();
    if(Array.isArray(map)){result={groups:map,synced:true,synced_at:new Date().toISOString()};}
    else {
     const ids=Object.keys(map).filter(k=>/^\d+$/.test(k));const list=[];
     for(const gid of ids){
      let item={id:gid,groupId:gid,name:`Nhóm ${gid}`};
      if(typeof api.getGroupInfo==='function'){
       try{const raw=await api.getGroupInfo(gid);const info=raw?.gridInfoMap?raw.gridInfoMap[gid]:raw;if(info&&typeof info==='object'){const admins=[...(info.adminIds||[]),...(info.admins||[])].map(x=>String(x?.id??x?.uid??x));item={id:gid,groupId:gid,name:String(info.name||item.name),totalMember:Number.isFinite(Number(info.totalMember))?Number(info.totalMember):null,isAdmin:String(info.creatorId||'')===uid||admins.includes(uid)};}}catch{}
      }
      list.push(item);
     }
     result={groups:list,gridVerMap:map,synced:true,synced_at:new Date().toISOString()};
    }
   }
   else if(input.kind==='roster'){
    if(!Object.hasOwn(await groupMap(),payload.group_id))throw portalError('GROUP_NOT_ACCESSIBLE',403);
    result=await scanRoster(api,payload.group_id);
   }else if(input.kind==='send') {
    if(!/^\d+$/.test(payload.target_id)||!['dm','group'].includes(payload.target_type)||typeof payload.text!=='string'||payload.text.length>2000||(!payload.text.trim()&&!payload.assets?.length))throw portalError('INVALID_MESSAGE',400);
    if(payload.target_type==='group'&&!Object.hasOwn(await groupMap(),payload.target_id))throw portalError('GROUP_NOT_ACCESSIBLE',403);
    if(inFlight.size||Date.now()<nextSendAt)throw portalError('RATE_LIMITED',429);
    inFlight.add(input.operation_id);sending=true;nextSendAt=Date.now()+(payload.target_type==='group'?5000:10000);
    // Re-read the durable policy immediately before entering the engine's own transport limiter.
    assertPortalRuntimeAllowed(root,desc.botKey||desc.configuredUid,{uid});
    const assets=await validatePortalAssets(payload.assets||[]);
    let attachments;
    if(assets.length){const parent=path.resolve(root,'mybot','instances',binding.runtime_id,'data','portal-outbound');if(!parent.startsWith(path.resolve(root,'mybot','instances')+path.sep))throw portalError('INVALID_RUNTIME',403);fs.mkdirSync(parent,{recursive:true});assetDir=fs.mkdtempSync(path.join(parent,'send-'));attachments=assets.map((asset,index)=>{const file=path.join(assetDir,`${index}.${asset.extension}`);fs.writeFileSync(file,asset.bytes,{flag:'wx',mode:0o600});return file;});}
    assertPortalRuntimeAllowed(root,desc.botKey||desc.configuredUid,{uid});
    result=await api.sendMessage({msg:payload.text,...(attachments?{attachments}:{})},payload.target_id,payload.target_type==='group'?1:0);
    if(attachments && (!Array.isArray(result?.attachment)||result.attachment.length===0))throw portalError('ATTACHMENT_RESULT_UNKNOWN',502);
   }else throw portalError('INVALID_OPERATION',400);
   res.json({success:true,data:result});
  }catch(e){const limited=Number(e.status)===429||Number(e.code)===429;const code=limited?'RATE_LIMITED':isDeliveryRejection(e)?'ZALO_DELIVERY_REJECTED':typeof e.code==='string'?e.code:'PORTAL_RUNTIME_FAILED';res.status(limited?429:e.status||502).json({success:false,error:{code,message:code,retry_after:limited?Math.max(2,Number(e.retry_after||e.retryAfter||2)):undefined}});}
  finally{if(sending)inFlight.delete(req.body.operation_id);if(assetDir){const target=path.resolve(assetDir);const expected=path.resolve(root,'mybot','instances');if(target.startsWith(expected+path.sep))fs.rmSync(target,{recursive:true,force:true});}}
 });
}
