import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecisionAdviser, decisionAdviceObservation, loadDecisionAdviserConfig } from "../src/main/decision-adviser.js";

const root = mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), "decision-policy-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
function fixture(settings = { enabled: true }) {
  const cwd = join(root, String(++seq)), home = join(cwd, "profile"); mkdirSync(home, { recursive: true });
  if (settings !== null) writeFileSync(join(home, "decision-adviser.json"), JSON.stringify(settings));
  return { cwd, home, cfg: { chatUrl: "https://own.example/v1", chatKey: "fixture-key" } };
}
const context = f => ({ eligible: true, ask: "Fix only worker.py and run its public check.", goal: "Repair worker.py", cwd: f.cwd,
  stage: "edit", revision: 0, sourceState: [], tools: ["host_run", "host_file_read", "host_file_write"] });
const fail = (adviser, f) => adviser.observe({ name: "host_run", cwd: f.cwd, rawArgs: { command: "python3 -m unittest -v", cwd: f.cwd },
  result: { ok: false, testFailure: true, stdout: "", stderr: "FAILED (failures=1)", exitCode: 1 } });
const make = (f, request) => createDecisionAdviser({ ...f, request, redact: text => String(text).replaceAll("SECRET_MARKER", "[redacted]"), denyPath: path => /\.env$/.test(path) });

test("absent/disabled settings cause zero calls and leave all profile files untouched", async () => {
  for (const settings of [null, { enabled: false }]) {
    const f = fixture(settings); writeFileSync(join(f.home, "env"), "existing private route\n"); let calls = 0;
    const a = make(f, () => { calls++; }); fail(a, f);
    assert.equal(await a.advise(context(f)), null); assert.equal(calls, 0);
    assert.equal(readFileSync(join(f.home, "env"), "utf8"), "existing private route\n");
  }
});

test("credentials stay on the same origin; explicit cross-origin key reference and no-auth loopback work", () => {
  const same = fixture(); assert.equal(loadDecisionAdviserConfig(same).apiKey, "fixture-key");
  const foreign = fixture({ enabled: true, endpoint: "https://other.example/decisions" });
  assert.equal(loadDecisionAdviserConfig(foreign).enabled, false);
  const explicit = fixture({ enabled: true, endpoint: "https://other.example/decisions", apiKeyEnv: "ADVISER_KEY" });
  assert.equal(loadDecisionAdviserConfig({ ...explicit, env: { ADVISER_KEY: "separate-key" } }).apiKey, "separate-key");
  const local = fixture({ enabled: true, endpoint: "http://127.0.0.1:9999/decisions" });
  assert.equal(loadDecisionAdviserConfig(local).apiKey, "");
  for (const settings of [{ enabled: true, maxPerTurn: 2 }, { enabled: true, endpoint: "http://other.example/decisions" },
    { enabled: true, endpoint: "https://user:pass@own.example/decisions" }, { enabled: true, timeoutMs: 1 }]) {
    assert.equal(loadDecisionAdviserConfig(fixture(settings)).enabled, false);
  }
});

test("failure-only once-per-turn advice exposes bounded redacted source and permitted actions", async () => {
  const f = fixture(); let calls = 0;
  const a = make(f, async input => {
    calls++; assert.equal(input.apiKey, "fixture-key"); assert.equal(input.endpoint, "https://own.example/v1/decisions");
    assert.equal(input.state.failure.exitCode, 1); assert.equal(input.state.sources.length, 1);
    assert(!JSON.stringify(input.state).includes("SECRET_MARKER")); assert.match(input.state.sources[0].text, /redacted/);
    assert.deepEqual(input.actions.map(row => row.id), ["inspect_source", "fix_test_setup", "fix_code", "retest", "escalate"]);
    return { ok: true, choice: "fix_code", elapsedMs: 3 };
  });
  const path = join(f.cwd, "worker.py"); writeFileSync(path, "SECRET_MARKER\n");
  a.observe({ name: "host_file_read", rawArgs: { path }, result: { ok: true, path, text: "SECRET_MARKER\n" }, cwd: f.cwd, completeRead: true });
  assert.equal(await a.advise(context(f)), null); fail(a, f);
  const result = await a.advise(context(f)); assert.equal(result.choice, "fix_code"); assert(a.current(result, context(f)));
  fail(a, f); assert.equal(await a.advise(context(f)), null); assert.equal(calls, 1);
  assert.match(decisionAdviceObservation(result.choice), /not owner guidance/);
  assert.equal(decisionAdviceObservation("report_done"), "");
});

test("same-batch passing check, mutation, CWD and actual owner steering invalidate pending failure", async () => {
  for (const kind of ["pass", "write", "cwd", "owner"]) {
    const f = fixture(); let calls = 0; const a = make(f, () => { calls++; }); fail(a, f);
    if (kind === "pass") a.observe({ name: "host_run", rawArgs: { command: "python3 -m unittest -v" }, result: { ok: true }, cwd: f.cwd });
    if (kind === "write") a.observe({ name: "host_file_write", rawArgs: { path: join(f.cwd, "new.py"), content: "fixed" }, result: { ok: true, path: join(f.cwd, "new.py") }, cwd: f.cwd });
    if (kind === "cwd") a.observe({ name: "set_workdir", result: { ok: true }, cwd: f.cwd });
    if (kind === "owner") a.invalidate();
    assert.equal(await a.advise(context(f)), null, kind); assert.equal(calls, 0);
  }
});

test("unavailable, denied/unstarted and read-only cases cannot grant authority or trigger retries", async () => {
  const f = fixture(); let calls = 0; const a = make(f, async () => { calls++; return { ok: true, choice: "report_done" }; });
  a.observe({ name: "host_run", rawArgs: { command: "denied" }, result: { ok: false, error: "Permission denied" }, cwd: f.cwd });
  assert.equal(await a.advise(context(f)), null);
  fail(a, f); assert.equal(await a.advise({ ...context(f), eligible: false }), null);
  const result = await a.advise(context(f)); assert.equal(result.status, "unavailable"); assert.equal(result.reason, "invalid-response");
  fail(a, f); assert.equal(await a.advise(context(f)), null); assert.equal(calls, 1);
});

test("the actual receipt working directory wins and an outside/different directory skips advice", async () => {
  const f = fixture(); let calls = 0; const a = make(f, () => { calls++; });
  a.observe({ name: "host_run", cwd: f.cwd, rawArgs: { command: "python3 -m unittest", cwd: f.cwd },
    result: { ok: false, testFailure: true, stderr: "FAILED", cwd: root, exitCode: 1 } });
  assert.equal(await a.advise(context(f)), null); assert.equal(calls, 0);
});

test("profile files and symlink aliases are never supplied as source bodies", async () => {
  const f = fixture(); const privatePath = join(f.home, "AGENTS.md"), alias = join(f.cwd, "alias.py");
  writeFileSync(privatePath, "private owner memory"); symlinkSync(privatePath, alias);
  const a = make(f, async input => { assert.equal(input.state.sources.length, 0); return { ok: false, reason: "timeout" }; });
  for (const path of [privatePath, alias]) a.observe({ name: "host_file_read", rawArgs: { path }, result: { ok: true, path, text: "private owner memory" }, completeRead: true, cwd: f.cwd });
  fail(a, f); const result = await a.advise(context(f)); assert.equal(result.reason, "timeout");
});

test("known config secrets and API patterns are removed; credentials and outside-workspace sources stay excluded", async () => {
  const f = fixture(); Object.assign(f.cfg, { home: f.home, toolsKey: "oddToolCredential", labToken: "oddLabCredential" });
  const outside = join(root, "outside.py"); writeFileSync(outside, "unrelated source");
  const source = join(f.cwd, "worker.py");
  const text = 'oddToolCredential oddLabCredential fixture-key Bearer shortValue api_key=unrecognizedValue\n';
  writeFileSync(source, text);
  const excluded = [outside, join(f.cwd, ".npmrc"), join(f.cwd, ".env"), join(f.cwd, "private.key"), join(f.cwd, "credentials.json")];
  for (const path of excluded.slice(1)) writeFileSync(path, "credential body");
  const a = make(f, async input => {
    const wire = JSON.stringify(input.state);
    for (const value of ["oddToolCredential", "oddLabCredential", "fixture-key", "shortValue", "unrecognizedValue", "credential body", "unrelated source"]) assert(!wire.includes(value), value);
    assert.equal(input.state.sources.length, 1); assert.equal(input.state.sourceState.length, 0);
    return { ok: true, choice: "inspect_source" };
  });
  for (const path of [...excluded, source]) a.observe({ name: "host_file_read", rawArgs: { path }, result: { ok: true, path, text: path === source ? text : "credential body" }, completeRead: true, cwd: f.cwd });
  fail(a, f);
  const receipt = await a.advise({ ...context(f), ask: text, sourceState: [{ path: excluded.at(-1), hash: "bad", status: "failed" }] });
  assert.equal(receipt.status, "completed");
});

test("late advice is rejected after steering/source revision and Stop propagates", async () => {
  const f = fixture(); let release; const a = make(f, () => new Promise(resolve => { release = resolve; })); fail(a, f);
  const pending = a.advise(context(f)); a.invalidate(); release({ ok: true, choice: "fix_code" });
  assert.equal(a.current(await pending, context(f)), false);
  const b = make(f, async input => { input.signal.addEventListener("abort", () => {}, { once: true }); return { ok: false, reason: "cancelled" }; });
  fail(b, f); const controller = new AbortController(); controller.abort();
  await assert.rejects(b.advise({ ...context(f), signal: controller.signal }), { name: "AbortError" });
});

test("explicit local provider uses only its local request path and preserves existing endpoint fields", async () => {
  const f = fixture({ enabled: true, provider: "local", endpoint: "https://saved.example/decisions", apiKeyEnv: "ABSENT_SAVED_KEY" });
  const original = readFileSync(join(f.home, "decision-adviser.json"), "utf8"); let local = 0;
  const a = createDecisionAdviser({ ...f, redact: String, denyPath: () => false,
    request: () => assert.fail("No endpoint request for explicit local provider"),
    localRequest: async input => { local++; assert.equal(input.apiKey, undefined); assert.equal(input.endpoint, undefined); return { ok: true, choice: "fix_code" }; } });
  fail(a, f); assert.equal((await a.advise(context(f))).choice, "fix_code"); assert.equal(local, 1);
  assert.equal(readFileSync(join(f.home, "decision-adviser.json"), "utf8"), original);
});
