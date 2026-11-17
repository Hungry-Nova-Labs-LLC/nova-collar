import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { enforceScratchDraftBudget, scratchDraftPolicy } from "../src/main/scratch-draft-budget.js";

const cwd = resolve("/independent-clock-fixture");
const policy = () => scratchDraftPolicy("Fix src/library.mjs and preserve its public behavior.", cwd);
const driver = length => {
  const prefix = 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n//';
  assert(length >= prefix.length);
  return prefix + "x".repeat(length - prefix.length);
};
const write = (path, content, { complete = false, id = "draft-a" } = {}) => {
  const json = JSON.stringify({ path, content });
  return { id, type: "function", function: { name: "host_file_write", arguments: complete ? json : json.slice(0, -2) } };
};
function fixture(ask) {
  let time = 0;
  const clocks = new Map(), p = ask ? scratchDraftPolicy(ask, cwd) : policy();
  return {
    clocks, p,
    at(value) { time = value; },
    check(calls, extra = {}) {
      return enforceScratchDraftBudget(calls, p, { pathState: () => false, sourceClocks: clocks, now: () => time, ...extra });
    },
  };
}
const durationError = error => error?.name === "ScratchDraftBudgetError" && error.scratchDraft?.reason === "duration";
const characterError = error => error?.name === "ScratchDraftBudgetError" && error.scratchDraft?.reason === "characters";

test("55s of prior work plus 1s of recognized helper drafting does not spend a 45s source budget", () => {
  const f = fixture(), calls = new Map();
  f.check(calls, { generationStartedAt: 0 });
  f.at(55_000); calls.set(0, write("scratch-check.mjs", "i")); f.check(calls, { generationStartedAt: 0 });
  f.at(56_000); calls.set(0, write("scratch-check.mjs", driver(1025)));
  const before = structuredClone([...calls]);
  assert.doesNotThrow(() => f.check(calls, { generationStartedAt: 0 }));
  assert.deepEqual([...calls], before, "clock bookkeeping must not add metadata to tool arguments");
});

test("a genuinely incomplete recognized helper still expires after 45s of its own draft", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i")]]);
  f.at(55_000); f.check(calls);
  f.at(99_999); calls.set(0, write("scratch-check.mjs", driver(1025))); assert.doesNotThrow(() => f.check(calls));
  f.at(100_000); assert.throws(() => f.check(calls), durationError);
  assert.equal(calls.size, 0, "an expired unfinished response is discarded atomically");
});

test("late real top-level path metadata starts a new clock instead of inheriting content-only time", () => {
  const f = fixture(), calls = new Map([[0, { id: "draft-a", function: { name: "host_file_write", arguments: '{"content":"i' } }]]);
  f.check(calls);
  f.at(55_000); calls.set(0, write("scratch-check.mjs", driver(1025))); assert.doesNotThrow(() => f.check(calls));
  f.at(56_000); assert.doesNotThrow(() => f.check(calls));
});

test("an empty content value and nested path lookalikes do not start the source clock", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "", { complete: true })]]);
  f.check(calls);
  f.at(20_000); calls.set(0, { id: "draft-a", function: { name: "host_file_write", arguments: '{"meta":{"path":"scratch-check.mjs"},"content":"i' } }); f.check(calls);
  f.at(55_000); calls.set(0, write("scratch-check.mjs", driver(1025))); assert.doesNotThrow(() => f.check(calls));
  f.at(56_000); assert.doesNotThrow(() => f.check(calls));
});

test("a different stable call identity cannot inherit an earlier call's elapsed draft time", () => {
  for (const [index, id, path] of [[1, "second", "second-check.mjs"], [0, "second", "first-check.mjs"], [0, "first", "second-check.mjs"]]) {
    const f = fixture(), calls = new Map([[0, write("first-check.mjs", "i", { id: "first" })]]);
    f.check(calls);
    f.at(55_000); calls.clear(); calls.set(index, write(path, "i", { id })); f.check(calls);
    f.at(56_000); calls.set(index, write(path, driver(1025), { id }));
    assert.doesNotThrow(() => f.check(calls));
  }
});

test("complete valid under-limit arguments may dispatch after 45s instead of being duration-discarded", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i")]]);
  f.check(calls);
  f.at(60_000); calls.set(0, write("scratch-check.mjs", driver(1025), { complete: true }));
  const before = structuredClone([...calls]); assert.doesNotThrow(() => f.check(calls)); assert.deepEqual([...calls], before);
});

test("complete valid JSON receives no exemption from the 4096-character cap", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", driver(4097), { complete: true })]]);
  f.at(60_000); assert.throws(() => f.check(calls), characterError); assert.equal(calls.size, 0);
});

test("a complete-looking object with invalid trailing JSON is still an unfinished draft", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i")]]);
  f.check(calls); f.at(60_000);
  const call = write("scratch-check.mjs", driver(1025), { complete: true }); call.function.arguments += " trailing-invalid-json";
  calls.set(0, call); assert.throws(() => f.check(calls), durationError); assert.equal(calls.size, 0);
});

test("metadata becoming known-new late cannot retroactively charge unknown time", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", driver(1025))]]);
  f.check(calls, { pathState: () => undefined });
  f.at(55_000); assert.doesNotThrow(() => f.check(calls, { pathState: () => false }));
  f.at(56_000); assert.doesNotThrow(() => f.check(calls, { pathState: () => false }));
});

test("unknown and regressing clocks cannot manufacture elapsed source time", () => {
  for (const unknown of [NaN, Infinity, undefined]) {
    const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", driver(1025))]]);
    assert.doesNotThrow(() => f.check(calls, { now: () => unknown }));
    f.at(60_000); assert.doesNotThrow(() => f.check(calls));
  }
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i")]]);
  f.at(1000); f.check(calls); f.at(999); calls.set(0, write("scratch-check.mjs", driver(1025)));
  assert.doesNotThrow(() => f.check(calls));
});

test("throwing duration clock skips only duration; the independent character cap remains", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", driver(1025))]]), now = () => { throw Error("clock unavailable"); };
  assert.doesNotThrow(() => f.check(calls, { now }));
  calls.set(0, write("scratch-check.mjs", driver(4097))); assert.throws(() => f.check(calls, { now }), characterError);
});

test("mixed buffered writes skip duration but still share atomic character overflow rejection", () => {
  const f = fixture(), calls = new Map([[0, write("src/library.mjs", "export const value = 1;", { complete: true })], [1, write("scratch-check.mjs", "i", { id: "helper" })]]);
  f.check(calls); f.at(60_000); calls.set(1, write("scratch-check.mjs", driver(1025), { id: "helper" })); assert.doesNotThrow(() => f.check(calls));
  assert.equal(calls.size, 2);
  calls.set(1, write("scratch-check.mjs", driver(4097), { id: "helper" })); assert.throws(() => f.check(calls), characterError); assert.equal(calls.size, 0);
});

test("explicit requested files, existing paths, and unknown metadata retain their normal budget", () => {
  for (const [ask, path, state] of [
    ["Fix scratch-check.mjs and preserve behavior.", "scratch-check.mjs", false],
    ["Fix src/library.mjs.", "scratch-check.mjs", true],
    ["Fix src/library.mjs.", "scratch-check.mjs", undefined],
    ["Write a large test suite for src/library.mjs.", "scratch-check.mjs", false],
  ]) {
    const f = fixture(ask), calls = new Map([[0, write(path, "i")]]);
    f.check(calls, { pathState: () => state }); f.at(60_000); calls.set(0, write(path, driver(5000)));
    assert.doesNotThrow(() => f.check(calls, { pathState: () => state })); assert.equal(calls.size, 1);
  }
});

test("the 1024-character eligibility floor is unchanged for incomplete helpers", () => {
  const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i")]]);
  f.check(calls); f.at(60_000); calls.set(0, write("scratch-check.mjs", driver(1023))); assert.doesNotThrow(() => f.check(calls));
  calls.set(0, write("scratch-check.mjs", driver(1024))); assert.throws(() => f.check(calls), durationError);
});


test("malformed provider identity disables optional duration without coercion or a size-cap exemption", () => {
  for (const id of [{ toString: null }, 7, null]) {
    const f = fixture(), calls = new Map([[0, write("scratch-check.mjs", "i", { id })]]);
    assert.doesNotThrow(() => f.check(calls));
    f.at(60_000); calls.set(0, write("scratch-check.mjs", driver(1025), { id }));
    assert.doesNotThrow(() => f.check(calls));
    calls.set(0, write("scratch-check.mjs", driver(4097), { id }));
    assert.throws(() => f.check(calls), characterError); assert.equal(calls.size, 0);
  }
});
