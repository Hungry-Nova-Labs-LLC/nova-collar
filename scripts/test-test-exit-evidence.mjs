import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-test-exits-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
process.env.npm_config_cache = join(root, "npm-cache");
process.env.npm_config_update_notifier = "false";
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Inference and network forbidden in this fixture."); };
const { executionEvidence } = await import("../src/main/verification-result.js");
const { commandDiagnostic } = await import("../src/main/command-diagnostic.js");
const { describeTool } = await import("../src/main/describe.js");
const { testExecutionCommand } = await import("../src/main/turn-policy.js");
const { createHarness } = await import("../src/main/harness.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { ensureHome, loadConfig } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { executeTool, windowToolDefs } = await import("../src/main/tools.js");
const { runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome();
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { setApprovalNotifier(null); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); });
const warning = "/bin/sh: /Users/example/.profile: Operation not permitted";
const fixture = name => { const dir = join(root, name); mkdirSync(dir); setWorkdir(dir); return dir; };
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });
async function host(command, cwd) {
  const raw = await executeTool("host_run", { command, cwd }, loadConfig(), { signal: AbortSignal.timeout(12000) });
  return { raw, result: executionEvidence(raw, { test: testExecutionCommand(command) }) };
}

test("a known test's real nonzero or explicit failure does not depend on footer spelling", () => {
  for (const raw of [
    { ok: false, exitCode: 1, stdout: "scenario mismatch" },
    { ok: false, stdout: "RESULT: FAIL (1 failed)" },
    { ok: true, exitCode: 7, stdout: "unfamiliar assertion summary" },
  ]) {
    const original = structuredClone(raw), result = executionEvidence(raw, { test: true });
    assert.equal(result.ok, false); assert.equal(result.testFailure, true);
    assert.deepEqual(raw, original);
  }
});

test("ordinary programs and successful expected FAIL output acquire no test failure", () => {
  assert.equal(executionEvidence({ ok: false, exitCode: 1, stdout: "scenario mismatch" }).testFailure, false);
  const result = executionEvidence({ ok: true, exitCode: 0, stdout: "RESULT: FAIL (1 failed)\nFAIL\n" }, { test: true });
  assert.equal(result.ok, true); assert.equal(result.testFailure, false);
});

test("held, skipped, unavailable and zero-test observations are nonpassing without genuine failure debt", () => {
  for (const flag of ["held", "skipped", "unavailable", "noTests"]) {
    const result = executionEvidence({ ok: false, exitCode: 1, stdout: "5 CHECKS FAILED", [flag]: true }, { test: true });
    assert.equal(result.ok, false, flag); assert.equal(result.testFailure, false, flag);
  }
  assert.equal(executionEvidence({ ok: true, skipped: true }, { test: true }).ok, false);
  assert.equal(executionEvidence({ ok: true, unavailable: true }, { test: true }).ok, false);
  assert.equal(executionEvidence({ ok: true, noTests: true }).ok, false);
  assert.equal(executionEvidence({ ok: false, killed: "stop" }, { test: true }).testFailure, false);
});

test("missing test definitions or interpreter entry files are explicitly unavailable", () => {
  for (const output of [
    'npm error Missing script: "test"',
    'npm ERR! Missing script: "test:unit"',
    'Error: no test specified',
    "python3: can't open file '/tmp/project/verify_case.py': [Errno 2] No such file or directory",
    'no tests ran in 0.01s',
  ]) {
    const result = executionEvidence({ ok: false, exitCode: 1, stderr: output }, { test: true });
    assert.equal(result.noTests, true, output); assert.equal(result.unavailable, true); assert.equal(result.skipped, true);
    assert.equal(result.ok, false); assert.equal(result.testFailure, false);
  }
  const dependency = executionEvidence({ ok: false, exitCode: 1, stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'assertion-helper' imported from verify.mjs" }, { test: true });
  assert.equal(dependency.testFailure, true, "missing runtime dependencies are actual test failures, not missing entry scripts");
  assert.equal(dependency.noTests, false);
  const fixtureLookup = executionEvidence({ ok: false, exitCode: 1, stderr: "Could not find '/tmp/project/fixture.data'" }, { test: true });
  assert.equal(fixtureLookup.noTests, false, "generic missing-resource output has no entry-script provenance");
  assert.equal(fixtureLookup.testFailure, true);
});

test("failed known-check summaries and normalized causes outrank startup warnings without changing raw evidence", () => {
  for (const summary of ["RESULT: FAIL (1 failed)", "SUMMARY: FAILURE: property mismatch", "8 FAILURES"]) {
    const raw = { ok: false, exitCode: 1, error: warning, stderr: warning, stdout: summary };
    const result = executionEvidence(raw, { test: true }), original = structuredClone(result);
    assert.equal(commandDiagnostic(result, "node verify.mjs"), summary);
    assert.deepEqual(result, original);
    assert(describeTool("host_run", { command: "node verify.mjs" }, result).detail.includes(warning));
  }
  const result = executionEvidence({ ok: false, exitCode: 1, error: warning, stderr: warning, stdout: "nonstandard output" }, { test: true });
  assert.equal(commandDiagnostic(result, "node verify.mjs"), "Test command exited with status 1.");
  assert.match(commandDiagnostic({ ok: false, error: warning, stderr: warning }, "check"), /Operation not permitted/);
});

test("actual host_run failure without recognized footer is genuine test evidence with a useful UI cause", async () => {
  const dir = fixture("host-failure");
  writeFileSync(join(dir, "verify.mjs"), `process.stderr.write(${JSON.stringify(warning + "\n")}); console.log("nonstandard scenario mismatch"); process.exitCode=3;\n`);
  const { raw, result } = await host("node verify.mjs", dir);
  assert.equal(raw.ok, false);
  assert.equal(result.testFailure, true); assert.equal(result.ok, false);
  const described = describeTool("host_run", { command: "node verify.mjs" }, result);
  assert.match(described.blurb, /The test command failed/);
  assert(described.detail.includes(warning)); assert(described.detail.includes("nonstandard scenario mismatch"));
});

test("actual missing npm profile, placeholder and missing Python entry create no irrecoverable test debt", async () => {
  for (const [name, manifest, command] of [
    ["npm-missing", {}, "npm test"],
    ["npm-placeholder", { scripts: { test: 'echo "Error: no test specified" && exit 1' } }, "npm test"],
    ["python-missing", {}, "python3 verify_absent.py"],
  ]) {
    const dir = fixture(name); writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    const gate = createHarness({ sessionId: name, requireEdits: false });
    assert.equal(gate.before("host_run", { command, cwd: dir }), null);
    const { result } = await host(command, dir);
    assert.equal(result.ok, false); assert.equal(result.noTests, true, result.stderr);
    assert.equal(result.testFailure, false); await gate.after("host_run", { command, cwd: dir }, result);
    assert.deepEqual(gate.debt(), []); assert.deepEqual(new VerificationLedger(name, dir).debt(), []);
  }
});

test("actual known failure with unfamiliar stdout cannot close all-tests-PASS after an unrelated successful command", async () => {
  const dir = fixture("closure");
  writeFileSync(join(dir, "verify.mjs"), `process.stderr.write(${JSON.stringify(warning + "\n")}); console.log("one property differed"); process.exitCode=1;\n`);
  const source = join(dir, "feature.mjs"), session = createSession(), events = [];
  const definitions = windowToolDefs({ local: true, search: false, remote: false }).filter(row => ["host_run", "host_file_write"].includes(row.function.name));
  let requests = 0;
  const result = await runTurn([], "Implement feature.mjs and verify the checks before reporting.", event => events.push(event), AbortSignal.timeout(20000), {
    sessionId: session.id, tools: definitions, complete: async messages => {
      requests++;
      if (requests === 1) return reply("", [call("host_file_write", { path: source, content: "export const enabled = true;\n" }, "edit")]);
      if (requests === 2) return reply("", [call("host_run", { command: "node verify.mjs", cwd: dir }, "check")]);
      if (requests === 3) {
        const check = messages.find(row => row.tool_call_id === "check");
        assert.match(check.content.split("Observed failure:")[1] || "", /The test command failed/);
        return reply("", [call("host_run", { command: "ls", cwd: dir }, "list")]);
      }
      return reply("PASS. All tests passed.");
    },
  });
  assert.equal(readFileSync(source, "utf8"), "export const enabled = true;\n");
  assert(events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok === false));
  assert(!/^PASS\b/.test(result.assistant), result.assistant);
  assert.match(result.assistant, /test verification command/);
  assert(new VerificationLedger(session.id, dir).debt().some(row => row.includes("node verify.mjs")));
});
