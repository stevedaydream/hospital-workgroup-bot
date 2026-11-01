import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReviewModel } from '../src/model-switch.js';

test('switch waits for stop acknowledgement and unloaded status without forcing tasks', async () => {
  const calls=[];
  let snapshots=0;
  await prepareReviewModel('local', { pause:async()=>{}, request:async(route,body)=>{
    calls.push({route,body});
    if(body) {assert.deepEqual(body,{type:'stopModel',id:'qwen36',force:false});return {stopped:true};}
    snapshots++;
    return {models:{profiles:[{profile:{id:'qwen36'},status:{loaded:snapshots===1,busy:false},managed:{ready:snapshots===1,starting:false,inflight:0}}]}};
  }});
  assert.equal(calls[0].route,'/action');
  assert.equal(snapshots,2);
});

test('busy model never gets force-stopped or a new launch request', async () => {
  let calls=0;
  await assert.rejects(prepareReviewModel('local',{pause:async()=>{},request:async(route,body)=>{
    calls++;assert.equal(route,'/action');assert.equal(body.force,false);return {stopped:false,tasks:['other project']};
  }}),/仍有工作/);
  assert.equal(calls,15);
});
