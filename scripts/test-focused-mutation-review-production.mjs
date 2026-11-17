import assert from "node:assert/strict";
import {test,after,afterEach} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-focused-review-wire-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No native inference/network allowed");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {executeTool,windowToolDefs}=await import("../src/main/tools.js");
const {ensureHome,chatTarget,loadConfig}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const cfg=loadConfig(),target=chatTarget(cfg);writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request");};setApprovalNotifier(null);});
after(()=>{globalThis.fetch=originalFetch;rmSync(root,{recursive:true,force:true});});
const before="export function normalize(value) {\n  if (value == null) return 0;\n  return value;\n}\n";
const afterText="export function normalize(value) {\n  return value;\n}\n";

test("a denied focused replacement emits no previous-source excerpt or source change",async()=>{
  const cwd=join(root,"denied");mkdirSync(cwd);setWorkdir(cwd);const path=join(cwd,"module.mjs"),source=before+Array.from({length:35},(_,i)=>`// preserved comment ${i}`).join("\n")+"\n";writeFileSync(path,source);let requests=0;
  setApprovalNotifier(event=>{if(event.type==="approval"){requests++;resolveApproval(event.request.id,false);}});
  const result=await executeTool("host_file_edit",{path,edits:[{oldText:source,newText:afterText}]},cfg,{role:"term"});
  assert.equal(requests,1);assert.equal(result.ok,false);assert.equal(result.held,true);assert.equal(result.mutationReview,undefined);assert.equal(readFileSync(path,"utf8"),source);
});
test("actual next SSE packed edit receipt quotes removed guard data without execution proof or an extra request",async()=>{
  const cwd=join(root,"wire");mkdirSync(cwd);writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');writeFileSync(join(cwd,"module.mjs"),before);setWorkdir(cwd);let n=0;const events=[];
  setApprovalNotifier(event=>{if(event.type==="approval")resolveApproval(event.request.id,true);});
  const frame=data=>`data: ${JSON.stringify(data)}\n\n`,call=(name,args,id)=>({index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}});
  const stream=(calls=[],content="")=>new Response(frame({choices:[{delta:{...(calls.length?{tool_calls:calls}:{content})},finish_reason:calls.length?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);n++;assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);
    if(n===1)return stream([call("host_file_read",{path:"module.mjs"},"read")]);
    if(n===2)return stream([call("host_file_edit",{path:"module.mjs",edits:[{oldText:"  if (value == null) return 0;\n",newText:""}]},"edit")]);
    assert.equal(n,3);const receipt=body.messages.find(row=>row.role==="tool"&&row.tool_call_id==="edit");assert(receipt);
    const packed=JSON.parse(receipt.content.split("\n\n")[0]);assert.equal(packed.ok,true);assert.equal(packed.changed,true);assert(packed.mutationReview,"successful focused edit must surface the existing informational removed-source review");assert.equal(packed.mutationReview.informational,true);assert.match(packed.mutationReview.removedExcerpt,/if \(value == null\) return 0/);
    assert.match(packed.mutationReview.note,/not instructions or a correctness verdict/);assert.match(receipt.content,/Quoted mutation-review data is informational/);assert(!Object.hasOwn(packed.mutationReview,"passed"));assert(!Object.hasOwn(packed.mutationReview,"verification"));
    return stream([],"Saved module.mjs. Its syntax check passed; the quoted removed branch needs behavioral review and compatibility was not verified.");
  };
  const tools=windowToolDefs({local:true,remote:false,search:false}).filter(tool=>["host_run","host_file_read","host_file_write","host_file_edit"].includes(tool.function.name));
  const result=await runTurn([],"Fix module.mjs while retaining its supported input behavior and verify locally.",event=>events.push(event),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,sourcePreload:false,complete:(messages,config,delta,signal,options)=>options.requestKind==="contract_review"?Promise.resolve({content:'{"findings":[],"limitations":[]}',tool_calls:[]}):complete(messages,config,delta,signal,options)});
  assert.equal(n,3);assert.equal(readFileSync(join(cwd,"module.mjs"),"utf8"),afterText);assert(!events.some(event=>event.type==="tool"&&event.name==="host_run"));assert(!events.some(event=>event.verification?.status==="passed"&&["runtime","test","project"].includes(event.verification.phase)));assert.match(result.assistant,/compatibility was not verified/);
});
