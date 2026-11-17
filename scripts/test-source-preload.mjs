import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PRELOAD_LIMITS, boundedReadSource, boundedSourceSnapshot, preloadAuthorized, preloadRequestedSource, requestedSourcePaths, sourcePreloadReaderCount } from "../src/main/source-preload.js";

const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".preload-test-"));
const sha = text => createHash("sha256").update(text).digest("hex");
const tool = (path = {}) => ({ type: "function", function: { name: "host_file_read", parameters: { type: "object", properties: { path: { type: "string", ...path } }, required: ["path"], additionalProperties: false } } });
const denyPath = path => /(?:^|\/)\.env(?:\.|$)|(?:^|\/)credentials?(?:\.|\/|$)|private-key/i.test(path);
const redact = text => text.replace(/TOKEN_PRIVATE_[A-Z]+/g, "[redacted]");
const snapshot = (path, text) => ({ ok: true, path, rawText: text, bytes: Buffer.byteLength(text), sha256: sha(text), identity: "test" });
const options = extra => ({ ask: "Fix module.py", cwd: root, implementation: true, stage: "edit", permitted: [tool()], offered: [tool()], denyPath, redact, pack: JSON.stringify, ...extra });
// Injected status-preserving packer: exercises preload's own escaping/shared
// budget logic. The full production packer/runTurn awaits complete source.
function pack(result, { max }) {
  const copy = structuredClone(result);
  if (JSON.stringify(copy).length <= max) return JSON.stringify(copy);
  if (typeof copy.text === "string") {
    const text = copy.text;
    const set = length => { copy.text=text.slice(0,length); copy.read.endOffset=length; copy.read.nextOffset=length<text.length?length:null; copy.read.eof=copy.read.completeFile=length===text.length; copy.text_truncated=length<text.length; };
    let low=0,high=text.length;
    while(low<high) { const mid=Math.ceil((low+high)/2); set(mid); if(JSON.stringify(copy).length<=max) low=mid; else high=mid-1; }
    set(low);
  }
  return JSON.stringify(copy).length <= max ? JSON.stringify(copy) : JSON.stringify({ ok: copy.ok, packing: { truncated: true, omitted: true } });
}

test("explicit positive literal code paths only, with lists and quoted spaces", () => {
  assert.deepEqual(requestedSourcePaths("Fix src/a.py and src/b.py; update `lib/my file.js`."), ["src/a.py", "src/b.py", "lib/my file.js"]);
  assert.deepEqual(requestedSourcePaths("Fix first.mjs and update second.mjs."),["first.mjs","second.mjs"]);
  assert.deepEqual(requestedSourcePaths("Files you may change: a.py, b.py"), ["a.py", "b.py"]);
  assert.deepEqual(requestedSourcePaths("Files to edit:\n- a.py\n- b.py\nKeep c.py unchanged"), ["a.py", "b.py"]);
  assert.deepEqual(requestedSourcePaths("Can we fix a.py?"), ["a.py"]);
  assert.deepEqual(requestedSourcePaths("Implement the requested API in a.py"), ["a.py"]);
  assert.deepEqual(requestedSourcePaths("Fix My Code/a.py"), []);
  assert.deepEqual(requestedSourcePaths("Review a.py; perhaps change b.py"), []);
});

test("negative/protected, quoted logs, fences, URLs and globs never become preloads", () => {
  assert.deepEqual(requestedSourcePaths("Fix a.py and b.py; do not read a.py; keep b.py unchanged"), []);
  assert.deepEqual(requestedSourcePaths("Fix sub/../a.py; do not read a.py"),[]);
  assert.deepEqual(requestedSourcePaths("Fix a.py; do not read sub/../a.py"),[]);
  assert.deepEqual(requestedSourcePaths("Fix sub/../a.py; keep a.py unchanged"),[]);
  assert.deepEqual(requestedSourcePaths("Fix a.py; do not read '/an/absolute/alias.py'"),[]);
  assert.deepEqual(requestedSourcePaths("Fix a.py without changing b.py"), ["a.py"]);
  assert.deepEqual(requestedSourcePaths("Example: fix a.py\n> Fix b.py\n```py\nfix c.py\n```\nFix https://example.test/a.py\nFix *.py\nFix 'old request: fix d.py'"), []);
  assert.deepEqual(requestedSourcePaths("Fix a.py, b.py, c.py, d.py, e.py"), ["a.py", "b.py", "c.py", "d.py"]);
});

test("equivalent lexical candidates are read once, and negative aliases cause zero reads",async()=>{
  const observed=[];const reader=async args=>{observed.push(args.path);return snapshot(join(root,"module.py"),"x=1");};
  const result=await preloadRequestedSource(options({ask:"Fix sub/../module.py and module.py",pack,reader}));
  assert.equal(result.reads,1);assert.deepEqual(observed,["sub/../module.py"]);
  const denied=await preloadRequestedSource(options({ask:"Fix sub/../module.py; do not read module.py",pack,reader}));
  assert.equal(denied.context,"");assert.equal(observed.length,1);
});

test("role, stage, tool authority and actual path schemas are required", () => {
  for (const extra of [{permitted:[]}, {offered:[]}, {role:"phone"}, {role:"other"}, {bot:{}}, {remote:true}, {stage:"review"}, {stage:"execute"}, {toolsEnabled:false}, {implementation:false}]) assert.equal(preloadAuthorized(options(extra)), false);
  const accept = preloadAuthorized(options({ permitted: [tool({enum:["module.py"]})], offered:[tool({const:"module.py"})] }));
  assert.equal(accept("module.py"), true); assert.equal(accept("other.py"), false);
  const moreRequired = tool(); moreRequired.function.parameters.required.push("secret");
  assert.equal(preloadAuthorized(options({offered:[moreRequired]}))("module.py"), false);
  const conditional = tool(); conditional.function.parameters.if={properties:{path:{const:"module.py"}}};
  assert.equal(preloadAuthorized(options({offered:[conditional]}))("module.py"), false);
  assert.equal(preloadAuthorized(options({offered:[tool({pattern:"^(a+)+$"})]}))("module.py"),false);
  assert.equal(preloadAuthorized(options({offered:[tool({maxLength:0})]}))("module.py"),false);
  assert.equal(preloadAuthorized(options({offered:[tool({enum:null})]}))("module.py"),false);
  const badRequired=tool();badRequired.function.parameters.required=null;
  assert.equal(preloadAuthorized(options({offered:[badRequired]}))("module.py"),false);
});

test("excluded capability/scope/secret paths perform zero reader calls", async () => {
  let calls=0; const reader=async()=>{calls++;throw Error("must not read");};
  for (const extra of [{role:"phone"}, {remote:true}, {bot:{}}, {offered:[]}, {stage:"review"}, {ask:"Fix ../outside.py"}, {ask:"Fix credentials.py"}, {contextChars:999}, {current:()=>false}]) {
    const result=await preloadRequestedSource(options({reader,...extra})); assert.equal(result.context, "");
  }
  assert.equal(calls,0);
});

test("real isolated FD read is complete, UTF8 exact and remains read-only", async () => {
  const path=join(root,"module.py"), text="# 😀\nvalue = 7\n"; writeFileSync(path,text);
  const result=await boundedReadSource({cwd:root,path:"module.py",denyPath});
  assert.equal(result.ok,true); assert.equal(result.rawText,text); assert.equal(result.path,realpathSync(path)); assert.equal(result.sha256,sha(text)); assert.equal(result.bytes,Buffer.byteLength(text));
  assert.equal(readFileSync(path,"utf8"),text);
});

test("real reader rejects oversized/binary/invalidUTF8/missing/symlink/hardlink paths", async () => {
  writeFileSync(join(root,"large.py"),"x".repeat(8193)); writeFileSync(join(root,"binary.py"),Buffer.from([1,0,2])); writeFileSync(join(root,"invalid.py"),Buffer.from([255,255]));
  symlinkSync(join(root,"module.py"),join(root,"link.py")); linkSync(join(root,"module.py"),join(root,"hard.py"));
  mkdirSync(join(root,"actual")); writeFileSync(join(root,"actual","inner.py"),"x=1"); symlinkSync(join(root,"actual"),join(root,"linked-dir"));
  for(const path of ["large.py","binary.py","invalid.py","missing.py","link.py","hard.py","module.py","linked-dir/inner.py"]) {
    const result=await boundedReadSource({cwd:root,path,denyPath}); assert.equal(result.ok,false,path); assert.equal(result.unavailable,true,path); assert.equal(result.rawText,undefined,path);
  }
});

test("actual read receipts expose redacted source, private exact snapshot only to note", async () => {
  writeFileSync(join(root,"visible.py"),"secret='TOKEN_PRIVATE_ABC'\nvalue=1\n");
  const events=[], notes=[];
  const result=await preloadRequestedSource(options({ask:"Fix visible.py",pack,emit:e=>events.push(e),note:(...args)=>notes.push(args)}));
  assert.equal(result.reads,1); assert.match(result.context,/\[redacted\]/); assert.doesNotMatch(result.context,/TOKEN_PRIVATE/);
  assert.equal(events.length,2); assert.equal(events[0].modelRequested,false); assert.equal(events[1].contextIncluded,true); assert.doesNotMatch(JSON.stringify(events),/TOKEN_PRIVATE/);
  assert.equal(notes.length,1); const [name,args,receipt,internal]=notes[0]; assert.equal(name,"host_file_read"); assert.equal(args.path,"visible.py");
  assert.match(internal.rawSourceSnapshot.text,/TOKEN_PRIVATE/); assert.match(boundedSourceSnapshot(receipt,internal),/TOKEN_PRIVATE/);
  assert.equal(receipt.rawText,undefined); assert.equal(receipt.read.completeFile,true);
});

test("source context is bounded valid quoted JSON, and partial source cannot prime note", async () => {
  const notes=[], events=[];
  const text="<tag>😀</tag>\n".repeat(450);
  const result=await preloadRequestedSource(options({ask:"Fix module.py",contextChars:1800,pack,reader:async()=>snapshot(join(root,"module.py"),text),note:(...a)=>notes.push(a),emit:e=>events.push(e)}));
  assert.ok(result.context.length<=1800); assert.ok(result.context.length>0); assert.doesNotMatch(result.context,/<tag>/);
  const json=result.context.split("\n").slice(2,-1).join("\n"); const data=JSON.parse(json); assert.equal(data.modelRequested,false); assert.equal(data.receipts[0].result.read.completeFile,false);
  assert.equal(notes.length,0); assert.equal(events[1].read.completeFile,false);
});

test("budget rejection or changed scope cannot seed hidden read-first snapshots", async () => {
  const notes=[],events=[];
  const result=await preloadRequestedSource(options({pack,reader:async()=>snapshot(join(root,"module.py"),"x=1"),allowContext:()=>false,note:(...a)=>notes.push(a),emit:e=>events.push(e)}));
  assert.equal(result.context,""); assert.equal(notes.length,0); assert.equal(events[1].contextIncluded,false);
  let current=true;
  const changed=await preloadRequestedSource(options({pack,reader:async()=>{current=false;return snapshot(join(root,"module.py"),"x=1");},current:()=>current,note:(...a)=>notes.push(a)}));
  assert.equal(changed.context,""); assert.equal(notes.length,0);
});

test("bounded raw snapshot rejects redacted/corrupt/partial/oversized data", () => {
  const raw="TOKEN_PRIVATE_ABC", text=redact(raw), path=join(root,"x.py");
  const result={ok:true,path,bytes:Buffer.byteLength(raw),text,read:{offset:0,totalChars:text.length,viewSha256:sha(text),completeFile:true}};
  const good={rawSourceSnapshot:{path,text:raw,bytes:Buffer.byteLength(raw),sha256:sha(raw)}};
  assert.equal(boundedSourceSnapshot(result,good),raw);
  assert.equal(boundedSourceSnapshot(result,{rawSourceSnapshot:{...good.rawSourceSnapshot,text}}),undefined);
  assert.equal(boundedSourceSnapshot({...result,read:{...result.read,completeFile:false}},good),undefined);
  assert.equal(boundedSourceSnapshot(result,{rawSourceSnapshot:{...good.rawSourceSnapshot,sha256:"bad"}}),undefined);
  assert.equal(boundedSourceSnapshot(result,{rawSourceSnapshot:{...good.rawSourceSnapshot,path:"other.py"}}),undefined);
  assert.equal(boundedSourceSnapshot({...result,bytes:8193},{rawSourceSnapshot:{path,text:"x".repeat(8193),bytes:8193,sha256:sha("x".repeat(8193))}}),undefined);
});

test("actual harness note hunk caches raw snapshot without any second filesystem read", () => {
  const source=readFileSync(new URL("../src/main/harness.js",import.meta.url),"utf8");
  const method=source.slice(source.indexOf("    note(name, args, result, sourceOptions) {"),source.indexOf("    before(name, rawArgs) {")).trim().replace(/,$/,"");
  const prior=new Map(); let rereads=0;
  const api=vm.runInNewContext(`({${method}})`,{READ:new Set(["host_file_read"]),WRITE:new Set(),prior,boundedSourceSnapshot,snapshotIfExists:()=>{rereads++;throw Error("whole-file reread");}});
  const raw="TOKEN_PRIVATE_ABC", text=redact(raw), path=join(root,"source.py");
  const result={ok:true,path,bytes:Buffer.byteLength(raw),text,read:{offset:0,totalChars:text.length,viewSha256:sha(text),completeFile:true}};
  api.note("host_file_read",{path:"source.py"},result,{rawSourceSnapshot:{path,text:raw,bytes:Buffer.byteLength(raw),sha256:sha(raw)}});
  assert.equal(rereads,0); assert.equal(prior.get(path),raw); assert.equal(prior.get("source.py"),raw);
  prior.clear(); api.note("host_file_read",{path:"source.py"},result,{rawSourceSnapshot:{path,text,bytes:Buffer.byteLength(raw),sha256:sha(raw)}});
  assert.equal(rereads,0); assert.equal(prior.size,0);
});

function fakeReader() {
  const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin=new PassThrough(); child.kills=[]; child.kill=signal=>{child.kills.push(signal);return false;}; child.unref=()=>{}; return child;
}

test("deadline bounds event-loop latency; stuck children retain all four capacity slots", async () => {
  const deadline=Date.now()+500; while(sourcePreloadReaderCount() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(sourcePreloadReaderCount(),0,"prior real child exits were observed");
  const children=[]; let ticks=0; const ticker=setInterval(()=>ticks++,1);
  const spawnReader=()=>{const c=fakeReader();children.push(c);return c;}; const start=Date.now();
  const values=await Promise.all(Array.from({length:4},()=>boundedReadSource({cwd:root,path:"module.py",denyPath,timeoutMs:20,spawnReader})));
  clearInterval(ticker); assert.ok(Date.now()-start<500); assert.ok(ticks>0); assert.ok(values.every(row=>row.unavailable && /timed out/.test(row.error)));
  assert.ok(children.every(child=>child.kills.includes("SIGKILL")));
  const fifth=await boundedReadSource({cwd:root,path:"module.py",denyPath,timeoutMs:20,spawnReader}); assert.match(fifth.error,/capacity/); assert.equal(children.length,4);
  for(const child of children) child.emit("exit",null,"SIGKILL");
});

test("Stop rejects normally and never becomes a successful preload", async () => {
  const child=fakeReader(), controller=new AbortController();
  const promise=boundedReadSource({cwd:root,path:"module.py",denyPath,signal:controller.signal,spawnReader:()=>child});
  controller.abort(); await assert.rejects(promise,{name:"AbortError"}); assert.deepEqual(child.kills,["SIGKILL"]); child.emit("exit",null,"SIGKILL");
});

test("canonical denial is decided before granting worker permission to read", async () => {
  const child=fakeReader(); let messages=""; child.stdin.on("data",data=>{messages+=data;});
  const promise=boundedReadSource({cwd:root,path:"module.py",denyPath:path=>path.includes("private-key"),spawnReader:()=>child});
  child.stdout.write(JSON.stringify({type:"ready",path:join(root,"private-key.py"),bytes:3})+"\n");
  assert.equal((await promise).unavailable,true); assert.doesNotMatch(messages,/proceed/); child.emit("exit",null,"SIGKILL");
});

test("unfinished/corrupt worker output never becomes source or proof", async () => {
  const child=fakeReader(); const promise=boundedReadSource({cwd:root,path:"module.py",denyPath,timeoutMs:20,spawnReader:()=>child});
  child.stdout.write('{"type":"result","ok":true,"rawText":"partial');
  const result=await promise; assert.equal(result.unavailable,true); assert.equal(result.rawText,undefined); child.emit("exit",null,"SIGKILL");
});

test("optional reader errors become explicit unavailable, while policy exceptions fail closed", async () => {
  const failed=await preloadRequestedSource(options({pack,reader:async()=>{throw Error("I/O unavailable");}}));
  assert.equal(failed.unavailable,1); assert.match(failed.context,/unavailable/); assert.doesNotMatch(failed.context,/I\/O unavailable/);
  let calls=0; const closed=await preloadRequestedSource(options({denyPath:()=>{throw Error("policy unavailable");},reader:async()=>{calls++;}}));
  assert.equal(closed.context,""); assert.equal(calls,0);
});

test.after(()=>rmSync(root,{recursive:true,force:true}));
