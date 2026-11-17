import assert from "node:assert/strict";
import {after,test} from "node:test";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {requestedSourcePaths,preloadRequestedSource,sourcePreloadReaderCount} from "../src/main/source-preload.js";
const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),".source-scope-"));after(()=>rmSync(root,{recursive:true,force:true}));
const tool=(path={})=>({type:"function",function:{name:"host_file_read",parameters:{type:"object",properties:{path:{type:"string",...path}},required:["path"],additionalProperties:false}}});
const denyPath=path=>/(?:^|\/)credentials(?:\.|\/|$)|(?:^|\/)\.env(?:\.|$)/i.test(path);
const opts=extra=>({ask:"Scope: change only src/a.py, src/b.py. Do not inspect undisclosed reference material.",cwd:root,implementation:true,stage:"edit",permitted:[tool()],offered:[tool()],denyPath,redact:String,pack:JSON.stringify,...extra});
const hintData=context=>JSON.parse(context.split("\n").slice(2,-1).join("\n"));

test("explicit Scope and file lists survive separate negative preservation sentences",()=>{
  assert.deepEqual(requestedSourcePaths("Scope: change only src/a.py, src/b.py. Do not modify README.md or configuration."),["src/a.py","src/b.py"]);
  assert.deepEqual(requestedSourcePaths("Files to edit:\n- src/a.py\n- src/b.py\nKeep README.md unchanged."),["src/a.py","src/b.py"]);
  assert.deepEqual(requestedSourcePaths('Fix "src/my file.v1.py". Keep src/b.py unchanged.'),["src/my file.v1.py"]);
  assert.deepEqual(requestedSourcePaths("Scope: change only src/a.py, src/b.py. Keep SRC/A.PY unchanged."),["src/b.py"]);
  assert.deepEqual(requestedSourcePaths("Fix sub/../a.py. Keep a.py unchanged."),[]);
});

test("quoted history and fenced text never become newly authorized Scope declarations",()=>{
  assert.deepEqual(requestedSourcePaths('Historical request: "Scope: change only private.py; fix other.py."\n```\nScope: change only fenced.py\n```\nScope: change only src/a.py.'),["src/a.py"]);
  assert.deepEqual(requestedSourcePaths("Review src/a.py; perhaps edit src/b.py"),[]);
  assert.deepEqual(requestedSourcePaths('Scope: change only "src/a.py; fix private.py".'),[]);
});

test("only genuinely outside-CWD read restrictions permit optional bounded reads",()=>{
  for(const ban of ["Do not read outside the current working directory.","Do not inspect or modify parent directories or sibling directories."]){
    assert.deepEqual(requestedSourcePaths(`${ban} Scope: change only src/a.py.`),["src/a.py"]);
  }
  for(const ban of ["Do not inspect other projects.","Do not read outside the billing folder.","Do not inspect reference material or private profile data."]){
    assert.deepEqual(requestedSourcePaths(`${ban} Scope: change only src/a.py.`),[]);
  }
});

test("specific, alias, absolute, glob and source-wide read bans remain conservative",async()=>{
  let reads=0;const reader=async()=>{reads++;throw Error("Must not read");};
  for(const ban of ["Do not read src/a.py.","Do not read SRC/A.PY.","Do not read sub/../src/a.py.","Do not inspect '/absolute/alias.py'.","Do not open *.py.","Do not look at src/a.py.","Do not access /absolute/private.py.","Do not scan source files.","Do not read any source files.","Read nothing."]){
    const ask=`Scope: change only src/a.py, src/b.py. ${ban}`;assert.deepEqual(requestedSourcePaths(ask),[]);
    const result=await preloadRequestedSource(opts({ask,reader}));assert.equal(result.context,"");assert.notEqual(result.scopeHint,true);
  }
  assert.equal(reads,0);
});

test("unknown restriction yields only literal declared-path metadata with zero probes or observations",async()=>{
  mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.py"),"PRIVATE_SOURCE_MUST_NOT_BE_READ=1\n");
  let reads=0;const notes=[],events=[],before=sourcePreloadReaderCount();
  const result=await preloadRequestedSource(opts({reader:async()=>{reads++;throw Error("No data read");},note:(...a)=>notes.push(a),emit:e=>events.push(e)}));
  assert.equal(result.scopeHint,true);assert.equal(result.reads,0);assert.equal(result.unavailable,0);assert.equal(reads,0);assert.equal(sourcePreloadReaderCount(),before);
  assert.deepEqual(notes,[]);assert.deepEqual(events,[]);assert(!result.context.includes("PRIVATE_SOURCE_MUST_NOT_BE_READ"));
  const data=hintData(result.context);assert.deepEqual(data.paths,["src/a.py","src/b.py"]);assert.equal(data.fileExistence,"not_checked");assert.equal(data.readsPerformed,0);assert.equal(data.readRestriction,"unknown");assert.equal(existsSync(join(root,"src/b.py")),false);
});

test("metadata hints retain all role, stage, schema, secret, containment and budget gates",async()=>{
  let reads=0;const reader=async()=>{reads++;throw Error("No read");};
  for(const extra of [{role:"phone"},{remote:true},{bot:{}},{stage:"review"},{stage:"execute"},{implementation:false},{permitted:[]},{offered:[]},{toolsEnabled:false},{offered:[tool({const:"other.py"})]},{offered:[tool({pattern:".*"})]},{contextChars:999},{current:()=>false},{allowContext:()=>false},{ask:"Scope: change only ../outside.py. Do not inspect reference material."},{ask:"Scope: change only credentials.py. Do not inspect reference material."}]){
    const result=await preloadRequestedSource(opts({reader,...extra}));assert.equal(result.context,"");
  }
  const one=await preloadRequestedSource(opts({reader,offered:[tool({enum:["src/a.py"]})]}));assert.deepEqual(hintData(one.context).paths,["src/a.py"]);assert.equal(reads,0);
});

test("outside-only positive Scope performs real bounded reads, never creates missing source or earns proof",async()=>{
  writeFileSync(join(root,"src/b.py"),"value=2\n");const notes=[],events=[];
  const result=await preloadRequestedSource(opts({ask:"Do not inspect outside the current working directory. Scope: change only src/a.py, src/b.py, src/new.py. Do not modify README.md.",note:(...a)=>notes.push(a),emit:e=>events.push(e)}));
  assert.equal(result.reads,2);assert.equal(result.unavailable,1);assert.notEqual(result.scopeHint,true);assert.equal(notes.length,2);assert(events.every(e=>!e.verification));assert.equal(existsSync(join(root,"src/new.py")),false);assert.equal(readFileSync(join(root,"src/b.py"),"utf8"),"value=2\n");
});

test("Stop or superseded scope cannot attach a planning hint",async()=>{
  const controller=new AbortController();controller.abort();await assert.rejects(preloadRequestedSource(opts({signal:controller.signal})),{name:"AbortError"});
  let current=true;const result=await preloadRequestedSource(opts({current:()=>current,allowContext:()=>{current=false;return true;}}));assert.equal(result.context,"");
});
