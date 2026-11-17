import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),".preload-production-"));
process.env.NOVAPUP_HOME=join(root,"profile");
process.env.NP_LAYA_MODEL=join(root,"absent-model");
process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error("Live providers/network are forbidden in this fixture.");};
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {requestBudget}=await import("../src/main/request-budget.js");
const {runTurn}=await import("../src/main/agent.js");
const {createHarness}=await import("../src/main/harness.js");
const {preloadRequestedSource,sourcePreloadReaderCount}=await import("../src/main/source-preload.js");
const {windowToolDefs,compactResult}=await import("../src/main/tools.js");
const {denySecretPath,redactSecrets}=await import("../src/main/safe.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setWorkdir(root);
const definitions=windowToolDefs({local:true,search:false,remote:false});
const tools=(...names)=>definitions.filter(row=>names.includes(row.function.name));
const reply=(content="",tool_calls=[])=>({content,tool_calls});
const call=(name,args,id="call")=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const fixture=name=>{const dir=join(root,name);mkdirSync(dir);writeFileSync(join(dir,"package.json"),'{"type":"module"}\n');setWorkdir(dir);return dir;};
afterEach(()=>{setApprovalNotifier(null);setWorkdir(root);});
after(()=>{globalThis.fetch=nativeFetch;rmSync(root,{recursive:true,force:true});});

test("real runTurn first request sees two actual sources and can focus-edit without model read rounds",async()=>{
  const dir=fixture("two-sources");const one="export const first = 1;\n",two="export const second = 1;\n";
  writeFileSync(join(dir,"first.mjs"),one);writeFileSync(join(dir,"second.mjs"),two);
  let requests=0,advisoryRequests=0;const events=[];const before=requestBudget(loadConfig(),chatTarget(loadConfig()));
  setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
  const result=await runTurn([],"Fix first.mjs and update second.mjs.",e=>events.push(e),AbortSignal.timeout(15000),{
    sessionId:createSession().id,tools:tools("host_file_read","host_file_edit","host_run"),
    complete:async(messages,cfg,_delta,_signal,opts)=>{
      requests++;
      assert.deepEqual(requestBudget(cfg,chatTarget(cfg)),before,"preload does not change configured request/output budgets");
      if(opts.requestKind==="contract_review"){
        advisoryRequests++;assert.equal(opts.predict,1536);assert.equal(opts.toolChoice,"none");
        const packet=JSON.parse(messages[1].content);assert.equal(packet.sources.length,2);
        assert(packet.sources.every(row=>row.baselineTextProvided&&row.baselineHashBound),"bounded raw preloads seed real before/after comparisons");
        return reply('{"findings":[],"limitations":[]}');
      }
      if(requests===1){
        const source=messages.find(row=>row.role==="assistant"&&row.content?.startsWith("<initial_source_reads>"));
        assert(source,"actual source observations precede the first model request");assert(source.content.includes(one.trim()));assert(source.content.includes(two.trim()));
        assert.equal(messages.some(row=>row.role==="tool"),false,"preflight is not a fake model-authored call");
        assert.equal(opts.toolChoice,"required","source reads do not fulfill the implementation");
        return reply("",[call("host_file_edit",{path:"first.mjs",edits:[{oldText:"first = 1",newText:"first = 2"}]},"first-edit"),call("host_file_edit",{path:"second.mjs",edits:[{oldText:"second = 1",newText:"second = 2"}]},"second-edit")]);
      }
      if(requests===2)return reply("",[call("host_run",{command:`node --input-type=module -e 'import assert from "node:assert/strict"; import {first} from "./first.mjs"; import {second} from "./second.mjs"; assert.equal(first,2); assert.equal(second,2); console.log("CHECK_OK");'`},"behavior")]);
      return reply("Updated both modules and observed CHECK_OK from their assertions.");
    }
  });
  assert.equal(requests,4);assert.equal(advisoryRequests,1);assert.match(result.assistant,/Updated both/);
  assert.match(readFileSync(join(dir,"first.mjs"),"utf8"),/first = 2/);assert.match(readFileSync(join(dir,"second.mjs"),"utf8"),/second = 2/);
  assert.equal(events.filter(e=>e.type==="tool_result"&&e.name==="host_file_edit"&&e.ok).length,2);
  assert.equal(events.filter(e=>e.type==="tool_result"&&e.name==="host_file_read"&&e.source==="initial_source_preload"&&e.ok).length,2);
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_file_read"&&e.modelRequested!==false).length,0);
});

test("preload alone cannot clear real gate debt or earn source/action progress",async()=>{
  const dir=fixture("no-proof");writeFileSync(join(dir,"helper.mjs"),"export const helper = 1;\n");
  const gate=createHarness({ask:"Fix helper.mjs",trackProjects:false});const before=gate.debt(),state=gate.progressState();
  const readTools=tools("host_file_read");
  const observed=await preloadRequestedSource({ask:"Fix helper.mjs",cwd:dir,implementation:true,stage:"edit",permitted:readTools,offered:readTools,denyPath:denySecretPath,redact:redactSecrets,pack:compactResult,note:(...args)=>gate.note(...args)});
  assert.equal(observed.reads,1);assert.deepEqual(gate.debt(),before);assert.deepEqual(gate.progressState(),state);gate.finish("finished");
  let requests=0;const events=[];
  const result=await runTurn([],"Fix helper.mjs",e=>events.push(e),AbortSignal.timeout(15000),{tools:tools("host_file_read","host_file_write"),complete:async(_messages,_cfg,_delta,_signal,opts)=>{requests++;assert.equal(opts.toolChoice,"required");return reply("PASS. The source looks correct.");}});
  assert.equal(requests,3);assert.match(result.assistant,/Incomplete/);assert.equal(events.some(e=>e.verification?.status==="passed"),false);
  assert.equal(readFileSync(join(dir,"helper.mjs"),"utf8"),"export const helper = 1;\n");
});

test("production packer keeps exact partial view coordinates and never seeds a partial restore cache",async()=>{
  const dir=fixture("partial");const text="// <mark>😀</mark>\n".repeat(300);writeFileSync(join(dir,"partial.mjs"),text);
  const readTools=tools("host_file_read"),events=[];let notes=0;
  const result=await preloadRequestedSource({ask:"Fix partial.mjs",cwd:dir,implementation:true,stage:"edit",permitted:readTools,offered:readTools,denyPath:denySecretPath,redact:redactSecrets,pack:compactResult,contextChars:2000,emit:e=>events.push(e),note:()=>notes++});
  assert(result.context.length>0&&result.context.length<=2000);const observed=events.find(e=>e.type==="tool_result");assert.equal(observed.ok,true);assert.equal(observed.read.completeFile,false);assert.equal(observed.read.nextOffset,observed.text.length);assert.equal(observed.text,text.slice(0,observed.read.nextOffset));assert.equal(notes,0);
  assert.doesNotMatch(result.context,/<mark>/);assert.doesNotThrow(()=>JSON.parse(result.context.split("\n").slice(2,-1).join("\n")));
});

test("actual role/catalog/negative/secret/outside constraints exclude source preloads",async()=>{
  const dir=fixture("excluded");writeFileSync(join(dir,"allowed.mjs"),"export const visible_marker = 1;\n");writeFileSync(join(dir,"kept.mjs"),"export const protected_marker = 7;\n");writeFileSync(join(dir,".env.py"),"NEVER_EXPOSE_SECRET_MARKER=1\n");
  const scenarios=[
    {ask:"Fix allowed.mjs",extra:{role:"phone"}},
    {ask:"Fix allowed.mjs",extra:{tools:tools("host_file_write")}},
    {ask:"Review allowed.mjs without editing",extra:{}},
    {ask:"Fix .env.py",extra:{}},
    {ask:"Fix ../outside.mjs",extra:{}},
    {ask:"Fix allowed.mjs; do not read allowed.mjs",extra:{}},
  ];
  for(const scenario of scenarios){const events=[];await runTurn([],scenario.ask,e=>events.push(e),AbortSignal.timeout(15000),{tools:tools("host_file_read","host_file_write"),complete:async messages=>{assert(!messages.some(row=>row.content?.startsWith?.("<initial_source_reads>")),scenario.ask);return reply("No implementation or execution was performed.");},...scenario.extra});assert.equal(events.some(e=>e.source==="initial_source_preload"),false,scenario.ask);}
  const events=[];await runTurn([],"Fix allowed.mjs; keep kept.mjs unchanged",e=>events.push(e),AbortSignal.timeout(15000),{tools:tools("host_file_read","host_file_write"),complete:async messages=>{const source=messages.find(row=>row.content?.startsWith?.("<initial_source_reads>"));assert(source?.content.includes("visible_marker"));assert(!source.content.includes("protected_marker"));return reply("No change was made; implementation remains incomplete.");}});
  assert.equal(events.filter(e=>e.type==="tool_result"&&e.source==="initial_source_preload").length,1);
});

test("preloaded read-first cache preserves normal broad-write approval denial and exact raw file",async()=>{
  const dir=fixture("approval");const original="// sk-fixtureSecretValue123456789\n"+Array.from({length:35},(_,i)=>`export const value${i} = ${i};`).join("\n")+"\n";
  const path=join(dir,"replace.mjs");writeFileSync(path,original);let approvals=0,requests=0;const events=[];
  setApprovalNotifier(e=>{if(e.type==="approval"){approvals++;resolveApproval(e.request.id,false);}});
  const result=await runTurn([],"Fix replace.mjs",e=>events.push(e),AbortSignal.timeout(15000),{tools:tools("host_file_read","host_file_write"),complete:async messages=>{requests++;if(requests===1){const data=messages.find(row=>row.content?.startsWith?.("<initial_source_reads>"));assert(data);assert(!data.content.includes("sk-fixtureSecretValue123456789"));assert(data.content.includes("[redacted]"));return reply("",[call("host_file_write",{path:"replace.mjs",content:"export const replacement = 2;\n"},"replace")]);}return reply("PASS. Replacement completed.");}});
  assert.equal(approvals,1);assert.equal(readFileSync(path,"utf8"),original);assert(events.some(e=>e.type==="tool_result"&&e.name==="host_file_write"&&e.ok===false));assert(result.messages.some(row=>row.role==="tool"&&row.content.includes('"held":true')));assert(!/^PASS\b/.test(result.assistant),result.assistant);
});

test("new review-only steering during a real preflight discards source context and cached write permission",async()=>{
  const dir=fixture("steer");writeFileSync(join(dir,"helper.mjs"),"export const helper = 1;\n");let polls=0;const events=[];
  const result=await runTurn([],"Fix helper.mjs",e=>events.push(e),AbortSignal.timeout(15000),{tools:tools("host_file_read","host_file_write"),takeInput:async()=>++polls===2?{messages:[{content:"Stop editing; review only."}]}:null,ackInput:async()=>{},complete:async(messages,_cfg,_delta,_signal,opts)=>{assert(!messages.some(row=>row.content?.startsWith?.("<initial_source_reads>")));assert.notEqual(opts.toolChoice,"required");return reply("Reviewed the request; no files were changed.");}});
  assert.match(result.assistant,/Reviewed/);assert.equal(readFileSync(join(dir,"helper.mjs"),"utf8"),"export const helper = 1;\n");assert(events.some(e=>e.type==="incorporated"));
});

test("Stop during an isolated stalled read aborts runTurn before any model request or mutation",async()=>{
  const dir=fixture("stop");writeFileSync(join(dir,"helper.mjs"),"export const helper = 1;\n");
  const settleBy=Date.now()+500;while(sourcePreloadReaderCount()&&Date.now()<settleBy)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(sourcePreloadReaderCount(),0);
  const require=createRequire(import.meta.url),cp=require("node:child_process"),originalSpawn=cp.spawn;
  const fake=new EventEmitter();fake.stdout=new PassThrough();fake.stderr=new PassThrough();fake.stdin=new PassThrough();fake.kill=()=>false;fake.unref=()=>{};
  let sawSpawn;const spawned=new Promise(resolve=>sawSpawn=resolve);const controller=new AbortController();let requests=0;
  cp.spawn=(...args)=>{if(args[1]?.[0]==="-e"){sawSpawn();return fake;}return originalSpawn(...args);};syncBuiltinESMExports();
  let timer;
  try{const turn=runTurn([],"Fix helper.mjs",()=>{},controller.signal,{tools:tools("host_file_read","host_file_write"),complete:async()=>{requests++;return reply("PASS.");}});await Promise.race([spawned,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("preload did not start")),3000);})]);clearTimeout(timer);controller.abort();await assert.rejects(turn,{name:"AbortError"});assert.equal(requests,0);assert.equal(readFileSync(join(dir,"helper.mjs"),"utf8"),"export const helper = 1;\n");}
  finally{cp.spawn=originalSpawn;syncBuiltinESMExports();fake.emit("exit",null,"SIGKILL");}
  assert.equal(sourcePreloadReaderCount(),0);
});
