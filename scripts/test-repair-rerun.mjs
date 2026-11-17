import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const home=mkdtempSync(join(tmpdir(),'collar-repair-rerun-'));
process.env.NOVAPUP_HOME=join(home,'profile');process.env.NP_LAYA_MODEL=join(home,'absent-model');process.env.HNL_MODEL='local-3.8';process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No network or live models in this fixture');};
const {ensureHome}=await import('../src/main/config.js');
const {runTurn}=await import('../src/main/agent.js');
const {createSession}=await import('../src/main/sessions.js');
const {setWorkdir}=await import('../src/main/workdir.js');
const {windowToolDefs}=await import('../src/main/tools.js');
const {VerificationLedger}=await import('../src/main/verification-ledger.js');
const {setApprovalNotifier,resolveApproval}=await import('../src/main/approvals.js');
ensureHome();setApprovalNotifier(e=>{if(e.type==='approval')resolveApproval(e.request.id,true);});
after(()=>{globalThis.fetch=savedFetch;setApprovalNotifier(null);rmSync(home,{recursive:true,force:true});});
// Isolate retry/debt semantics with the legacy writer catalog; the separate
// full-catalog production suite covers early focused-edit selection.
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>['host_file_read','host_file_write','host_run'].includes(t.function.name));
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(content='',tool_calls=[])=>({content,tool_calls});

test('failed-check guidance permits an exact rerun after repair while unchanged retries remain blocked',async()=>{
 const cwd=join(home,'project');mkdirSync(cwd);setWorkdir(cwd);
 writeFileSync(join(cwd,'feature.mjs'),'export const value = 1;\n');
 writeFileSync(join(cwd,'verify.mjs'),'import assert from "node:assert/strict"; import {value} from "./feature.mjs"; assert.equal(value,2); console.log("REAL_REPAIR_OK");\n');
 const session=createSession(),events=[];let requests=0,reviews=0;const command='node verify.mjs';
 const ledger=()=>new VerificationLedger(session.id,cwd);
 const result=await runTurn([],'Fix feature.mjs and verify it using the existing verify.mjs. Keep the verification assertions unchanged.',e=>events.push(e),AbortSignal.timeout(20000),{sessionId:session.id,tools,complete:async(messages,_cfg,_delta,_signal,opts)=>{
  if(opts.requestKind==='contract_review'){reviews++;return reply('{"findings":[],"limitations":[]}');}
  requests++;
  if(requests===1)return reply('',[call('host_file_read',{path:'feature.mjs'},'initial-read')]);
  if(requests===2)return reply('',[call('host_run',{command,cwd},'failed')]);
  if(requests===3){
   const receipt=messages.find(m=>m.role==='tool'&&m.tool_call_id==='failed').content;
   assert.match(receipt,/rerun the relevant verification against the current source/);
   assert.match(receipt,/same check after a real repair is expected/);
   assert(!receipt.includes('Do not repeat this call.'));
   assert(ledger().debt().length>0,'the failed check must remain open');
   return reply('',[call('host_run',{command,cwd},'unchanged')]);
  }
  if(requests===4){
   assert.match(messages.find(m=>m.role==='tool'&&m.tool_call_id==='unchanged').content,/Skipped/);
   assert.equal(events.filter(e=>e.type==='tool_result'&&e.name==='host_run'&&e.ok===false).length,1,'unchanged failed retry did not execute');
   return reply('',[call('host_run',{command:'pwd',cwd},'observe')]);
  }
  if(requests===5){
   assert(ledger().debt().length>0,'unrelated observation cannot clear a failed check');
   return reply('',[call('host_file_write',{path:'feature.mjs',content:'export const value = 2;\n'},'repair')]);
  }
  if(requests===6)return reply('',[call('host_run',{command,cwd},'rerun')]);
  assert.equal(requests,7);
  assert.match(messages.find(m=>m.role==='tool'&&m.tool_call_id==='rerun').content,/REAL_REPAIR_OK/);
  return reply('Repaired feature.mjs and reran the unchanged verification command. REAL_REPAIR_OK was observed. No declared project suite was available.');
 }});
 assert.equal(events.filter(e=>e.type==='tool_result'&&e.name==='host_run').length,3);
 assert.deepEqual(ledger().debt(),[]);assert.equal(reviews,1);assert.match(result.assistant,/REAL_REPAIR_OK/);
});
