import assert from "node:assert/strict";
import {after,afterEach,test} from "node:test";
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),".source-scope-production-"));process.env.NOVAPUP_HOME=join(root,"profile");process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("No native provider/network allowed.");};
const {ensureHome}=await import("../src/main/config.js");const {runTurn}=await import("../src/main/agent.js");const {setWorkdir}=await import("../src/main/workdir.js");const {windowToolDefs}=await import("../src/main/tools.js");const {createSession}=await import("../src/main/sessions.js");const {VerificationLedger}=await import("../src/main/verification-ledger.js");
ensureHome();setWorkdir(root);afterEach(()=>setWorkdir(root));after(()=>{globalThis.fetch=savedFetch;rmSync(root,{recursive:true,force:true});});
const definitions=windowToolDefs({local:true,search:false,remote:false}),tools=definitions.filter(t=>["host_file_read","host_file_write"].includes(t.function.name));const reply=content=>({content,tool_calls:[]});
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,"src"));writeFileSync(join(cwd,"src/a.mjs"),'export const SENTINEL_A=1;\n');writeFileSync(join(cwd,"src/b.mjs"),'export const SENTINEL_B=2;\n');writeFileSync(join(cwd,"package.json"),'{"type":"module"}');setWorkdir(cwd);return cwd;}
const scoped="Fix the implementation as requested. Scope: change only src/a.mjs, src/b.mjs, src/new.mjs. Do not modify README.md or configuration.";

test("actual first request gets allowed Scope source observations before model discovery without action or test credit",async()=>{
  const cwd=fixture("outside-only"),events=[],controller=new AbortController();let requests=0;
  await assert.rejects(runTurn([],`Do not inspect outside the current working directory. ${scoped}`,e=>events.push(e),controller.signal,{sessionId:createSession().id,tools,complete:async(messages,_cfg,_delta,_signal,opts)=>{
    requests++;assert.equal(requests,1);const context=messages.find(row=>String(row.content).startsWith("<initial_source_reads>"));assert(context);assert(context.content.includes("SENTINEL_A"));assert(context.content.includes("SENTINEL_B"));assert.equal(messages.some(row=>row.role==="tool"),false);assert.equal(opts.toolChoice,"required","source reads do not implement the requested changes");controller.abort();return reply("Observed source only.");
  }}),{name:"AbortError"});
  assert.equal(requests,1);assert.equal(events.filter(e=>e.type==="tool_result"&&e.source==="initial_source_preload"&&e.ok).length,2);assert(!events.some(e=>e.verification?.status==="passed"));assert.equal(existsSync(join(cwd,"src/new.mjs")),false);
});

test("actual unknown-restriction first request gets passive Scope metadata but no source, reads, named action or proof",async()=>{
  const cwd=fixture("unknown"),session=createSession(),events=[];let requests=0;
  const result=await runTurn([],`Do not inspect undisclosed reference material or private profile data. ${scoped}`,e=>events.push(e),AbortSignal.timeout(10000),{sessionId:session.id,tools,complete:async(messages,_cfg,_delta,_signal,opts)=>{
    requests++;const hint=messages.find(row=>String(row.content).startsWith("<user_declared_source_scope>"));assert(hint);assert(hint.content.includes("src/new.mjs"));assert(!JSON.stringify(messages).includes("SENTINEL_A"));assert(!messages.some(row=>String(row.content).startsWith("<initial_source_reads>")));assert.equal(opts.toolChoice,"required");assert(opts.contextSections.some(row=>/declared source scope/i.test(row.name)&&/no reads|no read/i.test(row.representation)));return reply("Only the user-declared scope is known; no implementation or check was performed.");
  }});
  assert.equal(requests,3);assert.match(result.assistant,/Incomplete/);assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_read"));assert(!events.some(e=>e.verification?.status==="passed"));assert.equal(existsSync(join(cwd,"src/new.mjs")),false);assert.equal(readFileSync(join(cwd,"src/a.mjs"),"utf8"),'export const SENTINEL_A=1;\n');assert.deepEqual(new VerificationLedger(session.id,cwd).debt(),[],"quoted scope creates neither verification debt nor passing evidence");
});

test("blanket and explicit alias read bans add neither source nor read-planning instruction",async()=>{
  for(const [name,ban]of [["blanket","Do not read any source files."],["alias","Do not inspect '/an/absolute/alias.mjs'."]]){
    const cwd=fixture(name),controller=new AbortController(),events=[];
    await assert.rejects(runTurn([],`${ban} ${scoped}`,e=>events.push(e),controller.signal,{sessionId:createSession().id,tools,complete:async(messages)=>{assert(!messages.some(row=>/^<(?:user_declared_source_scope|initial_source_reads)>/.test(String(row.content))));assert(!JSON.stringify(messages).includes("SENTINEL_A"));controller.abort();return reply("No read was authorized by this observation.");}}),{name:"AbortError"});
    assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_read"));assert.equal(existsSync(join(cwd,"src/new.mjs")),false);
  }
});

test("later human review-only guidance is incorporated before the metadata hint is attached",async()=>{
  const cwd=fixture("steered"),events=[];let polls=0,batch=null,requests=0;
  const result=await runTurn([],`Do not inspect undisclosed reference material. ${scoped}`,e=>events.push(e),AbortSignal.timeout(10000),{sessionId:createSession().id,tools,takeInput:()=>{if(++polls===2)batch={messages:[{content:"Stop editing; review only."}]};return batch;},ackInput:()=>{batch=null;},complete:async(messages,_cfg,_delta,_signal,opts)=>{requests++;assert(!messages.some(row=>String(row.content).startsWith("<user_declared_source_scope>")));assert(!opts.tools.some(t=>t.function.name==="host_file_write"));assert.equal(opts.toolChoice,"auto");return reply("Reviewed the declared scope only.");}});
  assert.equal(requests,1);assert.match(result.assistant,/Reviewed/);assert(!events.some(e=>e.type==="tool"&&e.name==="host_file_read"));assert.equal(existsSync(join(cwd,"src/new.mjs")),false);
});
