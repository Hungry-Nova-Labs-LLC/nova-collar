import assert from "node:assert/strict";
import {after, test} from "node:test";
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {pythonAssertionDriver} from "../src/main/assertion-source.js";
import {authoredAssertionSource} from "../src/main/authored-checks.js";
import {SCRATCH_DRAFT_CHARS, createDraftRecovery, enforceScratchDraftBudget as rawEnforce, scratchDraftPolicy, topLevelDraftStrings} from "../src/main/scratch-draft-budget.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(repo, ".scratch-test-"));
const cwd = join(root, "project"); mkdirSync(cwd);
after(() => rmSync(root, {recursive:true,force:true}));
const pythonPrefix = `import sys\nfailures = []\ndef check(label, passed):\n    if not passed:\n        failures.append(label)\ncheck("addition", 2 + 2 == 4)\ncheck("comparison", 2 < 3)\n`;
const python = pythonPrefix + `if failures:\n    print(failures)\n    sys.exit(1)\nprint("done")\n`;
const longPython = pythonPrefix + "# padding for a nonrequested scratch draft\n".repeat(150) + "if failures:\n    sys.exit(1)\n";
const js = 'import assert from "node:assert/strict";\nassert.equal(4,4);\n' + "// bounded helper padding\n".repeat(230);
const call = (path, content, id="one") => ({id,type:"function",function:{name:"host_file_write",arguments:JSON.stringify({path,content})}});
const calls = (path, content) => new Map([[0,call(path,content)]]);
const policy = ask => scratchDraftPolicy(ask || "Fix src/implementation.py and verify behavior.",cwd);
// Unit-only known metadata over these test-owned cache files. Production uses
// the bounded metadata child, tested separately below.
function enforceScratchDraftBudget(pending,p,extra={}) {
  const pathState=path=>{if(!p.initialFiles.has(path))p.initialFiles.set(path,existsSync(path));return p.initialFiles.get(path);};
  return rawEnforce(pending,p,{pathState,...extra});
}

test("Python custom driver requires function, accumulator, driver calls and failure-dependent exit",()=>{
  assert.equal(pythonAssertionDriver(python),true);
  assert.equal(authoredAssertionSource("arbitrary.py",python),true,"no filename dependency");
  assert.equal(pythonAssertionDriver(pythonPrefix),false,"unfinished source is not final execution intent");
  assert.equal(pythonAssertionDriver(pythonPrefix,{prefix:true}),true);
  assert.equal(pythonAssertionDriver(python.replace('sys.exit(1)','print("no exit")')),false);
  assert.equal(pythonAssertionDriver(python.replace('failures.append(label)','print(label)')),false);
  assert.equal(pythonAssertionDriver(python.replace('check("comparison", 2 < 3)','')),false);
});

test("Python documentation/comments and uncalled library functions are not drivers",()=>{
  assert.equal(pythonAssertionDriver('"""'+python+'"""'),false);
  assert.equal(pythonAssertionDriver(python.split('\n').map(line=>'# '+line).join('\n')),false);
  assert.equal(pythonAssertionDriver(pythonPrefix.split('check("addition"')[0]),false);
  assert.equal(pythonAssertionDriver('def wrapper():\n'+python.split('\n').map(line=>'    '+line).join('\n')),false);
});

test("partial top-level JSON decodes true path/content and ignores code-string/nested fake paths",()=>{
  const source='print(\'{"path":"src/implementation.py"}\')\n';
  const raw=JSON.stringify({meta:{path:'src/implementation.py'},path:'_verify.py',content:source});
  assert.equal(topLevelDraftStrings(raw).path,'_verify.py');
  assert.equal(topLevelDraftStrings(raw).content,source);
  const partial=JSON.stringify({path:'_verify.py',content:source}).slice(0,-2);
  assert.equal(topLevelDraftStrings(partial).path,'_verify.py');
  assert.equal(topLevelDraftStrings(partial).complete,false);
  assert.equal(topLevelDraftStrings('{"path":"src\\u002fimplementation.py","content":"x"}').path,'src/implementation.py');
});

test("ambiguous, non-string, malformed and incomplete path arguments never establish a target",()=>{
  for(const raw of ['{"path":"a.py","path":"b.py","content":"x"}', '{"path":{},"content":"x"}', '{"path":"unfinished', '{"path":"bad\\xescape","content":"x"}', '[]'])assert.equal(topLevelDraftStrings(raw),null,raw);
  assert.equal(topLevelDraftStrings('{"content":"first","path":"_verify.py"}').path,'_verify.py');
});

test("a large new nonrequested assertion driver clears the entire pending response",()=>{
  const pending=new Map([[0,call('src/implementation.py','print("not dispatched")')],[1,call('_verify.py',longPython)]]);
  assert.throws(()=>enforceScratchDraftBudget(pending,policy()),{name:'ScratchDraftBudgetError'});
  assert.equal(pending.size,0,"even earlier complete buffered calls cannot be dispatched");
});

test("small helpers, ordinary production code and existing files preserve full arguments",()=>{
  for(const [path,source]of [['_small.py',python],['generated.py','value = "'+"x".repeat(18000)+'"'],['ordinary.ts','export const value = "'+"x".repeat(18000)+'";']]){
    const pending=calls(path,source),original=pending.get(0).function.arguments;
    enforceScratchDraftBudget(pending,policy());assert.equal(pending.get(0).function.arguments,original);
  }
  writeFileSync(join(cwd,'existing.py'),'# existing user source\n');
  const existing=calls('existing.py',longPython);enforceScratchDraftBudget(existing,policy());assert.equal(existing.size,1);
});

test("requested production/test paths and explicit test authoring retain normal argument budget",()=>{
  for(const ask of ['Fix src/implementation.py and _verify.py.','Create long_checks.py and verify it.','Fix src/implementation.py and write comprehensive regression tests.','Build a large validation driver for src/implementation.py.']){
    const path=ask.includes('long_checks.py')?'long_checks.py':'_verify.py';const pending=calls(path,longPython);enforceScratchDraftBudget(pending,policy(ask));assert.equal(pending.size,1,ask);
  }
  assert.equal(policy('Build a complete application.').enabled,false,"unscoped broad work is conservatively exempt");
});

test("an initially new helper remains subject to budget after its small first write",()=>{
  const p=policy(),name='_new_check.py';enforceScratchDraftBudget(calls(name,python),p);
  writeFileSync(join(cwd,name),python);
  assert.throws(()=>enforceScratchDraftBudget(calls(name,longPython),p),{name:'ScratchDraftBudgetError'});
});

test("outside, secret and symlink-escaped paths earn no new inspection/permission",()=>{
  let deniedChecks=0;
  const outside=calls('../outside_verify.py',longPython);enforceScratchDraftBudget(outside,policy());assert.equal(outside.size,1);
  const secret=calls('_secret_verify.py',longPython);
  enforceScratchDraftBudget(secret,policy(),{denyPath:()=>true,pathState:()=>{deniedChecks++;throw Error('must not inspect denied target');}});
  assert.equal(secret.size,1);assert.equal(deniedChecks,0);
  const elsewhere=join(root,'outside');mkdirSync(elsewhere);symlinkSync(elsewhere,join(cwd,'link'));
  const escaped=calls('link/_verify.py',longPython);enforceScratchDraftBudget(escaped,policy(),{pathState:()=>undefined});assert.equal(escaped.size,1);
});

test("an unfinished Python helper uses both scratch purpose and structural driver evidence",()=>{
  const prefix=pythonPrefix+'# padding\n'.repeat(700);
  assert.throws(()=>enforceScratchDraftBudget(calls('_verify.py',prefix),policy()),{name:'ScratchDraftBudgetError'});
  const unknown=calls('unnamed.py',prefix);enforceScratchDraftBudget(unknown,policy());assert.equal(unknown.size,1,"unknown incomplete source is not enough");
  const filenameOnly=calls('_verify.py','value = "'+"x".repeat(18000)+'"');enforceScratchDraftBudget(filenameOnly,policy());assert.equal(filenameOnly.size,1);
});

test("decoded source count, not JSON escaping, sets the scratch limit",()=>{
  const source=pythonPrefix+'# "\\\n'.repeat(250);
  assert(source.length<SCRATCH_DRAFT_CHARS);const pending=calls('_escaped_verify.py',source);enforceScratchDraftBudget(pending,policy());assert.equal(pending.size,1);
});

// Synthetic SSE transport drives the same production guard. This fixture has
// no provider, app dependency or dispatcher. Calls are returned only after the
// full response; a guard exception cannot expose the prior buffered call.
async function streamed(parts,p,observe=()=>{}) {
  const frames=parts.map(part=>`data: ${JSON.stringify({choices:[{delta:{tool_calls:[part]}}]})}\n\n`);
  frames.push('data: [DONE]\n\n');let pulled=0;
  const response=new Response(new ReadableStream({pull(controller){if(pulled<frames.length)controller.enqueue(new TextEncoder().encode(frames[pulled++]));else controller.close();}}));
  const reader=response.body.getReader(),pending=new Map(),decoder=new TextDecoder();let buffer='';
  try{
    while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){if(!line.startsWith('data: ')||line==='data: [DONE]')continue;const data=JSON.parse(line.slice(6));
        for(const part of data.choices[0].delta.tool_calls){const item=pending.get(part.index)||{id:part.id||'call-'+part.index,function:{name:'',arguments:''}};item.function.name+=part.function?.name||'';item.function.arguments+=part.function?.arguments||'';pending.set(part.index,item);}
        observe(pending);enforceScratchDraftBudget(pending,p);
      }
    }
    return [...pending.values()];
  }finally{await reader.cancel();reader.releaseLock();}
}
function deltas(item,index=0,size=300){const raw=item.function.arguments;const parts=[];for(let i=0;i<raw.length;i+=size)parts.push({index,...(i===0?{id:item.id}:{}),function:{...(i===0?{name:item.function.name}:{}),arguments:raw.slice(i,i+size)}});return parts;}

test("SSE guard stops a new helper before its full source finishes and exposes no prior call",async()=>{
  const early=call('src/implementation.py','print("no dispatch")','prior');const helper=call('_sse_verify.py',longPython);let lastSize=0,pendingRef;
  await assert.rejects(streamed([...deltas(early,0),...deltas(helper,1)],policy(),map=>{pendingRef=map;lastSize=map.get(1)?.function.arguments.length||0;}),{name:'ScratchDraftBudgetError'});
  assert.equal(pendingRef.size,0);assert(lastSize<helper.function.arguments.length);
});

test("SSE keeps a large requested production function argument byte-identical",async()=>{
  const item=call('src/implementation.py',longPython);const output=await streamed(deltas(item),policy());
  assert.equal(output[0].function.arguments,item.function.arguments);
});

test("one scratch recovery uses the same request options and only completed receipts",async()=>{
  let count=0;const emissions=[],list=[{role:'tool',content:'completed stable receipt'}],opts={model:'selected',maxTokens:8192,scratchDraftPolicy:policy()};
  const recovery=createDraftRecovery({checkAbort:()=>{},emit:e=>emissions.push(e),context:()=>"recorded checks only",request:async(_path,messages,_delta,options)=>{
    count++;assert.equal(options.maxTokens,8192);assert.equal(options.model,'selected');
    if(count===1)return streamed(deltas(call('_recovery_verify.py',longPython)),options.scratchDraftPolicy);
    assert.equal(options.noLaneFallback,true);assert.equal(messages[0].content,'completed stable receipt');assert(!JSON.stringify(messages).includes('padding for'));
    return {content:'Incomplete. No available runtime check was established.',tool_calls:[]};
  }});
  const result=await recovery.run('selected-lane',list,()=>{},opts);assert.match(result.content,/Incomplete/);assert.equal(count,2);assert.equal(recovery.recoveryCount,1);assert(emissions.some(e=>e.kind==='scratch_assertion_budget'));
});

test("a second guarded response yields honest Incomplete state with no third request",async()=>{
  let count=0;const recovery=createDraftRecovery({checkAbort:()=>{},request:async()=>{count++;return streamed(deltas(call('_twice_verify.py',longPython)),policy());}});
  assert.equal(await recovery.run('lane',[],()=>{},{maxTokens:8192}),null);assert.equal(count,2);assert.match(recovery.stopReason,/Incomplete.*No calls from either/);
});

test("mixed repetition/scratch guards share one recovery and external Stop prevents retry",async()=>{
  let count=0;const mixed=createDraftRecovery({checkAbort:()=>{},request:async()=>{count++;const e=new Error('guard');e.name=count===1?'ThoughtLoop':'ScratchDraftBudgetError';throw e;}});
  assert.equal(await mixed.run('lane',[],()=>{},{}),null);assert.equal(count,2);
  const stop=new Error('Stopped');stop.name='AbortError';count=0;
  const stopped=createDraftRecovery({checkAbort:()=>{throw stop;},request:async()=>{count++;const e=new Error('guard');e.name='ScratchDraftBudgetError';throw e;}});
  await assert.rejects(stopped.run('lane',[],()=>{},{}),{name:'AbortError'});assert.equal(count,1);
});
