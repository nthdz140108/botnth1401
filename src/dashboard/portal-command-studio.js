import path from 'node:path';
import {commandRegistry} from '../commands/command-registry.js';
import {getCommandStudioContract,getStudioContractCatalog} from '../commands/studio/contracts.js';
import {contractFieldIndex} from '../commands/studio/contract-v2.js';
import {resolveCommandConfigSync} from '../commands/studio/config-resolver.js';
import {botStudioPath,readLayerDoc,atomicWriteJson,bumpRevision,invalidateStudioCache} from '../commands/studio/sparse-store.js';
import {validateStudioValues} from './command-studio-service.js';
import {roleSatisfies} from '../commands/command-permission-policy.js';
import {PORTAL_PERMISSIONS,platformPermissionFloor,tenantPermissionVerdict} from './portal-command-permissions.js';
import {portalError} from './portal-policy.js';

export const TENANT_STUDIO_KEYS=Object.freeze([
 'operation.enabled','operation.cooldownMode','operation.cooldownSeconds','operation.maxUsesPerHour',
 'responses.useCustomTemplates','responses.templates.onSuccess','responses.templates.onCooldown',
 'responses.templates.onPermissionDenied','responses.templates.onScopeDenied','responses.templates.onError','responses.templates.onKillSwitch',
 'restrictions.mode','restrictions.allowedThreads','restrictions.blockedThreads','restrictions.allowedUsers',
]);
const SAFE=new Set(TENANT_STUDIO_KEYS);
function contractFor(name){const c=getCommandStudioContract(name);if(!c)throw portalError('COMMAND_NOT_FOUND',404);return c;}
function editable(field){return SAFE.has(field.key)&&field.allowedScopes?.includes('bot')&&!field.sensitive&&!field.readOnly&&(field.apply||'config')==='config';}
function only(obj,keys){if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!keys.includes(k)))throw portalError('FIELD_NOT_ALLOWED',400);}
export function tenantCommandContract(name) {
 const c=contractFor(name);
 return {version:c.version,commandName:c.commandName,aliases:[...c.aliases],permission:platformPermissionFloor(name,c),scope:c.scope,tabs:c.tabs.map(tab=>({id:tab.id,title:tab.title,fields:tab.fields.filter(editable).map(field=>{
  const output={tenantEditable:true};for(const key of ['key','label','type','default','nullable','min','max','options','columns','allowedScopes'])if(field[key]!==undefined)output[key]=structuredClone(field[key]);return output;
 })})).filter(tab=>tab.fields.length)};
}
export function validateTenantCommandPatch(name,patch) {
 only(patch,['active','countdown','response','permission','values']);const c=contractFor(name);const fields=contractFieldIndex(c);
 if(patch.active!==undefined&&typeof patch.active!=='boolean')throw portalError('INVALID_STUDIO_VALUE',400);
 if(patch.countdown!==undefined&&(typeof patch.countdown!=='number'||!Number.isFinite(patch.countdown)||patch.countdown<0||patch.countdown>86400))throw portalError('INVALID_STUDIO_VALUE',400);
 if(patch.response!==undefined&&(typeof patch.response!=='string'||patch.response.length>2000))throw portalError('INVALID_STUDIO_VALUE',400);
 if(patch.permission!==undefined){if(!PORTAL_PERMISSIONS.includes(patch.permission))throw portalError('INVALID_PERMISSION',400);if(!roleSatisfies(patch.permission,platformPermissionFloor(name,c)))throw portalError('PERMISSION_ELEVATION',403);}
 const values=patch.values||{};only(values,TENANT_STUDIO_KEYS);
 for(const [key,value]of Object.entries(values)){
  const field=fields.get(key);if(!field||!editable(field))throw portalError('FIELD_NOT_ALLOWED',400);
  if(value===null&&field.nullable)continue;
  if(field.type==='number'&&(typeof value!=='number'||!Number.isFinite(value)))throw portalError('INVALID_STUDIO_VALUE',400);
  if(field.type==='template'&&(typeof value!=='string'||value.length>2000))throw portalError('INVALID_STUDIO_VALUE',400);
  if(field.type==='table'){
   if(!Array.isArray(value)||value.length>500)throw portalError('INVALID_STUDIO_VALUE',400);
   const idKey=key==='restrictions.allowedUsers'?'userId':'threadId';
   for(const row of value)if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==1||!Object.hasOwn(row,idKey)||typeof row[idKey]!=='string'||!/^\d{1,30}$/.test(row[idKey]))throw portalError('INVALID_STUDIO_VALUE',400);
  }
 }
 if(validateStudioValues(c,values).length)throw portalError('INVALID_STUDIO_VALUE',400);
 const normalized={...values};
 const aliases={active:'operation.enabled',countdown:'operation.cooldownSeconds',response:'responses.templates.onSuccess'};
 for(const [key,target]of Object.entries(aliases))if(patch[key]!==undefined){if(Object.hasOwn(values,target)&&values[target]!==patch[key])throw portalError('CONFLICTING_COMMAND_FIELDS',400);normalized[target]=patch[key];}
 if(patch.response!==undefined)normalized['responses.useCustomTemplates']=true;
 return {values:normalized,permission:patch.permission};
}
export async function applyTenantCommandPatches(root,botId,patches) {
 only(patches,Object.keys(patches||{}));
 const changes=Object.entries(patches).map(([name,patch])=>[name,validateTenantCommandPatch(name,patch)]);
 const file=botStudioPath(root,botId);const doc=await readLayerDoc(file);
 for(const [name,change]of changes){const previous=doc.commands[name]||{};doc.commands[name]={...previous,values:{...(previous.values||{}),...change.values},...(change.permission!==undefined?{tenantPermission:change.permission}:{})};}
 bumpRevision(doc);await atomicWriteJson(file,doc,{backupDir:path.join(root,'logs','dashboard-backups','portal',botId)});invalidateStudioCache(file);
 return {revision:doc.meta.revision,changed_commands:changes.map(([name])=>name)};
}
export async function readTenantCommand(root,botId,name) {
 const contract=contractFor(name);const safe=tenantCommandContract(name);const effective=resolveCommandConfigSync({root,botId,commandName:name,contract}).effective;const doc=await readLayerDoc(botStudioPath(root,botId));const floor=platformPermissionFloor(name,contract);
 const stored=doc.commands[name]?.tenantPermission;const permission=stored&&PORTAL_PERMISSIONS.includes(stored)&&roleSatisfies(stored,floor)?stored:floor;
 return {contract:safe,studio_values:Object.fromEntries(safe.tabs.flatMap(t=>t.fields).map(f=>[f.key,effective[f.key]])),studio_revision:doc.meta.revision,permission,permission_options:PORTAL_PERMISSIONS.filter(p=>roleSatisfies(p,floor))};
}
export function tenantCommandPermission(root,botId,name,role){return tenantPermissionVerdict(root,botId,name,role,contractFor(name));}
export function tenantCommandNames(){return getStudioContractCatalog().contracts.map(c=>c.commandName);}

export function tenantCommandSummary(name){const definition=commandRegistry.definitions.find(d=>d.name===name);if(!definition)throw portalError('COMMAND_NOT_FOUND',404);return {name,description:definition.description||'',syntax:definition.syntax||'',active:definition.active!==false,countdown:definition.countdown||0,permission:platformPermissionFloor(name,definition)};}
