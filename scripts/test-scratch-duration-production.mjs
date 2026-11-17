import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),".scratch-duration-"));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
for(const key of ["HNL_FAST_URL","HNL_FAST_MODEL","HNL_THINK_URL","HNL_THINK_MODEL","HNL_CHAT_KEY","HNL_TOOLS_KEY"])process.env[key]="";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Live provider/network forbidden.");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {scratchDraftPolicy}=await import("../src/main/scratch-draft-budget.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setWorkdir(root);const target=chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("No real provider.");};setWorkdir(root);});after(()=>{setApprovalNotifier(null);globalThis.fetch=savedFetch;rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_run","host_file_read","host_file_write"].includes(t.function.name));
const helper='import assert from "node:assert/strict";\nassert.equal(1,1);\n'+"// compact test source\n".repeat(65);
const data=value=>`data: ${JSON.stringify(value)}\n\n`,delta=d=>data({choices:[{delta:d}]}),end=()=>data({choices:[{delta:{},finish_reason:"tool_calls"}]})+'data: [DONE]\n\n';
const call=(name,args,index=0)=>({index,id:`call-${index}`,type:"function",function:{name,arguments:JSON.stringify(args)}});
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));setWorkdir(cwd);writeFileSync(join(cwd,"package.json"),'{"type":"module"}');writeFileSync(join(cwd,"src/feature.mjs"),'export const value=1;\n');return cwd;}
function stream(frames,setClock){let i=0;return new Response(new ReadableStream({pull(controller){if(i>=frames.length){controller.close();return;}const frame=frames[i++];setClock(frame.at);controller.enqueue(new TextEncoder().encode(frame.text));}},{highWaterMark:0}));}
function helperFrames(path,requestedPath){return [{at:1000,text:delta({reasoning_content:"Planning one bounded check."})},...(requestedPath?[{at:20000,text:delta({tool_calls:[call("host_file_write",{path:requestedPath,content:'export const value=2; // BUFFERED_REQUESTED_SOURCE\n'},0)]})}]:[]),{at:51000,text:delta({tool_calls:[call("host_file_write",{path,content:helper},requestedPath?1:0)]})},{at:51000,text:end()}];}
function slowDraftFrames(path){const start=JSON.stringify({path,content:"i"}).slice(0,-2),tail=JSON.stringify(helper.slice(1)).slice(1,-1);return [{at:1000,text:delta({reasoning_content:"Planning one bounded check."})},{at:2000,text:delta({tool_calls:[{index:0,id:"slow",type:"function",function:{name:"host_file_write",arguments:start}}]})},{at:51000,text:delta({tool_calls:[{index:0,function:{arguments:tail}}]})}];}

test("actual complete excludes preceding reasoning before a finished compact helper",async()=>{
  const cwd=fixture("duration"),path=join(cwd,"_check.mjs"),initialFiles=new Map([[path,false]]);let clock=0,requests=0;
  globalThis.fetch=async(_url,options)=>{requests++;const body=JSON.parse(options.body);assert.equal(body.max_tokens,8192);return stream(helperFrames(path),value=>{clock=value;});};
  const result=await complete([],loadConfig(),null,AbortSignal.timeout(5000),{target,tools,toolChoice:"auto",scratchDraftPolicy:scratchDraftPolicy("Fix src/feature.mjs.",cwd,initialFiles),scratchDraftNow:()=>clock});
  assert.equal(JSON.parse(result.tool_calls[0].function.arguments).content,helper);assert.equal(requests,1);assert.equal(existsSync(path),false);
});

test("actual SSE retains a complete valid compact call even after its own source clock passed45s",async()=>{
  const cwd=fixture("completed-source"),path=join(cwd,"_check.mjs"),initialFiles=new Map([[path,false]]);let clock=0;
  const raw=JSON.stringify({path,content:helper}),prefix=JSON.stringify({path,content:"i"}).slice(0,-2);
  globalThis.fetch=async()=>stream([{at:1000,text:delta({reasoning_content:"Plan the local check."})},
    {at:2000,text:delta({tool_calls:[{index:0,id:"complete-late",type:"function",function:{name:"host_file_write",arguments:prefix}}]})},
    {at:60000,text:delta({tool_calls:[{index:0,function:{arguments:raw.slice(prefix.length)}}]})},{at:60001,text:end()}],value=>{clock=value;});
  const result=await complete([],loadConfig(),null,AbortSignal.timeout(5000),{target,tools,toolChoice:"auto",scratchDraftPolicy:scratchDraftPolicy("Fix src/feature.mjs.",cwd,initialFiles),scratchDraftNow:()=>clock});
  assert.equal(JSON.parse(result.tool_calls[0].function.arguments).content,helper);assert.equal(existsSync(path),false);
});

test("HTTP and queue age do not count before the first actual model token",async()=>{
  const cwd=fixture("queue"),path=join(cwd,"_check.mjs"),initialFiles=new Map([[path,false]]);let clock=0;
  globalThis.fetch=async()=>stream([{at:1000,text:data({nova_status:{state:"queued",wait_ms:0,position:1}})},{at:200000,text:data({nova_status:{state:"admitted",wait_ms:199000}})},{at:250000,text:delta({tool_calls:[call("host_file_write",{path,content:helper})]})},{at:250001,text:end()}],value=>{clock=value;});
  const result=await complete([],loadConfig(),null,AbortSignal.timeout(5000),{target,tools,toolChoice:"auto",onProviderProgress:()=>{},scratchDraftPolicy:scratchDraftPolicy("Fix src/feature.mjs.",cwd,initialFiles),scratchDraftNow:()=>clock});
  assert.equal(JSON.parse(result.tool_calls[0].function.arguments).content,helper);assert.equal(existsSync(path),false);
});

test("requested production source keeps its8192 request and full arguments after long preceding reasoning",async()=>{
  const cwd=fixture("requested"),path=join(cwd,"src/feature.mjs");let clock=0;
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.max_tokens,8192);return stream(helperFrames(path),value=>{clock=value;});};
  const result=await complete([],loadConfig(),null,AbortSignal.timeout(5000),{target,tools,toolChoice:"required",scratchDraftPolicy:scratchDraftPolicy("Fix src/feature.mjs.",cwd),scratchDraftNow:()=>clock});
  assert.equal(JSON.parse(result.tool_calls[0].function.arguments).content,helper);assert.equal(readFileSync(path,"utf8"),'export const value=1;\n');
});

test("real lead keeps identical ordered tool schemas for named duration recovery and dispatches only its valid command",async()=>{
  const cwd=fixture("lead"),controller=new AbortController(),requests=[],events=[];let clock=0;
  writeFileSync(join(cwd,"quick.cjs"),'console.log("ACTUAL_DURATION_CHECK");\n');
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);assert.equal(body.max_tokens,8192);if(requests.length===1)return stream(slowDraftFrames(join(cwd,"_check.mjs")),value=>{clock=value;});assert.equal(requests.length,2);assert.deepEqual(body.tools,requests[0].tools);assert.deepEqual(body.tool_choice,{type:"function",function:{name:"host_run"}});return stream([{at:52000,text:delta({tool_calls:[call("host_run",{command:"node quick.cjs",cwd})]})},{at:52001,text:end()}],value=>{clock=value;});};
  await assert.rejects(runTurn([],"Fix src/feature.mjs and verify behavior.",e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_run"&&e.detail?.includes("ACTUAL_DURATION_CHECK"))controller.abort();},controller.signal,{sessionId:createSession().id,tools,complete:(m,c,d,s,o)=>{o.scratchDraftPolicy?.initialFiles?.set(join(cwd,"_check.mjs"),false);return complete(m,c,d,s,{...o,target,scratchDraftNow:()=>clock});}}),{name:"AbortError"});
  assert.equal(requests.length,2);assert.equal(events.filter(e=>e.type==="generation_guard"&&e.reason==="duration").length,1);assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_write"));assert.equal(existsSync(join(cwd,"_check.mjs")),false);assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),'export const value=1;\n');
});


test("real SSE mixed response preserves and dispatches completed requested source despite a slow small helper",async()=>{
  const cwd=fixture("mixed-requested"),controller=new AbortController(),events=[],source=join(cwd,"src/feature.mjs");let clock=0,requests=0;
  globalThis.fetch=async(_url,options)=>{requests++;assert.equal(requests,1);assert.equal(JSON.parse(options.body).max_tokens,8192);return stream(helperFrames(join(cwd,"_check.mjs"),source),value=>{clock=value;});};
  await assert.rejects(runTurn([],"Fix src/feature.mjs and verify behavior.",e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_write"&&e.ok)controller.abort();},controller.signal,{sessionId:createSession().id,tools,complete:(m,c,d,s,o)=>complete(m,c,d,s,{...o,target,scratchDraftNow:()=>clock})}),{name:"AbortError"});
  assert.equal(requests,1);assert.equal(events.filter(e=>e.type==="generation_guard").length,0);
  assert.equal(readFileSync(source,"utf8"),'export const value=2; // BUFFERED_REQUESTED_SOURCE\n');assert.equal(existsSync(join(cwd,"_check.mjs")),false,"Stop prevents the later helper, not a duration interruption");
});
