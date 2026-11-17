import assert from "node:assert/strict";
import {after, afterEach, test} from "node:test";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {scratchDraftPolicy} from "../src/main/scratch-draft-budget.js";

const repo=dirname(dirname(fileURLToPath(import.meta.url))),root=mkdtempSync(join(repo,".production-scratch-test-"));
process.env.NOVAPUP_HOME=join(root,"profile");mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Network/inference forbidden in fixture");};
const {complete,runTurn}=await import("../src/main/agent.js");
const {ensureHome}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {createSession}=await import("../src/main/sessions.js");
ensureHome();
const target={url:"http://127.0.0.1:19001/v1",model:"fixture-scratch-model",key:"fixture",local:true};
writeFileSync(join(process.env.NOVAPUP_HOME,"model-settings.json"),JSON.stringify({version:1,profiles:[{url:target.url,model:target.model,contextTokens:131072,outputTokens:8192,temperature:0,reasoning:true}]}));
const tools=windowToolDefs({local:true,search:false,remote:false}).filter(x=>["host_file_read","host_file_write","host_run"].includes(x.function.name));
const prefix=`import sys\nfailures=[]\ndef check(name, passed):\n    if not passed:\n        failures.append(name)\ncheck("one", 1==1)\ncheck("two", 2==2)\n`;
const helper=prefix+"# large scratch draft padding\n".repeat(400)+"if failures:\n    sys.exit(1)\n";
const args=(path,content)=>JSON.stringify({path,content});
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);mkdirSync(join(cwd,'src'));writeFileSync(join(cwd,'package.json'),'{"type":"module"}');setWorkdir(cwd);return cwd;}
function sse(items,{delay=1,onCancel=()=>{}}={}){
  const frames=[];
  items.forEach((item,index)=>{for(let at=0;at<item.arguments.length;at+=250)frames.push(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index,...(at===0?{id:'call-'+index}:{}),function:{...(at===0?{name:item.name}:{}),arguments:item.arguments.slice(at,at+250)}}]}}]})}\n\n`);});
  frames.push('data: [DONE]\n\n');let i=0,cancelled=false;
  return new Response(new ReadableStream({async pull(c){if(delay)await new Promise(r=>setTimeout(r,delay));if(cancelled)return;if(i<frames.length)c.enqueue(new TextEncoder().encode(frames[i++]));else c.close();},cancel(){cancelled=true;onCancel();}}));
}
afterEach(()=>{globalThis.fetch=async()=>{throw Error("No live provider");};});
after(()=>{globalThis.fetch=nativeFetch;rmSync(root,{recursive:true,force:true});});

test("actual complete cancels oversized helper SSE and never returns an earlier complete buffered call",async()=>{
  const cwd=fixture('atomic-complete');let cancelled=false,requests=0;
  globalThis.fetch=async(_url,init)=>{requests++;const body=JSON.parse(init.body);assert.equal(body.max_tokens,8192);assert.equal(body.options.num_predict,8192);
    return sse([{name:'host_file_write',arguments:args('src/implementation.py','print("not dispatched")')},{name:'host_file_write',arguments:args('_verify.py',helper)}],{onCancel:()=>{cancelled=true;}});
  };
  await assert.rejects(complete([],{home:process.env.NOVAPUP_HOME},()=>{},null,{target,tools,toolChoice:'auto',scratchDraftPolicy:scratchDraftPolicy('Implement src/implementation.py and verify behavior.',cwd)}),{name:'ScratchDraftBudgetError'});
  assert.equal(cancelled,true);assert.equal(requests,1);assert.equal(existsSync(join(cwd,'src/implementation.py')),false);
});

test("actual complete preserves large requested source/test arguments and8192 profile budget",async()=>{
  const cwd=fixture('requested'),payload=args('src/implementation.py',helper);let requests=0;
  globalThis.fetch=async(_url,init)=>{requests++;const body=JSON.parse(init.body);assert.equal(body.max_tokens,8192);assert.equal(body.options.num_predict,8192);return sse([{name:'host_file_write',arguments:payload}],{delay:0});};
  const reply=await complete([],{home:process.env.NOVAPUP_HOME},()=>{},null,{target,tools,toolChoice:'required',scratchDraftPolicy:scratchDraftPolicy('Write comprehensive tests in src/implementation.py.',cwd)});
  assert.equal(reply.tool_calls[0].function.arguments,payload);assert.equal(requests,1);
});

test("actual runTurn redirects one guard recovery and discards a nonmatching complete response",async()=>{
  const cwd=fixture('actual-turn');let requests=0,originalTools;const events=[];
  globalThis.fetch=async(_url,init)=>{requests++;assert(requests<=2,'no third guarded-response model request');const body=JSON.parse(init.body);assert.equal(body.max_tokens,8192);
    if(requests===1)originalTools=structuredClone(body.tools);
    if(requests===2){assert.deepEqual(body.tool_choice,{type:'function',function:{name:'host_run'}});assert.deepEqual(body.tools,originalTools,'preserve the entire ordered actual catalog, including context tools');}
    return sse([{name:'host_file_write',arguments:args(join(cwd,'src/implementation.py'),'print("not dispatched")')},{name:'host_file_write',arguments:args(join(cwd,'_verify.py'),helper)}]);
  };
  const result=await runTurn([],'Implement src/implementation.py and verify behavior.',e=>events.push(e),AbortSignal.timeout(10000),{
    sessionId:createSession().id,tools,complete:(messages,cfg,onDelta,signal,opts)=>complete(messages,cfg,onDelta,signal,{...opts,target}),
  });
  assert.equal(requests,2);assert.match(result.assistant,/^Incomplete\./);assert.match(result.assistant,/no operation from that response was dispatched/);
  assert.equal(existsSync(join(cwd,'src/implementation.py')),false);assert.equal(existsSync(join(cwd,'_verify.py')),false);
  assert.equal(events.filter(e=>e.type==='generation_guard').length,1);
  assert(!events.some(e=>e.type==='tool'&&e.name==='host_file_write'));
  assert(!JSON.stringify(result.messages).includes('large scratch draft padding'),'no partial arguments or prior response replay');
});

test("actual complete honors Stop without dispatch or guard-driven retry",async()=>{
  const cwd=fixture('stop'),controller=new AbortController();let requests=0,cancelled=false;
  globalThis.fetch=async()=>{requests++;setTimeout(()=>controller.abort(),15);return sse([{name:'host_file_write',arguments:args('_verify.py',helper)}],{delay:5,onCancel:()=>{cancelled=true;}});};
  await assert.rejects(complete([],{home:process.env.NOVAPUP_HOME},()=>{},controller.signal,{target,tools,scratchDraftPolicy:scratchDraftPolicy('Implement src/implementation.py.',cwd)}),{name:'AbortError'});
  assert.equal(requests,1);assert.equal(cancelled,true);assert.equal(existsSync(join(cwd,'_verify.py')),false);
});

for (const blocked of [
  {name:'unoffered-writer', requestTools:tools.filter(t=>t.function.name!=='host_file_write')},
  {name:'unknown-tool-catalog', requestTools:undefined},
  {name:'malformed-writer-schema', requestTools:[{type:'function',function:{name:'host_file_write',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'number'}},required:['path','content']}}}]},
  {name:'duplicate-writer-schema', requestTools:[...tools,tools.find(t=>t.function.name==='host_file_write')]},
  {name:'other-named-tool', requestTools:tools, toolChoice:{type:'function',function:{name:'host_run'}}},
  ...[
    {name:'path-enum', field:'path', constraint:{enum:['src/implementation.py']}},
    {name:'path-const', field:'path', constraint:{const:'src/implementation.py'}},
    {name:'path-pattern', field:'path', constraint:{pattern:'^src/'}},
    {name:'content-maxLength', field:'content', constraint:{maxLength:100}},
    {name:'extra-required', required:['path','content','approval']},
    {name:'closed-extra-keys-schema', root:{additionalProperties:false}},
    {name:'unknown-root-constraint', root:{allOf:[{properties:{path:{const:'src/implementation.py'}}}]}},
  ].map(item=>({name:item.name,requestTools:[{type:'function',function:{name:'host_file_write',parameters:{
    type:'object',properties:{path:{type:'string',...(item.field==='path'?item.constraint:{})},content:{type:'string',...(item.field==='content'?item.constraint:{})}},
    required:item.required||['path','content'],...item.root,
  }}}]})),
  {name:'phone-role', requestTools:tools, role:'phone'},
  {name:'remote-stage', requestTools:tools, remote:true},
]) test(`actual complete performs zero path probes for ${blocked.name}`,async()=>{
  const cwd=fixture('no-probe-'+blocked.name),initialFiles=new Map(),policy=scratchDraftPolicy('Implement src/implementation.py.',cwd,initialFiles);
  globalThis.fetch=async()=>sse([{name:'host_file_write',arguments:args('_verify.py',helper)}],{delay:0});
  // An explicitly absent tool catalog is sent as [] so complete's ordinary
  // default catalog is not mistaken for an absent request capability.
  const reply=await complete([],{home:process.env.NOVAPUP_HOME},()=>{},null,{target,tools:blocked.requestTools??[],
    role:blocked.role,remote:blocked.remote,toolChoice:blocked.toolChoice,scratchDraftPolicy:policy});
  assert.equal(initialFiles.size,0,'no pathState call and no metadata probe');
  assert.equal(reply.tool_calls.length,1,'untrusted call remains for ordinary dispatcher rejection, never dispatched here');
  assert.equal(existsSync(join(cwd,'_verify.py')),false);
});

for (const blocked of [
  {name:'only-shell-permitted', requestTools:tools.filter(t=>t.function.name!=='host_file_write')},
  {name:'phone-role', requestTools:tools, role:'phone'},
  {name:'remote-edit', requestTools:tools, ask:'Implement src/implementation.py on the remote computer and verify behavior.'},
  {name:'malformed-schema', requestTools:[{type:'function',function:{name:'host_file_write',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}}]},
]) test(`actual runTurn disables scratch policy before complete for ${blocked.name}`,async()=>{
  const cwd=fixture('no-turn-probe-'+blocked.name),controller=new AbortController();let observed=0;
  globalThis.fetch=async()=>sse([{name:'host_file_write',arguments:args('_verify.py',helper)}],{delay:0});
  await assert.rejects(runTurn([],blocked.ask||'Implement src/implementation.py and verify behavior.',()=>{},controller.signal,{
    sessionId:createSession().id,tools:blocked.requestTools,role:blocked.role,
    complete:async(messages,cfg,onDelta,signal,opts)=>{
      observed++;assert.equal(opts.scratchDraftPolicy,undefined,'no optional local metadata capability');
      const reply=await complete(messages,cfg,onDelta,signal,{...opts,target});
      controller.abort();return reply;
    },
  }),{name:'AbortError'});
  assert.equal(observed,1);assert.equal(existsSync(join(cwd,'_verify.py')),false);
});
