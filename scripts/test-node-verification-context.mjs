import assert from "node:assert/strict";
import {after, test} from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {inlineNodeAssertionCommand, inlineNodeCheckIdentity, nativeNodeInvocation, nodeResolutionContext} from "../src/main/node-verification-context.js";
import {testExecutionCommand} from "../src/main/turn-policy.js";

const root = mkdtempSync(join(tmpdir(), "nova-node-check-context-"));
process.env.NOVAPUP_HOME = join(root, "profile"); mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No backend/network calls in these tests."); };
const {probePath} = await import("../src/main/harness-check.js");
const {createHarness} = await import("../src/main/harness.js");
const {executionEvidence} = await import("../src/main/verification-result.js");
const {VerificationLedger} = await import("../src/main/verification-ledger.js");
const {setWorkdir} = await import("../src/main/workdir.js");
const {createSession} = await import("../src/main/sessions.js");
const {runTurn} = await import("../src/main/agent.js");
const {windowToolDefs} = await import("../src/main/tools.js");
const {setApprovalNotifier, resolveApproval} = await import("../src/main/approvals.js");
const execFileAsync = promisify(execFile);
async function localExec(command, options = {}) {
  try { return {ok:true, exitCode:0, ...await execFileAsync("/bin/sh", ["-c", command], {cwd:options.cwd || root, timeout:12000, maxBuffer:256 * 1024})}; }
  catch (error) { return {ok:false, exitCode:error.code, stdout:error.stdout || "", stderr:error.stderr || "", error:error.message}; }
}
const q = value => `'${value.replaceAll("'", "'\\''")}'`;
const evalCommand = source => `node --input-type=module -e ${q(source)}`;
function fixture(name) { const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir,"package.json"), '{"type":"module"}\n'); setWorkdir(dir); return dir; }
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { setApprovalNotifier(null); globalThis.fetch = nativeFetch; rmSync(root, {recursive:true,force:true}); });

test("actual eval and quoted stdin Node assertions receive test execution context", () => {
  for (const command of [
    evalCommand('import assert from "node:assert/strict"; assert.equal(1, 2);'),
    evalCommand('const assert = (await import("node:assert")).default; assert.deepStrictEqual([1], [2]);'),
    `node -e ${q('const check = require("node:assert"); check(1 === 2);')}`,
    `node --input-type=module <<'CHECK'\nimport assert from "node:assert/strict"; assert.equal(1, 2);\nCHECK`,
    `node --input-type=module - <<"CHECK"\nimport * as check from "node:assert"; check.ok(false);\nCHECK`,
  ]) { assert.equal(inlineNodeAssertionCommand(command), true, command); assert.equal(testExecutionCommand(command), true, command); }
});

test("printed/quoted/commented/dormant assertions and intentional failures stay ordinary programs", () => {
  for (const command of [
    `printf '%s' ${q('node -e \'const assert=require("node:assert");assert.fail()\'')}`,
    evalCommand('console.log("import assert from node:assert; assert.fail()"); process.exit(1);'),
    evalCommand('/* import assert from "node:assert"; assert.fail(); */ process.exit(1);'),
    evalCommand('const assert = require("node:assert"); console.log("assert.fail()"); process.exit(1);'),
    evalCommand('const assert = require("node:assert"); function dormant(){ assert.fail(); } process.exit(1);'),
    evalCommand('const assert = require("node:assert"); const dormant = () => assert.fail(); process.exit(1);'),
    evalCommand('let check = require("node:assert"); check = () => {}; check(false); process.exit(1);'),
    evalCommand('const check = require("node:assert"); check.equal = () => {}; check.equal(1,2); process.exit(1);'),
    evalCommand('const check = require("node:assert"); process.exit(1); check(false);'),
    evalCommand('const check = require("node:assert"); throw Error("ordinary failure"); check(false);'),
    evalCommand('const check = require("node:assert"); const pattern = /check.fail();/; console.log(pattern); process.exit(1);'),
    evalCommand('const check = require("node:assert"); true && /;check(false);x/.test("x"); process.exit(1);'),
    evalCommand('const check = require("node:assert"); if (true) /;check(false);x/.test("x"); process.exit(1);'),
    evalCommand('process.stdout.write("FAIL");'),
    `node --input-type=module <<CHECK\nimport assert from "node:assert"; assert.fail();\nCHECK`,
    `node --input-type=module <<'CHECK'\nconsole.log("ordinary");\nCHECK\nprocess.exit(1);\nCHECK`,
    `node -e ${q('require("node:assert").fail()')} | cat`,
  ]) assert.equal(testExecutionCommand(command), false, command);
});

test("resolution guidance requires a real failed native-loader diagnostic, not ordinary stdout", () => {
  const command = evalCommand('await import("./consumer.ts");');
  const stderr = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/project/dependency' imported from /project/consumer.ts\n at node:internal/modules/esm/resolve:241:11\n { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///project/dependency' }";
  const raw = {ok:false,exitCode:1,stdout:"",stderr};
  const context = nodeResolutionContext(command,raw);
  assert.equal(context.kind,"native_node_module_resolution"); assert.match(context.guidance,/explicit file extensions/);
  assert.equal(raw.ok,false); assert.equal(raw.stderr,stderr); assert.equal(raw.unavailable,undefined);
  assert.equal(nodeResolutionContext("cat failure.log",raw),null);
  assert.equal(nodeResolutionContext(command,{...raw,ok:true,exitCode:0}),null);
  assert.equal(nodeResolutionContext(command,{...raw,stderr:"",stdout:stderr}),null);
  assert.equal(nodeResolutionContext(command,{...raw,stderr:"AssertionError [ERR_ASSERTION]: values differ"}),null);
  assert.equal(nodeResolutionContext(command,{...raw,held:true}),null);
  assert.equal(nativeNodeInvocation(`echo ${q(command)}`),null);
});

test("real TS API import receipt is scoped and consumer loading failures remain failures", async () => {
  const dir=fixture("ts-consumer"), leaf=join(dir,"leaf.ts"), consumer=join(dir,"consumer.ts");
  writeFileSync(leaf,'export function step(value: number) { return value + 1; }\n');
  const source='import { step } from "./leaf"; export function render() { return step(1); }\n';
  writeFileSync(consumer,source);
  const leafResult=await probePath(leaf,readFileSync(leaf,"utf8"),{exec:localExec,api:{symbol:"step"}});
  assert.equal(leafResult.ok,true,leafResult.error); assert.equal(leafResult.apiVerified,true);
  assert.equal(leafResult.verificationScope,"api-shape"); assert.equal(leafResult.runtime,"native-node");
  assert.match(leafResult.blurb,/behavior and consumer integration not tested/);
  const failed=await probePath(consumer,source,{exec:localExec,api:{symbol:"render"}});
  assert.equal(failed.ok,false); assert.notEqual(failed.unavailable,true); assert.notEqual(failed.apiVerified,true);
  assert.equal(failed.verificationContext.kind,"native_node_module_resolution");
  const corrected=source.replace('"./leaf"','"./leaf.ts"'); writeFileSync(consumer,corrected);
  const imported=await probePath(consumer,corrected,{exec:localExec,api:{symbol:"render"}});
  assert.equal(imported.ok,true,imported.error); assert.equal(imported.verificationScope,"api-shape");
  const actual=await localExec(evalCommand('import assert from "node:assert/strict"; const {render}=await import("./consumer.ts"); assert.equal(render(),2);'),{cwd:dir});
  assert.equal(actual.ok,true,actual.stderr);
});

test("failed inline stdin check survives unrelated success and clears only after same-command source repair", async () => {
  const dir=fixture("stdin-debt"), source=join(dir,"logic.mjs"); writeFileSync(source,"export const value = 0;\n");
  const gate=createHarness({sessionId:"stdin-debt",localExec,approvalAware:true});
  const command=`node --input-type=module <<'CHECK'\nimport assert from "node:assert/strict"; import {value} from "./logic.mjs"; assert.equal(value,1);\nCHECK`;
  const run=async text => { const args={command:text,cwd:dir}; assert.equal(gate.before("host_run",args),null);
    const result=executionEvidence(await localExec(text,{cwd:dir}),{test:testExecutionCommand(text)}); await gate.after("host_run",args,result); return result; };
  assert.equal((await run(command)).testFailure,true); assert.match(gate.debt().join("\n"),/failed test verification|verification command/i);
  await run("ls"); assert.equal(new VerificationLedger("stdin-debt",dir).entries.size,1);
  assert(gate.debt().length); writeFileSync(source,"export const value = 1;\n");
  assert.equal((await run(command)).ok,true); assert.deepEqual(gate.debt(),[]);
});

test("an import-extension-only repair resolves obsolete native transport debt without clearing assertion failures", async () => {
  const dir=fixture("import-repair"), path=join(dir,"feature.ts"); writeFileSync(path,"export const value = 1;\n");
  const gate=createHarness({sessionId:"import-repair",localExec,approvalAware:true});
  const command=evalCommand('import assert from "node:assert/strict"; const {value}=await import("./feature"); assert.equal(value,1);');
  const repaired=command.replace('./feature"','./feature.ts"');
  const run=async (text,cwd=dir) => { const args={command:text,cwd}; assert.equal(gate.before("host_run",args),null);
    const result=executionEvidence(await localExec(text,{cwd}),{test:testExecutionCommand(text)}); await gate.after("host_run",args,result); return result; };
  const missing=await run(command); assert.equal(missing.ok,false); assert.match(missing.stderr,/ERR_MODULE_NOT_FOUND/);
  assert(gate.debt().length); await run("ls"); assert(gate.debt().length,"unrelated success must not erase the failed invocation");
  const restored=new VerificationLedger("import-repair",dir); assert.equal(restored.error,"");
  assert.equal([...restored.entries.values()][0].failure.kind,"native-node-module-resolution");
  const pendingSaved=readFileSync(restored.file,"utf8"), pendingMalformed=JSON.parse(pendingSaved);
  pendingMalformed.entries[0].transportCheckIdentity="0".repeat(64); writeFileSync(restored.file,JSON.stringify(pendingMalformed));
  assert.match(new VerificationLedger("import-repair",dir).error,/invalid transport verification relation/); writeFileSync(restored.file,pendingSaved);
  for (const different of [repaired.replace("node ","node --no-warnings "), repaired.replace("value,1","value===1,true"), evalCommand('import assert from "node:assert/strict"; assert.equal(1,1);')]) {
    assert.equal((await run(different)).ok,true); assert(gate.debt().length,"changed flags/assertions or unrelated checks cannot resolve the old loader failure");
  }
  const other=join(dir,"other"); mkdirSync(other); writeFileSync(join(other,"package.json"),'{"type":"module"}'); writeFileSync(join(other,"feature.ts"),'export const value = 1;');
  assert.equal((await run(repaired,other)).ok,true); assert(gate.debt().length,"a check in a different CWD cannot clear the original invocation");
  assert.equal((await run(repaired)).ok,true); assert.deepEqual(gate.debt(),[],"an import-only repair must not leave the old unexecutable command as permanent debt");
  const reloaded=new VerificationLedger("import-repair",dir); assert.equal(reloaded.error,""); assert.deepEqual(reloaded.debt(),[]);
  const receipt=[...reloaded.entries.values()].find(row=>row.resolvedTransportFailures?.length);
  assert.equal(receipt.command,repaired); assert.equal(receipt.status,"passed");
  assert.equal(receipt.resolvedTransportFailures[0].command,command); assert.match(receipt.resolvedTransportFailures[0].startupDiagnostic,/ERR_MODULE_NOT_FOUND/);
  assert.equal(receipt.resolvedTransportFailures[0].originalOutcome,"failed"); assert.equal(receipt.resolvedTransportFailures[0].resolvedByPassed,true);
  assert(![...reloaded.entries.values()].some(row=>row.command===command),"old broken command must not be marked passed");
  const saved=readFileSync(reloaded.file,"utf8"), data=JSON.parse(saved);
  for (const mutate of [
    row=>{row.resolvedTransportFailures[0].cwd=other;},
    row=>{row.resolvedTransportFailures[0].resolvedByCommandHash="0".repeat(64);},
    row=>{row.resolvedTransportFailures[0].command=row.resolvedTransportFailures[0].command.replace("value,1","value,2");},
    row=>{row.resolvedTransportFailures[0].startupDiagnostic="AssertionError [ERR_ASSERTION]: different";},
  ]) {
    const malformed=structuredClone(data); mutate(malformed.entries.find(row=>row.resolvedTransportFailures?.length));
    writeFileSync(reloaded.file,JSON.stringify(malformed)); assert.match(new VerificationLedger("import-repair",dir).error,/invalid transport verification relation/);
  }
  writeFileSync(reloaded.file,saved);
  const semantic=repaired.replace('value,1','value,2');
  assert.equal((await run(semantic)).testFailure,true); await run(repaired);
  assert(gate.debt().length,"changing assertion expectations cannot clear a genuine failed assertion");
  writeFileSync(path,"export const value = 2;\n"); assert.equal((await run(semantic)).ok,true); assert.deepEqual(gate.debt(),[]);
});

test("unsupported program changes and genuine assertion debt cannot use transport supersession", async () => {
  const bad=evalCommand('import assert from "node:assert/strict"; const {value}=await import("./feature"); assert.equal(value,1);');
  assert.equal(inlineNodeCheckIdentity(bad),inlineNodeCheckIdentity(bad.replace('./feature"','./feature.ts"')));
  assert.notEqual(inlineNodeCheckIdentity(bad),inlineNodeCheckIdentity(bad.replace('value,1','value,2')));
  assert.notEqual(inlineNodeCheckIdentity(bad),inlineNodeCheckIdentity(bad.replace('node ','node --no-warnings ')));
  assert.notEqual(inlineNodeCheckIdentity(bad),inlineNodeCheckIdentity(bad.replace('assert.equal','/* source changed */ assert.equal')));
  assert.equal(inlineNodeCheckIdentity(evalCommand('import assert from "node:assert/strict"; const path="./feature"; await import(path); assert.ok(true);')),null);
  assert.equal(inlineNodeCheckIdentity(evalCommand('import assert from "node:assert/strict"; assert.ok(4 / 2);')),null);
  const dir=fixture("genuine-assert-first"), bare=join(dir,"feature");
  writeFileSync(bare,'export const value = 0;'); writeFileSync(join(dir,"feature.ts"),'export const value = 1;');
  const gate=createHarness({sessionId:"assert-first",localExec,approvalAware:true});
  const run=async command=>{const args={command,cwd:dir};gate.before("host_run",args);const result=executionEvidence(await localExec(command,{cwd:dir}),{test:testExecutionCommand(command)});await gate.after("host_run",args,result);return result;};
  const asserted=await run(bad); assert.match(asserted.stderr,/ERR_ASSERTION/);
  rmSync(bare); const missing=await run(bad); assert.match(missing.stderr,/ERR_MODULE_NOT_FOUND/);
  assert.equal((await run(bad.replace('./feature"','./feature.ts"'))).ok,true);
  assert(gate.debt().length,"a later loader failure cannot downgrade and erase an earlier genuine assertion failure");
  assert.notEqual([...new VerificationLedger("assert-first",dir).entries.values()][0].failure.kind,"native-node-module-resolution");
});

test("no-session transport repair is equally narrow and never clears an assertion failure", async () => {
  const dir=fixture("no-session"), path=join(dir,"feature.ts"); writeFileSync(path,"export const value = 1;");
  const gate=createHarness({localExec,approvalAware:true});
  const bad=evalCommand('import assert from "node:assert/strict"; const {value}=await import("./feature"); assert.equal(value,1);'), repaired=bad.replace('./feature"','./feature.ts"');
  const run=async command=>{const args={command,cwd:dir};gate.before("host_run",args);const result=executionEvidence(await localExec(command,{cwd:dir}),{test:testExecutionCommand(command)});await gate.after("host_run",args,result);return result;};
  await run(bad); assert(gate.debt().length); await run("ls"); assert(gate.debt().length);
  await run(repaired); assert.deepEqual(gate.debt(),[]);
  await run(repaired.replace("value,1","value,2")); await run(repaired); assert(gate.debt().length);
});

test("production runTurn accepts a clean import-only inline repair and persists its honest linked receipt", async () => {
  const dir=fixture("turn-import-repair"); writeFileSync(join(dir,"feature.ts"),'export const value = 1;');
  const bad=evalCommand('import assert from "node:assert/strict"; const {value}=await import("./feature"); assert.equal(value,1);');
  const repaired=bad.replace('./feature"','./feature.ts"'), session=createSession().id;
  const tools=windowToolDefs({local:true,search:false,remote:false}).filter(row=>row.function.name==="host_run");
  let step=0;
  const result=await runTurn([],"Inspect the local TypeScript check results.",()=>{},AbortSignal.timeout(15000),{sessionId:session,tools,allow:true,
    complete:async messages=>{
      step++;
      if(step<=2)return {content:"",tool_calls:[{id:`check-${step}`,type:"function",function:{name:"host_run",arguments:JSON.stringify({command:step===1?bad:repaired,cwd:dir})}}]};
      assert(messages.find(row=>row.role==="tool"&&row.tool_call_id==="check-2").content.includes('"ok":true'));
      return {content:"The initial native import failed. After correcting only its extension, the unchanged assertions ran successfully.",tool_calls:[]};
    }});
  const ledger=new VerificationLedger(session,dir); assert.equal(ledger.error,""); assert.deepEqual(ledger.debt(),[]);
  assert([...ledger.entries.values()].some(row=>row.command===repaired&&row.status==="passed"&&row.resolvedTransportFailures?.[0].command===bad));
  assert.doesNotMatch(result.assistant,/^FAIL|^Incomplete/i);
});

test("production runTurn retains failed inline assertions through unrelated success and misleading PASS", async () => {
  const dir=fixture("turn-debt"), path=join(dir,"logic.mjs"); writeFileSync(path,"export const value = -1;\n");
  const session=createSession().id, events=[], definitions=windowToolDefs({local:true,search:false,remote:false});
  const tools=definitions.filter(row=>["host_run","host_file_write","host_file_read"].includes(row.function.name));
  const command=evalCommand('import assert from "node:assert/strict"; const {value}=await import("./logic.mjs"); assert.equal(value,1);');
  const call=(name,args,id)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
  let step=0;
  const result=await runTurn([],"Update logic.mjs.",e=>events.push(e),AbortSignal.timeout(25000),{
    sessionId:session,allow:true,tools,
    complete:async (_m,_c,_d,_s,opts)=> {
      if(opts?.requestKind==="contract_review")return {content:'{"findings":[],"limitations":[]}',tool_calls:[]};
      step++;
      if(step===1)return {content:"",tool_calls:[call("host_file_write",{path,content:"export const value = 0;\n"},"write")]};
      if(step===2)return {content:"",tool_calls:[call("host_run",{command,cwd:dir},"assert")]};
      if(step===3)return {content:"",tool_calls:[call("host_run",{command:"ls",cwd:dir},"list")]};
      return {content:"PASS. All tests passed.",tool_calls:[]};
    },
  });
  assert(events.some(e=>e.type==="tool_result"&&e.name==="host_run"&&e.ok===false));
  assert(new VerificationLedger(session,dir).debt().some(row=>/verification/i.test(row)));
  assert.match(result.assistant,/FAIL|Incomplete|Not proven/i); assert.doesNotMatch(result.assistant,/^PASS\b/);
});

test("production runTurn exposes native-resolution context after compacting raw command output", async () => {
  const dir=fixture("turn-context"); writeFileSync(join(dir,"entry.ts"),'import {missing} from "./absent";\n');
  let step=0, seenContext=false;
  const tools=windowToolDefs({local:true,search:false,remote:false}).filter(row=>row.function.name==="host_run");
  await runTurn([],"Inspect this local program observation.",()=>{},AbortSignal.timeout(15000),{tools,allow:true,
    complete:async messages=>{
      if(++step===1)return {content:"",tool_calls:[{id:"native",type:"function",function:{name:"host_run",arguments:JSON.stringify({command:evalCommand('await import("./entry.ts");'),cwd:dir})}}]};
      const message=messages.find(row=>row.role==="tool"&&row.tool_call_id==="native");
      seenContext ||= Boolean(message?.content.includes("Native Node ESM requires explicit file extensions"));
      return {content:"The invocation failed during module resolution; no behavior pass is established.",tool_calls:[]};
    }});
  assert.equal(seenContext,true);
});
