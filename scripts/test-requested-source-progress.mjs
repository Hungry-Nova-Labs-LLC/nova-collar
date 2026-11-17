import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {createRequestedSourceProgress} from "../src/main/requested-source-progress.js";
const cwd = "/allowed/project", path = join(cwd, "src/feature.mjs");
const digest = value => createHash("sha256").update(value).digest("hex");
const before = "export const value = 1;\n", text = "export const value = 2;\n";
const snapshot = (extra = {}) => ({path,currentPath:path,initialHash:digest(before),currentHash:digest(text),savedHash:digest(text),text,authorizedSave:true,...extra});
const policy = (extra = {}) => createRequestedSourceProgress({ask:"Fix src/feature.mjs and verify behavior.",cwd,denyPath:()=>false,...extra});

test("a saved current revision of one explicitly requested existing source qualifies; this is no test verdict", () => {
  assert.equal(policy()({cwd,snapshots:[snapshot()]}),true);
  assert.equal(policy({ask:"Fix src/other.mjs, src/feature.mjs."})({cwd,snapshots:[snapshot()]}),true);
  assert.equal(Object.hasOwn(snapshot(),"passed"),false);
});

test("unknown baseline/current/save metadata, no-op, stale body and read-only observations do not qualify", () => {
  for (const extra of [{initialHash:null},{initialHash:false},{initialHash:"unknown"},{currentHash:null},{currentHash:"x".repeat(64)},
    {savedHash:null},{savedHash:digest(before)},{currentHash:digest(before),savedHash:digest(before),text:before},
    {text:before},{authorizedSave:false},{authorizedSave:undefined}]) assert.equal(policy()({cwd,snapshots:[snapshot(extra)]}),false,JSON.stringify(extra));
  assert.equal(policy()({cwd,snapshots:[]}),false);
});

test("unrequested/helper/verification-only/protected/secret snapshots cannot disable the optional guard", () => {
  assert.equal(policy()({cwd,snapshots:[snapshot({path:join(cwd,"src/other.mjs"),currentPath:join(cwd,"src/other.mjs")})]}),false);
  for (const target of ["test_feature.py","checks/feature.mjs","feature.test.mjs","verify.mts"]) {
    const other=join(cwd,target);
    assert.equal(policy()({cwd,snapshots:[snapshot({path:other,currentPath:other})]}),false,target);
    assert.equal(policy({ask:`Fix ${target}.`})({cwd,snapshots:[snapshot({path:other,currentPath:other})]}),false,target);
  }
  const check='import assert from "node:assert/strict"; assert.equal(1,1);\n';
  assert.equal(policy()({cwd,snapshots:[snapshot({text:check,currentHash:digest(check),savedHash:digest(check)})]}),false);
  assert.equal(policy({protectedPaths:[join(cwd,"elsewhere/FEATURE.mjs")]})({cwd,snapshots:[snapshot()]}),false);
  assert.equal(policy({denyPath:()=>true})({cwd,snapshots:[snapshot()]}),false);
  assert.equal(policy({denyPath:undefined})({cwd,snapshots:[snapshot()]}),false);
});

test("only positive current-scope paths qualify; quoted history and negative/protected paths do not", () => {
  for (const ask of ["Review src/feature.mjs.","Fix src/other.mjs; do not change src/feature.mjs.",
    "Example: Fix src/feature.mjs.","Fix src/feature.mjs; keep src/feature.mjs unchanged.",
    "Fix src/feature.mjs; do not read any source files."]) assert.equal(policy({ask})({cwd,snapshots:[snapshot()]}),false,ask);
  assert.equal(policy({ask:"Do not inspect hidden private material. Fix src/feature.mjs."})({cwd,snapshots:[snapshot()]}),true,
    "an unknown privacy category grants no read; an independently authorized cached public-source save still counts");
});

test("CWD changes, case-only unrelated paths and outside aliases fail closed without canonicalization", () => {
  assert.equal(policy()({cwd:"/allowed/other",snapshots:[snapshot()]}),false);
  for (const other of ["/outside/feature.mjs",join(cwd,"src/Feature.mjs")]) assert.equal(policy()({cwd,snapshots:[snapshot({path:other,currentPath:other})]}),false);
  assert.equal(policy()({cwd,snapshots:[snapshot({currentPath:"/outside/feature.mjs"})],aliases:new Map([[path,"/outside/feature.mjs"]])}),false);
  const alias=join(cwd,"canonical/feature.mjs");
  assert.equal(policy()({cwd,snapshots:[snapshot({path:alias,currentPath:alias})],aliases:new Map([[path,alias]])}),true,
    "only a supplied existing cache identity can match an in-CWD alias");
});

test("large, malformed and thrown-denial inputs keep the optional guard on", () => {
  const large="x".repeat(80001);
  assert.equal(policy()({cwd,snapshots:[snapshot({text:large,currentHash:digest(large),savedHash:digest(large)})]}),false);
  assert.equal(policy({denyPath:()=>{throw Error("denied");}})({cwd,snapshots:[snapshot()]}),false);
  for(const snapshots of [null,{},"source"]) assert.equal(policy()({cwd,snapshots}),false);
});
