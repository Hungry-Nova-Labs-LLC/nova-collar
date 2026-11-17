import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
const hash = text => createHash("sha256").update(text).digest("hex");
import { createAuthoredCheckAwareness } from "../src/main/authored-checks.js";
const source = 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\nconsole.log("CHECK_RAN");\n';
const syntax = {ok:true,verification:{phase:"syntax",status:"passed"}};
function fixture() {
  const files=new Map();let rows=[];
  const observer=createAuthoredCheckAwareness({cwd:"/workspace",read:path=>files.get(path),sourceState:()=>rows === null ? null : [...files].map(([path,text])=>({kind:"file",path,hash:hash(text)})).concat(rows)});
  const write=(path,text,sourceRevision=1)=>{files.set(path,text);observer.observe({name:"host_file_write",result:{ok:true,path},proof:syntax,sourceRevision});};
  const begin=()=>observer.beforeExecution("host_run",{command:"node check.mjs"});
  const finish=(execution,result={ok:true,exitCode:0},sourceRevision=1)=>observer.observe({name:"host_run",result,execution,sourceRevision});
  write("/workspace/check.mjs",source);
  return {files,observer,write,begin,finish,setRows:value=>{rows=value;}};
}

test("project artifact revision drift retains historical success but current input coverage stays unknown",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution,{ok:true,exitCode:0},2);
  const row=f.observer.pending()[0];assert.equal(row.state,"input_coverage_changed_or_unknown");assert.equal(row.blocking,false);
  assert.equal(row.lastExecution.status,"passed");assert.equal(row.lastExecution.hash,execution.hash);assert(Object.isFrozen(row.lastExecution));
  assert.match(f.observer.context(),/historical direct execution passed/);assert.match(f.observer.context(),/current behavioral verification is not established/);
  assert(!f.observer.context().includes("source_changed_during_execution"));
  assert.equal(f.observer.takeReminder(),"");assert.match(f.observer.handoffContext(),/coverage changed or is unknown/);
});

test("genuine helper byte changes during execution remain stale while preserving the observed command result",()=>{
  const f=fixture(),execution=f.begin();f.files.set("/workspace/check.mjs",source+"// changed during the command\n");f.finish(execution);
  assert.equal(f.observer.pending()[0].state,"source_changed_during_execution");assert.equal(f.observer.pending()[0].lastExecution.status,"passed");
  assert.match(f.observer.context(),/not establish current input coverage/);
});

test("unknown new code or config changes during execution never receive current pass credit",()=>{
  for(const change of ["new dependency source","package/profile configuration","omitted input coverage"]) {
    const f=fixture(),execution=f.begin();f.finish(execution,{ok:true,exitCode:0},2);
    assert.equal(f.observer.pending()[0].state,"input_coverage_changed_or_unknown",change);
    assert.equal(f.observer.pending().length,1);assert.equal(f.observer.pending()[0].blocking,false);
  }
});

test("later source or config revisions preserve the old receipt without claiming it covers current inputs",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution);assert.equal(f.observer.pending().length,0);
  f.observer.observe({name:"host_run",result:{ok:true},sourceRevision:2});
  assert.equal(f.observer.pending()[0].lastExecution.status,"passed");assert.match(f.observer.context(),/earlier execution predates later source edits/);
});

test("a later helper edit retains the old hashed receipt but the new helper has not executed",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution);
  f.write("/workspace/check.mjs",source+"assert.equal(3,3);\n",2);
  const row=f.observer.pending()[0];assert.equal(row.state,"not_executed");assert.equal(row.lastExecution.hash,execution.hash);assert.notEqual(row.hash,row.lastExecution.hash);
});

test("later auxiliary cleanup cannot relabel the recorded run as an in-flight mutation",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution);
  f.files.delete("/workspace/check.mjs");f.observer.observe({name:"host_run",result:{ok:true},sourceRevision:2});
  const row=f.observer.pending()[0];assert.equal(row.lastExecution.status,"passed");assert.equal(row.lastExecution.hash,execution.hash);
  assert(!f.observer.context().includes("source_changed_during_execution"));assert.match(f.observer.context(),/earlier execution/);
});

test("failed unavailable killed and nonzero receipts remain nonpassing even with a stable helper",()=>{
  for(const [result,status] of [[{ok:false,exitCode:1},"failed_or_unconfirmed"],[{ok:true,exitCode:1},"failed_or_unconfirmed"],[{ok:true,killed:true},"failed_or_unconfirmed"],[{ok:true,noTests:true},"unavailable"],[{ok:false,held:true},"unavailable"]]){
    const f=fixture(),execution=f.begin();f.finish(execution,result,2);
    assert.equal(f.observer.pending()[0].lastExecution.status,status);assert.notEqual(f.observer.pending()[0].state,"passed");
  }
});


test("a known code/input hash changing during execution keeps the existing repair reminder",()=>{
  const f=fixture();f.setRows([{kind:"file",path:"/workspace/library.mjs",hash:hash("before")}]);const execution=f.begin();
  f.setRows([{kind:"file",path:"/workspace/library.mjs",hash:hash("after")}]);f.finish(execution,{ok:true,exitCode:0},2);
  assert.equal(f.observer.pending()[0].state,"source_changed_during_execution");assert.match(f.observer.takeReminder(),/source_changed_during_execution/);assert.equal(f.observer.handoffContext(),"");
});

test("later known input changes and unavailable cached witnesses cannot skip the existing reminder",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution,{ok:true,exitCode:0},2);f.setRows([{kind:"file",path:"/workspace/package.json",hash:hash("changed")}]);
  assert.match(f.observer.takeReminder(),/earlier execution predates later source edits/);assert.equal(f.observer.handoffContext(),"");
  const g=fixture();g.setRows(null);const run=g.begin();g.finish(run,{ok:true,exitCode:0},2);assert.match(g.observer.takeReminder(),/input coverage/);assert.equal(g.observer.handoffContext(),"");
});

test("a newer automatic direct proof replaces an older failed historical execution label",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution,{ok:false,exitCode:1});
  f.files.set("/workspace/check.mjs",source+"// corrected\n");
  f.observer.observe({name:"host_file_write",result:{ok:true,path:"/workspace/check.mjs"},proof:{ok:true,verification:{phase:"test",command:"node --test /workspace/check.mjs"}},sourceRevision:2});
  f.observer.observe({name:"host_run",result:{ok:true},sourceRevision:3});
  assert.equal(f.observer.pending()[0].lastExecution.status,"passed");assert(!f.observer.context().includes("historical direct execution failed"));
});


test("coverage-only uncertainty still invokes the existing one-time reminder for a blanket pass claim",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution,{ok:true,exitCode:0},2);
  assert.match(f.observer.takeReminder("PASS. All tests passed."),/input coverage changed or is unknown/);
  assert.equal(f.observer.takeReminder("PASS. All tests passed."),"");
});


test("later shell edits of the helper and malformed cached hashes cannot suppress a reminder",()=>{
  const f=fixture(),execution=f.begin();f.finish(execution,{ok:true,exitCode:0},2);
  f.files.set("/workspace/check.mjs",source+"// shell edit after execution\n");f.observer.observe({name:"host_run",result:{ok:true},sourceRevision:3});
  assert.equal(f.observer.handoffContext(),"");assert.match(f.observer.takeReminder(),/input coverage|earlier execution/);
  const g=fixture();g.setRows([{kind:"file",path:"/workspace/unknown.mjs",hash:"not-a-valid-hash"}]);const run=g.begin();g.finish(run,{ok:true,exitCode:0},2);
  assert.equal(g.observer.handoffContext(),"");assert.match(g.observer.takeReminder(),/input coverage/);
});
