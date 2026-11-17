import assert from "node:assert/strict";
import {test,after,afterEach} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-reported-helper-")));
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
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native/network request");};});
after(()=>{globalThis.fetch=oldFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_file_read","host_file_write","host_file_edit","host_run"].includes(t.function.name));
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const stream=delta=>new Response(frame({choices:[{delta,finish_reason:delta.tool_calls?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
const call=(name,args,id,index=0)=>({index,id,type:"function",function:{name,arguments:JSON.stringify(args)}});

for(const strong of [true,false])test(`actual SSE real Node ${strong?"failed authored assertion quotes its reported expression after packing":"ordinary failed program does not gain authored assertion context"}`,async()=>{
  const cwd=join(root,strong?"strong":"ordinary");mkdirSync(cwd);setWorkdir(cwd);let n=0;const bodies=[],events=[];
  const helper=strong
    ? 'import assert from "node:assert/strict";\nconst cells = [{ok:true}, {}];\nconsole.log("UNRELATED_STDOUT_" + "x".repeat(12000));\nassert.equal(cells[1].ok, true);\n'
    : 'console.log("example AssertionError ERR_ASSERTION");\nthrow new Error("ordinary failure");\n';
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);n++;assert(n<=9,"ordinary finite policy stays bounded");
    if(body.tools?.length){assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);}
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"sample.mjs",content:"export const value=7;\n"},"implementation"),call("host_file_write",{path:"check.mjs",content:helper},"helper",1)]});
    if(n===2)return stream({tool_calls:[call("host_run",{command:"node check.mjs"},"run")]});
    return stream({content:"Incomplete. Saved sample.mjs. The local check failed; its assertion or error is not a passing behavior check, and no project suite was established."});
  };
  const result=await runTurn([],"Create sample.mjs exporting value 7 and check it locally. Preserve the actual check outcomes.",e=>events.push(e),AbortSignal.timeout(20000),{sessionId:createSession().id,tools,sourcePreload:false,complete:(...args)=>complete(...args)});
  assert(n>=3);assert.equal(readFileSync(join(cwd,"sample.mjs"),"utf8"),"export const value=7;\n");
  const after=bodies.slice(2).find(body=>body.messages.some(row=>row.role==="tool"&&row.tool_call_id==="run"));assert(after);
  const receipt=after.messages.find(row=>row.role==="tool"&&row.tool_call_id==="run");assert.match(receipt.content,/"ok":false/);
  if(strong){
    assert.match(receipt.content,/Reported authored-helper assertion frames/);assert.match(receipt.content,/cells\[1\]\.ok/);
    assert.match(receipt.content,/No expected value is derived/);assert(receipt.content.indexOf("Reported authored-helper")>0);
  }else assert(!receipt.content.includes("Reported authored-helper assertion frames"));
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok===false));
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,1,"context creates no extra command");
  assert(!/^PASS\b/.test(result.assistant));assert.match(result.assistant,/FAIL|Incomplete|failed/);
  const archived=result.messages.find(row=>row.role==="tool"&&row.tool_call_id==="run");assert(archived);assert.match(archived.content,/"ok":false/);
});
