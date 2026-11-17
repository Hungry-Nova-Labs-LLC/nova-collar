import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compilerExecutionCommand, executionEvidence } from "../src/main/verification-result.js";

const base = dirname(fileURLToPath(import.meta.url));
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
const commandResult = (command, cwd) => {
  const raw = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
  assert.equal(raw.error, undefined);
  return executionEvidence({ ok: raw.status === 0, exitCode: raw.status, stdout: raw.stdout, stderr: raw.stderr },
    { compiler: compilerExecutionCommand(command) });
};

test("real bad Swift compiler diagnostics override a masked pipeline exit", () => {
  execFileSync("swiftc", ["--version"], { stdio: "pipe" });
  const cwd = mkdtempSync(join(base, ".tmp-compiler-"));
  try {
    mkdirSync(join(cwd, "cache"));
    writeFileSync(join(cwd, "Bad.swift"), "func broken( {\n");
    const command = `swiftc -module-cache-path ${quote(join(cwd, "cache"))} -o ${quote(join(cwd, "bad"))} Bad.swift 2>&1 | head -20; echo "compile exit: $?"`;
    const result = commandResult(command, cwd);
    assert.equal(result.exitCode, 0, "the shell really masks the compiler's failure");
    assert.equal(result.ok, false);
    assert.equal(result.compilerFailure, true);
    assert.match(result.compilerDiagnostic, /Bad\.swift:\d+:\d+: error:/);
    assert.match(result.diagnostic, /Compiler diagnostic/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("real valid Swift compile remains successful and warnings alone do not fail", () => {
  const cwd = mkdtempSync(join(base, ".tmp-compiler-"));
  try {
    mkdirSync(join(cwd, "cache"));
    writeFileSync(join(cwd, "Good.swift"), 'print("compiled")\n');
    const command = `swiftc -module-cache-path ${quote(join(cwd, "cache"))} -o ${quote(join(cwd, "good"))} Good.swift 2>&1 | head -20; echo "compile exit: $?"`;
    const result = commandResult(command, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.compilerFailure, false);
    assert.equal(execFileSync(join(cwd, "good"), [], { encoding: "utf8" }).trim(), "compiled");
    assert.equal(executionEvidence({ ok: true, exitCode: 0, stderr: "Good.swift:1:1: warning: unused value" }, { compiler: true }).ok, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("ordinary programs printing expected compiler errors retain successful exit", () => {
  const cwd = mkdtempSync(join(base, ".tmp-compiler-"));
  try {
    writeFileSync(join(cwd, "expected.mjs"), 'console.log("Bad.swift:10:1: error: expressions are not allowed at the top level"); console.log("SyntaxError: expected example");\n');
    const result = commandResult("node expected.mjs", cwd);
    assert.equal(result.ok, true);
    assert.equal(result.compilerFailure, false);
    assert.equal(compilerExecutionCommand(`echo 'data; swiftc Bad.swift'`), false);
    assert.equal(compilerExecutionCommand(`node -e 'console.log("Bad.swift:1:1: error: expected")'`), false);
    assert.equal(compilerExecutionCommand("cat compiler.log"), false);
    assert.equal(compilerExecutionCommand("cat <<'EOF'\nswiftc Bad.swift\nEOF"), false);
    assert.equal(compilerExecutionCommand("node expected.mjs --check"), false);
    assert.equal(compilerExecutionCommand(`python3 -c 'print("SyntaxError: expected")' -m py_compile`), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("general structured compiler errors are scoped and real nonzero exits remain failures", () => {
  for (const text of [
    "source.c:4:2: error: expected ';'",
    "Main.java:3: error: cannot find symbol",
    "src/item.ts(5,2): error TS2322: not assignable",
    "error[E0433]: failed to resolve",
    "clang: error: no input files",
    "SyntaxError: invalid syntax",
  ]) {
    assert.equal(executionEvidence({ ok: true, exitCode: 0, stdout: text }, { compiler: true }).ok, false, text);
    assert.equal(executionEvidence({ ok: true, exitCode: 0, stdout: text }).ok, true, text);
  }
  for (const command of ['swiftc Bad.swift 2>&1 | head -20; echo "compile exit: $?"', '"/usr/bin/swiftc" Bad.swift', "env FLAGS=1 clang bad.c", "xcrun swiftc bad.swift", "npx --no-install tsc --noEmit", "python3 -m py_compile bad.py", "node --check bad.js"]) {
    assert.equal(compilerExecutionCommand(command), true, command);
  }
  assert.equal(executionEvidence({ ok: true, exitCode: 2, stdout: "no structured diagnostics" }).ok, false);
});

test("compile-and-run or unrelated output cannot be attributed to the compiler", () => {
  const cwd = mkdtempSync(join(base, ".tmp-compiler-"));
  try {
    mkdirSync(join(cwd, "cache"));
    const text = "Example.swift:10:1: error: expected program output";
    writeFileSync(join(cwd, "Good.swift"), `print(${JSON.stringify(text)})\n`);
    const compile = `swiftc -module-cache-path ${quote(join(cwd, "cache"))} Good.swift -o sample`;
    for (const command of [compile + " && ./sample", compile + `; printf '%s\\n' ${quote(text)}`]) {
      assert.equal(compilerExecutionCommand(command), false, "mixed stdout has no compiler attribution");
      const result = commandResult(command, cwd);
      assert.equal(result.ok, true);
      assert.equal(result.compilerFailure, false);
      assert.match(result.stdout, /Example\.swift:10:1: error:/);
    }
    assert.equal(compilerExecutionCommand("swiftc Good.swift | head compiler.log"), false);
    assert.equal(compilerExecutionCommand("echo 'Bad.swift:1:1: error: sample'; swiftc Good.swift"), false);
    assert.equal(compilerExecutionCommand("swiftc Good.swift | sed 's/pass/error: fake/'"), false);
    assert.equal(compilerExecutionCommand("swiftc Good.swift && ./sample"), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
