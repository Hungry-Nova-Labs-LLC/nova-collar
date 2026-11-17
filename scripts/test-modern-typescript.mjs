import assert from "node:assert/strict";
import {after,test} from "node:test";
import {spawnSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {authoredAssertionSource,createAuthoredCheckAwareness,verificationReceiptLabel} from "../src/main/authored-checks.js";
import {enforceScratchDraftBudget,scratchDraftPolicy} from "../src/main/scratch-draft-budget.js";
import {sourceScopePlan} from "../src/main/source-preload.js";
import {createExistingEditBridge} from "../src/main/existing-edit-recovery.js";

const root=mkdtempSync(join(tmpdir(),"collar-modern-ts-"));
process.env.NOVAPUP_HOME=join(root,"profile");mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Live inference/network forbidden");};
const {CODE,verifyPath,runCommand,probePath}=await import("../src/main/harness-check.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {runTurn}=await import("../src/main/agent.js");
const {createSession}=await import("../src/main/sessions.js");
const {ensureHome}=await import("../src/main/config.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
after(()=>{globalThis.fetch=savedFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const code=ext=>ext==="cts"?'const assert = require("node:assert/strict");\nassert.equal(2 + 2, 4);\nconsole.log("ASSERTIONS_RAN");\n':'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\nconsole.log("ASSERTIONS_RAN");\n';
const call=(name,args,id="one")=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const reply=(content="",tool_calls=[])=>({content,tool_calls});
const exec=async(command,{cwd}={})=>{
  const shell=process.platform==="win32"?"powershell.exe":"/bin/sh";
  const args=process.platform==="win32"?["-NoProfile","-NonInteractive","-Command",command]:["-c",command];
  const r=spawnSync(shell,args,{cwd:cwd||root,encoding:"utf8",timeout:15000});
  return {ok:r.status===0,exitCode:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message};
};
const syntax={ok:true,verification:{phase:"syntax",status:"passed"}};
function observationFixture(){
  const files=new Map(),o=createAuthoredCheckAwareness({cwd:root,read:p=>files.get(p)});
  const write=(file,text)=>{const path=join(root,file);files.set(path,text);return o.observe({name:"host_file_write",result:{ok:true,path},proof:syntax});};
  const run=(file,result)=>{const execution=o.beforeExecution("host_run",{command:`node ${file}`});assert(execution);o.observe({name:"host_run",result,execution});};
  return {files,o,write,run};
}
for(const ext of ["mts","cts"]){
  test(`${ext}: assertion source is advisory, real execution and later edits remain revision-aware`,()=>{
    const f=observationFixture();assert.equal(authoredAssertionSource(`arbitrary.${ext}`,code(ext)),true);
    assert.equal(authoredAssertionSource(`verify.${ext}`,"const value: number = 2;"),false);
    const library=ext==="cts"?'const assert=require("node:assert"); module.exports=function(x){assert(x);}':'import assert from "node:assert"; export function value(x:number){assert(x);}';
    assert.equal(authoredAssertionSource(`library.${ext}`,library),false);
    assert.match(f.write(`check.${ext}`,code(ext)),/does not establish.*assertions ran/);
    assert.equal(f.o.pending()[0].blocking,false);assert.match(f.o.takeReminder(),/not_executed/);assert.equal(f.o.takeReminder(),"");
    f.run(`check.${ext}`,{ok:false,exitCode:1});assert.equal(f.o.pending()[0].state,"failed_or_unconfirmed");
    f.run(`check.${ext}`,{ok:true,unavailable:true,skipped:true});assert.equal(f.o.pending()[0].state,"unavailable");
    f.run(`check.${ext}`,{ok:true,exitCode:0});assert.equal(f.o.pending().length,0);
    f.write(`other.${ext}`,"const value = 5;\n");assert.match(f.o.context(),/earlier execution predates later source edits/);
    assert.equal(f.o.beforeExecution("host_run",{command:`cat check.${ext}`}),null);
  });
  test(`${ext}: syntax checks parse typed code without executing any side effects or claiming typecheck`,async()=>{
    const file=join(root,`syntax.${ext}`),sentinel=join(root,`executed-${ext}`);
    const prefix=ext==="cts"?'const fs = require("node:fs");':'import fs from "node:fs";';
    writeFileSync(file,`${prefix}\nconst value: number = "outside syntax coverage";\nfs.writeFileSync(${JSON.stringify(sentinel)}, "ran");\nthrow Error("must not execute");\n`);
    assert(CODE.has(`.${ext}`));assert.equal(runCommand(file),null,"never infer a standalone runner");
    const parsed=await verifyPath(file,{exec});assert(parsed,"recognized modern TypeScript has a syntax plan");
    if(parsed.unavailable){assert.equal(parsed.ok,false);assert.equal(parsed.skipped,true);return;}
    assert.equal(parsed.ok,true,parsed.error);assert.equal(parsed.syntaxOnly,true);assert.equal(existsSync(sentinel),false);
    assert.match(verificationReceiptLabel({ok:true,verification:{phase:"syntax"}}),/not executed/);
    writeFileSync(file,"const value: number = ;\n");assert.equal((await verifyPath(file,{exec})).ok,false);
    writeFileSync(file,"enum NeedsTransform { One, Two }\n");const transformed=await verifyPath(file,{exec});assert.equal(transformed.ok,false);assert.equal(transformed.unavailable,true);
  });
  test(`${ext}: missing strip API and unsupported native runtime stay unavailable`,async()=>{
    const file=join(root,`unsupported.${ext}`);
    const noStrip=await verifyPath(file,{exec:async()=>({ok:false,stderr:"NOVA_TS_UNAVAILABLE: native TypeScript syntax stripping is unavailable"})});
    assert(noStrip,"recognized modern TypeScript has an unavailable syntax receipt");assert.equal(noStrip.ok,false);assert.equal(noStrip.skipped,true);
    const noRuntime=await probePath(file,"",{api:{symbol:"helper"},exec:async()=>({ok:false,stderr:"ERR_UNKNOWN_FILE_EXTENSION"})});
    assert.equal(noRuntime.ok,false);assert.equal(noRuntime.unavailable,true);
  });
  test(`${ext}: requested large sources and basename aliases stay exempt from scratch limits`,()=>{
    const content=code(ext)+"// ordinary padding\n".repeat(300);
    const pending=path=>new Map([[0,call("host_file_write",{path,content})]]);
    for(const path of [`src/verify.${ext}`,`alias/verify.${ext}`]){
      const calls=pending(path);let probes=0;
      enforceScratchDraftBudget(calls,scratchDraftPolicy(`Fix src/verify.${ext} and preserve behavior.`,root),{pathState:()=>{probes++;return false;}});
      assert.equal(calls.size,1);assert.equal(probes,0,"requested paths never start optional scratch metadata work");
    }
    const explicitTests=pending(`extra.${ext}`);
    enforceScratchDraftBudget(explicitTests,scratchDraftPolicy(`Create a large test suite for src/library.${ext}.`,root),{pathState:()=>false});assert.equal(explicitTests.size,1);
  });
  test(`${ext}: new unrequested assertion guard discards the entire batch, not production source`,()=>{
    const policy=scratchDraftPolicy("Fix src/library.py.",root),content=code(ext)+"// padding\n".repeat(500);
    const calls=new Map([[0,call("host_file_write",{path:"src/library.py",content:"VALUE=1\n"},"impl")],[1,call("host_file_write",{path:`scratch.${ext}`,content},"scratch")]]);
    assert.throws(()=>enforceScratchDraftBudget(calls,policy,{pathState:()=>false}),{name:"ScratchDraftBudgetError"});assert.equal(calls.size,0);
    const unknown=new Map([[0,call("host_file_write",{path:`scratch.${ext}`,content})]]);enforceScratchDraftBudget(unknown,policy,{pathState:()=>undefined});assert.equal(unknown.size,1);
    const library=new Map([[0,call("host_file_write",{path:`library.${ext}`,content:"export const value='"+"x".repeat(9000)+"';"})]]);enforceScratchDraftBudget(library,policy,{pathState:()=>false});assert.equal(library.size,1);
  });
}

test("MTS ESM and CTS CommonJS syntax modes preserve module identity",async()=>{
  const file=join(root,"must-be-commonjs.cts");writeFileSync(file,"export const value: number = 4;\n");
  const checked=await verifyPath(file,{exec});assert(checked,"CTS has a syntax plan");if(checked.unavailable)return;
  assert.equal(checked.ok,false,"CTS must not parse as ESM just because types strip");
});

test("modern TypeScript scope preserves negative, quoted and read-ban decisions",()=>{
  assert.deepEqual(sourceScopePlan("Scope: change only src/a.mts, src/b.cts. Do not modify README.md.").paths,["src/a.mts","src/b.cts"]);
  assert.deepEqual(sourceScopePlan('Historical request: "fix private.mts"\nScope: change only src/a.mts, src/b.cts. Keep src/b.cts unchanged.').paths,["src/a.mts"]);
  assert.deepEqual(sourceScopePlan("Never read files. Scope: change only src/a.mts.").preloadPaths,[]);
  assert.deepEqual(sourceScopePlan("Scope: change only src/a.mtsx.").paths,[]);
});

test("existing-edit modern-TS candidates require actual complete reads and unchanged authority",async()=>{
  const offered=[{type:"function",function:{name:"host_file_edit",parameters:{type:"object",properties:{path:{type:"string"},edits:{type:"array"}},required:["path","edits"]}}}];
  for(const ext of ["mts","cts"]){
    const path=join(root,`known.${ext}`);let probes=0;
    const bridge=()=>createExistingEditBridge({ask:`Fix known.${ext}.`,cwd:root,probeFactory:()=>({state:()=>{probes++;return true;},settle:async()=>{},close(){}})});
    const base={local:true,editTask:true,suspended:false,workPhase:true,cwd:root,round:2,limit:8,offered,permittedNames:new Set(["host_file_edit"]),denyPath:()=>false,observations:()=>({reads:[{path,bytes:100,complete:true}],mutations:[],progress:[]})};
    const observedBridge=bridge();assert.equal(await observedBridge.choose(base),null,"one ordinary context turn remains available");
    const choice=await observedBridge.choose({...base,round:3});assert(choice,"complete observed modern-TS source is eligible");assert.equal(choice.path,path);
    const before=probes;assert.equal(await bridge().choose({...base,local:false}),null);assert.equal(probes,before);
    assert.equal(await bridge().choose({...base,observations:()=>({reads:[{path,bytes:100,complete:false}]})}),null);
  }
});

const defs=windowToolDefs({local:true,search:false,remote:false}).filter(t=>["host_file_write","host_run"].includes(t.function.name));
for(const ext of ["mts","cts"]){
  test(`${ext}: production write is syntax-only and honest unexecuted handoff is advisory`,async()=>{
    const dir=join(root,`production-${ext}`);mkdirSync(dir);writeFileSync(join(dir,"package.json"),'{"type":"module"}');setWorkdir(dir);
    const lib=join(dir,`library.${ext}`),helper=join(dir,`checks.${ext}`);let normal=0;const seen=[],events=[];
    const result=await runTurn([],`Implement library.${ext} and verify its behavior.`,e=>events.push(e),AbortSignal.timeout(20000),{sessionId:createSession().id,tools:defs,complete:async(messages,_cfg,_delta,_signal,options)=>{
      if(options?.requestKind==="contract_review")return reply('{"findings":[],"limitations":[]}');
      normal++;seen.push(...messages.filter(x=>x.role==="tool"||x.role==="assistant").map(x=>String(x.content)));
      if(normal===1)return reply("",[call("host_file_write",{path:lib,content:ext==="cts"?'const value: number=4; module.exports={value};\n':'export const value:number=4;\n'},"a"),call("host_file_write",{path:helper,content:code(ext)},"b")]);
      return reply("Incomplete. Source syntax checks passed; the authored assertions were not executed. No behavioral test pass is claimed.");
    }});
    assert(seen.some(s=>/contains authored assertions/.test(s)));assert(seen.some(s=>/HARNESS SYNTAX PASS.*not executed/.test(s)));
    assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));assert.match(result.assistant,/not executed/);assert(normal<=3,"no mandatory runtime debt/repeated advisory loop");
  });
}

for(const ext of ["mts","cts"]){
  test(`${ext}: production records an explicitly selected real Node assertion execution`,async()=>{
    const dir=join(root,`actual-run-${ext}`);mkdirSync(dir);writeFileSync(join(dir,"package.json"),'{"type":"module"}');setWorkdir(dir);
    const lib=join(dir,`library.${ext}`),helper=join(dir,`checks.${ext}`);let normal=0;const events=[],seen=[];
    const result=await runTurn([],`Implement library.${ext} and verify its behavior.`,e=>events.push(e),AbortSignal.timeout(20000),{sessionId:createSession().id,tools:defs,complete:async(messages,_cfg,_delta,_signal,options)=>{
      if(options?.requestKind==="contract_review")return reply('{"findings":[],"limitations":[]}');
      normal++;seen.push(...messages.filter(x=>x.role==="tool").map(x=>String(x.content)));
      if(normal===1)return reply("",[call("host_file_write",{path:lib,content:ext==="cts"?'const value: number=4; module.exports={value};\n':'export const value:number=4;\n'},"a"),call("host_file_write",{path:helper,content:code(ext)},"b")]);
      if(normal===2)return reply("",[call("host_run",{command:`node checks.${ext}`,cwd:dir},"c")]);
      return reply("The saved module parsed and the explicitly selected assertion helper executed successfully. No project test suite was declared.");
    }});
    assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok&&/ASSERTIONS_RAN/.test(e.detail)));
    assert(seen.some(s=>/ASSERTIONS_RAN/.test(s)),"actual execution output reaches the model");assert.match(result.assistant,/helper executed successfully/);assert.equal(normal,3,"no redundant authored-check reminder");
  });
}
