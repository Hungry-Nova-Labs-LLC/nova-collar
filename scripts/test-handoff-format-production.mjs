import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-handoff-")));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No native inference/network permitted.");};
const {runTurn,complete}=await import("../src/main/agent.js");
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {APP_CONTINUATION_CUE}=await import("../src/main/provider-messages.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();const target=chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected native request.");};});
after(()=>{setApprovalNotifier(null);globalThis.fetch=savedFetch;rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>["host_file_read","host_file_write","host_file_edit","host_run"].includes(t.function.name));
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const call=(name,args)=>({id:name,type:"function",function:{name,arguments:JSON.stringify(args)}});
const stream=(calls=[],content="")=>new Response(frame({choices:[{delta:{...(calls.length?{tool_calls:calls.map((c,index)=>({index,...c}))}:{}),...(content?{content}:{})},finish_reason:calls.length?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
const ask="Fix src/feature.mjs and verify the saved behavior.";
const cueCount=body=>body.messages.filter(m=>m.role==="assistant"&&String(m.content).includes("<handoff_format_budget>")).length;
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');writeFileSync(join(cwd,"src/feature.mjs"),"export const value=1;\n");writeFileSync(join(cwd,"README.md"),"Ordinary fixture context.\n");setWorkdir(cwd);return cwd;}
const read=()=>call("host_file_read",{path:"src/feature.mjs"});
const edit=()=>call("host_file_edit",{path:"src/feature.mjs",edits:[{oldText:"value=1",newText:"value=2"}]});
const verify=cwd=>call("host_run",{command:'node --input-type=module -e \'import assert from "node:assert/strict"; import {value} from "./src/feature.mjs"; assert.equal(value,2); console.log("ACTUAL_CHECK_OK")\'',cwd});
const opts=()=>({sessionId:createSession().id,tools,sourcePreload:false,complete:async(m,c,d,s,o)=>o.requestKind==="contract_review"?{content:'{"findings":[],"limitations":["Advisory only."]}',tool_calls:[]}:complete(m,c,d,s,{...o,target})});

test("actual SSE discloses the cap once after requested progress before a first concise handoff",async()=>{
 const cwd=fixture("once"),bodies=[];let n=0;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);bodies.push(b);if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([verify(cwd)]);return stream([],"Saved the requested source revision. Executable assertions printed ACTUAL_CHECK_OK. No project suite was declared.");};
 const result=await runTurn([],ask,()=>{},AbortSignal.timeout(12000),opts());
 assert.equal(n,4);assert.equal(cueCount(bodies[0]),0);assert.equal(cueCount(bodies[1]),0);assert.equal(cueCount(bodies[2]),1);assert.equal(cueCount(bodies[3]),1);assert.match(result.assistant,/ACTUAL_CHECK_OK/);
 for(const b of bodies){assert.equal(b.max_tokens,8192);assert.equal(b.options.num_ctx,131072);assert.equal(b.temperature,0);}assert.deepEqual(bodies[2].tools,bodies[0].tools);assert.equal(bodies[2].messages.at(-1).role,"user");assert.equal(bodies[2].messages.at(-1).content,APP_CONTINUATION_CUE);assert(bodies[2].messages.some(m=>m.role==="assistant"&&String(m.content).includes("<handoff_format_budget>")));
});

test("the formatting cue does not force a handoff or suppress still-needed ordinary tools",async()=>{
 const cwd=fixture("pending-tool"),bodies=[],events=[];let n=0;
 globalThis.fetch=async(_u,o)=>{bodies.push(JSON.parse(o.body));if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([call("host_file_read",{path:"README.md"})]);if(n===4)return stream([verify(cwd)]);return stream([],"Saved the source and inspected the remaining context. Actual assertions printed ACTUAL_CHECK_OK; no project suite was declared.");};
 const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(12000),opts());
 assert.equal(n,5);assert.equal(cueCount(bodies[2]),1);assert.equal(cueCount(bodies[4]),1);assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok));assert.match(result.assistant,/ACTUAL_CHECK_OK/);
});

test("current review-only steering suppresses the optional post-edit note and later writes",async()=>{
 const cwd=fixture("review"),bodies=[],events=[];let n=0,batch=null;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);bodies.push(b);if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);return stream([],"Reviewed the saved source and its recorded syntax check. Behavioral assertions were not run.");};
 const result=await runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_edit"&&e.ok)batch={messages:[{content:"Stop editing; review only."}]};},AbortSignal.timeout(12000),{...opts(),takeInput:()=>batch,ackInput:()=>{batch=null;}});
 assert.equal(n,3);assert.equal(cueCount(bodies[2]),0);assert(!bodies[2].tools.some(t=>t.function.name==="host_file_write"));assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),"export const value=2;\n");assert.match(result.assistant,/Reviewed/);
});

test("ignored formatting still uses the existing bounded content-limited fallback without changing budgets",async()=>{
 const cwd=fixture("ignored"),bodies=[];let n=0;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);bodies.push(b);if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([verify(cwd)]);if(n===4)return stream([],"Unnecessarily long narrative. ".repeat(130));return stream([],"Saved the source revision. Actual assertions printed ACTUAL_CHECK_OK; no project suite was declared.");};
 const result=await runTurn([],ask,()=>{},AbortSignal.timeout(12000),opts());
 assert.equal(n,5);assert.equal(cueCount(bodies[4]),1);assert(bodies[4].messages.some(m=>m.role==="user"&&String(m.content).includes("at most four short sentences")));assert(bodies.every(b=>b.max_tokens===8192));assert.match(result.assistant,/ACTUAL_CHECK_OK/);
});
