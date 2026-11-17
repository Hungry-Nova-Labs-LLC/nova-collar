import test from 'node:test';
import assert from 'node:assert/strict';
import { requestDecision, DECISION_LIMITS } from '../src/main/decision-service.js';

const endpoint='https://decision.example/v1/decisions';
const actions=[{id:'z_read',description:'Read current source.'},{id:'a_fix',description:'Repair the observed implementation.'}];
const state={goal:'Repair the implementation.',scope:{network:false},evidence:[{id:'e1',result:'Public check failed on current source.'}]};
const base={endpoint,apiKey:'synthetic-test-key',state,actions};
const good=()=>({model:'laya',answers:{next_step:{type:'choice',choice:'slot_1',confidence:0.8,probabilities:{slot_0:0.2,slot_1:0.8}}},usage:{input_tokens:100,output_tokens:0}});
const reply=(data=good(),init={})=>new Response(JSON.stringify(data),{status:200,...init});

test('native wire preserves complete JSON state and opaque ordered slots; returns original IDs',async()=>{
  let calls=0;
  const result=await requestDecision({...base,fetchImpl:async(url,init)=>{
    calls++;assert.equal(url,endpoint);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
    assert.equal(init.headers.authorization,'Bearer synthetic-test-key');
    const wire=JSON.parse(init.body);assert.deepEqual(wire.state,state);assert.equal(wire.model,'laya');
    assert.deepEqual(wire.questions.next_step.criteria,{slot_0:'z_read: Read current source.',slot_1:'a_fix: Repair the observed implementation.'});
    assert.equal(wire.questions.next_step.type,'choice');return reply();
  }});
  assert.equal(calls,1);assert.equal(result.ok,true);assert.equal(result.choice,'a_fix');
  assert.deepEqual(result.probabilities,{z_read:0.2,a_fix:0.8});assert.equal(result.confidence,0.8);
  assert.equal(Number.isFinite(result.elapsedMs),true);assert.deepEqual(state,base.state);
});

test('snapshots action IDs before awaiting so later caller mutation cannot relabel a reply',async()=>{
  const mutable=actions.map(x=>({...x}));let release;
  const pending=requestDecision({...base,actions:mutable,fetchImpl:()=>new Promise(resolve=>{release=resolve;})});
  mutable[1].id='wrong_id';release(reply());
  assert.equal((await pending).choice,'a_fix');
});

test('explicit unauthenticated loopback omits Authorization; remote never invents a key',async()=>{
  let calls=0;
  const result=await requestDecision({...base,endpoint:'http://127.0.0.1:9123/v1/decisions',apiKey:'',fetchImpl:async(_url,init)=>{
    calls++;assert.equal(Object.hasOwn(init.headers,'authorization'),false);return reply();
  }});
  assert.equal(result.ok,true);assert.equal(calls,1);
  assert.equal((await requestDecision({...base,apiKey:'',fetchImpl:()=>{throw Error('must not call');}})).reason,'missing-key');
});

test('credential URLs, query/fragment URLs and cleartext remote endpoints are rejected before fetch',async()=>{
  for (const url of ['https://user:password@decision.example/v1/decisions',endpoint+'?token=synthetic',endpoint+'#fragment','http://decision.example/v1/decisions','file:///tmp/decisions']) {
    let calls=0;const result=await requestDecision({...base,endpoint:url,fetchImpl:()=>{calls++;return reply();}});
    assert.equal(result.reason,'invalid-endpoint');assert.equal(calls,0);
  }
});

test('rejects lossy/cyclic state, oversize state and invalid action sets without network calls',async()=>{
  const cyclic={};cyclic.self=cyclic;
  const sparse=[];sparse.length=2;sparse[1]='value';sparse.extra='must not disappear';
  for (const value of [cyclic,{lost:undefined},{date:new Date()},sparse,{bad:Infinity}]) {
    const result=await requestDecision({...base,state:value,fetchImpl:()=>{throw Error('must not call');}});
    assert.equal(result.reason,'invalid-state');
  }
  assert.equal((await requestDecision({...base,state:'x'.repeat(DECISION_LIMITS.stateBytes),fetchImpl:()=>{throw Error('must not call');}})).reason,'state-too-large');
  for (const choices of [[],[actions[0]],[actions[0],actions[0]],[{id:'__proto__',description:'bad'},actions[1]],[{id:'valid',description:'x'.repeat(1025)},actions[1]]]) {
    assert.equal((await requestDecision({...base,actions:choices,fetchImpl:()=>{throw Error('must not call');}})).reason,'invalid-actions');
  }
  const many=Array.from({length:8},(_,i)=>({id:'action_'+i,description:'"'.repeat(1024)}));
  assert.equal((await requestDecision({...base,state:'x'.repeat(16370),actions:many,fetchImpl:()=>{throw Error('must not call');}})).reason,'request-too-large');
});

test('rejects unknown slot choices and invalid/inconsistent probability distributions without repair',async()=>{
  const mutations=[
    answer=>{answer.choice='a_fix';},answer=>{answer.choice='slot_9';},answer=>{answer.confidence=2;},
    answer=>{answer.probabilities.slot_0=-0.1;},answer=>{answer.probabilities.slot_1='0.8';},
    answer=>{delete answer.probabilities.slot_0;},answer=>{answer.probabilities.extra=0;},
    answer=>{answer.probabilities={slot_0:0.1,slot_1:0.1};},answer=>{answer.choice='slot_0';},
  ];
  for(const mutate of mutations){const data=good();mutate(data.answers.next_step);let calls=0;
    const result=await requestDecision({...base,fetchImpl:async()=>{calls++;return reply(data);}});
    assert.equal(result.reason,'invalid-response');assert.equal(calls,1);assert.equal(Object.hasOwn(result,'choice'),false);
  }
});

test('response bound applies before and during body read and cancels unread bodies',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true;}});
  const oversized=new Response(stream,{status:200,headers:{'content-length':String(DECISION_LIMITS.responseBytes+1)}});
  assert.equal((await requestDecision({...base,fetchImpl:async()=>oversized})).reason,'response-too-large');
  await new Promise(setImmediate);assert.equal(cancelled,true);
  const large=new Response(' '.repeat(DECISION_LIMITS.responseBytes+1),{status:200});
  assert.equal((await requestDecision({...base,fetchImpl:async()=>large})).reason,'response-too-large');
});

test('UTF-8 split across byte chunks is decoded intact; invalid UTF-8 is rejected',async()=>{
  const data={...good(),note:'漢😀'};const bytes=new TextEncoder().encode(JSON.stringify(data));
  const stream=new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}});
  assert.equal((await requestDecision({...base,fetchImpl:async()=>new Response(stream)})).ok,true);
  assert.equal((await requestDecision({...base,fetchImpl:async()=>new Response(new Uint8Array([255]))})).reason,'invalid-response');
});

test('rejects response redirects and never retries HTTP failures or exposes raw errors/key',async()=>{
  for (const status of [302,401,404,429,500]) {
    let calls=0;const result=await requestDecision({...base,fetchImpl:async()=>{calls++;return new Response('synthetic-test-key private raw error',{status});}});
    assert.equal(result.ok,false);assert.equal(calls,1);assert.equal(JSON.stringify(result).includes('synthetic-test-key'),false);
    assert.equal(JSON.stringify(result).includes('private raw error'),false);
    assert.equal(result.reason,status===302?'redirect':status===401?'authentication':status===404?'not-found':status===429?'rate-limited':'service-unavailable');
  }
  const result=await requestDecision({...base,fetchImpl:async()=>{throw Error('synthetic-test-key private exception');}});
  assert.equal(result.reason,'network-error');assert.equal(JSON.stringify(result).includes('synthetic-test-key'),false);
  const redirected={status:200,url:'https://elsewhere.example/v1/decisions',redirected:true};
  assert.equal((await requestDecision({...base,fetchImpl:async()=>redirected})).reason,'redirect');
});

test('pre-cancelled parent makes zero requests; parent stop returns even if fetch ignores abort',async()=>{
  const already=new AbortController();already.abort();let calls=0;
  assert.equal((await requestDecision({...base,signal:already.signal,fetchImpl:()=>{calls++;}})).reason,'cancelled');
  assert.equal(calls,0);
  const parent=new AbortController();let transportSignal;
  const start=performance.now();
  const pending=requestDecision({...base,signal:parent.signal,fetchImpl:async(_url,init)=>{transportSignal=init.signal;return new Promise(()=>{});}});
  parent.abort();const result=await pending;
  assert.equal(result.reason,'cancelled');assert.equal(transportSignal.aborted,true);assert.ok(performance.now()-start<500);
});

test('timeout covers a stuck response body and cancels its reader',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const start=performance.now();
  const result=await requestDecision({...base,timeoutMs:100,fetchImpl:async()=>response});
  assert.equal(result.reason,'timeout');assert.ok(performance.now()-start<1000);
  await new Promise(setImmediate);assert.equal(cancelled,true);
});

test('success removes parent listener and clears the timeout without a later abort',async()=>{
  const parent=new AbortController();let additions=0,removals=0,transportSignal;
  const add=parent.signal.addEventListener.bind(parent.signal),remove=parent.signal.removeEventListener.bind(parent.signal);
  parent.signal.addEventListener=(...args)=>{additions++;return add(...args);};
  parent.signal.removeEventListener=(...args)=>{removals++;return remove(...args);};
  const result=await requestDecision({...base,signal:parent.signal,timeoutMs:100,fetchImpl:async(_url,init)=>{transportSignal=init.signal;return reply();}});
  assert.equal(result.ok,true);assert.equal(additions,1);assert.equal(removals,1);
  parent.abort();await new Promise(resolve=>setTimeout(resolve,130));assert.equal(transportSignal.aborted,false);
});
