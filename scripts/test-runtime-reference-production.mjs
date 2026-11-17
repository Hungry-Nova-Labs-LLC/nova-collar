import assert from "node:assert/strict";
import {after,test} from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import * as nodeModule from "node:module";

const root=mkdtempSync(join(tmpdir(),'collar-static-reference-'));
process.env.NOVAPUP_HOME=join(root,'profile');process.env.NP_LAYA_MODEL=join(root,'absent-laya');process.env.HNL_MODEL='local-3.8';process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No live network or inference in this fixture.');};
const {runTurn}=await import('../src/main/agent.js');
const {setWorkdir}=await import('../src/main/workdir.js');
const {createSession}=await import('../src/main/sessions.js');
const {ensureHome}=await import('../src/main/config.js');
const {windowToolDefs}=await import('../src/main/tools.js');
const {VerificationLedger}=await import('../src/main/verification-ledger.js');
const {setApprovalNotifier,resolveApproval}=await import('../src/main/approvals.js');
ensureHome();setApprovalNotifier(e=>{if(e.type==='approval')resolveApproval(e.request.id,true);});
after(()=>{globalThis.fetch=originalFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const tools=windowToolDefs({local:true,remote:false,search:false}).filter(t=>['host_file_read','host_file_write','host_run'].includes(t.function.name));
const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(content='',tool_calls=[])=>({content,tool_calls});
function fixture(name){const cwd=join(root,name);mkdirSync(join(cwd,'src'),{recursive:true});writeFileSync(join(cwd,'package.json'),'{"type":"module"}\n');writeFileSync(join(cwd,'src/widget.ts'),'export const original=1;\n');setWorkdir(cwd);return cwd;}

test('actual runTurn gives early type-only runtime-name advisory from cached write without executing project source',async()=>{
  const cwd=fixture('typed'),sentinel=join(cwd,'MUST_NOT_EXECUTE'),session=createSession().id,events=[],messages=[];let normal=0;
  const text=`import type {Shape} from './types-never-resolved';\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)},'bad');\nexport function render(input: Shape){return combineParts(scanValue(input));}\n`;
  const result=await runTurn([],'Fix src/widget.ts.',e=>events.push(e),AbortSignal.timeout(20000),{sessionId:session,tools,sourcePreload:false,complete:async(list,_cfg,_delta,_signal,options)=>{
    if(options?.requestKind==='contract_review')return reply('{"findings":[],"limitations":[]}');
    normal++;messages.push(...list.filter(m=>m.role==='tool').map(m=>String(m.content)));
    if(normal===1)return reply('',[call('host_file_read',{path:'src/widget.ts'},'read')]);
    if(normal===2)return reply('',[call('host_file_write',{path:'src/widget.ts',content:text},'write')]);
    return reply('Incomplete. Source syntax was checked, but behavioral execution was not performed. Static observations are advisory.');
  }});
  assert.equal(existsSync(sentinel),false);assert.equal(readFileSync(join(cwd,'src/widget.ts'),'utf8'),text);
  assert(!events.some(e=>e.type==='tool'&&e.name==='host_run'));
  const note=messages.find(x=>x.includes('Static source advisory'));assert(note,'advisory reaches the next actual production model request');
  if(typeof nodeModule.stripTypeScriptTypes==='function'){assert.match(note,/combineParts/);assert.match(note,/scanValue/);}else assert.match(note,/unavailable/);
  assert.match(note,/not a test/);assert.match(result.assistant,/Incomplete/);assert(normal<=3,'advisory creates no forced replan/debt loop');
  const ledger=new VerificationLedger(session,cwd);assert(![...ledger.entries.values()].some(row=>row.kind==='command'));
  assert(!events.some(e=>e.type==='tool_result'&&e.verification?.phase==='test'&&e.verification.status==='passed'));
});

test('a static advisory cannot clear a genuine earlier failed command or create a passing check',async()=>{
  const cwd=fixture('prior-failure'),session=createSession().id,events=[];let normal=0;
  writeFileSync(join(cwd,'test-owned.mjs'),'throw Error("OWNED_CHECK_FAILED");\n');
  const result=await runTurn([],'Fix src/widget.ts.',e=>events.push(e),AbortSignal.timeout(25000),{sessionId:session,tools,sourcePreload:false,complete:async(_list,_cfg,_delta,_signal,options)=>{
    if(options?.requestKind==='contract_review')return reply('{"findings":[],"limitations":[]}');normal++;
    if(normal===1)return reply('',[call('host_file_read',{path:'src/widget.ts'},'read')]);
    if(normal===2)return reply('',[call('host_run',{command:'node test-owned.mjs',cwd},'failed-check')]);
    if(normal===3)return reply('',[call('host_file_write',{path:'src/widget.ts',content:'export const f=()=>missingRuntimeBinding();\n'},'write')]);
    return reply('Incomplete. The owned check still failed; static analysis is advisory and no successful rerun is claimed.');
  }});
  assert.match(result.assistant,/failed test verification command/);assert(!/^PASS/.test(result.assistant));
  const rows=[...new VerificationLedger(session,cwd).entries.values()];
  assert(rows.some(row=>row.kind==='command'&&row.status==='failed'&&row.command==='node test-owned.mjs'));
  assert(events.some(e=>e.type==='source_advisory'&&e.verification===false));
  assert(!events.some(e=>e.type==='source_advisory'&&e.passed===true));
});

test('actual cached write with runtime imports and scoped parameters yields no missing-name hint or project import',async()=>{
  const cwd=fixture('bound-imports'),session=createSession().id,events=[],seen=[];let normal=0;
  const text='import {tool as alias} from "./NONEXISTENT_DO_NOT_IMPORT.mjs";\nexport function render(tool: (x: number)=>number) { return tool(alias); }\n';
  const result=await runTurn([],'Fix src/widget.ts.',e=>events.push(e),AbortSignal.timeout(20000),{sessionId:session,tools,sourcePreload:false,complete:async(list,_cfg,_delta,_signal,options)=>{
    if(options?.requestKind==='contract_review')return reply('{"findings":[],"limitations":[]}');normal++;
    seen.push(...list.filter(m=>m.role==='tool').map(m=>String(m.content)));
    if(normal===1)return reply('',[call('host_file_read',{path:'src/widget.ts'},'read')]);
    if(normal===2)return reply('',[call('host_file_write',{path:'src/widget.ts',content:text},'write')]);
    return reply('Incomplete. Saved source syntax was checked, but no behavioral execution or module-resolution check was performed.');
  }});
  assert.equal(readFileSync(join(cwd,'src/widget.ts'),'utf8'),text);
  if(typeof nodeModule.stripTypeScriptTypes==='function'){
    assert(!events.some(e=>e.type==='source_advisory'));assert(!seen.some(s=>s.includes('Static source advisory')));
  } else assert(seen.some(s=>s.includes('unavailable')));
  assert(!events.some(e=>e.type==='tool'&&e.name==='host_run'));assert.match(result.assistant,/no behavioral execution/);
});
