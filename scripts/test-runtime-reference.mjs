import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";
import { analyzeRuntimeReferenceSource as analyze } from "../src/main/runtime-reference-core.js";
import { analyzeRuntimeReferences, createRuntimeReferenceAwareness, runtimeReferenceObservation } from "../src/main/runtime-reference.js";

const snapshot = (text, path = "/bounded/project/example.mjs") => ({path,text,hash:createHash("sha256").update(text).digest("hex")});
const names = result => result.findings.map(row => row.name);
const typed = 'import type { Shape } from "./never-resolve-this";\nexport function render(input: Shape) { return combineParts(scanValue(input)); }\n';

test("type-only declarations do not create runtime bindings; actual runtime imports do", () => {
  const result = analyze(snapshot(typed,"/bounded/project/example.ts"));
  if (typeof nodeModule.stripTypeScriptTypes !== "function") { assert.equal(result.status,"unavailable"); return; }
  assert.equal(result.status,"findings");assert.deepEqual(names(result),["combineParts","scanValue"]);assert(result.findings.every(x=>x.line===2));
  const query=analyze(snapshot('type Shape=import("./never-resolve-this").Shape;\nexport function render(input: Shape) { return combineParts(scanValue(input)); }','/bounded/project/query.ts'));
  assert.deepEqual(names(query),["combineParts","scanValue"],"a type query does not import runtime callees either");
  const correct=analyze(snapshot('import {combineParts,scanValue} from "./still-never-resolved";\nexport function render(input) { return combineParts(scanValue(input)); }'));
  assert.equal(correct.status,"no_findings");assert.equal(runtimeReferenceObservation(correct),"");
});

test("real lexical scopes bind parameters, destructuring, catch names, aliases and named functions", () => {
  const text='import {value as alias} from "./not-loaded"; const object={value:1};\nexport function f({local}, [item]) { try { throw 1; } catch(error) { return (()=>local+item+error+alias+object.value)(); } }\nconst self=function own(){ return own; };';
  assert.deepEqual(names(analyze(snapshot(text))),[]);
  assert.deepEqual(names(analyze(snapshot('const object={value:1}; export const f=()=>({missing, present:object.value});'))),["missing"]);
});

test("typeof probes and conservative runtime globals do not manufacture missing bindings", () => {
  assert.deepEqual(names(analyze(snapshot('if(typeof OptionalHook!=="undefined") console.log(globalThis,Buffer,process,window,document,fetch,AbortController);'))),[]);
  assert.deepEqual(names(analyze(snapshot('const value=typeof MissingObject.member;'))),["MissingObject"]);
  assert.deepEqual(names(analyze(snapshot('export const hook=()=>customInjectedHook();'))),["customInjectedHook"]);
});

test("a sole immediate typeof-function guarded call is exempt, not unrelated or changed-scope uses", () => {
  for(const source of ['if(typeof optionalHook === "function") optionalHook();',
    'if("function" === typeof optionalHook) { optionalHook(); }',
    'export function run(){if(typeof optionalHook === "function") { return optionalHook(); }}']) {
    assert.deepEqual(names(analyze(snapshot(source))),[]);
  }
  for(const source of ['if(typeof optionalHook === "function") optionalHook(); optionalHook();',
    'if(typeof optionalHook === "function") {} else { optionalHook(); }',
    'if(typeof optionalHook === "function") { optionalHook=undefined; optionalHook(); }',
    'if(typeof optionalHook === "function") { const later=()=>optionalHook(); }']) {
    assert.deepEqual(names(analyze(snapshot(source))),['optionalHook']);
  }
  assert.deepEqual(names(analyze(snapshot('alert("x");confirm("x");prompt("x");new MutationObserver(()=>{});'))),[]);
});

test("dynamic scopes, unsupported syntax/formats or missing strip API are unavailable rather than passing", () => {
  for(const source of ['eval("var injected=1"); injected();','with(object){ injected(); }','export const value = ;']) {
    const result=analyze(snapshot(source));assert.equal(result.status,"unavailable");assert.equal(result.findings.length,0);assert(!Object.hasOwn(result,"passed"));
  }
  assert.equal(analyze(snapshot('<view/>','/bounded/project/example.tsx')).status,"unavailable");
  assert.equal(analyze(snapshot('enum Mode {One,Two}','/bounded/project/example.ts')).status,"unavailable");
  assert.equal(analyze(snapshot(typed,'/bounded/project/example.ts'),{stripTypes:null}).status,"unavailable");
  assert.equal(analyze(snapshot('const n=1;'),{parser:null}).status,"unavailable");
  assert.equal(analyze(snapshot('const n=1;'),{scopeAnalyzer:null}).status,"unavailable");
});

test("CommonJS lexical bindings and supported modern TypeScript modes remain scoped", () => {
  assert.deepEqual(names(analyze(snapshot('const value=require("never-load"); module.exports=function(x){return value+x+arguments.length;};','/bounded/project/example.cjs'))),[]);
  for(const ext of ['mts','cts']) {
    const source=ext==='mts'?'export const f=(x:number)=>missingHelper(x);':'module.exports=(x:number)=>missingHelper(x);';
    const result=analyze(snapshot(source,'/bounded/project/example.'+ext));
    if(typeof nodeModule.stripTypeScriptTypes==='function')assert.deepEqual(names(result),['missingHelper']);else assert.equal(result.status,'unavailable');
  }
});

test("source bytes/hash/layout and output size are bounded without source or AST leakage", () => {
  assert.equal(analyze(snapshot('//'+"界".repeat(30_000))).status,"unavailable");
  assert.equal(analyze({...snapshot('const n=1;'),hash:'0'.repeat(64)}).status,"unavailable");
  assert.equal(analyze(snapshot(typed,'/bounded/project/example.ts'),{stripTypes:()=>''}).status,"unavailable");
  const result=analyze(snapshot(Array.from({length:20},(_,n)=>`missing${n}();`).join('\n')));
  assert.equal(result.findings.length,8);assert.equal(result.omittedCount,12);
  const observation=runtimeReferenceObservation(result),json=observation.slice(observation.indexOf(': ')+2,observation.indexOf('\nNames listed'));
  assert(json.length<=2200);assert.equal(JSON.parse(json).findings.length,8);assert(!json.includes('missing19'));
  assert(!Object.hasOwn(result,'passed'));assert(!Object.hasOwn(result,'verification'));assert.match(observation,/no pass, failure debt, permission or verification credit/);
});

test("actual worker parses source as data and reports its own Node/Electron/TS capabilities", async () => {
  const result=await analyzeRuntimeReferences(snapshot('import {writeFileSync} from "node:fs"; export function f(){return absentBinding();}'));
  assert.equal(result.status,'findings');assert.deepEqual(names(result),['absentBinding']);
  assert.equal(result.analysisRuntime.node,process.versions.node);
  assert.equal(result.analysisRuntime.nativeTypeStripAvailable,typeof nodeModule.stripTypeScriptTypes==='function');
  assert.equal(result.analysisRuntime.electron,process.versions.electron||null);
  const ts=await analyzeRuntimeReferences(snapshot(typed,'/bounded/project/example.ts'));
  assert.equal(ts.status,typeof nodeModule.stripTypeScriptTypes==='function'?'findings':'unavailable');
});

test("worker timeout/Stop supply no verification and oversize input never enters analysis", async () => {
  const slow=await analyzeRuntimeReferences(snapshot('//'+"x".repeat(70_000)),{timeoutMs:1});assert.equal(slow.status,'unavailable');
  const oversized=await analyzeRuntimeReferences(snapshot('//'+"x".repeat(90_000)));assert.equal(oversized.status,'unavailable');
  const stop=new AbortController();stop.abort();await assert.rejects(analyzeRuntimeReferences(snapshot('missing();'),{signal:stop.signal}),{name:'AbortError'});
  const during=new AbortController();const pending=analyzeRuntimeReferences(snapshot('//'+"x".repeat(70_000)),{signal:during.signal});during.abort();await assert.rejects(pending,{name:'AbortError'});
});

test("awareness uses only observed successful cached writes, dedupes revisions and caps four analyses", async () => {
  let checks=0,reads=0;const source=snapshot('missing();');
  const awareness=createRuntimeReferenceAwareness({snapshot:()=>{reads++;return source;},maxChecks:100,analyze:async value=>{checks++;return analyze(value);}});
  for(const args of [{name:'host_file_read',result:{ok:true,path:source.path}},{name:'host_file_write',result:{ok:false,path:source.path}},{name:'host_file_edit',result:{ok:true,changed:false,path:source.path}}]) assert.equal(await awareness.observe(args),'');
  assert.equal(reads,0);
  const write={name:'host_file_write',result:{ok:true,path:source.path}};assert.match(await awareness.observe(write),/missing/);assert.equal(await awareness.observe(write),'');assert.equal(checks,1);
  for(let n=0;n<8;n++){source.text=`missing${n}();`;source.hash=createHash('sha256').update(source.text).digest('hex');await awareness.observe(write);}
  assert.equal(checks,4);
});

test("async analysis is discarded if the current cached identity changes or Stop arrives before attachment", async () => {
  for(const change of ['hash','path','result-hash','missing']) {
    const first=snapshot('missing();');let current=first,checks=0;
    const awareness=createRuntimeReferenceAwareness({snapshot:()=>current,analyze:async value=>{
      checks++;const result=analyze(value);
      if(change==='hash')current=snapshot('different();');
      if(change==='path')current={...first,path:'/bounded/project/different.mjs'};
      if(change==='missing')current=null;
      return change==='result-hash'?{...result,sourceHash:'0'.repeat(64)}:result;
    }});
    assert.equal(await awareness.observe({name:'host_file_write',result:{ok:true,path:first.path}}),'');assert.equal(checks,1);
  }
  for(const stopAt of ['analysis','cached-recheck']) {
    const stop=new AbortController(),source=snapshot('missing();');let reads=0;
    const awareness=createRuntimeReferenceAwareness({snapshot:()=>{if(++reads===2&&stopAt==='cached-recheck')stop.abort();return source;},
      analyze:async value=>{const result=analyze(value);if(stopAt==='analysis')stop.abort();return result;}});
    await assert.rejects(awareness.observe({name:'host_file_write',result:{ok:true,path:source.path},signal:stop.signal}),{name:'AbortError'});
  }
});
