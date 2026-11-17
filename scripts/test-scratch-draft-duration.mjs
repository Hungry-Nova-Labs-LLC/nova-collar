import assert from "node:assert/strict";
import {test} from "node:test";
import {enforceScratchDraftBudget,scratchDraftPolicy} from "../src/main/scratch-draft-budget.js";
const cwd="/workspace",helper='import assert from "node:assert/strict";\nassert.equal(1,1);\n'+"// bounded helper source\n".repeat(65);
const calls=(path="_check.mjs",content=helper,complete=false)=>new Map([[0,{function:{name:"host_file_write",arguments:complete?JSON.stringify({path,content}):JSON.stringify({path,content}).slice(0,-2)}}]]);
const policy=ask=>scratchDraftPolicy(ask||"Fix src/feature.mjs and verify existing behavior.",cwd);
const ctx=(extra={})=>({pathState:()=>false,sourceClocks:new Map(),now:()=>1000,...extra});

test("duration budget counts only eligible incomplete source drafting after1024 source characters",()=>{
  const pending=calls(),context=ctx();enforceScratchDraftBudget(pending,policy(),context);context.now=()=>46000;let error;try{enforceScratchDraftBudget(pending,policy(),context);}catch(e){error=e;}
  assert.equal(error?.name,"ScratchDraftBudgetError");assert.equal(pending.size,0);assert.equal(error.scratchDraft.reason,"duration");
  assert.equal(error.scratchDraft.elapsedSinceFirstEligibleSourceFrameMs,45000);assert.equal(error.scratchDraft.responseElapsedSinceFirstTokenMs,undefined);assert.equal(error.scratchDraft.limitMs,45000);assert.equal(error.scratchDraft.minSourceChars,1024);
  assert(error.scratchDraft.observedChars>=1024&&error.scratchDraft.observedChars<4096);assert.match(error.message,/first eligible source frame/);
});

test("fast helpers and tiny helpers after long reasoning retain their ordinary argument budget",()=>{
  const fast=calls();enforceScratchDraftBudget(fast,policy(),ctx({now:()=>45999}));assert.equal(fast.size,1);
  const tiny=calls("_check.mjs",'import assert from "node:assert/strict";\nassert.equal(1,1);\n');enforceScratchDraftBudget(tiny,policy(),ctx({now:()=>600000}));assert.equal(tiny.size,1);
  const ordinary=calls("implementation.mjs",'export const value="'+"x".repeat(1500)+'";');enforceScratchDraftBudget(ordinary,policy(),ctx());assert.equal(ordinary.size,1);
});

test("unknown or invalid clocks disable only duration;4096-character limit remains authoritative",()=>{
  for(const extra of [{sourceClocks:null},{sourceClocks:undefined},{now:()=>NaN},{now:()=>-1},{now:()=>{throw Error("unknown clock");}}]){
    const pending=calls();enforceScratchDraftBudget(pending,policy(),ctx(extra));assert.equal(pending.size,1);
  }
  const pending=calls("_check.mjs",helper+"// padding\n".repeat(500));let error;try{enforceScratchDraftBudget(pending,policy(),ctx({sourceClocks:null}));}catch(e){error=e;}
  assert.equal(error?.scratchDraft.reason,"characters");assert.equal(error?.scratchDraft.limitChars,4096);assert.equal(error?.scratchDraft.elapsedSinceFirstEligibleSourceFrameMs,undefined);assert.equal(pending.size,0);
});

test("requested production/test files, existing paths and unknown metadata never receive the optional duration bound",()=>{
  for(const [path,p,extra]of [["src/feature.mjs",policy(),{}],["_check.mjs",policy("Write comprehensive tests for src/feature.mjs."),{}],["_check.mjs",policy(),{pathState:()=>true}],["_check.mjs",policy(),{pathState:()=>undefined}]]){
    const pending=calls(path);enforceScratchDraftBudget(pending,p,ctx(extra));assert.equal(pending.size,1);
  }
  for(const path of ["../outside.mjs","_secret.mjs"]){let probes=0;const pending=calls(path);enforceScratchDraftBudget(pending,policy(),ctx({denyPath:p=>p.endsWith("_secret.mjs"),pathState:()=>{probes++;return false;}}));assert.equal(probes,0);assert.equal(pending.size,1);}
});

test("ambiguous partial argument metadata is not promoted into a duration decision",()=>{
  const pending=new Map([[0,{function:{name:"host_file_write",arguments:'{"content":"incomplete source before its target'}}]]);
  enforceScratchDraftBudget(pending,policy(),ctx());assert.equal(pending.size,1);
});


test("duration never discards completed requested work or a multi-helper batch; character overflow still clears the whole batch",()=>{
  const pending=calls("src/feature.mjs",'export const value=2;\n',true);pending.set(1,calls().get(0));
  enforceScratchDraftBudget(pending,policy(),ctx({now:()=>600000}));assert.equal(pending.size,2);assert.equal(JSON.parse(pending.get(0).function.arguments).content,'export const value=2;\n');
  const helpers=calls();helpers.set(1,calls("_another.mjs").get(0));enforceScratchDraftBudget(helpers,policy(),ctx({now:()=>600000}));assert.equal(helpers.size,2);
  pending.set(1,calls("_check.mjs",helper+"// padding\n".repeat(500)).get(0));let error;try{enforceScratchDraftBudget(pending,policy(),ctx({now:()=>600000}));}catch(e){error=e;}
  assert.equal(error?.scratchDraft.reason,"characters");assert.equal(pending.size,0,"existing character overflow still discards every pending call");
});
