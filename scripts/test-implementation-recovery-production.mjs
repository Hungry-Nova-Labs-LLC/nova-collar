import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'collar-write-recovery-'));
process.env.NOVAPUP_HOME=join(root,'profile');
process.env.NP_LAYA_MODEL=join(root,'absent-model');
process.env.HNL_MODEL='local-3.8';process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('No provider/network allowed in this fixture');};
const {ensureHome}=await import('../src/main/config.js');
const {setWorkdir}=await import('../src/main/workdir.js');
const {runTurn}=await import('../src/main/agent.js');
const {createHarness}=await import('../src/main/harness.js');
const {createSession}=await import('../src/main/sessions.js');
const {windowToolDefs}=await import('../src/main/tools.js');
const {setApprovalNotifier,resolveApproval}=await import('../src/main/approvals.js');
ensureHome();setApprovalNotifier(e=>{if(e.type==='approval')resolveApproval(e.request.id,true);});
after(()=>{setApprovalNotifier(null);globalThis.fetch=savedFetch;rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false}).filter(t=>['host_file_read','host_file_write','host_run'].includes(t.function.name));
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(content='',tool_calls=[])=>({content,tool_calls});
function fixture(name){const dir=join(root,name);mkdirSync(dir);setWorkdir(dir);writeFileSync(join(dir,'package.json'),'{"type":"module"}\n');writeFileSync(join(dir,'existing.mjs'),'export const previous = 1;\n');return dir;}
const ask='Read existing.mjs. Add result.mjs exporting answer(). Verify it locally.';

test('the real dispatcher requests one named mutation after limited implementation prose, then observes real checks',async()=>{
 const dir=fixture('positive');let requests=0,reviewRequests=0,named=0;const events=[];
 const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(20000),{sessionId:createSession().id,tools,complete:async(_m,_c,_d,_s,opts)=>{
  if(opts.requestKind==='contract_review'){reviewRequests++;return reply(JSON.stringify({findings:[],limitations:['This advisory reply is not execution proof.']}));}
  if(++requests===1)return reply('',[call('host_file_read',{path:join(dir,'existing.mjs')},'read')]);
  if(requests===2)return {...reply('A long implementation proposal'),content_limited:true};
  if(requests===3){assert.equal(opts.toolChoice.function.name,'host_file_write');named++;return reply('',[call('host_file_write',{path:'result.mjs',content:'export function answer(){return 42;}\n'},'write')]);}
  if(requests===4)return reply('',[call('host_run',{command:'node --input-type=module -e \'import assert from "node:assert/strict"; import {answer} from "./result.mjs"; assert.equal(answer(),42); console.log("BEHAVIOR_OK")\'',cwd:dir},'check')]);
  return reply('Saved result.mjs and observed BEHAVIOR_OK from the executable assertions. No declared project test suite was available.');
 }});
 assert.equal(named,1);assert.equal(existsSync(join(dir,'result.mjs')),true);
 assert(events.some(e=>e.type==='tool_result'&&e.name==='host_run'&&e.ok&&e.detail?.includes('BEHAVIOR_OK')));
 assert.match(result.assistant,/BEHAVIOR_OK/);assert.equal(requests,5);assert(reviewRequests<=1,'at most one separate advisory call; baseline source5 has none');
});

test('a named response cannot smuggle a second write or change the required target',async()=>{
 const dir=fixture('wrong-batch');let requests=0;const events=[];
 const result=await runTurn([],ask,e=>events.push(e),AbortSignal.timeout(15000),{sessionId:createSession().id,tools,complete:async()=>{
  if(++requests===1)return reply('',[call('host_file_read',{path:join(dir,'existing.mjs')},'read')]);
  if(requests===2)return {...reply('An implementation proposal'),content_limited:true};
  if(requests===3)return reply('',[call('host_file_write',{path:'result.mjs',content:'export function answer(){return 42;}'},'allowed'),call('host_file_write',{path:'unrequested.mjs',content:'bad'},'extra')]);
  return reply('No implementation was performed after the rejected response.');
 }});
 assert(requests>3&&requests<=8);assert.equal(existsSync(join(dir,'result.mjs')),false);assert.equal(existsSync(join(dir,'unrequested.mjs')),false);
 assert(!events.some(e=>e.type==='tool'&&e.name==='host_file_write'));
 assert.match(result.assistant,/Incomplete|FAIL/);
});

test('new human review-only guidance cancels the queued named recovery before another request',async()=>{
 const dir=fixture('steering');let requests=0,batch=null,limitedProduced=false,afterLimitedPolls=0;
 const result=await runTurn([],ask,()=>{},AbortSignal.timeout(15000),{sessionId:createSession().id,tools,takeInput:()=>{if(limitedProduced&&++afterLimitedPolls===2)batch={messages:[{content:'Stop editing; review only.'}]};return batch;},ackInput:()=>{batch=null;},complete:async(_m,_c,_d,_s,opts)=>{
  if(++requests===1)return reply('',[call('host_file_read',{path:join(dir,'existing.mjs')},'read')]);
  if(requests===2){limitedProduced=true;return {...reply('An implementation proposal'),content_limited:true};}
  assert.notEqual(opts.toolChoice?.function?.name,'host_file_write');
  assert(!opts.tools?.some(t=>t.function.name==='host_file_write'));
  return reply('Reviewed the current state; no implementation was saved.');
 }});
 assert.equal(existsSync(join(dir,'result.mjs')),false);assert.match(result.assistant,/Reviewed/);
});


test('a prose-only named response consumes one attempt and ordinary no-action replies remain bounded',async()=>{
 const dir=fixture('named-prose');let requests=0,named=0;
 const result=await runTurn([],ask,()=>{},AbortSignal.timeout(15000),{sessionId:createSession().id,tools,complete:async(_m,_c,_d,_s,opts)=>{
  if(++requests===1)return reply('',[call('host_file_read',{path:join(dir,'existing.mjs')},'read')]);
  if(requests===2)return {...reply('An implementation proposal'),content_limited:true};
  if(requests===3){assert.equal(opts.toolChoice.function.name,'host_file_write');named++;}
  else assert.equal(typeof opts.toolChoice,'string');
  return reply('More implementation prose, without a file operation.');
 }});
 assert.equal(named,1);assert(requests>3&&requests<=8);assert.equal(existsSync(join(dir,'result.mjs')),false);
 assert.match(result.assistant,/Incomplete|FAIL/);
});


test('recoveryFiles returns only positively requested missing files using bounded metadata probes',async()=>{
 const dir=fixture('missing-metadata');
 const gate=createHarness({ask:'Add src/deep/result.mjs. Keep existing.mjs unchanged.'});
 assert.deepEqual(await gate.recoveryFiles(),[join(dir,'src/deep/result.mjs')]);
});

test('protected missing descendants cannot be selected through a symlink parent alias',async()=>{
 const dir=fixture('protected-alias');mkdirSync(join(dir,'real'));symlinkSync(join(dir,'real'),join(dir,'alias'));
 const gate=createHarness({ask:'Add alias/deep/new.mjs. Do not change real/deep/new.mjs.'});
 assert.deepEqual(await gate.recoveryFiles(),[]);
});

test('outside and dangling parent aliases are unavailable rather than missing-file authority',async()=>{
 const dir=fixture('outside-alias'),outside=join(root,'other-project');mkdirSync(outside);
 symlinkSync(outside,join(dir,'external'));symlinkSync(join(root,'absent-project'),join(dir,'dangling'));
 const gate=createHarness({ask:'Add external/new.mjs and dangling/new.mjs.'});
 assert.deepEqual(await gate.recoveryFiles(),[]);
});

test('existing, negative, verifier and suspended targets never become new-file recovery candidates',async()=>{
 const dir=fixture('existing-negative');
 const gate=createHarness({ask:'Update existing.mjs. Do not add forbidden.mjs. Add harness-check.js.'});
 assert.deepEqual(await gate.recoveryFiles(),[]);
 gate.setRequireEdits(false);assert.deepEqual(await gate.recoveryFiles(),[]);
});

test('an actual attached preload can ground named recovery without receiving implementation credit',async()=>{
 const dir=fixture('preloaded-named');let requests=0,reviews=0,named=0;const events=[];
 const result=await runTurn([],'Fix existing.mjs and add result.mjs exporting answer(). Verify both locally.',e=>events.push(e),AbortSignal.timeout(20000),{sessionId:createSession().id,tools,complete:async(messages,_c,_d,_s,opts)=>{
  if(opts.requestKind==='contract_review'){reviews++;return reply('{"findings":[],"limitations":[]}');}
  if(++requests===1){assert(messages.some(m=>m.content?.startsWith?.('<initial_source_reads>')));assert.equal(opts.toolChoice,'required');return {...reply('An implementation proposal'),content_limited:true};}
  if(requests===2){assert.equal(opts.toolChoice.function.name,'host_file_write');named++;return reply('',[call('host_file_write',{path:'result.mjs',content:'export function answer(){return 42;}\n'},'named')]);}
  if(requests===3)return reply('',[call('host_file_write',{path:'existing.mjs',content:'export const previous = 2;\n'},'existing')]);
  if(requests===4)return reply('',[call('host_run',{command:'node --input-type=module -e \'import assert from "node:assert/strict"; import {answer} from "./result.mjs"; import {previous} from "./existing.mjs"; assert.equal(answer(),42); assert.equal(previous,2); console.log("PRELOAD_NAMED_OK")\'',cwd:dir},'check')]);
  return reply('Saved both requested files and observed PRELOAD_NAMED_OK from the executable assertions. No declared project test suite was available.');
 }});
 assert.equal(named,1);assert.equal(requests,5);assert.equal(reviews,1);
 assert.equal(events.filter(e=>e.type==='tool_result'&&e.source==='initial_source_preload').length,1);
 assert.equal(events.filter(e=>e.type==='tool'&&e.name==='host_file_read').length,1,'only the app-initiated read is present');
 assert.equal(existsSync(join(dir,'result.mjs')),true);assert.match(result.assistant,/PRELOAD_NAMED_OK/);
});
