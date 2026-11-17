import assert from "node:assert/strict";
import {test} from "node:test";
import {createTurnBudget, isTurnBudgetError, localBudgetTargets, turnBudgetHint} from "../src/main/turn-budget.js";
const clock = (options={}) => {
  let time=1000;
  const budget=createTurnBudget({defaultEnabled:true,startedAt:1000,wallStartedAt:100000,now:()=>time,...options});
  return {budget,set:ms=>{time=1000+ms;}};
};
test("local default reserves 435 implementation, 150 verification and 15 handoff seconds",()=>{
  const c=clock();assert.deepEqual({...c.budget.snapshot()}, {enabled:true,known:true,phase:"work",elapsedMs:0,remainingMs:600000,phaseRemainingMs:435000,totalMs:600000,workMs:435000,verificationMs:150000,handoffMs:15000});
  c.set(435000);assert.equal(c.budget.snapshot().phase,"verification");
  c.set(585000);assert.equal(c.budget.snapshot().phase,"handoff");
  assert.throws(()=>c.budget.admission(),isTurnBudgetError);
});
test("only supplied trusted numeric metadata sets explicit limits; earliest wins",()=>{
  assert.equal(clock({budgetMs:1200000}).budget.snapshot().totalMs,1200000);
  assert.equal(clock({budgetMs:1200000,deadlineAt:400000}).budget.snapshot().totalMs,300000);
  assert.equal(clock({deadlineAt:108000}).budget.snapshot().phase,"handoff");
  assert.equal(clock({budgetMs:0}).budget.snapshot().phase,"handoff");
  for(const budgetMs of ["600000",NaN,Infinity,-1,null]) {
    const c=clock({budgetMs});assert.equal(c.budget.snapshot().known,false);assert.throws(()=>c.budget.admission(),isTurnBudgetError);
  }
});
test("noncoding callers without explicit metadata stay unlimited",async()=>{
  const c=clock({defaultEnabled:false});let called=0;
  assert.equal(c.budget.snapshot().phase,"unlimited");
  assert.equal(await c.budget.run(({timeoutMs})=>{called++;assert.equal(timeoutMs,undefined);return 5;}),5);
  assert.equal(called,1);
});
test("monotonic clock regression or failure refuses new work without fabricated time",()=>{
  const c=clock();c.set(5);c.budget.snapshot();c.set(-1);
  const s=c.budget.snapshot();assert.equal(s.known,false);assert.equal(s.elapsedMs,null);assert.equal(s.remainingMs,null);
  assert.equal(s.phase,"handoff");
  assert.equal(clock({now:()=>{throw Error("clock");}}).budget.snapshot().known,false);
});
test("only genuine owned errors identify expiry; a provider's name cannot spoof it",()=>{
  assert(!isTurnBudgetError(Object.assign(Error("fake"),{name:"TurnBudgetError"})));
});
test("a completed normal call preserves its response and never changes model options",async()=>{
  const c=clock();const signal=new AbortController().signal;
  const reply=await c.budget.run(({signal:child,timeoutMs})=>{assert.notEqual(child,signal);assert.equal(timeoutMs,435000);return {tool_calls:[{id:"complete"}]};},{signal});
  assert.equal(reply.tool_calls[0].id,"complete");c.budget.dispose();
});
test("elapsed boundary rejects a late buffered response even before timer dispatch",async()=>{
  const c=clock();let ran=0;
  await assert.rejects(c.budget.run(()=>{c.set(435001);return {tool_calls:[{id:"must-not-dispatch"}]};}).then(()=>{ran++;}),isTurnBudgetError);
  assert.equal(ran,0);assert.equal(c.budget.snapshot().phase,"verification");
});
test("owned model cancellation bounds a signal-ignoring adapter without admitting its late reply",async()=>{
  const c={budget:createTurnBudget({budgetMs:20012})}; // work 9ms, verification 5003ms, handoff 15s
  let child,settled=false;
  await assert.rejects(c.budget.run(async({signal})=>{child=signal;await new Promise(r=>setTimeout(r,20));settled=true;return "late";}),isTurnBudgetError);
  assert(child.aborted);await new Promise(r=>setTimeout(r,25));assert(settled);c.budget.dispose();
});
test("external user Stop remains AbortError, distinct from owned phase expiry",async()=>{
  const c=clock(),stop=new AbortController();
  const call=c.budget.run(()=>new Promise(()=>{}),{signal:stop.signal});stop.abort();
  await assert.rejects(call,e=>e.name==="AbortError"&&!isTurnBudgetError(e));c.budget.dispose();
});
test("already-dispatched command settles cleanup before its receipt is returned",async()=>{
  const c={budget:createTurnBudget({budgetMs:20012})};let cleaned=false,observed;
  const value=await c.budget.run(async({signal})=>{await new Promise(resolve=>{signal.addEventListener("abort",()=>setTimeout(()=>{cleaned=true;resolve();},5),{once:true});});observed=signal.reason;return {ok:false};},{settle:true});
  assert(cleaned);assert(isTurnBudgetError(observed));assert.equal(value.ok,false);c.budget.dispose();
});
test("optional review cannot spend verification or short work reserves",()=>{
  const c=clock();assert(c.budget.optionalAvailable());c.set(400000);assert(!c.budget.optionalAvailable());c.set(440000);assert(!c.budget.optionalAvailable());
});
test("phase hints state priority, preserve authority and distinguish syntax from behavior",()=>{
  const c=clock();c.set(435000);const hint=turnBudgetHint(c.budget.snapshot());
  assert.match(hint,/phase=verification/);assert.match(hint,/not.*permissions/);assert.match(hint,/Do not invent or guess/);assert.match(hint,/not a behavioral test/);
  assert.equal(turnBudgetHint(clock({budgetMs:8000}).budget.snapshot()),"");
});


test("recognized verification uses its reserved window across work-end, without extra authority",async()=>{
  const c=clock();c.set(434999);
  const result=await c.budget.run(({timeoutMs})=>{assert.equal(timeoutMs,150001);c.set(435100);return "actual-check";},{verification:true});
  assert.equal(result,"actual-check");
  c.set(584999);
  await assert.rejects(c.budget.run(()=>{c.set(585001);return "too-late";},{verification:true}),isTurnBudgetError);
});


test("default endpoint eligibility uses explicit local routing or loopback, never remote model size",()=>{
  for (const url of ["http://127.0.0.1:8081/v1","https://localhost:1234/v1","http://[::1]:8081/v1"]) assert(localBudgetTargets([{url,local:false,model:"custom-27b"}]));
  assert(localBudgetTargets([{local:true,url:"https://user-owned-native.example/v1"}]));
  for(const targets of [[],null,[{local:false,url:"https://remote.example/v1",model:"small-3b"}],
    [{local:false,url:"http://127.0.0.1.evil.example/v1"}], [{url:"file://localhost/path"}],
    [{local:true},{local:false,url:"https://remote.example/v1"}], [{}]]) assert.equal(localBudgetTargets(targets),false,JSON.stringify(targets));
});
