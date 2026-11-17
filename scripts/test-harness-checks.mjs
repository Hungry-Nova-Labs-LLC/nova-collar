import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "nova-check-plans-"));
process.env.NOVAPUP_HOME = join(root, "profile");
mkdirSync(process.env.NOVAPUP_HOME);
const { CODE, executionEvidence, probePath, runCommand, verifyPath } = await import("../src/main/harness-check.js");
after(() => rmSync(root, { recursive: true, force: true }));
const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(python, ["--version"]).status === 0;
const swiftAvailable = spawnSync("swiftc", ["--version"]).status === 0;
const exec = async (command, { cwd } = {}) => {
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const result = spawnSync(shell, args, { cwd: cwd || root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  return { ok: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
};

test("Python src-layout libraries import in their package context and project cwd", { skip: !pythonAvailable }, async () => {
  const project = join(root, "python-src"), pkg = join(project, "src", "sample");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(join(pkg, "helper.py"), "VALUE = 42\n");
  const file = join(pkg, "library.py");
  const source = `from .helper import VALUE\nfrom pathlib import Path\nassert Path.cwd() == Path(${JSON.stringify(project)}).resolve()\nassert VALUE == 42\n`;
  writeFileSync(file, source);
  const result = await probePath(file, source, { exec });
  assert.equal(result.ok, true, result.error);
  assert.match(result.blurb, /package import ok/);
  writeFileSync(file, "raise RuntimeError('real library failure')\n");
  const failed = await probePath(file, "raise RuntimeError('real library failure')\n", { exec });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /real library failure/);
});

test("Python package entrypoints run as modules with relative imports", { skip: !pythonAvailable }, async () => {
  const pkg = join(root, "cli-project", "cli"); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), ""); writeFileSync(join(pkg, "value.py"), "VALUE = 7\n");
  const file = join(pkg, "main.py"), source = "from .value import VALUE\nif __name__ == '__main__':\n    print(VALUE)\n";
  writeFileSync(file, source);
  const result = await probePath(file, source, { exec, expect: ["7"] });
  assert.equal(result.ok, true, result.error);
});

test("stdlib unittest executes assertions without requiring pytest", { skip: !pythonAvailable }, async () => {
  const file = join(root, "test_standard.py");
  const source = "import unittest\nclass Sample(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(2 + 2, 4)\n";
  writeFileSync(file, source);
  assert.doesNotMatch(runCommand(file, source).command, /pytest/);
  assert.equal((await probePath(file, source, { exec })).ok, true);
  writeFileSync(file, source.replace("2 + 2, 4", "2 + 2, 5"));
  assert.equal((await probePath(file, source, { exec })).ok, false);
});

test("missing pytest and zero tests are unavailable, never a plain-script test pass", async () => {
  let calls = 0;
  const result = await probePath(join(root, "test_missing.py"), "def test_value(): pass\n", { exec: async () => {
    calls++; return { ok: false, stderr: "No module named pytest" };
  } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false); assert.equal(result.unavailable, true); assert.equal(result.skipped, true);
  const empty = await probePath(join(root, "empty.test.js"), "", { exec: async () => ({ ok: true, stdout: "TAP version 13\n1..0\n# tests 0\n# fail 0\n" }) });
  assert.equal(empty.ok, false); assert.equal(empty.unavailable, true);
  const nested = "Warning: node:test run() is being called recursively within a test file. skipping running files.";
  assert.equal(executionEvidence({ ok: true, stderr: nested }, { test: true }).noTests, true);
  assert.equal(executionEvidence({ ok: true, stderr: nested }, { test: false }).ok, true);
});

test("mixed unittest/pytest modules are not reduced to a partial stdlib suite", () => {
  const file = join(root, "test_mixed.py");
  const source = "import unittest\nclass Unit(unittest.TestCase):\n    def test_ok(self): pass\ndef test_failure():\n    assert False\n";
  assert.match(runCommand(file, source).command, /pytest/);
  const classMixed = "import unittest\nclass Unit(unittest.TestCase):\n    def test_ok(self): pass\nclass TestOther:\n    def test_failure(self): assert False\n";
  assert.match(runCommand(file, classMixed).command, /pytest/);
});

test("process status and structured failing-test summaries override masked success", () => {
  assert.equal(executionEvidence({ ok: true, exitCode: 1, stdout: "done" }).ok, false);
  for (const output of ["not ok 1 - assertion\n", "# fail 2\n", "FAILED (failures=1)\n", "5 CHECK(S) FAILED\n", 'FAILURES: ["assertion"]\n']) {
    assert.equal(executionEvidence({ ok: true, exitCode: 0, stdout: output }, { test: true }).ok, false, output);
  }
  assert.equal(executionEvidence({ ok: true, exitCode: 0, stdout: 'TypeError is expected; FAIL is sample data\nFAILURES: []\n# fail 0\n' }).ok, true);
  assert.equal(executionEvidence({ ok: true, stdout: "5 CHECK(S) FAILED\n" }).ok, true, "reading an old failing log is not a new test execution");
});

test("ordinary expected-output programs may print framework-shaped failure text", { skip: !pythonAvailable }, async () => {
  const file = join(root, "expected-output.py");
  const source = "print('not ok 1 - example')\nprint('FAILED (failures=1)')\n";
  writeFileSync(file, source);
  const result = await probePath(file, source, { exec, expect: ["not ok 1 - example", "FAILED (failures=1)"] });
  assert.equal(result.ok, true, result.error);
});

test("an actual unittest failure is not erased by a successful trailing shell command", { skip: !pythonAvailable || process.platform === "win32" }, async () => {
  const file = join(root, "test_masked_failure.py");
  const source = "import unittest\nclass Sample(unittest.TestCase):\n    def test_bad(self): self.assertEqual(1, 2)\n";
  writeFileSync(file, source);
  let observedExit;
  const masked = async (command, options) => {
    const result = await exec(`${command}; echo wrapper-completed`, options);
    observedExit = result.exitCode;
    return result;
  };
  const result = await probePath(file, source, { exec: masked });
  assert.equal(observedExit, 0, "outer shell really did mask the failing test exit");
  assert.equal(result.ok, false);
  assert.match(result.error, /FAILED \(failures=1\)/);
});

test("Swift libraries get real parse checks without linking/running or requiring sibling types", { skip: !swiftAvailable }, async () => {
  const file = join(root, "Library.swift");
  writeFileSync(file, "struct Library { let dependency: DefinedInAnotherFile }\n");
  assert.equal(CODE.has(".swift"), true);
  assert.equal(runCommand(file, "struct Library {}"), null);
  const parsed = await verifyPath(file, { exec });
  assert.equal(parsed.ok, true, parsed.error); assert.equal(parsed.syntaxOnly, true);
  writeFileSync(file, "struct Library {\n");
  assert.equal((await verifyPath(file, { exec })).ok, false);
});

test("a missing Swift compiler is an explicit unavailable check", async () => {
  const result = await verifyPath(join(root, "Missing.swift"), { exec: async () => ({ ok: false, stderr: "/bin/sh: swiftc: command not found" }) });
  assert.equal(result.ok, false); assert.equal(result.unavailable, true); assert.equal(result.blocking, true);
});

test("native TypeScript syntax checks strip types without executing or claiming typecheck", async () => {
  const file = join(root, "syntax.ts");
  writeFileSync(file, 'const value: number = "a type error is outside syntax coverage"; throw Error("must not execute"); export { value };\n');
  const parsed = await verifyPath(file, { exec });
  if (parsed.unavailable) return; // Older installed Node must report this explicitly.
  assert.equal(parsed.ok, true, parsed.error); assert.equal(parsed.syntaxOnly, true);
  writeFileSync(file, "export const value: number = ;\n");
  assert.equal((await verifyPath(file, { exec })).ok, false);
  writeFileSync(file, "enum Choice { First, Second }\n");
  const transform = await verifyPath(file, { exec });
  assert.equal(transform.ok, false); assert.equal(transform.unavailable, true);
  const tsx = await verifyPath(join(root, "view.tsx"), { exec });
  assert.equal(tsx.unavailable, true);
});

test("a Node without the TS stripping API reports an unavailable check", async () => {
  const result = await verifyPath(join(root, "older.ts"), { exec: async () => ({ ok: false, stderr: "NOVA_TS_UNAVAILABLE: native TypeScript syntax stripping is unavailable" }) });
  assert.equal(result.ok, false); assert.equal(result.unavailable, true);
});

test("Python runtime API inspection accepts inherited and re-exported methods and checks requested variadics", { skip: !pythonAvailable }, async () => {
  const pkg = join(root, "api-python", "publicapi"); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  writeFileSync(join(pkg, "base.py"), "class Base:\n    def call(self, fn, *args, **kwargs):\n        return fn(*args, **kwargs)\nclass Lane(Base): pass\n");
  const file = join(pkg, "api.py"), source = "from .base import Lane\n";
  writeFileSync(file, source);
  const result = await probePath(file, source, { exec, api: { symbol: "Lane", method: "call", variadicPositional: true, variadicKeyword: true } });
  assert.equal(result.ok, true, result.error); assert.equal(result.apiVerified, true);
  assert.doesNotMatch(result.stdout, /NOVA_API_/);
  writeFileSync(join(pkg, "base.py"), "class Lane:\n    def call(self, fn): return fn()\n");
  const invalid = await probePath(file, source, { exec, api: { symbol: "Lane", method: "call", variadicKeyword: true } });
  assert.equal(invalid.ok, false); assert.notEqual(invalid.apiVerified, true);
});

test("JS runtime API inspection supports re-exported inherited methods and CommonJS classes", async () => {
  const dir = join(root, "api-js"); mkdirSync(dir);
  writeFileSync(join(dir, "base.mjs"), "class Base { call() {} } export class Lane extends Base {}\n");
  const file = join(dir, "api.mjs"), source = 'export { Lane } from "./base.mjs";\n'; writeFileSync(file, source);
  const result = await probePath(file, source, { exec, api: { symbol: "Lane", method: "call" } });
  assert.equal(result.ok, true, result.error); assert.equal(result.apiVerified, true);
  const cjs = join(dir, "api.cjs"); writeFileSync(cjs, "module.exports = class Lane { static call() {} };\n");
  assert.equal((await probePath(cjs, "", { exec, api: { symbol: "Lane", method: "call" } })).apiVerified, true);
});

test("API checks do not claim success when module exits before checks or constructor context is needed", async () => {
  const file = join(root, "early-exit.mjs"); writeFileSync(file, "process.exit(0);\n");
  const early = await probePath(file, "", { exec, api: { symbol: "Lane" } });
  assert.equal(early.unavailable, true); assert.notEqual(early.apiVerified, true);
  writeFileSync(file, "export class Lane { call = () => {}; }\n");
  const instance = await probePath(file, "", { exec, api: { symbol: "Lane", method: "call" } });
  assert.equal(instance.unavailable, true); assert.notEqual(instance.apiVerified, true);
});
