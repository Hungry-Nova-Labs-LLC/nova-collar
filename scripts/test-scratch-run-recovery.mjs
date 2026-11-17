import assert from "node:assert/strict";
import {test} from "node:test";
import {scratchRunRecoveryTool,scratchRunRecoveryMatches,createDraftRecovery} from "../src/main/scratch-draft-budget.js";

const runner=()=>({type:"function",function:{name:"host_run",parameters:{type:"object",properties:{command:{type:"string"},cwd:{type:"string"},timeoutMs:{type:"integer",minimum:1,maximum:90000},paths:{type:"array",maxItems:50,items:{type:"string"}}},required:["command"]}}});
const call=(command="node check.cjs",extra={})=>({id:"run",function:{name:"host_run",arguments:JSON.stringify({command,...extra})}});
const guard=name=>Object.assign(new Error("Synthetic interrupted response"),{name});

test("only the current built-in runner in ordinary tool mode can be selected",()=>{
  const tool=runner();assert.equal(scratchRunRecoveryTool([tool],"required"),tool);
  assert.equal(scratchRunRecoveryTool([tool],"auto"),tool);
  for(const choice of ["none",{type:"function",function:{name:"host_file_write"}},{type:"function",function:{name:"host_run"}}])assert.equal(scratchRunRecoveryTool([tool],choice),null);
  assert.equal(scratchRunRecoveryTool([],"auto"),null);assert.equal(scratchRunRecoveryTool([tool,tool],"auto"),null);
  for(const mutate of [s=>{s.properties.command.enum=["other command"];},s=>{s.properties.command.pattern=".*";},s=>{s.required.push("approval");},s=>{s.properties.cwd.const="/outside";},s=>{s.properties.timeoutMs.maximum=600000;},s=>{s.properties.paths.items.pattern=".*";},s=>{s.additionalProperties=false;},s=>{s.allOf=[];}]){
    const custom=runner();mutate(custom.function.parameters);assert.equal(scratchRunRecoveryTool([custom],"auto"),null);
  }
  const lean=runner();lean.function.parameters.properties.timeoutMs={type:"integer"};lean.function.parameters.properties.paths={type:"array"};assert.equal(scratchRunRecoveryTool([lean],"auto"),lean);
});

test("one named runner response still needs one valid call in the current workspace",()=>{
  const choice={cwd:"/workspace"};assert.equal(scratchRunRecoveryMatches(choice,[call()],"/workspace"),true);
  assert.equal(scratchRunRecoveryMatches(choice,[call("node check.cjs",{cwd:"."})],"/workspace"),true);
  for(const calls of [[],[call(),call()], [{function:{name:"host_file_write",arguments:'{}'}}], [call("   ")], [call("node check.cjs",{cwd:"/outside"})], [call("node check.cjs",{timeoutMs:90001})], [call("node check.cjs",{extra:"unknown"})]])assert.equal(scratchRunRecoveryMatches(choice,calls,"/workspace"),false);
  assert.equal(scratchRunRecoveryMatches(choice,[call()],"/changed"),false);
});

test("the first scratch overflow spends the existing one recovery on a named runner without changing8192",async()=>{
  let count=0;const tool=runner(),messages=[{role:"tool",content:"completed receipt"}],original={tools:[tool,{type:"function",function:{name:"host_file_read"}}],toolChoice:"required",predict:8192,scratchDraftPolicy:{enabled:true},scratchRunRecovery:{tool,cwd:"/workspace"}};
  const recovery=createDraftRecovery({checkAbort:()=>{},context:()=>"existing debt",request:async(_lane,list,_delta,opts)=>{
    count++;assert.equal(opts.predict,8192);
    if(count===1)throw guard("ScratchDraftBudgetError");
    assert.equal(opts.noLaneFallback,true);assert.equal(opts.tools,original.tools,"the same ordered original catalog retains its prefix");assert.deepEqual(opts.toolChoice,{type:"function",function:{name:"host_run"}});assert.equal(opts.scratchDraftPolicy,undefined);
    assert(list.at(-1).content.includes("no command has been supplied or executed"));
    return {content:"",tool_calls:[call()]};
  }});
  const result=await recovery.run("selected",messages,()=>{},original);assert.equal(count,2);assert.deepEqual(result.scratch_run_recovery,{cwd:"/workspace"});assert.equal(recovery.recoveryCount,1);assert.equal(original.toolChoice,"required");
});

test("unavailable runner keeps the original conservative retry and ThoughtLoop shares the same quota",async()=>{
  let count=0;const options={toolChoice:"required",predict:8192};
  const recovery=createDraftRecovery({checkAbort:()=>{},request:async(_lane,_list,_delta,opts)=>{count++;assert.equal(opts.predict,8192);assert.equal(opts.toolChoice,"required");throw guard(count===1?"ThoughtLoop":"ScratchDraftBudgetError");}});
  assert.equal(await recovery.run("selected",[],()=>{},options),null);assert.equal(count,2);assert.equal(recovery.recoveryCount,1);
});
