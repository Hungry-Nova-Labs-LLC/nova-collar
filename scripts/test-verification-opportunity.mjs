import assert from "node:assert/strict";
import {test} from "node:test";
import {createVerificationOpportunity,VERIFICATION_OPPORTUNITY_ROUNDS,MIN_VERIFICATION_OPPORTUNITY_MS} from "../src/main/verification-opportunity.js";
const cwd="/authorized/project";
const tool={type:"function",function:{name:"host_run",parameters:{type:"object",properties:{command:{type:"string"},cwd:{type:"string"},timeoutMs:{type:"integer",minimum:1,maximum:90000},paths:{type:"array",maxItems:50,items:{type:"string"}}},required:["command"]}}};
const clock={enabled:true,known:true,phase:"work",remainingMs:600000,handoffMs:15000};
const state=extra=>({round:12,limit:12,cwd,local:true,editTask:true,suspended:false,busy:false,signal:new AbortController().signal,permittedNames:new Set(["host_run"]),offered:[tool],clock,observations:()=>({requestedSourceProgress:true,modelRunAttempted:false,actionDebt:[]}),...extra});

test("a distinct once-only two-round grant retains the exact offered schema and gives no proof or command",()=>{
  const policy=createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."});const grant=policy.choose(state());
  assert.equal(VERIFICATION_OPPORTUNITY_ROUNDS,2);assert.equal(MIN_VERIFICATION_OPPORTUNITY_MS,30000);
  assert.deepEqual(grant,{tool,cwd,limitBefore:12,limitAfter:14});assert.equal(grant.tool,tool);assert(Object.isFrozen(grant));
  assert.equal(policy.used,true);assert.equal(policy.choose(state()),null);assert.equal(policy.current(grant,state()),true);
  for(const key of ["command","passed","revision","proof"])assert(!Object.hasOwn(grant,key));
  policy.finish(grant);assert.equal(policy.current(grant,state()),false);assert.equal(policy.choose(state()),null);
});

test("unknown role/stage/capability/clock/bounds never inspect lazy source observations",()=>{
  const invalid=[{local:false},{local:"yes"},{editTask:false},{editTask:1},{suspended:true},{suspended:undefined},{busy:true},{busy:undefined},
    {cwd:"/other"},{permittedNames:new Set()},{permittedNames:["host_run"]},{offered:[]},{offered:[tool,tool]},{toolChoice:"none"},{toolChoice:{type:"function",function:{name:"host_run"}}},{toolChoice:"unknown"},
    {offered:[{...tool,function:{...tool.function,parameters:{type:"object",properties:{command:{type:"string"}},required:["other"]}}}]},
    {clock:{...clock,known:false}},{clock:{...clock,enabled:false}},{clock:{...clock,phase:"handoff"}},
    {clock:{...clock,remainingMs:44999}},{clock:{...clock,remainingMs:NaN}},{clock:{...clock,handoffMs:-1}},
    {round:11},{round:13},{limit:59,round:59},{limit:0,round:0},{limit:12.5,round:12.5},{signal:AbortSignal.abort()}];
  for(const extra of invalid){let reads=0;const policy=createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."});assert.equal(policy.choose(state({observations:()=>{reads++;throw Error("must not inspect");},...extra})),null,JSON.stringify(extra));assert.equal(reads,0);assert.equal(policy.used,false);}
});

test("only current requested byte progress, no action debt and no completed model run qualify",()=>{
  for(const observed of [{requestedSourceProgress:false,modelRunAttempted:false,actionDebt:[]},
    {requestedSourceProgress:true,modelRunAttempted:true,actionDebt:[]},
    {requestedSourceProgress:true,modelRunAttempted:undefined,actionDebt:[]},
    {requestedSourceProgress:true,modelRunAttempted:false,actionDebt:["write still owed"]},
    {requestedSourceProgress:true,modelRunAttempted:false,actionDebt:null}])assert.equal(createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."}).choose(state({observations:observed})),null);
  assert.equal(createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."}).choose(state({observations:()=>{throw Error("unknown");}})),null);
});

test("30 seconds is an admission bound; an admitted response can complete before handoff without another 30 seconds",()=>{
  const policy=createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."});const grant=policy.choose(state({clock:{...clock,remainingMs:45000}}));assert(grant);
  assert.equal(policy.current(grant,state({clock:{...clock,phase:"verification",remainingMs:16000}})),true);
  assert.equal(policy.current(grant,state({clock:{...clock,phase:"handoff",remainingMs:15000}})),false);
  assert.equal(createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."}).choose(state({limit:58,round:58})).limitAfter,60);
});

test("human invalidation/current source reversal/command/cwd/schema/Stop drift cannot retain a pending choice",()=>{
  for(const extra of [{cwd:"/different"},{local:false},{editTask:false},{suspended:true},{busy:true},{permittedNames:new Set()},
    {offered:[structuredClone(tool)]},{signal:AbortSignal.abort()},
    {observations:{requestedSourceProgress:false,modelRunAttempted:false,actionDebt:[]}},
    {observations:{requestedSourceProgress:true,modelRunAttempted:true,actionDebt:[]}}]){
    const policy=createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."});const choice=policy.choose(state());assert.equal(policy.current(choice,state(extra)),false);
  }
  const policy=createVerificationOpportunity({cwd,ask:"Fix src/a.mjs and verify locally."});const choice=policy.choose(state());policy.disable();assert.equal(policy.current(choice,state()),false);assert.equal(policy.choose(state()),null);
});


test("explicit no-execution instructions veto only the optional allowance before lazy observation",()=>{
  for(const ask of ["Fix src/a.mjs; do not run commands.","Fix src/a.mjs; do not run any tests.","Fix src/a.mjs without executing programs.","Fix src/a.mjs. Never use host_run.","Fix src/a.mjs. No runtime checks.","Fix src/a.mjs; don't test it.",null]){
    let reads=0;const policy=createVerificationOpportunity({cwd,ask});assert.equal(policy.choose(state({observations:()=>{reads++;throw Error("not allowed");}})),null);assert.equal(reads,0);
  }
  assert(createVerificationOpportunity({cwd,ask:"Do not inspect hidden private material. Fix src/a.mjs and verify locally."}).choose(state()));
});
