import assert from "node:assert/strict";
import {test,after,afterEach} from "node:test";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {commandIdentityForDisplay,lastUnresolvedFailureForDisplay} from "../src/main/handoff-failure.js";
const signature=text=>createHash("sha256").update(text).digest("hex");
test("omitted and relative cwd identities bind the actual current directory without resolving the filesystem",()=>{
  const raw={command:"node check.mjs"};const a=commandIdentityForDisplay(raw,"/workspace/a",resolve),b=commandIdentityForDisplay(raw,"/workspace/b",resolve);
  assert.notEqual(a,b);assert.equal(a,commandIdentityForDisplay({...raw,cwd:"."},"/workspace/a",resolve));
  assert.notEqual(commandIdentityForDisplay({...raw,cwd:"nested"},"/workspace/a",resolve),commandIdentityForDisplay({...raw,cwd:"nested"},"/workspace/b",resolve));
  const failure={name:"host_run",ok:false,executionFailed:true,executionIdentity:a};
  assert.equal(lastUnresolvedFailureForDisplay([failure,{name:"host_run",ok:true,executionUnavailable:false,executionIdentity:b}]),failure);
});
test("unknown malformed cwd or resolver metadata disables display resolution",()=>{
  for(const [raw,cwd,resolver] of [[{command:"pwd",cwd:{}},"/workspace",resolve],[{command:"pwd"},null,resolve],[{command:"pwd"},"relative",resolve],[{command:"pwd"},"/workspace",()=>{throw Error("unknown");}],[{command:"pwd"},"/workspace",()=>"relative"]])assert.equal(commandIdentityForDisplay(raw,cwd,resolver),null);
});
const bad=(sig="check",extra={})=>({name:"host_run",sig:`${signature(sig)}:before`,executionIdentity:`host_run:${signature(sig)}`,ok:false,executionFailed:true,note:"AssertionError",...extra});
const good=(sig="check",extra={})=>({name:"host_run",sig:`${signature(sig)}:after`,executionIdentity:`host_run:${signature(sig)}`,ok:true,executionUnavailable:false,...extra});

test("only a later real successful exact command suppresses its historical raw failure for display",()=>{
  const failure=bad(),pass=good(),trail=[failure,pass],snapshot=JSON.stringify(trail);
  assert.equal(lastUnresolvedFailureForDisplay(trail),undefined);assert.equal(JSON.stringify(trail),snapshot);
  assert.equal(lastUnresolvedFailureForDisplay([pass,failure]),failure);
});
test("different command name or signature never clears a historical failure display",()=>{
  const failure=bad();for(const pass of [good("other"),good("check",{name:"computer_exec"}),good("check",{executionIdentity:"unknown"})])assert.equal(lastUnresolvedFailureForDisplay([failure,pass]),failure);
});
test("unavailable informational failed-harness or incomplete metadata never resolves a failure",()=>{
  const failure=bad();for(const pass of [good("check",{executionUnavailable:true}),good("check",{informational:true}),good("check",{verification:{status:"failed"}}),good("check",{verification:{status:"unavailable"}}),good("check",{executionUnavailable:undefined})])assert.equal(lastUnresolvedFailureForDisplay([failure,pass]),failure);
  const harness=bad("check",{executionFailed:false});assert.equal(lastUnresolvedFailureForDisplay([harness,good()]),harness);
});
test("resolving the latest command still reports another unrelated unresolved failure",()=>{
  const earlier=bad("other"),resolved=bad();assert.equal(lastUnresolvedFailureForDisplay([earlier,resolved,good()]),earlier);
  const project={name:"harness",ok:false,note:"project failed"};assert.equal(lastUnresolvedFailureForDisplay([project,resolved,good()]),project);
});

const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-failure-display-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Native inference/network forbidden");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const target=chatTarget(loadConfig());writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request");};});
after(()=>{globalThis.fetch=oldFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_file_read","host_file_write","host_file_edit","host_run"].includes(t.function.name));
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const stream=delta=>new Response(frame({choices:[{delta,finish_reason:delta.tool_calls?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
const call=(name,args,id)=>({index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
for(const repaired of [true,false])test(`actual SSE deadline handoff ${repaired?"omits an exactly rerun resolved failure":"retains a failure after unrelated success"} without changing receipts`,async()=>{
  const cwd=join(root,repaired?"repaired":"unrelated");mkdirSync(cwd);writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');setWorkdir(cwd);
  const events=[],bodies=[];let n=0,aborted=false;
  const command="python3 - <<'CHECK'\nfrom service import value\nassert value == 7, 'expected seven'\nprint('MATCHED_CHECK_PASS')\nCHECK";
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);n++;assert.equal(body.max_tokens,8192);
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"service.py",content:"value = 6\n"},"initial")]});
    if(n===2)return stream({tool_calls:[call("host_run",{command,cwd},"failed-check")]});
    if(n===3&&repaired)return stream({tool_calls:[call("host_file_edit",{path:"service.py",edits:[{oldText:"value = 6",newText:"value = 7"}]},"repair")]});
    if(n===(repaired?4:3))return stream({tool_calls:[call("host_run",{command:repaired?command:"pwd",cwd},"later-check")]});
    assert.equal(n,repaired?5:4);
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:"Preparing an evidence-based report."}}]})));options.signal.addEventListener("abort",()=>{aborted=true;try{controller.error(options.signal.reason);}catch{}},{once:true});}}));
  };
  const result=await runTurn([],"Create service.py with value 7 and verify it locally; preserve the actual check outcomes.",e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,budgetMs:20000,complete:(...args)=>complete(...args)});
  assert(aborted);assert.match(result.assistant,/Incomplete/);
  if(repaired)assert(!result.assistant.includes("Most recent recorded failure"),JSON.stringify({assistant:result.assistant,receipts:result.messages.filter(row=>row.role==="tool").map(row=>({id:row.tool_call_id,content:row.content}))}));else assert.match(result.assistant,/Most recent recorded failure \(host_run\):[\s\S]*AssertionError/);
  const failed=result.messages.find(row=>row.role==="tool"&&row.tool_call_id==="failed-check");assert(failed);assert.match(failed.content,/"ok":false/);assert.match(failed.content,/AssertionError/);
  const later=result.messages.find(row=>row.role==="tool"&&row.tool_call_id==="later-check");assert(later);assert.match(later.content,/"ok":true/);
  assert.equal(readFileSync(join(cwd,"service.py"),"utf8"),repaired?"value = 7\n":"value = 6\n");
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,2);
});
