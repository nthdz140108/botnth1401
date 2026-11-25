import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function portalError(code, status = 409) { return Object.assign(new Error(code), {code, status}); }
export function readPortalPolicy(root) {
 const file=path.join(root,'mybot','portal-bindings.json');
 try { const value=JSON.parse(fs.readFileSync(file,'utf8')); if(!value.bindings || !value.operations) throw new Error('invalid'); return value; }
 catch(e) { if(e.code==='ENOENT') return {version:1,bindings:{},operations:{}}; throw portalError('PORTAL_POLICY_UNAVAILABLE',503); }
}
export function writePortalPolicy(root,value) {
 const file=path.join(root,'mybot','portal-bindings.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=`${file}.${crypto.randomUUID()}.tmp`;
 try { const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file); }
 finally {if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export function portalBindingForRuntime(root,botId) {
 const binding=Object.values(readPortalPolicy(root).bindings).find(b=>b.runtime_id===String(botId));
 // Generated portal identities must never fall back to legacy lifecycle rules.
 if(!binding && String(botId).startsWith('portal_'))throw portalError('PORTAL_BINDING_MISSING',403);
 return binding || null;
}
export function assertPortalRuntimeAllowed(root,botId,{now=Date.now(),allowStopped=false,uid=null}={}) {
 const b=portalBindingForRuntime(root,botId);if(!b)return null;
 if(!Number.isFinite(Date.parse(b.expires_at)) || Date.parse(b.expires_at)<=now)throw portalError('SLOT_EXPIRED',403);
 if(!allowStopped && b.desired_status!=='running')throw portalError('PORTAL_RUNTIME_STOPPED',403);
 if(uid && (!b.uid || b.uid!==String(uid)))throw portalError('PORTAL_UID_MISMATCH',403);
 return b;
}
export function assertNotPortalManaged(root,botId) { if(portalBindingForRuntime(root,botId)||Object.values(readPortalPolicy(root).bindings).some(b=>b.uid===String(botId)))throw portalError('PORTAL_MANAGED_SLOT',403); }
export function assertPortalAccountOwnership(root,botId,uid) {if(Object.values(readPortalPolicy(root).bindings).some(b=>b.uid===String(uid)&&b.runtime_id!==String(botId)))throw portalError('ACCOUNT_ALREADY_BOUND',403);}

