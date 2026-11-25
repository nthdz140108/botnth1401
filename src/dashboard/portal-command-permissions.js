import { resolveRequiredRole,roleSatisfies } from '../commands/command-permission-policy.js';
import { botStudioPath,readJsonCached } from '../commands/studio/sparse-store.js';

export const PORTAL_PERMISSIONS=Object.freeze(['all','adminBox','adminBot','adminLevelHigh']);
export function platformPermissionFloor(name,definition={}) {
 const base=definition.permission==='adminBotOrGroup'?'adminBox':definition.permission||'all';
 const policy=resolveRequiredRole({canonicalName:name,definition}).requiredRole;
 const floor=roleSatisfies(base,policy)?base:policy;
 return floor==='member'?'all':floor;
}
export function tenantPermissionVerdict(root,botId,name,callerRole,definition={}) {
 const floor=platformPermissionFloor(name,definition);
 const doc=readJsonCached(botStudioPath(root,botId));
 const requested=doc?.commands?.[name]?.tenantPermission;
 // Stored policy is an additional restriction. Corrupt or lowered values never replace the platform floor.
 const required=requested&&PORTAL_PERMISSIONS.includes(requested)&&roleSatisfies(requested,floor)?requested:floor;
 return {allowed:roleSatisfies(callerRole||'member',required),requiredRole:required};
}
