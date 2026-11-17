import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-shell-verification-"));
process.env.NOVAPUP_HOME = join(root, "profile");
mkdirSync(process.env.NOVAPUP_HOME);
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Live inference/network forbidden."); };
const { createHarness } = await import("../src/main/harness.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { executionEvidence } = await import("../src/main/verification-result.js");
const { testExecutionCommand } = await import("../src/main/turn-policy.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const exec = promisify(execFile);
after(() => { globalThis.fetch = savedFetch; rmSync(root, { recursive: true, force: true }); });
function fixture(name) { const path = join(root, name); mkdirSync(path); setWorkdir(path); return path; }
async function localExec(command, options = {}) {
  try { return { ok: true, exitCode: 0, ...await exec("/bin/sh", ["-c", command], { cwd: options.cwd || root, timeout: 12000, maxBuffer: 256 * 1024 }) }; }
  catch (error) { return { ok: false, exitCode: error.code, stdout: error.stdout || "", stderr: error.stderr || "", error: error.message }; }
}
async function shell(gate, command, cwd) {
  const args = { command, cwd };
  assert.equal(gate.before("host_run", args), null);
  const result = executionEvidence(await localExec(command, { cwd }), { test: testExecutionCommand(command) });
  const proof = await gate.after("host_run", args, result);
  return { result, proof };
}
async function createSwift(gate, path, source = "let count = 1\n") {
  const args = { path, content: source };
  assert.equal(gate.before("host_file_write", args), null);
  writeFileSync(path, source);
  return gate.after("host_file_write", args, { ok: true, path });
}

test("known requested source edits are found by bytes, not shell-language guesses", async () => {
  const dir = fixture("variable-edit"), path = join(dir, "Library.swift");
  writeFileSync(path, "let count = 1\n");
  const gate = createHarness({ ask: "Fix Library.swift.", sessionId: "variable-edit", localExec, approvalAware: true });
  const command = "python3 - <<'PY'\np = 'Library.swift'\ns = open(p).read()\nopen(p, 'w').write(s.replace('1', '2'))\nPY";
  const { proof } = await shell(gate, command, dir);
  assert.equal(proof.ok, true, proof.detail);
  assert.equal(proof.verification.phase, "syntax");
  assert.equal(gate.progressState().find(row => row.kind === "file").initialHash === proof.verification.hash, false);
  assert.deepEqual(gate.debt(), []);
  assert(!/runtime.*(?:verified|passed)/i.test(proof.detail));
});

test("every changed known file is checked and unchanged reads earn no write proof", async () => {
  const dir = fixture("multiple"), a = join(dir, "First.swift"), b = join(dir, "Second.swift");
  writeFileSync(a, "let first = 1\n"); writeFileSync(b, "let second = 1\n");
  const gate = createHarness({ ask: "Fix First.swift and update Second.swift.", sessionId: "multiple", localExec });
  const command = "python3 - <<'PY'\nfor p in ['First.swift', 'Second.swift']:\n s = open(p).read()\n open(p, 'w').write(s.replace('1', '2'))\nPY";
  const { proof } = await shell(gate, command, dir);
  assert.equal(proof.ok, true, proof.detail); assert.equal(proof.paths.length, 2);
  assert.deepEqual(gate.debt(), []);
  const untouched = createHarness({ ask: "Fix First.swift.", sessionId: "read-only", localExec });
  assert.equal((await shell(untouched, "cat First.swift", dir)).proof, null);
  assert.deepEqual(untouched.progressState(), []);
  assert.deepEqual(untouched.debt(), ["write and run First.swift"]);
});

test("a failed shell still records its changed source without claiming command success", async () => {
  const dir = fixture("failed-shell"), path = join(dir, "Library.swift");
  writeFileSync(path, "let count = 1\n");
  const gate = createHarness({ ask: "Fix Library.swift.", sessionId: "failed-shell", localExec });
  const { result, proof } = await shell(gate, "printf 'let count = 2\\n' > Library.swift; exit 7", dir);
  assert.equal(result.ok, false); assert.equal(proof.ok, false);
  assert.equal(proof.verification.phase, "syntax"); assert.match(proof.detail, /command failed/);
});

test("removed turn-created syntax-only auxiliary is retired; required paths stay fixed", async () => {
  const dir = fixture("retire"), auxiliary = join(dir, "scratch.swift");
  const gate = createHarness({ sessionId: "retire", localExec });
  assert.equal((await createSwift(gate, auxiliary)).verification.phase, "syntax");
  await shell(gate, "mv scratch.swift entry.swift", dir);
  assert.deepEqual(gate.debt(), []);
  assert(!gate.progressState().some(row => row.path.endsWith("scratch.swift")));
  assert.deepEqual(new VerificationLedger("retire", dir).debt(), []);
  const required = join(dir, "Required.swift"), wanted = createHarness({ ask: "Create Required.swift.", sessionId: "required", localExec });
  await createSwift(wanted, required);
  await shell(wanted, "mv Required.swift different.swift", dir);
  assert(wanted.debt().some(row => row.includes("Required.swift")));
  const executable = join(dir, "requested.swift"), runOnly = createHarness({ ask: "Run requested.swift.", requireEdits: false, requireExecution: true, sessionId: "run-required", localExec });
  await createSwift(runOnly, executable);
  await shell(runOnly, "rm requested.swift", dir);
  assert(runOnly.debt().some(row => row.includes("requested.swift")), "positively requested execution paths also stay fixed");
});

test("preexisting auxiliaries, actual failed syntax and runtime-required debt cannot retire", async () => {
  const dir = fixture("retain"), path = join(dir, "existing.swift");
  writeFileSync(path, "let value = 1\n");
  const ledger = new VerificationLedger("retain", dir);
  ledger.checked(path, { ok: true, phase: "syntax" });
  const gate = createHarness({ sessionId: "retain", localExec });
  await shell(gate, "rm existing.swift", dir);
  assert(gate.debt().some(row => row.includes("existing.swift")));
  for (const [name, phase] of [["bad.swift", "syntax"], ["strong.swift", "runtime"]]) {
    const file = join(dir, name), id = `retain-${phase}`, other = createHarness({ sessionId: id, localExec });
    await createSwift(other, file);
    new VerificationLedger(id, dir).checked(file, { ok: false, phase, diagnostic: "real failure" });
    // Restore the actual failed ledger as a resumed turn: it is never ephemeral.
    const resumed = createHarness({ sessionId: id, localExec });
    await shell(resumed, `rm ${name}`, dir);
    assert(resumed.debt().some(row => row.includes(name)));
  }
});

test("only the executable position establishes named ad-hoc test context", () => {
  for (const command of ["python3 verify_case.py", "node scenario.check.mjs", "./build/verify-engine", "./engine_verify; echo done", "swiftc -o engine_verify main.swift; ./engine_verify; echo finished"]) assert(testExecutionCommand(command), command);
  for (const command of ["cat verify_case.py", "grep FAILED checks.log", "printf '2 CHECK(S) FAILED'", "swiftc -o engine_verify main.swift", "node -e 'console.log(\"; ./engine_verify;\")'", "./application"]) assert(!testExecutionCommand(command), command);
});

test("quoted inline code and data cannot invent standard test-runner context", () => {
  for (const command of [
    `node -e "console.log('; npm test'); console.log('2 CHECK(S) FAILED')"`,
    `node -e "console.log('; node test.js'); console.log('2 CHECK(S) FAILED')"`,
    `node --eval "console.log('--test; npm test')"`,
    `node --print "'--test; npm test'"`,
    `node -e"console.log('--test')"`,
    `echo "node --test; npm test; ./engine_verify"`,
    `printf '%s\\n' '; node test.js'`,
    `node application.js '--test'`,
    `node -r '--test' application.js`,
    `python3 -c "print('; npm test')"`,
    `sh -c 'npm test'`,
    `echo "$(npm test)"`,
    `node <<'JS'\nconsole.log('; npm test')\nJS`,
  ]) assert.equal(testExecutionCommand(command), false, command);
});

test("actual standard runners and named checks retain shell-word flag semantics", () => {
  for (const command of [
    "npm test", "pnpm run test:unit", "yarn test", "python3 -m unittest", "cargo test",
    "node --test tests/a.mjs", "node '--test' tests/a.mjs", "node --import './register.mjs' --test tests/a.mjs",
    "node --experimental-strip-types verify.ts", "node --experimental-strip-types --no-warnings verify.ts",
    "node './a path/verify-case.mjs'", "./build/engine_verify; echo finished",
    `node -e "console.log('; npm test')"; npm test`,
  ]) assert.equal(testExecutionCommand(command), true, command);
});

test("successful inline data program leaves no false selftest obligation", async () => {
  const dir = fixture("quoted-inline"), gate = createHarness({ sessionId: "quoted-inline", localExec });
  const command = `node -e "console.log('; npm test'); console.log('2 CHECK(S) FAILED')"`;
  const { result } = await shell(gate, command, dir);
  assert.equal(result.exitCode, 0); assert.equal(result.ok, true); assert.equal(result.testFailure, false);
  assert.match(result.stdout, /2 CHECK\(S\) FAILED/);
  assert.deepEqual(gate.debt(), []);
  assert.deepEqual(new VerificationLedger("quoted-inline", dir).debt(), []);
});

test("structured failed selftest survives masked exit and unrelated success, then matching rerun clears", async () => {
  const dir = fixture("selftest-debt"), binary = join(dir, "engine_verify");
  writeFileSync(binary, '#!/bin/sh\nprintf "2 CHECK(S) FAILED\\n"\nexit 1\n'); chmodSync(binary, 0o700);
  const gate = createHarness({ sessionId: "selftest-debt", localExec });
  const command = './engine_verify; echo "run exit: $?"';
  const first = await shell(gate, command, dir);
  assert.equal(first.result.exitCode, 0); assert.equal(first.result.ok, false); assert.equal(first.result.testFailure, true);
  await shell(gate, "ls", dir);
  await shell(gate, "python3 -c 'print(42)'", dir);
  assert(gate.debt().some(row => row.includes("test verification command")));
  assert(new VerificationLedger("selftest-debt", dir).debt().some(row => row.includes("engine_verify")));
  writeFileSync(binary, '#!/bin/sh\nprintf "all assertions passed\\n"\n'); chmodSync(binary, 0o700);
  const pass = await shell(gate, command, dir);
  assert.equal(pass.result.ok, true); assert.deepEqual(gate.debt(), []);
});

test("expected FAIL text in an ordinary program is not verification failure", async () => {
  const dir = fixture("expected-output"), gate = createHarness({ sessionId: "expected-output", localExec });
  const { result } = await shell(gate, "printf 'FAIL\\n2 CHECK(S) FAILED\\n'", dir);
  assert.equal(result.ok, true); assert.equal(result.testFailure, false); assert.deepEqual(gate.debt(), []);
});

test("selftest command identity preserves quoted spaces and actual rerun requirements", () => {
  const dir = fixture("quoted-test"), command = "./verify-engine 'argument with spaces'";
  const ledger = new VerificationLedger("quoted-test", dir);
  ledger.commandChecked(dir, command, { ok: false, testFailure: true, diagnostic: "actual test failure" });
  const resumed = new VerificationLedger("quoted-test", dir);
  resumed.commandChecked(dir, "ls", { ok: true });
  resumed.commandChecked(dir, command.replace("with spaces", "with  spaces"), { ok: true });
  assert.equal(resumed.debt().length, 1, "quoted argument spaces remain significant");
  resumed.commandChecked(dir, command, { ok: true, held: true }); assert.equal(resumed.debt().length, 1);
  resumed.commandChecked(dir, command, { ok: true }); assert.deepEqual(resumed.debt(), []);
});

test("a corrected real compile after auxiliary rename has no obsolete compiler or filename debt", async () => {
  const dir = fixture("compile-rename"), library = join(dir, "Library.swift"), scratch = join(dir, "scratch.swift");
  writeFileSync(library, "struct Example { static let value = 42 }\n");
  const gate = createHarness({ sessionId: "compile-rename", localExec });
  assert.equal((await createSwift(gate, scratch, "print(Example.value)\n")).ok, true);
  const command = "swiftc Library.swift scratch.swift -o checker";
  gate.before("host_run", { command, cwd: dir });
  const failed = await localExec(command, { cwd: dir });
  assert.equal(failed.ok, false); assert.match(failed.stderr, /expressions are not allowed/);
  await gate.after("host_run", { command, cwd: dir }, { ...failed, compilerFailure: true });
  await shell(gate, "mv scratch.swift main.swift", dir);
  const corrected = await shell(gate, "swiftc Library.swift main.swift -o checker", dir);
  assert.equal(corrected.result.ok, true, corrected.result.stderr);
  assert.deepEqual(gate.debt(), []);
});

test("production runTurn cannot close with all-tests-PASS after failed selftest and unrelated tools", async () => {
  const { ensureHome } = await import("../src/main/config.js");
  const { createSession } = await import("../src/main/sessions.js");
  const { runTurn } = await import("../src/main/agent.js");
  const { windowToolDefs } = await import("../src/main/tools.js");
  const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
  ensureHome();
  const dir = fixture("closure"), source = join(dir, "Library.swift"), binary = join(dir, "engine_verify");
  writeFileSync(source, "let count = 1\n");
  writeFileSync(binary, '#!/bin/sh\nprintf "2 CHECK(S) FAILED\\n"\nexit 1\n'); chmodSync(binary, 0o700);
  const definitions = windowToolDefs({ local: true, search: false, remote: false }).filter(row => ["host_run"].includes(row.function.name));
  const commands = ["python3 - <<'PY'\np = 'Library.swift'\ns = open(p).read()\nopen(p,'w').write(s.replace('1','2'))\nPY", './engine_verify; echo "run exit: $?"', "ls", "python3 -c 'print(42)'"];
  let calls = 0; const events = [];
  setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
  try {
    const result = await runTurn([], "Fix Library.swift and run the checks.", event => events.push(event), AbortSignal.timeout(25000), {
      sessionId: createSession().id, tools: definitions, complete: async () => {
        if (calls < commands.length) return { content: "", tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "host_run", arguments: JSON.stringify({ command: commands[calls++], cwd: dir }) } }] };
        calls++; return { content: "PASS. All tests passed.", tool_calls: [] };
      },
    });
    assert.equal(readFileSync(source, "utf8"), "let count = 2\n");
    assert(events.some(row => row.type === "tool_result" && row.name === "harness" && row.verification?.phase === "syntax"));
    assert(events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok === false));
    assert(!/^PASS\b/.test(result.assistant), result.assistant);
    assert.match(result.assistant, /(?:FAIL|Incomplete|Not proven|Still open)/);
    assert.match(result.assistant, /verification command|engine_verify/);
  } finally { setApprovalNotifier(null); }
});
