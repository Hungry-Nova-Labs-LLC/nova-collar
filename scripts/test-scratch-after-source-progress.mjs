import assert from "node:assert/strict";
import {after, afterEach, test} from "node:test";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root = realpathSync(mkdtempSync(join(tmpdir(),"collar-stage-")));
process.env.NOVAPUP_HOME=join(root,"profile"); process.env.NP_LAYA_MODEL=join(root,"absent"); process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch; globalThis.fetch=async()=>{throw Error("No native inference/network permitted.");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
const {VerificationLedger}=await import("../src/main/verification-ledger.js");
ensureHome(); const target=chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
setApprovalNotifier(event=>{if(event.type==="approval")resolveApproval(event.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("Unexpected network request.");};});
after(()=>{globalThis.fetch=savedFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,search:false,remote:false}).filter(t=>["host_file_read","host_file_write","host_file_edit","host_run"].includes(t.function.name));
const ask="Fix src/feature.mjs and verify its saved behavior.";
const before="export const value = 1;\n", afterSource="export const value = 2;\n";
const helper='import assert from "node:assert/strict";\nassert.equal(1,1);\n// '+"bounded fixture comment ".repeat(230)+"\n";
const frame=value=>`data: ${JSON.stringify(value)}\n\n`;
const call=(name,args,id=name)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const stream=(calls=[],content="")=>new Response(frame({choices:[{delta:{...(content?{content}:{}),...(calls.length?{tool_calls:calls.map((c,index)=>({index,...c}))}:{})},finish_reason:calls.length?"tool_calls":"stop"}]})+"data: [DONE]\n\n");
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));writeFileSync(join(cwd,"package.json"),'{"type":"module"}\n');writeFileSync(join(cwd,"src/feature.mjs"),before);writeFileSync(join(cwd,"quick.cjs"),'console.log("QUICK_CHECK");\n');setWorkdir(cwd);return cwd;}
function options(cwd,extra={}){return{sessionId:createSession().id,tools,sourcePreload:false,...extra,complete:async(m,c,d,s,o)=>{
  if(o.requestKind==="contract_review")return{content:'{"findings":[],"limitations":["Advisory only."]}',tool_calls:[]};
  o.scratchDraftPolicy?.initialFiles.set(join(cwd,"_large_check.mjs"),false);
  extra.observe?.(o); return complete(m,c,d,s,{...o,target,...(extra.scratchNow?{scratchDraftNow:extra.scratchNow}:{})});
}};}
const edit=()=>call("host_file_edit",{path:"src/feature.mjs",edits:[{oldText:"value = 1",newText:"value = 2"}]});
const read=()=>call("host_file_read",{path:"src/feature.mjs"});
const large=()=>call("host_file_write",{path:"_large_check.mjs",content:helper});

test("actual SSE after a real requested save permits a >4k helper only through its ordinary model tool call",async()=>{
 const cwd=fixture("after-save"),stop=new AbortController(),events=[],policies=[],bodies=[];let n=0;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);bodies.push(b);if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([large()]);stop.abort();throw Object.assign(Error("Stop after bounded fixture"),{name:"AbortError"});};
 await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_write"&&e.ok)stop.abort();},stop.signal,options(cwd,{observe:o=>policies.push(o.scratchDraftPolicy)})),{name:"AbortError"});
 assert.equal(events.filter(e=>e.type==="generation_guard").length,0,JSON.stringify(events.filter(e=>e.type==="generation_guard")));assert.equal(n,3);assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),afterSource);assert.equal(readFileSync(join(cwd,"_large_check.mjs"),"utf8"),helper);
 assert.equal(policies[0]?.enabled,true);assert.equal(policies[1]?.enabled,true);assert.equal(policies[2],undefined);assert(!events.some(e=>e.type==="generation_guard"));
 for(const b of bodies){assert.equal(b.max_tokens,8192);assert.equal(b.options.num_ctx,131072);}assert.deepEqual(bodies[2].tools,bodies[0].tools);
 assert(!events.some(e=>e.verification?.status==="passed"&&["test","runtime","project"].includes(e.verification.phase)),"stage is not behavioral proof");
});

for(const helperOnly of [false,true])test(`actual SSE ${helperOnly?"helper-only save":"pre-progress drafting"} keeps the optional guard`,async()=>{
 const cwd=fixture(helperOnly?"helper-only":"before-save"),stop=new AbortController(),events=[],policies=[];let n=0;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);if(++n===1&&helperOnly)return stream([call("host_file_write",{path:"_small_check.mjs",content:'import assert from "node:assert/strict"; assert.equal(1,1);\n'})]);
 if(n===(helperOnly?2:1))return stream([large()]);assert.equal(b.tool_choice?.function?.name,"host_run");return stream([call("host_run",{command:"node quick.cjs",cwd})]);};
 await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_run")stop.abort();},stop.signal,options(cwd,{observe:o=>policies.push(o.scratchDraftPolicy)})),{name:"AbortError"});
 assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),before);assert.equal(existsSync(join(cwd,"_large_check.mjs")),false);assert(events.some(e=>e.type==="generation_guard"&&e.reason==="characters"));assert(policies.slice(0,helperOnly?2:1).every(p=>p?.enabled===true));assert.equal(policies.at(-1),undefined,"named runner recovery has no offered writer, independently of stage");
});

test("any human steering conservatively restores optional limits after a requested save",async()=>{
 const cwd=fixture("steered"),stop=new AbortController(),events=[],policies=[];let n=0,batch=null,ack=false;
 globalThis.fetch=async(_u,o)=>{const b=JSON.parse(o.body);if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([large()]);assert.equal(b.tool_choice?.function?.name,"host_run");return stream([call("host_run",{command:"node quick.cjs",cwd})]);};
 await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_edit"&&e.ok)batch={messages:[{content:"Please keep the explanation concise."}]};if(e.type==="tool_result"&&e.name==="host_run")stop.abort();},stop.signal,options(cwd,{takeInput:()=>batch,ackInput:()=>{ack=true;batch=null;},observe:o=>policies.push(o.scratchDraftPolicy)})),{name:"AbortError"});
 assert(ack);assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),afterSource);assert.equal(existsSync(join(cwd,"_large_check.mjs")),false);assert.equal(policies[2]?.enabled,true);assert(events.some(e=>e.type==="generation_guard"));
});

test("after progress Stop still discards a fully buffered helper without finishing or writing it",async()=>{
 const cwd=fixture("stop"),stop=new AbortController(),events=[];let n=0,cancelled=false;
 globalThis.fetch=async(_u,o)=>{if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frame({choices:[{delta:{tool_calls:[{index:0,...large()}]}}]})));o.signal.addEventListener("abort",()=>{cancelled=true;try{controller.error(o.signal.reason);}catch{}},{once:true});setTimeout(()=>stop.abort(),10);}}));};
 await assert.rejects(runTurn([],ask,e=>events.push(e),stop.signal,options(cwd)),{name:"AbortError"});assert.equal(n,3);assert(cancelled);assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),afterSource);assert.equal(existsSync(join(cwd,"_large_check.mjs")),false);assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_write"));
});

test("after progress the existing hard handoff still atomically discards an unfinished helper",async()=>{
 const cwd=fixture("hard-end"),events=[];let n=0,cancelled=false;
 globalThis.fetch=async(_u,o)=>{if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frame({choices:[{delta:{tool_calls:[{index:0,...large()}]}}]})));o.signal.addEventListener("abort",()=>{cancelled=true;try{controller.error(o.signal.reason);}catch{}},{once:true});}}));};
 const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(8000),options(cwd,{budgetMs:17000}));
 assert.equal(n,3);assert(cancelled);assert.match(result.assistant,/Incomplete/);assert.equal(readFileSync(join(cwd,"src/feature.mjs"),"utf8"),afterSource);assert.equal(existsSync(join(cwd,"_large_check.mjs")),false);assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_write"));
});

test("real failed-check debt survives a permitted large helper after requested-source progress",async()=>{
 const cwd=fixture("failure-debt"),stop=new AbortController(),events=[];let n=0;
 writeFileSync(join(cwd,"verify.cjs"),'const assert=require("node:assert/strict"); assert.equal(1,2);\n');
 const opts=options(cwd);
 globalThis.fetch=async()=>{if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);if(n===3)return stream([call("host_run",{command:"node verify.cjs",cwd})]);if(n===4)return stream([large()]);stop.abort();throw Object.assign(Error("Unexpected continuation"),{name:"AbortError"});};
 await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_write"&&e.ok)stop.abort();},stop.signal,opts),{name:"AbortError"});
 assert.equal(n,4);assert.equal(readFileSync(join(cwd,"_large_check.mjs"),"utf8"),helper);const debt=new VerificationLedger(opts.sessionId,cwd).unresolved();assert(debt.some(row=>/node verify\.cjs/.test(row.command||row.diagnostic||"")),JSON.stringify(debt));assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&!e.ok));
});


test("after requested progress a compact incomplete helper can cross the optional45s source timer",async()=>{
 const cwd=fixture("after-duration"),stop=new AbortController(),events=[];let n=0,clock=0;
 const compact='import assert from "node:assert/strict";\nassert.equal(1,1);\n// '+"source draft ".repeat(110)+"\n";
 globalThis.fetch=async()=>{if(++n===1)return stream([read()]);if(n===2)return stream([edit()]);
   if(n!==3){stop.abort();throw Object.assign(Error("Unexpected recovery"),{name:"AbortError"});}
   const raw=JSON.stringify({path:"_large_check.mjs",content:compact}),prefix=JSON.stringify({path:"_large_check.mjs",content:"i"}).slice(0,-2);
   const frames=[{at:1000,delta:{tool_calls:[{index:0,id:"duration",type:"function",function:{name:"host_file_write",arguments:prefix}}]}},
    {at:50000,delta:{tool_calls:[{index:0,function:{arguments:raw.slice(prefix.length,-2)}}]}},
    {at:50001,delta:{tool_calls:[{index:0,function:{arguments:raw.slice(-2)}}]},finish_reason:"tool_calls"}];
   return new Response(new ReadableStream({pull(controller){const f=frames.shift();if(!f){controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));controller.close();return;}clock=f.at;controller.enqueue(new TextEncoder().encode(frame({choices:[f]})));}},{highWaterMark:0}));};
 await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_file_write"&&e.ok)stop.abort();},stop.signal,options(cwd,{scratchNow:()=>clock})),{name:"AbortError"});
 assert.equal(events.filter(e=>e.type==="generation_guard").length,0,JSON.stringify(events.filter(e=>e.type==="generation_guard")));assert.equal(n,3);assert.equal(readFileSync(join(cwd,"_large_check.mjs"),"utf8"),compact);assert(!events.some(e=>e.type==="generation_guard"));
});
