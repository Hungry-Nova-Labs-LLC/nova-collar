import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";

const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),".scratch-run-production-"));
process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
for(const key of ["HNL_FAST_URL","HNL_FAST_MODEL","HNL_THINK_URL","HNL_THINK_MODEL","HNL_CHAT_KEY","HNL_TOOLS_KEY"])process.env[key]="";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No real provider/network allowed.");};
const {ensureHome,loadConfig,chatTarget}=await import("../src/main/config.js");
const {runTurn}=await import("../src/main/agent.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createSession}=await import("../src/main/sessions.js");
const {VerificationLedger}=await import("../src/main/verification-ledger.js");
const {listCheckpoints}=await import("../src/main/checkpoints.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setWorkdir(root);const target=chatTarget(loadConfig());
const profile={version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]};
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify(profile));
setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
afterEach(()=>{globalThis.fetch=async()=>{throw Error("No real provider.");};setWorkdir(root);});
after(()=>{setApprovalNotifier(null);globalThis.fetch=savedFetch;rmSync(root,{recursive:true,force:true});});
const definitions=windowToolDefs({local:true,remote:false,search:false}),tools=definitions.filter(t=>["host_file_read","host_file_write","host_run"].includes(t.function.name));
const prefix='import sys\nfailures=[]\ndef check(name, passed):\n    if not passed:\n        failures.append(name)\ncheck("one", True)\ncheck("two", True)\n';
const helper=prefix+"# unrequested helper padding\n".repeat(500)+"if failures:\n    sys.exit(1)\n";
const data=delta=>`data: ${JSON.stringify({choices:[{delta}]})}\n\n`;
const done=text=>data({content:text})+'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
function calls(rows){let text="";rows.forEach((row,index)=>{const args=JSON.stringify(row.args);for(let at=0;at<args.length;at+=250)text+=data({tool_calls:[{index,...(at===0?{id:`call-${index}`,type:"function"}:{}),function:{...(at===0?{name:row.name}:{}),arguments:args.slice(at,at+250)}}]});});return text+'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';}
const write=(path,content)=>({name:"host_file_write",args:{path,content}}),run=(command,cwd)=>({name:"host_run",args:{command,cwd}});
const loop=()=>data({reasoning_content:"Synthetic repeat marker. ".repeat(30)});
function fixture(name,{declared=false,fail=false}={}){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));setWorkdir(cwd);writeFileSync(join(cwd,"src/feature.mjs"),'export const value = 1;\n');writeFileSync(join(cwd,"package.json"),JSON.stringify({type:"module",...(declared?{scripts:{test:"node check.cjs"}}:{})}));writeFileSync(join(cwd,"check.cjs"),`const fs=require('node:fs');const assert=require('node:assert/strict');assert.match(fs.readFileSync('src/feature.mjs','utf8'),/value = ${fail?3:2}/);console.log('REAL_PROJECT_CHECK');\n`);return cwd;}
function provider(respond){const requests=[];globalThis.fetch=async(url,options)=>{assert.equal(String(url),`${target.url}/chat/completions`);const body=JSON.parse(options.body);requests.push(body);assert.equal(body.model,target.model);assert.equal(body.max_tokens,8192);assert.equal(body.options.num_predict,8192);assert.equal(body.options.num_ctx,131072);return new Response(respond(body,requests.length));};return requests;}
const ask="Fix src/feature.mjs and verify behavior using an existing supported check.";

// Queue real neutral human input only after the actual requested-source save.
// This keeps source-first interruption tests on the guard-retained path without
// changing runtime flags or swallowing separately queued later review guidance.
function guardedAfterSavedSource(cwd,{takeInput,ackInput}={}){
  const source=join(cwd,"src/feature.mjs");let neutral=null,queued=false,acknowledged=0;
  return{
    observe(event){
      if(!queued&&event.type==="tool_result"&&event.name==="host_file_write"&&event.ok
        &&readFileSync(source,"utf8")==='export const value = 2;\n'){
        queued=true;neutral={messages:[{content:"Please keep the explanation concise."}]};
      }
    },
    options:{takeInput:async()=>neutral||await takeInput?.(),ackInput:async(batch)=>{
      if(neutral&&batch===neutral){neutral=null;acknowledged++;return;}
      await ackInput?.(batch);
    }},
    assertApplied(events){
      assert.equal(queued,true,"neutral guidance follows an actual saved requested-source result");
      assert.equal(acknowledged,1,"neutral guidance is incorporated exactly once");
      assert.equal(events.filter(e=>e.type==="generation_guard"&&e.kind==="scratch_assertion_budget"&&e.reason==="characters").length,1,"this fixture must actually enter the retained scratch guard");
    }
  };
}


test("first scratch interruption redirects one real SSE recovery to a runner and never replays buffered writes",async()=>{
  const cwd=fixture("redirect"),events=[],controller=new AbortController(),source=join(cwd,"src/feature.mjs");let originalTools;writeFileSync(join(cwd,"quick.cjs"),'console.log("ACTUAL_CHECK_OUTPUT");\n');
  const requests=provider((body,n)=>{
    if(n===1){originalTools=structuredClone(body.tools);return calls([write(source,'export const value = 2;\n'),write(join(cwd,"_verify.py"),helper)]);}
    if(n===2){assert.deepEqual(body.tool_choice,{type:"function",function:{name:"host_run"}});assert.deepEqual(body.tools,originalTools,"keep the actual ordered catalog including app context tools");return calls([run("node quick.cjs",cwd)]);}
    assert(n<8,"no unbounded recovery");return done("The actual check printed ACTUAL_CHECK_OUTPUT; no source change was saved.");
  });
  await assert.rejects(runTurn([],ask,e=>{events.push(e);if(e.type==="tool_result"&&e.name==="host_run"&&e.detail?.includes("ACTUAL_CHECK_OUTPUT"))controller.abort();},controller.signal,{sessionId:createSession().id,tools}),{name:"AbortError"});
  assert.equal(readFileSync(source,"utf8"),'export const value = 1;\n');assert.equal(existsSync(join(cwd,"_verify.py")),false);
  assert.equal(events.filter(e=>e.type==="tool"&&e.name==="host_file_write").length,0);
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok&&e.detail?.includes("ACTUAL_CHECK_OUTPUT")));
  assert.equal(requests.length,2);assert(!JSON.stringify(requests[1].messages).includes("unrequested helper padding"));assert.equal(requests.filter(b=>b.tool_choice?.function?.name==="host_run").length,1);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),"utf8")),profile);
});

test("a wrong or multi-call named recovery response dispatches no tool from that response",async()=>{
  const cwd=fixture("wrong-batch"),events=[];
  const requests=provider((_body,n)=>n===1?calls([write(join(cwd,"_verify.py"),helper)]):calls([run("node quick.cjs",cwd),write(join(cwd,"unrequested.mjs"),"UNEXECUTED_RECOVERY_PAYLOAD")]));
  const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools});
  assert.equal(requests.length,2);assert.match(result.assistant,/Incomplete/);assert.equal(existsSync(join(cwd,"unrequested.mjs")),false);assert(!events.some(e=>e.type==="tool"&&["host_run","host_file_write"].includes(e.name)));assert(!JSON.stringify(result.messages).includes("UNEXECUTED_RECOVERY_PAYLOAD"));
});

test("new review-only guidance discards the named runner response before dispatch",async()=>{
  const cwd=fixture("runner-steering"),events=[];let batch=null;
  const requests=provider((body,n)=>{
    if(n===1)return calls([write(join(cwd,"_verify.py"),helper)]);
    if(n===2){assert.equal(body.tool_choice.function.name,"host_run");batch={messages:[{content:"Stop editing; review only."}]};return calls([run("node check.cjs",cwd)]);}
    assert(!body.tools?.some(tool=>tool.function.name==="host_file_write"));assert.notEqual(body.tool_choice?.function?.name,"host_run");return done("Reviewed the existing observations; no new command was executed.");
  });
  const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,takeInput:()=>batch,ackInput:()=>{batch=null;}});
  assert.equal(requests.length,3);assert(!events.some(e=>e.type==="tool"&&e.name==="host_run"));assert.match(result.assistant,/Reviewed/);
});

for(const mode of ["passed","failed","unavailable"]){
  test(`two interrupted responses settle ${mode} pending project evidence without another model request`,async()=>{
    const cwd=fixture(`project-${mode}`,{declared:mode!=="unavailable",fail:mode==="failed"}),session=createSession(),events=[],guidance=guardedAfterSavedSource(cwd);
    const requests=provider((_body,n)=>n===1?calls([write(join(cwd,"src/feature.mjs"),'export const value = 2;\n')]):n===2?calls([write(join(cwd,"_verify.py"),helper)]):loop());
    const result=await runTurn([],ask,e=>{events.push(e);guidance.observe(e);},AbortSignal.timeout(20000),{sessionId:session.id,tools,...guidance.options});
    guidance.assertApplied(events);
    assert.equal(requests.length,3);assert.match(result.assistant,/^Incomplete\./);assert.equal(existsSync(join(cwd,"_verify.py")),false);
    const ledger=new VerificationLedger(session.id,cwd),project=[...ledger.entries.values()].find(row=>row.kind==="project");assert.equal(project.status,mode);
    const checks=events.filter(e=>e.type==="tool_result"&&e.name==="harness"&&e.verification?.phase==="project");assert.equal(checks.length,1);
    assert(events.findIndex(e=>e.type==="checkpoint")>events.findIndex(e=>e===checks[0]),"checkpoint/archive cleanup follows settled project evidence");
    if(mode==="failed")assert(ledger.debt().some(text=>/project/.test(text)));if(mode==="unavailable")assert.equal(checks[0].unavailable,true);
  });
}

test("queued review-only guidance before interrupted settlement prevents project commands",async()=>{
  const cwd=fixture("steered",{declared:true}),session=createSession(),events=[];let batch=null;
  const guidance=guardedAfterSavedSource(cwd,{takeInput:()=>batch,ackInput:()=>{batch=null;}});
  const requests=provider((_body,n)=>{if(n===1)return calls([write(join(cwd,"src/feature.mjs"),'export const value = 2;\n')]);if(n===2)return calls([write(join(cwd,"_verify.py"),helper)]);batch={messages:[{content:"Stop editing; review only."}]};return loop();});
  const result=await runTurn([],ask,e=>{events.push(e);guidance.observe(e);},AbortSignal.timeout(15000),{sessionId:session.id,tools,...guidance.options});
  guidance.assertApplied(events);
  assert.equal(requests.length,3);assert.match(result.assistant,/Incomplete/);assert(!events.some(e=>e.type==="tool_result"&&e.verification?.phase==="project"));
  assert.notEqual([...new VerificationLedger(session.id,cwd).entries.values()].find(row=>row.kind==="project")?.status,"passed");
});

test("Stop during the guarded retry aborts without project settlement or extra inference",async()=>{
  const cwd=fixture("stopped",{declared:true}),controller=new AbortController(),events=[],guidance=guardedAfterSavedSource(cwd);
  const requests=provider((_body,n)=>n===1?calls([write(join(cwd,"src/feature.mjs"),'export const value = 2;\n')]):n===2?calls([write(join(cwd,"_verify.py"),helper)]):loop());
  await assert.rejects(runTurn([],ask,e=>{events.push(e);guidance.observe(e);if(requests.length===3&&e.type==="think")controller.abort();},controller.signal,{sessionId:createSession().id,tools,...guidance.options}),{name:"AbortError"});
  guidance.assertApplied(events);
  assert.equal(requests.length,3);assert(!events.some(e=>e.type==="tool_result"&&e.verification?.phase==="project"));
});


test("Stop during actual interrupted project settlement closes the checkpoint as cancelled after the check starts",async()=>{
  const cwd=fixture("settlement-stop",{declared:true}),session=createSession(),controller=new AbortController(),events=[],guidance=guardedAfterSavedSource(cwd);
  writeFileSync(join(cwd,"check.cjs"),'const fs=require("node:fs");fs.writeFileSync("CHECK_STARTED","started");setTimeout(()=>{fs.writeFileSync("CHECK_FINISHED","finished");},1000);\n');
  const requests=provider((_body,n)=>n===1?calls([write(join(cwd,"src/feature.mjs"),'export const value = 2;\n')]):n===2?calls([write(join(cwd,"_verify.py"),helper)]):loop());
  let checkpointSawStarted=false;
  const ticker=setInterval(()=>{if(existsSync(join(cwd,"CHECK_STARTED")))controller.abort();},10),rescue=setTimeout(()=>controller.abort(),5000);
  try {
    await assert.rejects(runTurn([],ask,e=>{events.push(e);guidance.observe(e);if(e.type==="checkpoint")checkpointSawStarted=existsSync(join(cwd,"CHECK_STARTED"));},controller.signal,{sessionId:session.id,tools,...guidance.options}),{name:"AbortError"});
  } finally {clearInterval(ticker);clearTimeout(rescue);}
  guidance.assertApplied(events);
  assert.equal(requests.length,3);assert.equal(checkpointSawStarted,true,"cleanup must not run before settlement starts");
  assert.equal(listCheckpoints(session.id)[0]?.reason,"cancelled");assert.equal(existsSync(join(cwd,"CHECK_FINISHED")),false);
});
