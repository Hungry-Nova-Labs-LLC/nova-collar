import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "nova-command-diagnostics-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Network/model calls are forbidden in diagnostic tests."); };
const { describeTool } = await import("../src/main/describe.js");
const { executeTool } = await import("../src/main/tools.js");
const { ensureHome, loadConfig } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { commandDiagnostic } = await import("../src/main/command-diagnostic.js");
const { failureGoal } = await import("../src/main/goal.js");
const { runTurn } = await import("../src/main/agent.js");
const { windowToolDefs } = await import("../src/main/tools.js");
ensureHome();
after(() => { setApprovalNotifier(null); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });

const warning = "/bin/sh: /Users/example/.profile: Operation not permitted";

test("command summary names a failed test instead of incidental shell startup stderr", () => {
  const result = describeTool("host_run", { command: "node check.mjs" }, {
    ok: false, stdout: "45 assertions passed\n5 FAILURES\n", stderr: warning,
  });
  assert.match(result.blurb, /5 FAILURES/);
  assert(result.detail.includes(warning), "the complete diagnostic remains available");
});

test("command errors outrank startup warnings without suppressing real permission failures", () => {
  const result = describeTool("host_run", { command: "node check.mjs" }, {
    ok: false, stderr: `${warning}\nTypeError: invalid argument\n    at check.mjs:2`,
  });
  assert.match(result.blurb, /TypeError/);
  const denied = describeTool("host_run", { command: "node check.mjs" }, { ok: false, stderr: warning });
  assert.match(denied.blurb, /Operation not permitted/);
});

test("a successful command retains its output summary despite stderr warnings", () => {
  const result = describeTool("host_run", { command: "node check.mjs" }, {
    ok: true, stdout: "CHECK_OK\n", stderr: warning,
  });
  assert.match(result.blurb, /CHECK_OK/);
  assert(!result.blurb.startsWith("Failed"));
});

function failed(stderr, stdout = "", error = stderr.trim()) {
  return { ok: false, error, stderr, stdout };
}

test("a production-shaped copied error selects the terminal Python exception", () => {
  const stderr = `${warning}\nTraceback (most recent call last):\n  File "check.py", line 2, in <module>\n    open("missing.fixture")\nFileNotFoundError: missing.fixture\n`;
  const raw = failed(stderr), original = structuredClone(raw);
  const result = describeTool("host_run", { command: "python3 check.py" }, raw);
  assert.match(result.blurb, /FileNotFoundError: missing\.fixture/);
  assert(!result.blurb.includes(".profile"));
  assert(result.detail.includes(stderr.trim()));
  assert.deepEqual(raw, original, "presentation must not change raw process evidence");
});

test("a chained traceback names its final exception rather than a header or earlier cause", () => {
  const stderr = `${warning}\nTraceback (most recent call last):\nValueError: earlier cause\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\nFileNotFoundError: final fixture failure\n`;
  const result = describeTool("host_run", { command: "python3 check.py" }, failed(stderr));
  assert.match(result.blurb, /FileNotFoundError: final fixture failure/);
  assert(!result.blurb.includes("earlier cause"));
});

test("Node error codes survive a copied stderr error field", () => {
  const stderr = `${warning}\nnode:internal/modules/esm/resolve:241\n    throw new ERR_MODULE_NOT_FOUND(\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module 'missing.mjs'\n    at resolve (node:internal/modules/esm/resolve:241:11)\n`;
  const result = describeTool("host_run", { command: "node check.mjs" }, failed(stderr));
  assert.match(result.blurb, /ERR_MODULE_NOT_FOUND/);
  assert(result.detail.includes(stderr.trim()));
});

test("a full copied error can retain the terminal exception beyond the stderr display bound", () => {
  const full = `${warning}\nTraceback (most recent call last):\n${'  File "frame.py", line 1\n'.repeat(400)}FileNotFoundError: final error beyond stderr bound\n`;
  const raw = failed(full.slice(0, 8000), "", full.trim());
  const result = describeTool("host_run", { command: "python3 check.py" }, raw);
  assert.match(result.blurb, /FileNotFoundError: final error/);
  assert.equal(raw.stderr.length, 8000);
  assert.equal(raw.error, full.trim());
});

test("failed test output outranks a copied startup-only error", () => {
  const raw = failed(warning, "45 assertions passed\n5 CHECKS FAILED\n");
  const result = describeTool("host_run", { command: "node check.mjs" }, raw);
  assert.match(result.blurb, /5 CHECKS FAILED/);
  assert(result.detail.includes(warning));
  assert(result.detail.includes("45 assertions passed"));
});

test("a concrete labelled assertion is useful when no failure-count summary exists", () => {
  const result = describeTool("host_run", { command: "node check.mjs" }, failed(warning, "ok - first assertion\nFAIL - result did not match expected value\n"));
  assert.match(result.blurb, /FAIL - result did not match/);
});

test("an independent spawn error remains more specific than incidental startup stderr", () => {
  const result = describeTool("host_run", { command: "missing-interpreter check.py" }, failed(warning, "", "spawn missing-interpreter ENOENT"));
  assert.match(result.blurb, /spawn missing-interpreter ENOENT/);
});

test("compact UI/recovery causes use existing secret redaction without changing raw evidence", () => {
  const token = "sk-fixturePrivateValue123456";
  const raw = failed(`${warning}\nValueError: rejected ${token}\n`);
  const original = structuredClone(raw), diagnostic = commandDiagnostic(raw, "python3 check.py");
  assert.match(diagnostic, /ValueError/);
  assert(!diagnostic.includes(token));
  assert.match(diagnostic, /\[redacted\]/);
  assert.deepEqual(raw, original);
});

test("a genuine profile-only permission failure is preserved in both production fields", () => {
  const result = describeTool("host_run", { command: "check" }, failed(warning));
  assert.match(result.blurb, /Operation not permitted/);
  assert(result.detail.includes(warning));
});

test("expected bare FAIL output never changes a successful command into a failure", () => {
  const raw = { ok: true, stdout: "FAIL\n", stderr: warning };
  const result = describeTool("host_run", { command: "node expected.mjs" }, raw);
  assert.equal(result.ok, true);
  assert(!result.blurb.startsWith("Failed:"));
});

test("bare FAIL text is not promoted into a causal diagnostic for an already failed command", () => {
  const result = describeTool("host_run", { command: "node check.mjs" }, failed(warning, "FAIL\n", "exit 1"));
  assert(!/^Failed: FAIL(?:\s|$)/.test(result.blurb));
  assert(result.detail.includes("FAIL\n"));
});

function quote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

async function hostFixture(name, file, content, interpreter) {
  const cwd = join(root, name); mkdirSync(cwd); setWorkdir(cwd);
  writeFileSync(join(cwd, file), content);
  const command = `${interpreter} ${quote(file)}`;
  setApprovalNotifier(event => {
    if (event.type !== "approval") return;
    assert.equal(event.request.tool, "host_run");
    assert(event.request.detail.includes(cwd) && event.request.detail.includes(command));
    resolveApproval(event.request.id, true);
  });
  const raw = await executeTool("host_run", { command, cwd, timeoutMs: 5000 }, loadConfig(), { signal: AbortSignal.timeout(8000) });
  const original = structuredClone(raw), result = describeTool("host_run", { command, cwd }, raw);
  assert.equal(raw.ok, false);
  assert(raw.error && raw.stderr, "the real dispatcher supplies error as well as stderr");
  assert.deepEqual(raw, original);
  return { raw, result };
}

test("real host_run plus describe preserves a Python terminal exception", async () => {
  const { raw, result } = await hostFixture("python", "check.py", `import sys\nsys.stderr.write(${JSON.stringify(warning + '\n')})\nopen("missing.fixture")\n`, "python3");
  assert.match(raw.error, /FileNotFoundError/);
  assert.match(result.blurb, /FileNotFoundError/);
  assert(result.detail.includes(raw.stderr.trim()));
});

test("real host_run plus describe preserves a Node missing-module code", async () => {
  const { raw, result } = await hostFixture("node", "check.mjs", `process.stderr.write(${JSON.stringify(warning + '\n')});\nawait import("./missing-fixture-module.mjs");\n`, quote(process.execPath));
  assert.match(raw.error, /ERR_MODULE_NOT_FOUND/);
  assert.match(result.blurb, /ERR_MODULE_NOT_FOUND/);
  assert(result.detail.includes(raw.stderr.trim()));
});

test("real host_run with startup-only stderr surfaces failed assertions from stdout", async () => {
  const { raw, result } = await hostFixture("stdout", "check.mjs", `process.stderr.write(${JSON.stringify(warning + '\n')});\nconsole.log("12 assertions passed");\nconsole.log("3 CHECKS FAILED");\nprocess.exitCode = 1;\n`, quote(process.execPath));
  assert.match(raw.stdout, /3 CHECKS FAILED/);
  assert.match(result.blurb, /3 CHECKS FAILED/);
  assert(result.detail.includes(raw.stderr.trim()));
});

test("the shared diagnostic survives the recovery goal's first-160-character bound", () => {
  const stderr = `${warning}\nTraceback (most recent call last):\n${'  File "long-frame.py", line 50\n'.repeat(12)}FileNotFoundError: missing.fixture\n`;
  const diagnostic = commandDiagnostic(failed(stderr), "python3 check.py");
  const goal = failureGoal({ name: "host_run", detail: diagnostic });
  assert.match(goal, /FileNotFoundError: missing\.fixture/);
  assert(!goal.includes(".profile") && !goal.includes("Traceback"));
});

test("real runTurn host_run failure uses the same compact cause in its model-facing recovery goal", async () => {
  const cwd = join(root, "agent-recovery"); mkdirSync(cwd); setWorkdir(cwd);
  writeFileSync(join(cwd, "check.py"), `import sys\nsys.stderr.write(${JSON.stringify(warning + '\n')})\nopen("missing.fixture")\n`);
  const command = "python3 check.py";
  setApprovalNotifier(event => {
    if (event.type === "approval") {
      assert(event.request.detail.includes(cwd) && event.request.detail.includes(command));
      resolveApproval(event.request.id, true);
    }
  });
  const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(tool => tool.function.name === "host_run");
  const events = []; let requests = 0, recovery = "";
  await runTurn([], "Run check.py and report its actual failure.", event => events.push(event), AbortSignal.timeout(10000), {
    tools,
    complete: async messages => {
      requests++;
      if (requests === 1) return { content: "", tool_calls: [{ id: "fixture", type: "function", function: { name: "host_run", arguments: JSON.stringify({ command, cwd }) } }] };
      const message = messages.findLast(row => row.role === "tool" && row.tool_call_id === "fixture");
      recovery = String(message?.content || "").split("\n\nObserved failure: ")[1] || "";
      assert.match(recovery, /FileNotFoundError/);
      assert(!recovery.includes(".profile") && !recovery.includes("Traceback"));
      assert(String(message.content).includes(warning), "raw evidence is still model-visible outside the compact goal");
      return { content: "FAIL. The fixture input is missing.", tool_calls: [] };
    },
  });
  assert.equal(requests, 2);
  assert(events.some(event => event.type === "goal" && /FileNotFoundError/.test(event.opposite)));
  assert(events.some(event => event.type === "tool_result" && event.name === "host_run" && event.ok === false && /FileNotFoundError/.test(event.blurb)));
});
