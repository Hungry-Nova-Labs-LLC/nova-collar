import assert from "node:assert/strict";
import {test,after} from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const root=mkdtempSync(join(tmpdir(),"collar-turn-budget-"));
process.env.NOVAPUP_HOME=join(root,"profile");mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Live inference/network forbidden");};
const {runTurn}=await import("../src/main/agent.js");
const {createSession}=await import("../src/main/sessions.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {ensureHome}=await import("../src/main/config.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
after(()=>{globalThis.fetch=savedFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const defs=windowToolDefs({local:true,search:false,remote:false}).filter(t=>["host_file_read","host_file_write","host_run"].includes(t.function.name));
const call=(name,args,id="a")=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const reply=(content="",tool_calls=[])=>({content,tool_calls});
function project(name){const dir=join(root,name);mkdirSync(dir);writeFileSync(join(dir,"package.json"),'{"type":"module"}');setWorkdir(dir);return dir;}
const options=()=>({sessionId:createSession().id,tools:defs,sourcePreload:false});

test("eight seconds before trusted hard deadline admits no request or action and returns honest Incomplete",async()=>{
  const dir=project("late"),events=[];let requests=0;
  const result=await runTurn([],"Implement new.mjs and verify behavior.",e=>events.push(e),null,{...options(),deadlineAt:Date.now()+8000,complete:async()=>{requests++;return reply("PASS");}});
  assert.equal(requests,0);assert(!existsSync(join(dir,"new.mjs")));
  assert.match(result.assistant,/Incomplete/);assert.match(result.assistant,/No further model or command/);
  assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});

test("real saved source and assertion execution within budget permit supported handoff without optional reviewer",async()=>{
  const dir=project("actual-check"),path=join(dir,"lib.mjs"),events=[];
  writeFileSync(path,'export const value=3;\n');
  writeFileSync(join(dir,"check.mjs"),'import assert from "node:assert/strict"; import {value} from "./lib.mjs"; assert.equal(value,4); console.log("REAL_ASSERTION_PASSED");\n');
  let normal=0,reviews=0;
  const result=await runTurn([],"Implement lib.mjs by setting exported value to 4. Run node check.mjs to verify it.",e=>events.push(e),null,{...options(),budgetMs:25000,complete:async (_messages,_cfg,_delta,_signal,opts)=>{
    if(opts.requestKind==="contract_review"){reviews++;return reply('{"findings":[],"limitations":[]}');}
    normal++;
    if(normal===1)return reply("",[call("host_file_read",{path})]);
    if(normal===2)return reply("",[call("host_file_write",{path,content:'export const value=4;\n'})]);
    if(normal===3)return reply("",[call("host_run",{command:"node check.mjs",cwd:dir})]);
    return reply("Saved lib.mjs and ran node check.mjs successfully: REAL_ASSERTION_PASSED. No project suite was declared.");
  }});
  assert.equal(reviews,0);assert.equal(normal,4,JSON.stringify(result));
  assert.equal(readFileSync(path,"utf8"),'export const value=4;\n');
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok&&/REAL_ASSERTION_PASSED/.test(e.detail)));
  assert.match(result.assistant,/REAL_ASSERTION_PASSED/);assert(!/^FAIL/.test(result.assistant));
});

test("hard handoff cancellation discards the complete pending batch without replaying primary generation",async()=>{
  const dir=project("cancel-buffer"),destination=join(dir,"new.mjs"),events=[],catalogs=[];let requests=0;
  const result=await runTurn([],"Implement new.mjs and verify behavior.",e=>events.push(e),null,{...options(),budgetMs:21000,complete:async (messages,_cfg,_delta,signal,opts)=>{
    requests++;catalogs.push((opts.tools||[]).map(t=>t.function.name));
    if(requests===1){await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true}));return reply("",[call("host_file_write",{path:destination,content:"NEVER_DISPATCH\n"})]);}
    assert.fail("The hard handoff must not start another primary request.");
  }});
  assert(!existsSync(destination));assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_write"));
  assert(events.some(e=>e.type==="turn_budget"&&e.phase==="work"));assert.equal(requests,1);
  assert.equal(catalogs.length,1);assert.match(result.assistant,/Incomplete/);assert(!/^PASS/.test(result.assistant));
});

test("external Stop aborts pending inference immediately and never starts recovery or closeout",async()=>{
  project("stop");const stop=new AbortController();let requests=0;
  const started=performance.now();
  const promise=runTurn([],"Implement new.mjs.",()=>{},stop.signal,{...options(),budgetMs:600000,complete:async (_messages,_cfg,_delta,signal)=>{
    requests++;setTimeout(()=>stop.abort(),5);return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
  }});
  await assert.rejects(promise,e=>e.name==="AbortError");assert.equal(requests,1);assert(performance.now()-started<1000);
});

test("short explicit budget retains review-only scope and never auto-guesses or executes a check",async()=>{
  const dir=project("review-scope"),path=join(dir,"lib.mjs"),events=[];writeFileSync(path,'export const value=3;\n');
  let requests=0;
  await runTurn([],"Review only. Inspect lib.mjs. Do not run any programs.",e=>events.push(e),null,{...options(),budgetMs:25000,complete:async()=>{
    requests++;if(requests===1)return reply("",[call("host_file_write",{path,content:'export const value=4;\n'})]);
    return reply("No source change or execution was performed. This is a review only.");
  }});
  assert.equal(readFileSync(path,"utf8"),'export const value=3;\n');
  assert(!events.some(e=>e.type==="tool_result"&&e.name==="host_run"));
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_file_write"&&!e.ok));
});

test("successful async advisory settles before checkpoint finish on normal handoff",async()=>{
  const dir=project("async-close"),events=[];let normal=0,reviewed=false,checkpointBeforeReview=false;
  const result=await runTurn([],"Implement fresh.mjs exporting value 4.",event=>{events.push(event);if(event.type==="checkpoint"&&!reviewed)checkpointBeforeReview=true;},null,{...options(),budgetMs:600000,complete:async (_messages,_cfg,_delta,_signal,opts)=>{
    if(opts.requestKind==="contract_review"){await new Promise(resolve=>setTimeout(resolve,20));reviewed=true;return reply('{"findings":[],"limitations":[]}');}
    normal++;if(normal===1)return reply("",[call("host_file_write",{path:join(dir,"fresh.mjs"),content:'export const value=4;\n'})]);
    return reply("Saved fresh.mjs. Its syntax check passed; full behavior was not tested.");
  }});
  assert(reviewed);assert(!checkpointBeforeReview);assert(result.advisoryReview?.status==="completed");
});

test("declared project verification crosses work-end using the reserved window without a cached false failure",async()=>{
  const dir=project("project-reserve"),events=[];let normal=0;
  writeFileSync(join(dir,"package.json"),JSON.stringify({type:"module",scripts:{test:"node check.cjs"}}));
  writeFileSync(join(dir,"check.cjs"),'const assert=require("node:assert/strict"),fs=require("node:fs");assert.equal(fs.readFileSync("feature.mjs","utf8"),"export const value=4;\\n");setTimeout(()=>console.log("DECLARED_PROJECT_PASSED"),1200);\n');
  const result=await runTurn([],"Implement feature.mjs exporting value 4.",e=>events.push(e),null,{...options(),budgetMs:21000,complete:async (_messages,_cfg,_delta,_signal,opts)=>{
    assert.notEqual(opts.requestKind,"contract_review");normal++;
    if(normal===1)return reply("",[call("host_file_write",{path:join(dir,"feature.mjs"),content:'export const value=4;\n'})]);
    return reply("Saved feature.mjs. The declared project check passed: DECLARED_PROJECT_PASSED.");
  }});
  const proofs=events.filter(e=>e.type==="tool_result"&&e.name==="harness"&&e.verification?.phase==="project");
  assert(proofs.some(e=>e.ok&&e.verification.status==="passed"&&/DECLARED_PROJECT_PASSED/.test(e.detail)),JSON.stringify(proofs));
  assert(!proofs.some(e=>e.verification.status==="failed"));assert.equal(normal,2);assert.match(result.assistant,/DECLARED_PROJECT_PASSED/);
});

test("default local implementation clock is ten minutes while ordinary chat has no default",async()=>{
  const dir=project("default-scope"),events=[];let normal=0;
  await runTurn([],"Implement fresh.mjs exporting value 4.",e=>events.push(e),null,{...options(),complete:async (_messages,_cfg,_delta,_signal,opts)=>{
    if(opts.requestKind==="contract_review")return reply('{"findings":[],"limitations":[]}');normal++;
    if(normal===1)return reply("",[call("host_file_write",{path:join(dir,"fresh.mjs"),content:'export const value=4;\n'})]);
    return reply("Saved fresh.mjs; syntax passed but behavior was not tested.");
  }});
  assert(events.some(e=>e.type==="turn_budget"&&e.totalMs===600000&&e.workMs===435000));
  const chat=[];
  await runTurn([],"What is two plus two?",e=>chat.push(e),null,{tools:[],complete:async()=>reply("Four.")});
  assert(!chat.some(e=>e.type==="turn_budget"));
});
