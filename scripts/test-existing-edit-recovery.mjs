import assert from "node:assert/strict";
import { test } from "node:test";
import { createExistingEditBridge, existingEditCallMatches, builtinFocusedEditor } from "../src/main/existing-edit-recovery.js";
const editor = () => ({ type: "function", function: { name: "host_file_edit", parameters: { type: "object", properties: {
  path: { type: "string" }, edits: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: {
    oldText: { type: "string", minLength: 1 }, newText: { type: "string" } }, required: ["oldText", "newText"], additionalProperties: false } },
}, required: ["path", "edits"] } } });
const setup = () => ({ round: 2, limit: 8, cwd: "/workspace", local: true, editTask: true, suspended: false,
  workPhase: true, permittedNames: new Set(["host_file_edit"]), offered: [editor()], denyPath: () => false,
  observations: () => ({ reads: [{ path: "/workspace/src/a.mjs", bytes: 100, complete: true }, { path: "/workspace/src/b.mjs", bytes: 100, complete: true }], mutations: [], progress: [] }) });
const ask = "Fix the implementation. Scope: change only src/a.mjs, src/b.mjs. Do not modify README.md.";
const bridge = (options = {}) => createExistingEditBridge({ ask, cwd: "/workspace", probeFactory: () => ({ state: () => true, settle: async () => {}, close() {} }), ...options });

test("one extra ordinary turn follows actual source reads, then one deterministic target in a compound request", async () => {
  const b = bridge(); assert.equal(await b.choose(setup()), null);
  const chosen = await b.choose({ ...setup(), round: 3 });
  assert.deepEqual(chosen, { tool: "host_file_edit", path: "/workspace/src/a.mjs", cwd: "/workspace" });
  assert.equal(await b.choose({ ...setup(), round: 4 }), null);
});
test("capability, role, stage, cwd and budget checks precede lazy candidate access", async () => {
  for (const change of [{ local: false }, { local: "yes" }, { editTask: false }, { editTask: 1 }, { suspended: true }, { suspended: undefined }, { cwd: "/changed" }, { workPhase: false }, { workPhase: undefined }, { limit: undefined }, { offered: [] }, { permittedNames: new Set() }]) {
    let touched = 0; const options = { ...setup(), ...change, get observations() { touched++; throw Error("Must not inspect"); } };
    assert.equal(await bridge().choose(options), null); assert.equal(touched, 0);
  }
  for (const change of [s => s.properties.path.pattern = ".*", s => s.properties.edits.maxItems = 100, s => s.properties.edits.items.properties.oldText.minLength = 0]) {
    const bad = editor(); change(bad.function.parameters); let touched = 0;
    assert.equal(await bridge().choose({ ...setup(), offered: [bad], get observations() { touched++; return {}; } }), null); assert.equal(touched, 0);
  }
  assert(builtinFocusedEditor(editor()));
});
test("unread, protected, alias-mismatched, outside, empty and unknown targets never gain an edit hint", async () => {
  for (const [text, reads] of [
    [ask, []], ["Fix src/a.mjs. Keep src/a.mjs unchanged.", [{ path: "/workspace/src/a.mjs", bytes: 100 }]],
    ["Fix src/A.mjs.", [{ path: "/workspace/src/a.mjs", bytes: 100 }]],
    ["Fix ../a.mjs.", [{ path: "/a.mjs", bytes: 100 }]], [ask, [{ path: "/workspace/src/a.mjs", bytes: 0 }]],
  ]) assert.equal(await bridge({ ask: text }).choose({ ...setup(), round: 8, observations: () => ({ reads }) }), null);
  const b = bridge({ probeFactory: () => ({ state: () => undefined, settle: async () => {}, close() {} }) });
  assert.equal(await b.choose({ ...setup(), round: 8 }), null); assert.equal(await b.choose({ ...setup(), round: 9 }), null);
});
test("real requested mutation/proof suppresses the bridge while an unrelated helper does not satisfy the task", async () => {
  for (const observation of [{ mutations: ["/workspace/src/a.mjs"] }, { progress: [{ path: "/workspace/src/b.mjs", hash: "after", initialHash: "before" }] }]) {
    assert.equal(await bridge().choose({ ...setup(), round: 8, observations: () => ({ ...setup().observations(), ...observation }) }), null);
  }
  const chosen = await bridge().choose({ ...setup(), round: 8, observations: () => ({ ...setup().observations(), mutations: ["/workspace/helper.mjs"],
    progress: [{ path: "/workspace/src/a.mjs", hash: "same", status: "passed", phase: "test" }] }) });
  assert.equal(chosen.path, "/workspace/src/b.mjs");
});
test("last ordinary round reserves the single eligible edit and human narrowing disables it permanently", async () => {
  assert.equal((await bridge().choose({ ...setup(), round: 8 })).tool, "host_file_edit");
  const b = bridge(); b.disable(); assert.equal(await b.choose({ ...setup(), round: 8 }), null);
});
test("partial source, read bans and protected basename aliases cannot force an edit or metadata probe", async () => {
  let probes = 0;
  const make = text => bridge({ ask: text, probeFactory: () => { probes++; throw Error("No probe expected"); } });
  for (const options of [
    { ...setup(), round: 8, observations: () => ({ reads: [{ path: "/workspace/src/a.mjs", bytes: 100, complete: false }] }) },
    { ...setup(), round: 8, observations: () => ({ ...setup().observations(), protectedPaths: ["/workspace/a.mjs", "/workspace/b.mjs"] }) },
  ]) assert.equal(await make(ask).choose(options), null);
  for (const ban of ["Do not read any files. ", "Do not inspect '/workspace/src/a.mjs'. "]) assert.equal(await make(ban + ask).choose({ ...setup(), round: 8 }), null);
  assert.equal(probes, 0);
  assert.equal((await bridge({ ask: "Do not inspect hidden reference material or private profiles. " + ask }).choose({ ...setup(), round: 8 })).path, "/workspace/src/a.mjs");
});
test("named edit response validation binds exactly one structured operation to current cwd and target", () => {
  const choice = { tool: "host_file_edit", path: "/workspace/src/a.mjs", cwd: "/workspace" };
  const call = (path = "src/a.mjs", edits = [{ oldText: "old", newText: "new" }]) => ({ function: { name: "host_file_edit", arguments: JSON.stringify({ path, edits }) } });
  assert(existingEditCallMatches(choice, [call()], "/workspace"));
  for (const calls of [[], [call(), call()], [call("other.mjs")], [call("src/a.mjs", [])], [call("src/a.mjs", [{ oldText: "", newText: "x" }])], [{ function: { name: "host_file_write", arguments: '{}' } }]]) {
    assert.equal(existingEditCallMatches(choice, calls, "/workspace"), false);
  }
  assert.equal(existingEditCallMatches(choice, [call()], "/changed"), false);
});
