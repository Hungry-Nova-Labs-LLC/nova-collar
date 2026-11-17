import assert from "node:assert/strict";
import {after, test} from "node:test";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createNewPathProbe, newPathProbeCount} from "../src/main/new-path-probe.js";

const repo=dirname(dirname(fileURLToPath(import.meta.url))),root=mkdtempSync(join(repo,".path-probe-test-"));
const cwd=join(root,"project");mkdirSync(cwd);after(()=>rmSync(root,{recursive:true,force:true}));
const options={cwd,denyPath:()=>false};

test("metadata worker distinguishes first-observed new/existing paths without source reads",async()=>{
  const existing=join(cwd,"existing.py");writeFileSync(existing,"private source need not be read");
  const states=new Map(),probe=createNewPathProbe({...options,initialFiles:states});
  const missing=join(cwd,"sub/new.py");assert.equal(probe.state(missing),undefined);assert.equal(probe.state(existing),undefined);
  await probe.settle();assert.equal(probe.state(missing),false);assert.equal(probe.state(existing),true);
  mkdirSync(join(cwd,"sub"));writeFileSync(missing,"now created by the completed tool");
  assert.equal(probe.state(missing),false,"first observed absence remains associated with turn-created helper");probe.close();
});

test("outside and symlink escapes stay unknown; optional cap grants no permission",async()=>{
  const outside=join(root,"outside");mkdirSync(outside);symlinkSync(outside,join(cwd,"link"));
  const probe=createNewPathProbe(options);assert.equal(probe.state(join(outside,"new.py")),undefined);
  const escaped=join(cwd,"link/new.py");probe.state(escaped);await probe.settle();assert.equal(probe.state(escaped),undefined);probe.close();
});

function fake(){const child=new EventEmitter();child.pid=999999;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kills=[];child.kill=s=>{child.kills.push(s);return false;};child.unref=()=>{};return child;}
async function drained(){for(let i=0;i<100&&newPathProbeCount();i++)await new Promise(r=>setTimeout(r,2));assert.equal(newPathProbeCount(),0);}

test("unknown metadata and a blocked child bound latency and preserve occupied capacity",async()=>{
  await drained();const children=[],spawnProbe=()=>{const c=fake();children.push(c);return c;};
  const probe=createNewPathProbe({...options,timeoutMs:20,spawnProbe});let ticks=0;const ticker=setInterval(()=>ticks++,1),start=Date.now();
  for(let i=0;i<4;i++)probe.state(join(cwd,`slow-${i}.py`));await probe.settle();clearInterval(ticker);
  assert(Date.now()-start<500);assert(ticks>0);assert.equal(children.length,4);assert(children.every(c=>c.kills.includes('SIGKILL')));
  probe.state(join(cwd,"capacity.py"));await probe.settle();assert.equal(children.length,4,"unexited children keep their slots");
  for(const c of children)c.emit('exit');probe.close();
});

test("invalid/canonical-denied child data never establishes newness",async()=>{
  const child=fake(),path=join(cwd,"probe.py");const probe=createNewPathProbe({...options,spawnProbe:()=>child});probe.state(path);
  child.stdout.write(JSON.stringify({known:true,isNew:true,root:cwd,path:join(cwd,"other.py")})+'\n');
  await probe.settle();assert.equal(probe.state(path),undefined);child.emit('exit');probe.close();
});

test("Stop and synchronous probe startup errors remain unknown, never successful state",async()=>{
  const child=fake(),controller=new AbortController(),path=join(cwd,"stop.py");
  const probe=createNewPathProbe({...options,signal:controller.signal,spawnProbe:()=>child});probe.state(path);controller.abort();await probe.settle();
  assert.equal(probe.state(path),undefined);assert.deepEqual(child.kills,['SIGKILL']);child.emit('exit');probe.close();
  const failed=createNewPathProbe({...options,spawnProbe:()=>{throw Error('startup failed');}});failed.state(join(cwd,'failed.py'));await failed.settle();failed.close();
});
