import assert from "node:assert/strict";
import {after,test} from "node:test";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=realpathSync(mkdtempSync(join(tmpdir(),"collar-witness-")));
process.env.NOVAPUP_HOME=join(root,"profile");
const {ensureHome}=await import("../src/main/config.js");
const {setWorkdir}=await import("../src/main/workdir.js");
const {createHarness}=await import("../src/main/harness.js");
const {createSession}=await import("../src/main/sessions.js");
const {readUserFile,writeUserFile}=await import("../src/main/files.js");
ensureHome();after(()=>rmSync(root,{recursive:true,force:true}));
const before="export const value=1;\n",changed="export const value=2;\n";
function fixture(name){const cwd=join(root,name);mkdirSync(cwd);writeFileSync(join(cwd,"feature.mjs"),before);setWorkdir(cwd);return cwd;}
function gate(signal){return createHarness({ask:"Fix feature.mjs.",sessionId:createSession().id,signal,approvalAware:true,localExec:async()=>({ok:true,stdout:"",stderr:"",code:0})});}
function observe(g){const args={path:"feature.mjs"};g.note("host_file_read",args,readUserFile(args.path));}
async function save(g,text){const args={path:"feature.mjs",content:text};assert.equal(g.before("host_file_write",JSON.stringify(args)),null);const result=writeUserFile(args.path,text);const proof=await g.after("host_file_write",JSON.stringify(args),result);return{result,proof};}

test("the private getter requires after-save evidence, not a read, preflight, write claim, or syntax claim",async()=>{
 fixture("save");const stop=new AbortController(),g=gate(stop.signal);observe(g);assert.equal(g.requestedSourceProgress(),false);
 const args={path:"feature.mjs",content:changed};assert.equal(g.before("host_file_write",JSON.stringify(args)),null);const result=writeUserFile(args.path,changed);
 g.note("host_file_write",args,result);assert.equal(g.requestedSourceProgress(),false,"note alone is not completed authorized after() bookkeeping");
 await g.after("host_file_write",JSON.stringify(args),result);assert.equal(g.requestedSourceProgress(),true);
 const debt=JSON.stringify(g.debt());g.setRequireEdits(false);assert.equal(g.requestedSourceProgress(),false);assert.equal(JSON.stringify(g.debt()),debt);
 g.setRequireEdits(true);stop.abort();assert.equal(g.requestedSourceProgress(),false);
});

test("a successful no-op and newly-created target with unknown/null initial body do not qualify",async()=>{
 fixture("noop");const g=gate();observe(g);await save(g,before);assert.equal(g.requestedSourceProgress(),false);
 const cwd=fixture("created"),g2=createHarness({ask:"Fix new.mjs.",sessionId:createSession().id,approvalAware:true,localExec:async()=>({ok:true,code:0})});
 const args={path:"new.mjs",content:changed};assert.equal(g2.before("host_file_write",JSON.stringify(args)),null);const result=writeUserFile(args.path,changed);await g2.after("host_file_write",JSON.stringify(args),result);assert.equal(g2.requestedSourceProgress(),false,cwd);
});

test("a real saved revision can qualify with syntax failure while all genuine failure debt remains",async()=>{
 fixture("failed-syntax");const g=createHarness({ask:"Fix feature.mjs.",sessionId:createSession().id,approvalAware:true,localExec:async()=>({ok:false,code:1,stderr:"SyntaxError: fixture syntax failure"})});
 observe(g);const{proof}=await save(g,"export const broken = ;\n");assert.equal(proof.ok,false);const owed=g.debt();assert(owed.length);assert.equal(g.requestedSourceProgress(),true);assert.deepEqual(g.debt(),owed,"optional stage never clears verification debt");
});
