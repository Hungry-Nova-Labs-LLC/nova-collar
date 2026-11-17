import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createPossibleVerificationHelperAwareness, possibleVerificationHelperSource } from "../src/main/possible-verification-helper.js";
import { authoredAssertionSource } from "../src/main/authored-checks.js";
const cwd = "/possible-helper-fixture";
const hash = text => createHash("sha256").update(text).digest("hex");
const driver = 'let failures = 0;\nconst eq = (got: unknown, want: unknown): void => { if (JSON.stringify(got) !== JSON.stringify(want)) { failures++; } };\neq(2, 2); eq(4, 4);\nconsole.log(`checked ${failures}`);\nprocess.exit(failures === 0 ? 0 : 1);\n';
const ask = "Fix src/library.mjs and preserve existing behavior.";
function fixture({ source = driver, path = cwd + "/verify.ts", human = ask, limit = 4, snapshot: provided } = {}) {
  let calls = 0;
  const witness = { path, text: source, hash: hash(source) };
  const observer = createPossibleVerificationHelperAwareness({ cwd, ask: human, maxCues: limit, snapshot: p => { calls++; return provided ? provided(p) : witness; } });
  const input = { name: "host_file_write", active: true, rawArgs: JSON.stringify({ path, content: source }), result: { ok: true, path, bytes: Buffer.byteLength(source) }, proof: { ok: true, verification: { status: "passed", phase: "syntax", remote: false, hash: witness.hash } } };
  return { observer, input, witness, calls: () => calls };
}

test("a custom typed arrow driver yields only a possible-source cue while strong classification remains false", () => {
  assert.equal(authoredAssertionSource("verify.ts", driver), false);
  assert.equal(possibleVerificationHelperSource("verify.ts", driver), true);
  const f = fixture(), before = structuredClone(f.input), text = f.observer.observe(f.input);
  assert.match(text, /possible_saved_verification_helper/); assert.match(text, /If it is intended for verification/);
  assert.match(text, /already available or declared runner/); assert.match(text, /Saving or syntax parsing does not establish execution/);
  assert(!text.includes("node ") && !text.includes("npx ") && !text.includes("python "), "never supply a guessed command");
  assert.deepEqual(f.input, before); assert.deepEqual(Object.keys(f.observer), ["observe"]);
});

test("comments, quoted examples, ordinary app/library code and incomplete/unsupported sources are not helper cues", () => {
  for (const source of ["// " + driver.replaceAll("\n", "\n// "), JSON.stringify(driver), "`" + driver.replaceAll("`", "\\`") + "`", "export " + driver, driver.replace("process.exit(failures === 0 ? 0 : 1);", ""), driver.replace("failures++;", "console.log('ordinary');"), driver.replace("eq(4, 4);", ""), "const ratio = 4 / 2;\n" + driver]) {
    assert.equal(possibleVerificationHelperSource("verify.ts", source), false, source.slice(0, 60));
  }
  assert.equal(possibleVerificationHelperSource(undefined, driver), false);
  assert.equal(possibleVerificationHelperSource("app.ts", driver), false);
  assert.equal(possibleVerificationHelperSource("verify.py", driver), false);
  assert.equal(possibleVerificationHelperSource("verify.ts", driver + "x".repeat(80_001)), false);
});

test("strong existing assertion sources never receive a duplicate possible cue", () => {
  const source = 'import assert from "node:assert/strict"; assert.equal(1,1);\n';
  assert.equal(authoredAssertionSource("verify.mjs", source), true);
  const f = fixture({ source, path: cwd + "/verify.mjs" }); assert.equal(f.observer.observe(f.input), "");
});

test("requested, protected-name aliases, explicit test creation and out-of-project paths avoid even the cached getter", () => {
  for (const human of [ask + " Use verify.ts.", ask + " Keep nested/VERIFY.ts unchanged.", "Add tests for src/library.mjs.", "Review src/library.mjs."]) {
    const f = fixture({ human });
    // A review-only stage is explicitly inactive; other scope cases fail the pure scope filter.
    if (human.startsWith("Review")) f.input.active = false;
    assert.equal(f.observer.observe(f.input), ""); assert.equal(f.calls(), 0);
  }
  const f = fixture({ path: "/outside/verify.ts" }); assert.equal(f.observer.observe(f.input), ""); assert.equal(f.calls(), 0);
});

test("inactive/Stop/failed/no-op/held/unavailable/unsupported write metadata earns no snapshot or cue", () => {
  const changes = [f => { f.input.active = false; }, f => { f.input.active = "yes"; }, f => { f.input.name = "host_run"; }, f => { f.input.result.ok = false; }, f => { f.input.result.held = true; }, f => { f.input.result.changed = false; }, f => { f.input.proof.unavailable = true; }, f => { f.input.proof.verification.phase = "runtime"; }, f => { f.input.proof.verification.remote = true; }, f => { f.input.signal = AbortSignal.abort(); }];
  for (const change of changes) { const f = fixture(); change(f); assert.equal(f.observer.observe(f.input), ""); assert.equal(f.calls(), 0); }
});

test("the cached body, actual saved arguments, proof revision and edit afterHash must agree", () => {
  const bad = fixture({ snapshot: () => ({ path: cwd + "/verify.ts", text: driver + "\n// stale", hash: hash(driver) }) });
  assert.equal(bad.observer.observe(bad.input), "");
  const f = fixture(); f.input.proof.verification.hash = "0".repeat(64); assert.equal(f.observer.observe(f.input), ""); assert.equal(f.calls(), 0);
  const mismatched = fixture(); mismatched.input.rawArgs = JSON.stringify({path:"other.ts",content:driver}); assert.equal(mismatched.observer.observe(mismatched.input), ""); assert.equal(mismatched.calls(),0);
  const edited = fixture(); edited.input.name = "host_file_edit"; edited.input.rawArgs = JSON.stringify({ path: edited.input.result.path, edits: [{ oldText: "old", newText: "new" }] });
  edited.input.result.afterHash = edited.witness.hash; assert.match(edited.observer.observe(edited.input), /possible_saved_verification_helper/);
});

test("the cue is once per saved hash and limited to four immediate observations per turn", () => {
  const f = fixture(); assert(f.observer.observe(f.input)); assert.equal(f.observer.observe(f.input), "");
  for (let i = 1; i <= 4; i++) {
    const source = driver + `\n// saved revision ${i}\n`; f.witness.text = source; f.witness.hash = hash(source);
    f.input.rawArgs = JSON.stringify({ path: f.input.result.path, content: source }); f.input.proof.verification.hash = f.witness.hash;
    const text = f.observer.observe(f.input); assert.equal(Boolean(text), i < 4);
  }
});
