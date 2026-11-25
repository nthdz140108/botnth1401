import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRoster } from '../src/service-debug/info-service/roster-service.js';
test('shared roster reports full partial unknown and retains known IDs on pagination error',async()=>{
 const api={getGroupInfo:async()=>({name:'g',memberIds:['1','2'],totalMember:2})};
 assert.equal((await scanRoster(api,'10')).completeness,'full');
 api.getGroupInfo=async()=>({memberIds:['1'],totalMember:3,hasMoreMember:1});api.getGroupInfoV2=async()=>{throw Error('denied');};
 const partial=await scanRoster(api,'10');assert.equal(partial.completeness,'partial');assert.deepEqual(partial.members.map(m=>m.uid),['1']);
 api.getGroupInfo=async()=>({memberIds:['1']});assert.equal((await scanRoster(api,'10')).completeness,'unknown');
});
