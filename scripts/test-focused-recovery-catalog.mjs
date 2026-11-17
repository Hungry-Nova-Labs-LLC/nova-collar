import assert from "node:assert/strict";
import {test} from "node:test";
import {existingEditRequestTools} from "../src/main/existing-edit-recovery.js";
import {windowToolDefs} from "../src/main/tools.js";
const choice={tool:"host_file_edit",path:"/workspace/src/a.mjs",cwd:"/workspace"};

test("request-local editor selection preserves the exact current schema and ordinary ordered catalog",()=>{
  for(const local of [true,false]){
    const offered=windowToolDefs({local,search:false,remote:false}),before=JSON.stringify(offered),selected=existingEditRequestTools(choice,offered);
    assert.equal(selected.length,1);assert.equal(selected[0],offered.find(tool=>tool.function.name==="host_file_edit"));assert.equal(JSON.stringify(offered),before);assert.notEqual(selected,offered);
  }
});
test("missing duplicated or unknown editor schemas cannot substitute a recovery catalog",()=>{
  const tool=windowToolDefs({local:true,search:false,remote:false}).find(tool=>tool.function.name==="host_file_edit");
  assert.equal(existingEditRequestTools(choice,[]),null);assert.equal(existingEditRequestTools(choice,[tool,tool]),null);
  const unknown=structuredClone(tool);unknown.function.parameters.required.push("unknown");assert.equal(existingEditRequestTools(choice,[unknown]),null);
  assert.equal(existingEditRequestTools({tool:"host_file_write"},[tool]),null);assert.equal(existingEditRequestTools(choice,null),null);
});
