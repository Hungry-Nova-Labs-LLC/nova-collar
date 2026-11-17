import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "nova-project-checks-"));
process.env.NOVAPUP_HOME = join(root, "profile"); mkdirSync(process.env.NOVAPUP_HOME);
const npmConfig = join(root, "npmrc"); writeFileSync(npmConfig, "");
const npmEnv = { ...process.env, npm_config_userconfig: npmConfig, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" };
const npmAvailable = spawnSync("npm", ["--version"], { env: npmEnv, timeout: 10000 }).status === 0;
const { projectChecks, projectSnapshot } = await import("../src/main/project-verification.js");
const { createHarness } = await import("../src/main/harness.js");
const { setWorkdir } = await import("../src/main/workdir.js");
after(() => rmSync(root, { recursive: true, force: true }));
function project(name, scripts = { test: "node test.js" }) {
  const path = join(root, name); mkdirSync(path);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(path, "source.yaml"), "value: 1\n");
  return path;
}

test("read-only work creates no obligation; shell/config edits require declared project checks", async () => {
  const path = project("config-edits"); setWorkdir(path);
  let calls = [];
  const options = { sessionId: "config-chat", trackProjects: true, localExec: async (command, opts) => { calls.push({ command, opts }); return { ok: false, stderr: "test regression" }; } };
  const gate = createHarness(options);
  gate.before("host_run", { command: "pwd" }); await gate.after("host_run", { command: "pwd" }, { ok: true });
  assert.deepEqual(gate.debt(), []);
  gate.before("host_run", { command: "an approved config edit" });
  writeFileSync(join(path, "source.yaml"), "value: 2\n");
  await gate.after("host_run", { command: "an approved config edit" }, { ok: true });
  assert.ok(gate.debt().some((row) => row.includes("project")));
  assert.equal((await gate.checkProjects())[0].ok, false);
  assert.equal(calls[0].command, "npm run test");
  assert.equal(calls[0].opts.cwd, realpathSync(path));
  assert.match(createHarness(options).context(), /test regression/);
});

test("package managers and explicit shared check profiles retain provenance without running refresh", () => {
  const path = project("profiles", { build: "build", test: "tests", dev: "serve", deploy: "publish" });
  writeFileSync(join(path, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { build: "build", test: "tests", dev: "serve", deploy: "publish" } }));
  assert.deepEqual(projectChecks(path).commands, ["pnpm run build", "pnpm run test"]);
  mkdirSync(join(path, ".nova")); writeFileSync(join(path, ".nova", "checks.json"), JSON.stringify({ commands: ["python3 -m unittest discover"], timeoutMs: 999999 }));
  assert.deepEqual(projectChecks(path).commands, ["python3 -m unittest discover"]);
  assert.equal(projectChecks(path).timeoutMs, 90000);
  assert.ok(projectChecks(path).source.endsWith(".nova/checks.json"));
  writeFileSync(join(path, ".nova", "checks.json"), "{");
  assert.ok(projectChecks(path).error);
});

test("partial observation and active writers remain unverified", async () => {
  for (const kind of ["partial", "writer"]) {
    const path = project(kind); setWorkdir(path);
    let calls = 0;
    const gate = createHarness({ sessionId: `${kind}-chat`, trackProjects: true, hasActiveWriters: () => kind === "writer", localExec: async () => { calls++; return { ok: true }; } });
    gate.before("host_run", { command: "approved edit" });
    writeFileSync(join(path, "source.yaml"), "value: changed\n");
    if (kind === "partial") writeFileSync(join(path, "huge.data"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await gate.after("host_run", { command: "approved edit" }, { ok: true });
    const rows = await gate.checkProjects();
    assert.equal(rows[0].ok, false, kind);
    assert.equal(rows[0].verification.status, "unverified", kind);
    assert.ok(gate.debt().length, kind);
    if (kind !== "partial") assert.equal(calls, 0, kind);
  }
});

test("an absent executable profile is explicitly unavailable rather than a failed or passing test", async () => {
  const path = project("no-profile", {}); setWorkdir(path);
  let calls = 0;
  const gate = createHarness({ sessionId: "no-profile-chat", trackProjects: true, localExec: async () => { calls++; return { ok: true }; } });
  gate.before("host_run", { command: "approved config edit" });
  writeFileSync(join(path, "source.yaml"), "value: changed\n");
  await gate.after("host_run", { command: "approved config edit" }, { ok: true });
  const receipt = (await gate.checkProjects())[0];
  assert.equal(receipt.skipped, true); assert.equal(receipt.unavailable, true);
  assert.equal(receipt.verification.status, "unavailable");
  assert.match(receipt.detail, /No project test pass is claimed/);
  assert.equal(calls, 0); assert.deepEqual(gate.debt(), []);
});

test("removing a test profile cannot erase an observed project test failure", async () => {
  const path = project("removed-tests"); setWorkdir(path);
  const gate = createHarness({ sessionId: "removed-tests-chat", trackProjects: true, localExec: async () => ({ ok: false, stderr: "assertion regression" }) });
  gate.before("host_run", { command: "approved edit" });
  writeFileSync(join(path, "source.yaml"), "value: changed\n");
  await gate.after("host_run", { command: "approved edit" }, { ok: true });
  assert.equal((await gate.checkProjects())[0].ok, false);
  writeFileSync(join(path, "package.json"), "{}\n");
  const receipt = (await gate.checkProjects())[0];
  assert.equal(receipt.ok, false); assert.equal(receipt.verification.status, "failed");
  assert.ok(gate.debt().length);
});

test("npm test lifecycle selection preserves hooks and excludes only the known no-test placeholder", () => {
  const path = project("npm-lifecycle", { test: "echo \"Error: no test specified\" && exit 1" });
  assert.equal(projectChecks(path).unavailable, true);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { pretest: "node before.js", posttest: "node after.js" } }));
  writeFileSync(join(path, "test.js"), "throw Error('real test failure');\n");
  assert.deepEqual(projectChecks(path).commands, ["npm test"]);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { pretest: "node before.js", test: "node test.js", posttest: "node after.js" } }));
  assert.deepEqual(projectChecks(path).commands, ["npm run test"]);
});

test("real npm lifecycle hooks execute and a failing test remains failed", { skip: !npmAvailable }, async () => {
  const path = project("npm-real", { pretest: "node record.cjs before", test: "node record.cjs test", posttest: "node record.cjs after" });
  mkdirSync(join(path, ".cache")); setWorkdir(path);
  const source = 'require("node:fs").appendFileSync(".cache/lifecycle", process.argv[2] + "\\n");\n';
  writeFileSync(join(path, "record.cjs"), source);
  const gate = createHarness({ sessionId: "npm-real-chat", trackProjects: true, localExec: async (command, { cwd }) => {
    const [bin, ...args] = command.split(" ");
    const result = spawnSync(bin, args, { cwd, env: npmEnv, encoding: "utf8", timeout: 15000 });
    return { ok: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  } });
  gate.before("host_run", { command: "edit source" }); writeFileSync(join(path, "source.yaml"), "changed\n");
  await gate.after("host_run", { command: "edit source" }, { ok: true });
  assert.equal((await gate.checkProjects())[0].ok, true);
  assert.equal(readFileSync(join(path, ".cache/lifecycle"), "utf8"), "before\ntest\nafter\n");
  gate.before("host_run", { command: "edit source" });
  writeFileSync(join(path, "record.cjs"), source + 'if (process.argv[2] === "test") process.exit(1);\n');
  await gate.after("host_run", { command: "edit source" }, { ok: true });
  assert.equal((await gate.checkProjects())[0].ok, false);
  assert.ok(gate.debt().length);
});

test("structured failed-test outcomes and nonzero exit evidence cannot be masked by outer success", async () => {
  for (const [name, evidence] of [["exit", { ok: true, exitCode: 1, stdout: "tail succeeded" }], ["summary", { ok: true, exitCode: 0, stdout: "5 CHECK(S) FAILED\nwrapper done" }]]) {
    const path = project(`masked-${name}`); setWorkdir(path);
    const gate = createHarness({ sessionId: `masked-${name}-chat`, trackProjects: true, localExec: async () => evidence });
    gate.before("host_run", { command: "edit" }); writeFileSync(join(path, "source.yaml"), "changed\n");
    await gate.after("host_run", { command: "edit" }, { ok: true });
    assert.equal((await gate.checkProjects())[0].ok, false);
    assert.ok(gate.debt().length);
  }
});

test("nested newly created projects keep independent failures and checks.json changes invalidate a pass", async () => {
  const path = project("nested-parent"), nested = join(path, "child"); setWorkdir(path);
  const gate = createHarness({ sessionId: "nested-chat", trackProjects: true, localExec: async (_command, options) => options.cwd.endsWith("child") ? { ok: false, error: "child tests failed" } : { ok: true } });
  gate.before("host_run", { command: "create child", paths: [path] });
  mkdirSync(nested); writeFileSync(join(nested, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  await gate.after("host_run", { command: "create child" }, { ok: true });
  const rows = await gate.checkProjects();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.path.endsWith("child")).ok, false);
  assert.ok(gate.debt().some((row) => row.includes("child")));
  gate.before("host_run", { command: "edit check profile", paths: [path] });
  mkdirSync(join(path, ".nova")); writeFileSync(join(path, ".nova", "checks.json"), JSON.stringify({ commands: ["custom test"] }));
  await gate.after("host_run", { command: "edit check profile" }, { ok: true });
  assert.ok(gate.debt().some((row) => row.includes(realpathSync(path))));
});

test("project source changes during a check remain unverified", async () => {
  const path = project("racing-check"); setWorkdir(path);
  const gate = createHarness({ sessionId: "racing-chat", trackProjects: true, localExec: async () => { writeFileSync(join(path, "source.yaml"), "value: after\n"); return { ok: true }; } });
  gate.before("host_run", { command: "edit" }); writeFileSync(join(path, "source.yaml"), "value: before\n"); await gate.after("host_run", { command: "edit" }, { ok: true });
  const result = (await gate.checkProjects())[0];
  assert.equal(result.ok, false);
  assert.match(result.detail, /changed during project verification/);
});

test("saved project modules are compiled without launching them as standalone programs", async () => {
  const path = project("project-module"), file = join(path, "module.js"); setWorkdir(path);
  const commands = [];
  const gate = createHarness({ sessionId: "module-chat", trackProjects: true, localExec: async (command) => { commands.push(command); return { ok: true }; } });
  gate.before("host_file_write", { path: file, content: "export const value = 1;\n" });
  writeFileSync(file, "export const value = 1;\n");
  await gate.after("host_file_write", { path: file, content: "export const value = 1;\n" }, { ok: true, path: file });
  assert.equal(commands.length, 1); assert.match(commands[0], /--check/);
  assert.ok(gate.debt().some((row) => row.includes("project")));
  await gate.checkProjects(); assert.equal(commands[1], "npm run test");
  assert.deepEqual(gate.debt(), []);
});

test("Git HEAD contributes to project identity even when both worktrees are clean", () => {
  const path = project("git-revisions");
  const git = (args) => execFileSync("git", ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "ignore" });
  git(["init"]); git(["add", "."]); git(["commit", "-m", "baseline"]);
  const before = projectSnapshot(path);
  writeFileSync(join(path, "source.yaml"), "value: committed\n"); git(["add", "."]); git(["commit", "-m", "change"]);
  const after = projectSnapshot(path);
  assert.equal(before.git, true); assert.equal(before.files.size, 0); assert.equal(after.files.size, 0);
  assert.notEqual(before.head, after.head); assert.notEqual(before.revision, after.revision);
});

test("an unchanged failed project check runs once per turn; a changed revision or stopped writer permits retry", async () => {
  const path = project("bounded-attempts"); setWorkdir(path);
  let calls = 0, writer = false;
  const options = { sessionId: "attempts-chat", trackProjects: true, hasActiveWriters: () => writer, localExec: async () => { calls++; return { ok: false, stderr: "reproduced failure" }; } };
  const gate = createHarness(options);
  gate.before("host_run", { command: "edit" }); writeFileSync(join(path, "source.yaml"), "value: first\n"); await gate.after("host_run", { command: "edit" }, { ok: true });
  assert.equal((await gate.checkProjects()).length, 1); assert.equal(calls, 1);
  assert.deepEqual(await gate.checkProjects(), []); assert.equal(calls, 1); assert.ok(gate.debt().length);
  writeFileSync(join(path, "source.yaml"), "value: repaired\n"); await gate.checkProjects(); assert.equal(calls, 2);
  writer = true; assert.equal((await gate.checkProjects())[0].verification.status, "failed", "a writer skip preserves the observed real failure"); assert.equal(calls, 2);
  writer = false; await gate.checkProjects(); assert.equal(calls, 3);
  await gate.checkProjects(); assert.equal(calls, 3);
  await createHarness(options).checkProjects(); assert.equal(calls, 4, "a new deliberate turn gets a fresh attempt");
});
