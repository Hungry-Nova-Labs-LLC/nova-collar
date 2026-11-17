import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-authored-receipt-")));
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
const call=(name,args,id,index=0)=>({index,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const wrapped=(messages,cfg,delta,signal,options)=>options.requestKind==="contract_review"
  ?Promise.resolve({content:'{"findings":[],"limitations":["Advisory only."]}',tool_calls:[]}):complete(messages,cfg,delta,signal,options);
function project(name){const cwd=join(root,name);mkdirSync(cwd);writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');setWorkdir(cwd);return cwd;}

for(const [name,effect,cleanup] of [
  ["generated-data",'mkdirSync("generated"); writeFileSync("generated/result.bin", "observed data");'],
  ["generated-data-cleanup",'mkdirSync("generated"); writeFileSync("generated/result.bin", "observed data");',true],
  ["new-dependency",'writeFileSync("new-dependency.mjs", "const extra = 2;\\n");'],
  ["configuration",'writeFileSync("package.json", JSON.stringify({type:"module",private:true}));'],
]) test(`actual SSE ${name} revision keeps historical successful execution but no current-coverage pass or advisory retry`,async()=>{
  const cwd=project(name),events=[],bodies=[];let n=0;
  const helper='import assert from "node:assert/strict";\nimport {mkdirSync,writeFileSync} from "node:fs";\nimport {value} from "./service.mjs";\n'+effect+'\nassert.equal(value, 7);\nconsole.log("ACTUAL_ASSERTION_RAN");\n';
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);n++;assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"service.mjs",content:"export const value=7;\n"},"implementation"),call("host_file_write",{path:"check.mjs",content:helper},"helper",1)]});
    if(n===2)return stream({tool_calls:[call("host_run",{command:"node check.mjs",cwd},"run")]});
    if(n===3&&cleanup)return stream({tool_calls:[call("host_run",{command:"rm -f check.mjs; rm -rf generated",cwd},"cleanup")]});
    assert.equal(n,cleanup?4:3,"a nonblocking source observation must not schedule another primary request");
    const receipt=body.messages.find(row=>row.role==="tool"&&row.tool_call_id==="run");assert(receipt);assert.match(receipt.content,/ACTUAL_ASSERTION_RAN/);
    return stream({content:"Saved service.mjs. The local assertion helper exited successfully; no declared project-wide check was available."});
  };
  const result=await runTurn([],"Create service.mjs exporting value 7 and verify its behavior locally.",e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,complete:wrapped});
  assert.equal(n,cleanup?4:3);assert.equal(readFileSync(join(cwd,"service.mjs"),"utf8"),"export const value=7;\n");
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,cleanup?2:1);
  assert.match(result.assistant,/historical direct execution passed/);assert.match(result.assistant,/input coverage changed or is unknown/);
  assert.match(result.assistant,/current behavioral verification is not established/);assert(!result.assistant.includes("source_changed_during_execution"));
  assert(!bodies.some(body=>body.messages.some(row=>row.role==="user"&&String(row.content).startsWith("Authored-check observation"))),"the advisory is appended locally, never promoted to a new user request");
  assert(!events.some(e=>e.verification?.status==="passed"&&["runtime","test","project"].includes(e.verification.phase)),"a historical tool result adds no ledger proof");
  const final=result.messages.filter(row=>row.role==="assistant").at(-1);assert.equal(final.content,result.assistant);
});

test("an unexecuted helper preserves the existing reminder instead of accepting a broad pass claim",async()=>{
  const cwd=project("not-executed"),events=[];let n=0;
  const helper='import assert from "node:assert/strict";\nassert.equal(2+2,4);\nconsole.log("NEVER_RAN");\n';
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);n++;
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"service.mjs",content:"export const value=7;\n"},"implementation"),call("host_file_write",{path:"check.mjs",content:helper},"helper",1)]});
    if(n===2)return stream({content:"PASS. The implementation and all tests passed."});
    assert.equal(n,3);assert(body.messages.some(row=>row.role==="user"&&String(row.content).includes("not_executed")));
    return stream({content:"Incomplete. Saved the implementation and parsed the helper. Its assertions were not executed, so behavior remains unverified."});
  };
  const result=await runTurn([],"Create service.mjs exporting value 7 and verify its behavior locally.",e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,complete:wrapped});
  assert.equal(n,3);assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));assert.match(result.assistant,/not executed/);assert(!/^PASS/.test(result.assistant));
  assert(!events.some(e=>e.verification?.status==="passed"&&["runtime","test","project"].includes(e.verification.phase)));
});


test("known production source mutation during a successful helper run retains stale-state reminder and no current pass",async()=>{
  const cwd=project("known-source"),events=[];let n=0;
  const helper='import assert from "node:assert/strict";\nimport {writeFileSync} from "node:fs";\nimport {value} from "./service.mjs";\nwriteFileSync("service.mjs", "export const value=8;\\n");\nassert.equal(value,7);\nconsole.log("OLDER_IMPORT_PASSED");\n';
  // The existing strong classifier declines export-like strings; avoid an
  // unrelated classifier change while retaining a genuine disk code change.
  const executable=helper.replace('"export const value=8;\\n"', '"ex"+"port const value=8;\\n"');
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);n++;
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"service.mjs",content:"export const value=7;\n"},"implementation"),call("host_file_write",{path:"check.mjs",content:executable},"helper",1)]});
    if(n===2)return stream({tool_calls:[call("host_run",{command:"node check.mjs",cwd},"run")]});
    if(n===3)return stream({content:"PASS. All assertions cover the latest source."});
    assert.equal(n,4);assert(body.messages.some(row=>row.role==="user"&&String(row.content).includes("source_changed_during_execution")));
    return stream({content:"Incomplete. The helper command succeeded using an earlier imported value while changing the production source. Current behavior was not verified."});
  };
  const result=await runTurn([],"Create service.mjs exporting value 7 and verify its behavior locally.",e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,complete:wrapped});
  assert.equal(n,4);assert.match(readFileSync(join(cwd,"service.mjs"),"utf8"),/value=8/);assert.match(result.assistant,/Incomplete/);
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,1);
});
