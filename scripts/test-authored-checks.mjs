import assert from "node:assert/strict";
import {after, test} from "node:test";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {authoredAssertionSource, createAuthoredCheckAwareness, directAuthoredScript, verificationReceiptLabel} from "../src/main/authored-checks.js";

const script = 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\nconsole.log("ASSERTIONS_RAN");\n';
const syntax = {ok:true, verification:{phase:"syntax",status:"passed"}};
function fixture() {
  const files = new Map();
  const observer = createAuthoredCheckAwareness({cwd:"/workspace",read:path=>files.get(path)});
  const write = (name, text, proof=syntax) => {
    const path=resolve("/workspace",name); files.set(path,text);
    return observer.observe({name:"host_file_write",result:{ok:true,path},proof});
  };
  const run = (command,result) => {
    const execution=observer.beforeExecution("host_run",{command});
    observer.observe({name:"host_run",result,execution});
    return execution;
  };
  return {files,observer,write,run};
}

const root=mkdtempSync(join(tmpdir(),"collar-authored-checks-"));
process.env.NOVAPUP_HOME=join(root,"profile");mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL=join(root,"absent-model");process.env.HNL_MODEL="local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("Live inference/network forbidden");};
const {runTurn}=await import("../src/main/agent.js");
const {createSession}=await import("../src/main/sessions.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {ensureHome}=await import("../src/main/config.js");
const {windowToolDefs}=await import("../src/main/tools.js");
const {setApprovalNotifier,resolveApproval}=await import("../src/main/approvals.js");
ensureHome();setApprovalNotifier(e=>{if(e.type==="approval")resolveApproval(e.request.id,true);});
after(()=>{globalThis.fetch=savedFetch;setApprovalNotifier(null);rmSync(root,{recursive:true,force:true});});
const call=(name,args,id)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const reply=(content="",tool_calls=[])=>({content,tool_calls});

// Auxiliary review traffic is explicit; these fixture totals include that one request.
const advisoryReply = options => options?.requestKind === "contract_review" ? { content: '{"findings":[],"limitations":[]}', tool_calls: [] } : null;
const defs=windowToolDefs({local:true,search:false,remote:false}).filter(t=>["host_file_write","host_run"].includes(t.function.name));
function project(name){const path=join(root,name);mkdirSync(path);writeFileSync(join(path,"package.json"),'{"type":"module"}');setWorkdir(path);return path;}


test("assertion intent needs source signals, never a verify/test filename",()=>{
  assert.equal(authoredAssertionSource("verify.ts","export const metadata = {name:'tests'};"),false);
  assert.equal(authoredAssertionSource("library.mjs",'import assert from "node:assert/strict"; export function compute(x){assert(x);return x;}'),false);
  assert.equal(authoredAssertionSource("ordinary.ts",script),true);
  assert.equal(authoredAssertionSource("ordinary.ts",'function check(x){return x;} check(1); check(2); process.exit(0);'),true);
  assert.equal(authoredAssertionSource("module.py","def validate(x):\n    assert x\n"),false);
});

test("syntax, import/runtime and suite labels preserve distinct proof strengths",()=>{
  assert.match(verificationReceiptLabel(syntax),/SYNTAX PASS.*not executed/);
  assert.match(verificationReceiptLabel({ok:true,verification:{phase:"runtime"}}),/not a behavioral test-suite verdict/);
  assert.match(verificationReceiptLabel({ok:true,skipped:true}),/UNAVAILABLE.*no pass/);
  assert.equal(verificationReceiptLabel({ok:false}),"HARNESS FAIL");
});

test("authored TypeScript has one informational reminder and no speculative execution/debt",()=>{
  const f=fixture();
  assert.match(f.write("ordinary.ts",script),/does not establish.*assertions ran/);
  assert.equal(f.observer.pending()[0].state,"not_executed");
  assert.equal(f.observer.pending()[0].blocking,false);
  assert.match(f.observer.takeReminder(),/runner cannot be established/);
  assert.equal(f.observer.takeReminder(),"");
  assert.equal(f.observer.beforeExecution("host_run",{command:"cat ordinary.ts"}),null);
  assert.equal(f.observer.beforeExecution("host_run",{command:"node ordinary.ts",cwd:{bad:true}}),null);
  assert.equal(f.observer.beforeExecution("host_run",{command:"node -e 'console.log(1)'"}),null);
  f.run("node ordinary.ts",{ok:false,skipped:true,unavailable:true,exitCode:73});
  assert.equal(f.observer.pending()[0].state,"unavailable");
  assert.equal(f.observer.pending()[0].blocking,false);
});

test("only a matching stable successful execution clears the observation",()=>{
  const f=fixture();f.write("probe.mjs",script);
  assert.equal(f.run("node unrelated.mjs",{ok:true,exitCode:0}),null);
  assert.equal(f.observer.pending().length,1);
  assert(f.run('node "probe.mjs"',{ok:true,exitCode:0}));
  assert.equal(f.observer.pending().length,0);
  f.write("implementation.mjs","export const changed=true;");
  assert.match(f.observer.context(),/earlier execution predates later source edits/);
});

test("relative command cwd uses the turn directory and cached shell revisions invalidate old receipts",()=>{
  const f=fixture();f.write("nested/probe.mjs",script);
  f.observer.observe({name:"host_file_read",result:{ok:true},sourceRevision:3});
  const execution=f.observer.beforeExecution("host_run",{command:"node probe.mjs",cwd:"nested"});
  assert(execution);assert.equal(execution.path,"/workspace/nested/probe.mjs");
  f.observer.observe({name:"host_run",result:{ok:true},execution,sourceRevision:3});
  assert.equal(f.observer.pending().length,0);
  f.observer.observe({name:"host_run",result:{ok:true},sourceRevision:4});
  assert.match(f.observer.context(),/earlier execution predates later source edits/);
});

test("failure, no-tests and changed-during-run receipts never become a pass",()=>{
  const f=fixture();f.write("probe.mjs",script);
  f.run("node probe.mjs",{ok:false,exitCode:1});
  f.run("node unrelated.mjs",{ok:true,exitCode:0});
  assert.equal(f.observer.pending()[0].state,"failed_or_unconfirmed");
  f.run("node probe.mjs",{ok:true,exitCode:1});
  assert.equal(f.observer.pending()[0].state,"failed_or_unconfirmed");
  f.run("node probe.mjs",{ok:true,exitCode:0,noTests:true});
  assert.equal(f.observer.pending()[0].state,"unavailable");
  const execution=f.observer.beforeExecution("host_run",{command:"node probe.mjs"});
  f.files.set("/workspace/probe.mjs",script+"// changed during execution\n");
  f.observer.observe({name:"host_run",result:{ok:true,exitCode:0},execution});
  assert.equal(f.observer.pending()[0].state,"source_changed_during_execution");
});

test("API import success is not helper execution; a real automatic direct test receipt is",()=>{
  const f=fixture();
  f.write("probe.mjs",script,{ok:true,verification:{phase:"runtime",command:'node -e "import(\'./probe.mjs\')"'}});
  assert.equal(f.observer.pending().length,1);
  f.write("probe.mjs",script+"\n",{ok:true,verification:{phase:"test",command:"node --test /workspace/probe.mjs"}});
  assert.equal(f.observer.pending().length,0);
});

test("command association accepts simple quoted script positions and leaves opaque commands unknown",()=>{
  assert.equal(directAuthoredScript('node --test "space name.mjs"',"/workspace"),"/workspace/space name.mjs");
  for(const c of ['cat probe.mjs','node -e "probe.mjs"','node probe.mjs; echo done','node probe.mjs | head','python3 -m unittest','node --import plugin.mjs probe.mjs'])assert.equal(directAuthoredScript(c,"/workspace"),null,c);
});

test("mutation review stays informational and creates no verification credit",()=>{
  const f=fixture();
  const notice=f.observer.observe({name:"host_file_write",result:{ok:true,path:"/workspace/impl.mjs",mutationReview:{removedLines:["old guard"]}}});
  assert.match(notice,/not instructions or regression proof/);
  assert.deepEqual(f.observer.pending(),[]);
});


test("production turn surfaces a syntax-only authored check and allows an honest unavailable handoff",async()=>{
  const dir=project("unavailable-ts"),helper=join(dir,"ordinary.ts"),lib=join(dir,"library.ts");
  let requests=0;const events=[],seen=[];
  const result=await runTurn([],"Implement library.ts and verify its behavior.",e=>events.push(e),AbortSignal.timeout(20000),{
    sessionId:createSession().id,tools:defs,complete:async (messages,_cfg,_delta,_signal,options)=>{
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;seen.push(...messages.filter(x=>x.role==="tool"||x.role==="user").map(x=>String(x.content)));
      if(requests===1)return reply("",[call("host_file_write",{path:lib,content:"export const value=4;\n"},"a"),call("host_file_write",{path:helper,content:script},"b")]);
      if(requests===2)return reply("PASS. The saved implementation and all tests passed.");
      return reply("Incomplete. Source syntax checks passed. The authored TypeScript assertions were not executed; no declared test runner was established, so no behavioral pass is claimed.");
    },
  });
  assert.equal(requests, 4,JSON.stringify({assistant:result.assistant,messages:result.messages.filter(e=>e.role==="tool"||e.role==="user").map(e=>e.content)}));
  assert(seen.some(x=>/Authored-check observation.*not_executed/.test(x)));
  assert(seen.some(x=>/HARNESS SYNTAX PASS.*not executed/.test(x)));
  assert(!events.some(x=>x.type==="tool"&&x.name==="host_run"));
  assert.match(result.assistant,/not executed/);assert(!/^PASS\b/.test(result.assistant));
});

test("production turn recognizes actual helper execution and avoids a redundant reminder",async()=>{
  const dir=project("ran-js"),helper=join(dir,"ordinary.mjs"),lib=join(dir,"library.mjs");
  let requests=0;const events=[];
  const result=await runTurn([],"Implement library.mjs and verify behavior.",e=>events.push(e),AbortSignal.timeout(20000),{
    sessionId:createSession().id,tools:defs,complete:async (_messages,_cfg,_delta,_signal,options)=>{
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if(requests===1)return reply("",[call("host_file_write",{path:lib,content:"export const value=4;\n"},"a"),call("host_file_write",{path:helper,content:script},"b")]);
      if(requests===2)return reply("",[call("host_run",{command:"node ordinary.mjs",cwd:dir},"c")]);
      return reply("The saved implementation parsed and the local assertion helper ran successfully; no project test suite was declared.");
    },
  });
  assert.equal(requests, 4,JSON.stringify({assistant:result.assistant,messages:result.messages.filter(e=>e.role==="tool"||e.role==="user").map(e=>e.content)}));
  assert(events.some(x=>x.type==="tool_result"&&x.name==="host_run"&&x.ok&&/ASSERTIONS_RAN/.test(x.detail)));
  assert.match(result.assistant,/helper ran successfully/);
});

test("production known shell edits reopen the informational helper observation without speculative debt",async()=>{
  const dir=project("shell-revision"),helper=join(dir,"ordinary.mjs"),lib=join(dir,"library.mjs");
  let requests=0;const seen=[];
  const result=await runTurn([],"Implement library.mjs and verify behavior.",()=>{},AbortSignal.timeout(20000),{
    sessionId:createSession().id,tools:defs,complete:async (messages,_cfg,_delta,_signal,options)=>{
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;seen.push(...messages.filter(x=>x.role==="user").map(x=>String(x.content)));
      if(requests===1)return reply("",[call("host_file_write",{path:lib,content:"export const value=4;\n"},"a"),call("host_file_write",{path:helper,content:script},"b")]);
      if(requests===2)return reply("",[call("host_run",{command:"node ordinary.mjs",cwd:dir},"c")]);
      if(requests===3)return reply("",[call("host_run",{command:'python3 -c "p=\'library.mjs\';s=open(p).read();open(p,\'w\').write(s.replace(\'4\',\'5\'))"',cwd:dir},"d")]);
      if(requests===4)return reply("PASS. All assertions cover the latest source.");
      return reply("The helper ran before the later source edit and was not executed afterward. Current behavior remains unverified.");
    },
  });
  assert.equal(requests, 6);
  assert(seen.some(x=>/earlier execution predates later source edits/.test(x)));
  assert.match(result.assistant,/not executed afterward/);
});
