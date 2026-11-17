import assert from "node:assert/strict";
import {test,after,afterEach} from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as diagnostics from "../src/main/command-diagnostic.js";
const assertionFailureRepairObservation=diagnostics.assertionFailureRepairObservation || (()=>"");

test("only an observed failed assertion receives balanced, non-authoritative repair guidance",()=>{
 const result=Object.freeze({ok:false,stderr:"AssertionError [ERR_ASSERTION]: mismatch",stdout:"before check"});
 const text=assertionFailureRepairObservation(result);
 assert.match(text,/observed value, expected value, supplied input data and user contract/);
 assert.match(text,/If the check is valid, repair the implementation/);
 assert.match(text,/Only a demonstrably mistaken expectation[\s\S]*authored during this task[\s\S]*independently stated derivation[\s\S]*preserved required coverage/);
 assert.match(text,/User-supplied and protected checks remain authoritative/);
 assert.match(text,/changes no result, verification debt, permission or scope/);
 assert.equal(result.ok,false);assert.equal(result.stdout,"before check");
});

test("success, unavailable checks and non-assertion failures do not receive the optional observation",()=>{
 for(const result of [{ok:true,stderr:"AssertionError"},{ok:false,held:true,stderr:"AssertionError"},{ok:false,skipped:true,stderr:"AssertionError"},{ok:false,unavailable:true,stderr:"AssertionError"},{ok:false,stderr:"SyntaxError: invalid token"},{ok:false,stdout:"Example: AssertionError or ERR_ASSERTION may appear in documentation",stderr:"Error: ordinary runtime failure"},{}])assert.equal(assertionFailureRepairObservation(result),"");
});

const root=mkdtempSync(join(tmpdir(),"collar-assertion-repair-"));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Native inference/network forbidden.");};
const {runTurn,complete}=await import("../src/main/agent.js");
const {createSession}=await import("../src/main/sessions.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const target=chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request.");};});
after(()=>{setApprovalNotifier(null);globalThis.fetch=originalFetch;rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_run","host_file_read"].includes(t.function.name));
const frame=v=>`data: ${JSON.stringify(v)}\n\n`;
const stream=(command,cwd)=>new Response(frame({choices:[{delta:command?{tool_calls:[{index:0,id:"actual-check",type:"function",function:{name:"host_run",arguments:JSON.stringify({command,cwd})}}]}:{content:"FAIL. The actual command failed; no source or test was edited and no passing check is claimed."},finish_reason:command?"tool_calls":"stop"}]})+"data: [DONE]\n\n");

for(const [name,command,hasGuidance] of [
 ["node-assertion",`node --input-type=module -e 'import assert from "node:assert/strict"; assert.equal(6,9,"comparison mismatch");'`,true],
 ["ordinary-error",`node --input-type=module -e 'console.log("Example: AssertionError or ERR_ASSERTION in docs"); throw new Error("ordinary runtime failure");'`,false],
])test(`actual next-request ${name} preserves its failed receipt and only assertion diagnostics gain guidance`,async()=>{
 const cwd=join(root,name);mkdirSync(cwd);writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');setWorkdir(cwd);
 let requests=0;const events=[];
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(options.body);requests++;assert.equal(body.max_tokens,8192);assert.equal(body.options.num_ctx,131072);assert.equal(body.temperature,0);
  if(requests===1)return stream(command,cwd);
  const receipt=body.messages.find(m=>m.role==="tool"&&m.tool_call_id==="actual-check");assert(receipt);
  const raw=JSON.parse(receipt.content.split("\n\nObserved failure:")[0]);assert.equal(raw.ok,false);
  assert.match(raw.stderr,hasGuidance?/ERR_ASSERTION/:/ordinary runtime failure/);
  assert.equal(receipt.content.includes("Assertion-repair observation"),hasGuidance);
  if(hasGuidance)assert.match(receipt.content,/User-supplied and protected checks remain authoritative/);
  return stream();
 };
 const result=await runTurn([],"Run the compact local JavaScript check and report its actual failure. Do not edit files or claim verification passed.",e=>events.push(e),AbortSignal.timeout(12000),{sessionId:createSession().id,tools,sourcePreload:false,budgetMs:25000,complete:(m,c,d,s,o)=>complete(m,c,d,s,{...o,target})});
 assert(hasGuidance?requests===5:(requests>=2&&requests<=3),JSON.stringify({requests,assistant:result.assistant}));assert.match(result.assistant,/FAIL|failed/);assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_run").length,1);assert(!events.some(e=>e.type==="tool"&&["host_file_write","host_file_edit"].includes(e.name)));
});
