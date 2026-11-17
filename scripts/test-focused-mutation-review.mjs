import assert from "node:assert/strict";
import {test,after} from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
const root=mkdtempSync(join(tmpdir(),"collar-focused-review-"));process.env.NOVAPUP_HOME=join(root,"profile");
const {planFileEdit,commitFileEdit}=await import("../src/main/file-edit.js");
const {writeUserFile}=await import("../src/main/files.js");
const {ensureHome}=await import("../src/main/config.js");ensureHome();
after(()=>rmSync(root,{recursive:true,force:true}));
const before="export function normalize(value) {\n  if (value == null) return 0;\n  return value;\n}\n";
const afterText="export function normalize(value) {\n  return value;\n}\n";
const edits=[{oldText:"  if (value == null) return 0;\n",newText:""}];

test("actual focused commit and whole-file write produce identical bounded removed-source review",()=>{
  const focused=join(root,"focused.mjs"),whole=join(root,"whole.mjs");writeFileSync(focused,before);writeFileSync(whole,before);
  const result=commitFileEdit(planFileEdit(focused,edits),{allow:true}),replacement=writeUserFile(whole,afterText,{allow:true});
  assert.equal(result.ok,true);assert.equal(result.changed,true);assert.equal(readFileSync(focused,"utf8"),afterText);assert.equal(readFileSync(whole,"utf8"),afterText);
  assert.deepEqual(result.mutationReview,replacement.mutationReview);assert.match(result.mutationReview.removedExcerpt,/if \(value == null\) return 0/);
  assert.equal(result.mutationReview.informational,true);assert(!Object.hasOwn(result.mutationReview,"passed"));assert(!Object.hasOwn(result.mutationReview,"verification"));
  assert(!Object.hasOwn(result,"original"));assert(!Object.hasOwn(result,"content"));
});
test("no-op stale held and stopped focused edits disclose no removed-source notice",()=>{
  for(const mode of ["noop","stale","held","stop"]){
    const path=join(root,mode+".mjs");writeFileSync(path,before);
    const plan=planFileEdit(path,mode==="noop"?[{oldText:"return value",newText:"return value"}]:edits);
    if(mode==="stale")writeFileSync(path,before+"// later human edit\n");
    const stop=new AbortController();if(mode==="stop")stop.abort();
    const result=commitFileEdit(plan,{tasker:mode==="held"?"user":"",allow:mode!=="held",signal:stop.signal});
    assert.equal(result.mutationReview,undefined,mode);assert.equal(readFileSync(path,"utf8"),mode==="stale"?before+"// later human edit\n":before);
    if(mode==="noop")assert.equal(result.unchanged,true);else assert.equal(result.ok,false);
  }
});
test("multibyte previous sources over80000bytes and binary files never expose excerpts",()=>{
  const large=join(root,"large.txt"),text="é".repeat(40_001);writeFileSync(large,text);
  const result=commitFileEdit(planFileEdit(large,[{oldText:text,newText:"replacement\n"}]),{allow:true});assert.equal(result.ok,true);assert.equal(result.mutationReview,undefined);
  const binary=join(root,"binary.txt");writeFileSync(binary,Buffer.from([255,254,0,1]));const plan=planFileEdit(binary,[{oldText:"x",newText:"y"}]);assert.equal(plan.ok,false);assert.equal(plan.mutationReview,undefined);assert.deepEqual(readFileSync(binary),Buffer.from([255,254,0,1]));
});
test("focused excerpts retain existing redaction and truthful line-bound omissions",()=>{
  const path=join(root,"redacted.txt"),token="sk-proj-"+"a".repeat(40),text=`token=${token}\nkeep\n`;writeFileSync(path,text);
  const result=commitFileEdit(planFileEdit(path,[{oldText:`token=${token}\n`,newText:""}]),{allow:true});assert.equal(result.ok,true);assert.match(result.mutationReview.removedExcerpt,/redacted/);assert(!JSON.stringify(result).includes(token));assert(result.mutationReview.removedExcerpt.length<=1800);
  const lines=join(root,"lines.txt"),old="row\n".repeat(601);writeFileSync(lines,old);const omitted=commitFileEdit(planFileEdit(lines,[{oldText:old,newText:"kept\n"}]),{allow:true});assert.equal(omitted.ok,true);assert.match(omitted.mutationReview.omitted,/line review limit/);assert.equal(omitted.mutationReview.removedExcerpt,undefined);
});
