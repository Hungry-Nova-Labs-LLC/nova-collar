import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-verification-opportunity-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No native inference/network permitted");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome,chatTarget,loadConfig}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const target=chatTarget(loadConfig());writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
let approvals=[];let approve=true;setApprovalNotifier(event=>{if(event.type==="approval"){approvals.push(event.request);resolveApproval(event.request.id,approve);}});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request");};approve=true;approvals=[];});
after(()=>{globalThis.fetch=originalFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,search:false,remote:false}).filter(tool=>["host_run","host_file_read","host_file_write","host_file_edit"].includes(tool.function.name));
const frame=data=>`data: ${JSON.stringify(data)}\n\n`;
const call=(name,args,id,index=0)=>({index,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const stream=(calls=[],content="")=>new Response((content?frame({choices:[{delta:{content}}]}):"")+frame({choices:[{delta:{...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
const ask="Do not inspect hidden references or private profiles. Fix the implementation. Scope: change only src/a.mjs, src/b.mjs. Do not modify README.md. Verify the saved behavior locally.";
const check=`node --input-type=module -e 'import assert from "node:assert/strict"; import {value as a} from "./src/a.mjs"; import {value as b} from "./src/b.mjs"; assert.equal(a,4); assert.equal(b,5); console.log("ACTUAL_ASSERTIONS_OBSERVED")'`;
function project(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');writeFileSync(join(cwd,"README.md"),"Context, not a test.\n");for(let i=0;i<12;i++)writeFileSync(join(cwd,`context${i}.txt`),`Observation ${i}.\n`);writeFileSync(join(cwd,"src/a.mjs"),"export const value = 1;\n");writeFileSync(join(cwd,"src/b.mjs"),"export const value = 2;\n");setWorkdir(cwd);return cwd;}
function ordinary(n,{priorRun=false,noChange=false}={}){
  if(n===1)return stream([call("host_file_read",{path:"src/a.mjs"},"read-a"),call("host_file_read",{path:"src/b.mjs"},"read-b",1)]);
  if(n===3)return stream([call("host_file_edit",{path:"src/a.mjs",edits:[{oldText:"value = 1",newText:`value = ${noChange?1:4}`}]},"edit-a")]);
  if(n===7)return stream([call("host_file_edit",{path:"src/b.mjs",edits:[{oldText:"value = 2",newText:`value = ${noChange?2:5}`}]},"edit-b")]);
  if(n===4&&priorRun)return stream([call("host_run",{command:"node --version"},"version")]);
  return stream([call("host_file_read",{path:`context${n-1}.txt`},`context-${n}`)]);
}
const wrapped=(messages,cfg,delta,signal,options)=>options.requestKind==="contract_review"?Promise.resolve({content:'{"findings":[],"limitations":[]}',tool_calls:[]}):complete(messages,cfg,delta,signal,options);
const options=extra=>({sessionId:createSession().id,tools,sourcePreload:false,complete:wrapped,...extra});
const isSelected=body=>body.tool_choice?.function?.name==="host_run"&&body.tools?.length===1;

// Counterfactual oracle: frozen19 reaches the tools-free summary with no run.
test("actual SSE two requested edits and read exhaustion admit one real check, then restore full ordered tools",async()=>{
  const cwd=project("checks-before-summary"),events=[],bodies=[];let n=0,selected=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);n++;
    if(isSelected(body)){selected++;assert.equal(n,13);assert.deepEqual(body.tools,bodies[0].tools.filter(t=>t.function.name==="host_run"));assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);assert.equal(body.temperature,0);assert.equal(body.think,true);assert.match(JSON.stringify(body.messages),/<verification_opportunity>/);assert(!JSON.stringify(body.messages).includes(check));return stream([call("host_run",{command:check},"assertions")]);}
    if(n<=12)return ordinary(n);
    if(!body.tools.length)return stream([],"Only syntax/source checks were observed; no behavioral check was executed.");
    assert.equal(n,14);assert.deepEqual(body.tools,bodies[0].tools);return stream([],"Saved the two requested source changes and executed assertions: ACTUAL_ASSERTIONS_OBSERVED. No declared project suite was available.");
  };
  const result=await runTurn([],ask,event=>events.push(event),AbortSignal.timeout(20000),options());
  assert.equal(selected,1,"an exhausted implementation must receive the selected check opportunity before a forced summary");assert.equal(n,14);
  assert(events.some(event=>event.type==="tool_result"&&event.name==="host_run"&&event.ok&&event.detail.includes("ACTUAL_ASSERTIONS_OBSERVED")));
  assert.match(result.assistant,/ACTUAL_ASSERTIONS_OBSERVED/);assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),"export const value = 4;\n");assert.equal(readFileSync(join(cwd,"src/b.mjs"),"utf8"),"export const value = 5;\n");
});

for(const bad of ["read","prose","wrong-cwd","multi","unknown","malformed"])test(`actual SSE ${bad} selected response is wholly undispatched, consumes one quota, and restores full catalog`,async()=>{
  const cwd=project(`bad-${bad}`),events=[],bodies=[];let n=0,selected=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);n++;
    if(isSelected(body)){selected++;assert.equal(n,13);
      if(bad==="read")return stream([call("host_file_read",{path:"never-read.txt"},"rejected-read")]);
      if(bad==="prose")return stream([],"The assertions should pass, but no command was submitted.");
      if(bad==="unknown")return stream([call("unoffered_tool",{command:"should never run"},"rejected-unknown")]);
      if(bad==="malformed"){const invalid=call("host_run",{},"bad-json");invalid.function.arguments="{command:";return stream([invalid]);}
      const calls=[call("host_run",{command:`node -e 'require("fs").writeFileSync("REJECTED_SENTINEL","bad")'`,...(bad==="wrong-cwd"?{cwd:root}:{})},"rejected-run")];
      if(bad==="multi")calls.push(call("host_file_write",{path:"REJECTED_SENTINEL",content:"bad"},"rejected-write",1));return stream(calls);
    }
    if(n<=12)return ordinary(n);
    assert.equal(n,14);assert.deepEqual(body.tools,bodies[0].tools);assert.match(JSON.stringify(body.messages),/discarded before dispatch/);return stream([],"Incomplete. Changes were saved, but no behavioral check was executed.");
  };
  const result=await runTurn([],ask,event=>events.push(event),AbortSignal.timeout(20000),options());
  assert.equal(selected,1);assert.equal(n,14);assert(!existsSync(join(cwd,"REJECTED_SENTINEL")));assert(!existsSync(join(root,"REJECTED_SENTINEL")));assert(!events.some(e=>e.type==="tool"&&(e.name==="host_run"||e.name==="unoffered_tool")));assert.match(result.assistant,/Incomplete|FAIL/);
  assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_read"&&JSON.parse(e.args).path==="never-read.txt"));
});

test("a prior model version command conservatively prevents the allowance even though it is no behavioral test",async()=>{
  project("version-disables");const events=[];let n=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;assert(!isSelected(body));if(n<=12)return ordinary(n,{priorRun:true});assert.equal(body.tool_choice,"none");assert.deepEqual(body.tools,[]);return stream([],"Changes saved. Only a version command and syntax checks ran; behavior remains unverified.");};
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options());assert.equal(n,13);assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,1);
});

test("review steering arriving during the selected stream cancels its buffered command before dispatch",async()=>{
  const cwd=project("review-steering"),events=[],bodies=[];let n=0,batch=null;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);n++;
    if(isSelected(body)){assert.equal(n,13);batch={messages:[{content:"Stop editing; review only. Do not run any programs."}]};return stream([call("host_run",{command:`node -e 'require("fs").writeFileSync("REVIEW_SENTINEL","bad")'`},"stale-run")]);}
    if(n<=12)return ordinary(n);assert.equal(n,14);assert.deepEqual(body.tools,[]);return stream([],"Reviewed the saved changes only. No program ran after the stage change.");};
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options({takeInput:()=>batch,ackInput:()=>{batch=null;}}));
  assert(!existsSync(join(cwd,"REVIEW_SENTINEL")));assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});

test("Stop during the selected stream discards its command with no native execution",async()=>{
  const cwd=project("stop"),events=[];let n=0;const controller=new AbortController();
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;if(isSelected(body)){controller.abort(new DOMException("Stopped by fixture","AbortError"));return stream([call("host_run",{command:`node -e 'require("fs").writeFileSync("STOP_SENTINEL","bad")'`},"stopped-run")]);}return ordinary(n);};
  await assert.rejects(runTurn([],ask,e=>events.push(e),controller.signal,options()),e=>e.name==="AbortError");assert.equal(n,13);assert(!existsSync(join(cwd,"STOP_SENTINEL")));assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});

test("an explicitly denied selected command remains held under ordinary approval policy",async()=>{
  const cwd=project("denied"),events=[];let n=0;approve=false;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;if(isSelected(body))return stream([call("host_run",{command:`node -e 'require("fs").writeFileSync("DENIED_SENTINEL","bad")'`},"denied")]);return ordinary(n);};
  const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options());assert.equal(n,13);assert.equal(result.held,true);assert(approvals.length>0);assert(!existsSync(join(cwd,"DENIED_SENTINEL")));
});


test("a successful opportunity check cannot earn any tool rounds beyond its fixed second round",async()=>{
  project("hard-two-round-limit");const events=[],bodies=[];let n=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);n++;
    if(isSelected(body)){assert.equal(n,13);return stream([call("host_run",{command:check},"actual-check")]);}
    if(n<=12)return ordinary(n);
    if(n===14){assert.deepEqual(body.tools,bodies[0].tools);return stream([call("host_file_read",{path:"README.md"},"last-ordinary-read")]);}
    assert.equal(n,15);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,"none");assert.equal(body.max_tokens,1536);return stream([],"The requested sources were saved; ACTUAL_ASSERTIONS_OBSERVED came from executed assertions. No declared project suite was available.");
  };
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options());assert.equal(n,15);assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,1);
});

test("less than 30 seconds before hard handoff never admits the selected verification request",async()=>{
  project("short-clock");let n=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;assert(!isSelected(body));if(n<=12)return ordinary(n);assert.equal(n,13);assert.deepEqual(body.tools,[]);return stream([],"Saved changes, but no behavioral execution was observed.");};
  await runTurn([],ask,()=>{},AbortSignal.timeout(20000),options({budgetMs:40000}));assert.equal(n,13);
});

test("neutral human steering also cancels the in-flight quota without consuming an extra ordinary tool round",async()=>{
  const cwd=project("neutral-steering"),events=[];let n=0,batch=null;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;if(isSelected(body)){assert.equal(n,13);batch={messages:[{content:"Keep the explanation concise."}]};return stream([call("host_run",{command:`node -e 'require("fs").writeFileSync("NEUTRAL_SENTINEL","bad")'`},"stale-command")]);}
    if(n<=12)return ordinary(n);assert.equal(n,14);assert.deepEqual(body.tools,[]);return stream([],"Incomplete. Changes were saved; no behavioral check was executed.");};
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options({takeInput:()=>batch,ackInput:()=>{batch=null;}}));assert.equal(n,14);assert(!existsSync(join(cwd,"NEUTRAL_SENTINEL")));assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});

test("CWD drift while a selected response is buffered cannot execute its command in either directory",async()=>{
  const cwd=project("cwd-drift"),other=join(cwd,"other");mkdirSync(other);let n=0;const events=[];
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;if(isSelected(body)){setWorkdir(other);return stream([call("host_run",{command:`node -e 'require("fs").writeFileSync("CWD_SENTINEL","bad")'`},"drift-command")]);}if(n<=12)return ordinary(n);assert.equal(n,14);return stream([],"Incomplete. The workspace changed; no check was executed.");};
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options());assert.equal(n,14);assert(!existsSync(join(cwd,"CWD_SENTINEL")));assert(!existsSync(join(other,"CWD_SENTINEL")));assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});

test("byte-identical requested edits earn neither source progress nor a verification allowance",async()=>{
  const cwd=project("no-op"),events=[];let n=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;assert(!isSelected(body));if(!body.tools.length)return stream([],"Incomplete. No requested source byte change was made and no behavioral check ran.");return ordinary(n,{noChange:true});};
  await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),options());assert(n<=9);assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),"export const value = 1;\n");assert.equal(readFileSync(join(cwd,"src/b.mjs"),"utf8"),"export const value = 2;\n");assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});


test("an implementation request combined with an explicit no-command ban never gets the optional execution cue",async()=>{
  project("explicit-no-execution");const events=[];let n=0;
  globalThis.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);n++;assert(!isSelected(body));assert(!JSON.stringify(body.messages).includes("<verification_opportunity>"));if(n<=12)return ordinary(n);assert.equal(n,13);assert.deepEqual(body.tools,[]);return stream([],"Saved the requested changes. Only syntax/source inspection was performed; no commands or behavioral tests were run.");};
  await runTurn([],ask.replace("Verify the saved behavior locally.","Do not run commands or tests."),e=>events.push(e),AbortSignal.timeout(20000),options());assert.equal(n,13);assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));
});
