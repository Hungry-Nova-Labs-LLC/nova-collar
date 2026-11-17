import assert from "node:assert/strict";
import {test,after} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {join,relative,isAbsolute} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-command-cwd-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.OLLAMA_MODEL="fixture-local-chat";
const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Native inference/network forbidden");};
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {executeTool,windowToolDefs}=await import("../src/main/tools.js");
const {getWorkdir,setWorkdir}=await import("../src/main/workdir.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const cfg=loadConfig();const target=chatTarget(cfg);
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
const {complete,runTurn}=await import("../src/main/agent.js");
const {createSession}=await import("../src/main/sessions.js");
after(()=>{globalThis.fetch=oldFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});

test("host_run keeps cwd optional and discloses current-workspace omission without a guessed path",()=>{
  const tool=windowToolDefs({local:true,remote:false,search:false}).find(row=>row.function.name==="host_run");
  assert(tool);assert(!tool.function.parameters.required.includes("cwd"));assert.match(tool.function.description,/Omit cwd to use the current workspace/);
  assert.match(tool.function.description,/intentionally different/);assert.match(tool.function.description,/already-observed/);
});
test("an omitted cwd actually executes in the selected workspace after normal approval",async()=>{
  const cwd=join(root,"current");mkdirSync(cwd);setWorkdir(cwd);let approvals=0;
  setApprovalNotifier(event=>{if(event.type!=="approval")return;approvals++;assert.equal(event.request.detail.split("\n")[0],cwd);resolveApproval(event.request.id,true);});
  const result=await executeTool("host_run",{command:"pwd; printf DEFAULT_CWD_OK > default-marker.txt"},cfg,{role:"term"});
  assert.equal(approvals,1);assert.equal(result.ok,true);assert.equal(result.approved,true);assert(result.stdout.includes(cwd));
  assert.equal(readFileSync(join(cwd,"default-marker.txt"),"utf8"),"DEFAULT_CWD_OK");assert.equal(getWorkdir(),cwd);
});
test("an explicit valid outside cwd still asks ordinary approval and remains held when denied",async()=>{
  const cwd=join(root,"inside"),outside=join(root,"outside");mkdirSync(cwd);mkdirSync(outside);setWorkdir(cwd);let approvals=0;
  setApprovalNotifier(event=>{if(event.type!=="approval")return;approvals++;assert.equal(event.request.detail.split("\n")[0],outside);resolveApproval(event.request.id,false);});
  const args={command:"printf OUTSIDE_MUST_NOT_RUN > outside-marker.txt",cwd:outside};const original=JSON.stringify(args);
  const result=await executeTool("host_run",args,cfg,{role:"term"});
  assert.equal(approvals,1);assert.equal(result.ok,false);assert.equal(result.held,true);assert.match(result.error,/Not approved/);
  assert(!existsSync(join(outside,"outside-marker.txt")));assert.equal(JSON.stringify(args),original);assert.equal(getWorkdir(),cwd);
});


test("actual serialized implementation request includes current-cwd guidance and omitted-cwd dispatch stays in that workspace",async()=>{
  const cwd=join(root,"wire");mkdirSync(cwd);setWorkdir(cwd);let n=0;const events=[];
  setApprovalNotifier(event=>{if(event.type==="approval")resolveApproval(event.request.id,true);});
  const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
  const stream=delta=>new Response(frame({choices:[{delta,finish_reason:delta.tool_calls?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
  const call=(name,args,id)=>({index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);n++;assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);
    const schema=body.tools.find(t=>t.function.name==="host_run");assert(schema);assert.match(schema.function.description,/Omit cwd to use the current workspace/);
    assert(body.messages.some(row=>typeof row.content==="string"&&row.content.includes("omit cwd to use the current workspace")),"the actual code-job context contains the same preventive note");
    if(n===1)return stream({tool_calls:[call("host_file_write",{path:"sample.mjs",content:"export const value=7;\n"},"save")]});
    if(n===2)return stream({tool_calls:[call("host_run",{command:"pwd"},"check-cwd")]});
    assert.equal(n,3);return stream({content:"Saved sample.mjs and observed its syntax check. The pwd command confirmed the selected workspace; behavior was not tested."});
  };
  const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_file_read","host_file_write","host_file_edit","host_run"].includes(t.function.name));
  const result=await runTurn([],"Implement sample.mjs exporting value 7 and verify locally.",e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,complete:(messages,config,delta,signal,options)=>options.requestKind==="contract_review"?Promise.resolve({content:'{"findings":[],"limitations":[]}',tool_calls:[]}):complete(messages,config,delta,signal,options)});
  assert.equal(n,3);assert.equal(getWorkdir(),cwd);assert.equal(readFileSync(join(cwd,"sample.mjs"),"utf8"),"export const value=7;\n");
  const run=events.find(e=>e.type==="tool"&&e.name==="host_run");assert(run);assert(!Object.hasOwn(JSON.parse(run.args),"cwd"));
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok&&e.detail.includes(cwd)));assert.match(result.assistant,/behavior was not tested/);
});
