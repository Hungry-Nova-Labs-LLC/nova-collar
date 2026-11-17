import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { ACTION_TEXT_LIMIT, CLOSEOUT_TOKENS, createTurnProgress, executionRequested, implementationRequested, observedImplementationResult, passedProof, steeringEditStage, testExecutionCommand } from "../src/main/turn-policy.js";
import { briefArgs, toolSig } from "../src/main/laya-loop.js";

const home = mkdtempSync(join(tmpdir(), "collar-agent-policy-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Live providers/network are forbidden in this fixture."); };
const { chatTarget, ensureHome, loadConfig } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { runTurn, complete } = await import("../src/main/agent.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { projectSnapshot } = await import("../src/main/project-verification.js");
ensureHome(); setWorkdir(home);
// The fixture is its own approval UI for fixed, temporary-file-only actions.
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
const definitions = windowToolDefs({ local: true, search: false, remote: false });
const tools = (...names) => definitions.filter(row => names.includes(row.function.name));
const call = (name, args, id = "call") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });

// Auxiliary review traffic is explicit; these fixture totals include that one request.
const advisoryReply = options => options?.requestKind === "contract_review" ? { content: '{"findings":[],"limitations":[]}', tool_calls: [] } : null;
const state = (hash, status = "passed", phase = "runtime") => [{ kind: "file", path: "/private/example.mjs", hash, status, phase }];
const data = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
afterEach(() => { globalThis.fetch = async () => { throw Error("No live provider in this fixture."); }; });
after(() => { setApprovalNotifier(null); globalThis.fetch = nativeFetch; rmSync(home, { recursive: true, force: true }); });

test("canonical full argument identity separates long corrections without exposing secrets", () => {
  const one = JSON.stringify({ path: "long.txt", content: "x".repeat(500) + "first", nested: { z: 2, a: 1 } });
  const two = JSON.stringify({ nested: { a: 1, z: 2 }, content: "x".repeat(500) + "second", path: "long.txt" });
  assert.equal(briefArgs(one), briefArgs(two));
  assert.notEqual(toolSig("host_file_write", one), toolSig("host_file_write", two));
  assert.equal(toolSig("read", '{"a":{"y":2,"x":1},"b":[1,2]}'), toolSig("read", '{ "b":[1,2], "a":{"x":1,"y":2}}'));
  assert.notEqual(toolSig("read", '{"b":[1,2]}'), toolSig("read", '{"b":[2,1]}'));
  const secret = "sk-fixturePrivateValue123456";
  assert(!toolSig("read", JSON.stringify({ token: secret })).includes(secret));
  assert(!briefArgs(JSON.stringify({ token: secret })).includes(secret));
});

test("progress credit requires changed bytes or improved passing verification and has a finite ceiling", () => {
  const progress = createTurnProgress(state("old", "failed"));
  progress.observe(state("old", "failed"), 8);
  assert.equal(progress.extend(8, 8), 8, "same failure/read/timestamp gives no extension");
  progress.observe(state("changed", "failed"), 8);
  assert.equal(progress.changed, true);
  assert.equal(progress.extend(8, 8), 12, "an actual failing edit is still source progress");
  assert.equal(progress.extend(12, 12), 12, "the same evidence cannot buy another extension");
  progress.observe(state("changed", "skipped"), 12);
  assert.equal(progress.extend(12, 12), 12);
  progress.observe(state("changed", "passed"), 12);
  assert.equal(progress.extend(12, 12), 16);
  let limit = 16;
  while (limit < 60) { progress.observe(state(`revision-${limit}`), limit); limit = progress.extend(limit, limit); }
  progress.observe(state("last"), 60); assert.equal(progress.extend(60, 60), 60);
  const created = createTurnProgress();
  created.observe([{ ...state("new", "failed")[0], initialHash: null }], 8);
  assert.equal(created.extend(8, 8), 12, "a recorded absent-to-present source transition counts");
  const epoch = created.revision;
  created.observe([{ ...state("new", "passed")[0], initialHash: null }], 12);
  assert.equal(created.revision, epoch, "a verification receipt alone does not change the source revision");
  assert.equal(passedProof({ ok: true, skipped: true, unavailable: true }), false);
});

test("explicit edit intent excludes discussion/review and blanket no-edit constraints", () => {
  for (const text of ["Can you fix the parser?", "Can we fix this: parser.js?", "Could we update parser.js?", "Implement a helper. Do not modify README.md.", "Review it and fix the bug.",
    "Update src/tool.js without changing src/config.js", "Fix app.js; do not modify files outside this project",
    "Fix src/tool.js and only review src/config.js", "Implement a read-only accessor in parser.js"]) assert(implementationRequested(text), text);
  for (const text of ["Explain how to fix this function.", "Let's discuss the code.", "Review the patch without editing.",
    "Only plan the fix.", "Can you only review the fix?", "How should I update this module?", "How can we fix parser.js?", "Should we fix parser.js?",
    "Fix suggestions, but do not edit any files.", "Fix app.js without changing anything", "Read-only: review app.js",
    "Help me understand the proposed fix in parser.js.", "Stop writing code; explain the fix.",
    "Stop editing and review the proposed fix.", "Please stop editing and just review the current patch."]) assert(!implementationRequested(text), text);
  for (const text of ["Stop editing; review only.", "Stop editing and review the proposed fix.", "Please stop editing and just review the current patch.", "Stop writing code; explain the fix."]) assert.equal(steeringEditStage(text), "review");
  assert.equal(steeringEditStage("Keep comments brief."), null);
  assert.equal(steeringEditStage("Resume editing the helper."), "edit");
  for (const text of ["Actually, review only for now.", "For now, only review the patch.", "I changed my mind: review only."]) assert.equal(steeringEditStage(text), "review");
  assert.equal(steeringEditStage("Fix src/a.js and only review src/b.js"), "edit");
  assert.equal(steeringEditStage("Actually, fix the helper."), "edit");
  assert.equal(steeringEditStage("Update src/tool.js without changing src/config.js"), "edit");
  assert.equal(testExecutionCommand("cat failing-test.log"), false);
  assert.equal(testExecutionCommand("node --test checks.mjs; echo finished"), true);
  assert.equal(testExecutionCommand("python3 -m unittest"), true);
  for (const text of ["Run check.js and confirm it prints TOKEN.", "Please execute tiny.py.", "Review helper.js and run check.js.", "Run check.js; do not execute other.py.", "Run check.js without editing.", "Run the tests without changing files.", "Run npm test without editing files.", "Run pnpm test.", "Run yarn test.", "Run the test.", "Run the project check."]) assert(executionRequested(text), text);
  for (const text of ["Explain how to run check.js.", "The run report contains a test.", "Only review check.js; do not run any scripts.", "Do not run check.js.", "Check the nginx service status.", "Check the weather.", "Run docker ps.", "Check the Nova Collar project's GitHub traffic.", "Check the project license."]) assert(!executionRequested(text), text);
  assert.equal(steeringEditStage("Check the weather."), null); assert.equal(steeringEditStage("Run docker ps."), null);
  assert.equal(steeringEditStage("Run check.js without editing."), "execute");
  assert.equal(steeringEditStage("Stop running tests."), "review");
  assert.equal(steeringEditStage("Do not run any programs; review only."), "review");
  assert.equal(steeringEditStage("Do not run old.js; run new.js without editing."), "execute");
});

test("production dispatcher executes a corrected long command and retains exact-repeat protection", async () => {
  const padding = "x".repeat(280);
  const first = `node -e '/*${padding}*/ process.stderr.write("first probe failed");process.exit(1)'`;
  const corrected = `node -e '/*${padding}*/ process.stdout.write("corrected probe")'`;
  assert.equal(briefArgs(JSON.stringify({ command: first })), briefArgs(JSON.stringify({ command: corrected })));
  const events = []; let requests = 0;
  const result = await runTurn([], "Inspect two program observations and give a concise result.", event => events.push(event), AbortSignal.timeout(15000), {
    tools: tools("host_run"), complete: async messages => {
      requests++;
      if (requests === 1) return reply("", [call("host_run", { command: first }, "failed")]);
      if (requests === 2) return reply("", [call("host_run", { command: corrected }, "corrected")]);
      assert(messages.find(row => row.role === "tool" && row.tool_call_id === "corrected").content.includes("corrected probe"));
      return reply("The corrected probe completed.");
    },
  });
  assert.equal(requests, 3); assert.match(result.assistant, /corrected probe/);
  assert.equal(events.filter(row => row.type === "tool_result" && row.name === "host_run" && row.ok).length, 1);
  let repeats = 0, executions = 0;
  await runTurn([], "Inspect the program observation.", event => { if (event.type === "tool_result" && event.name === "host_run") executions++; }, AbortSignal.timeout(15000), {
    tools: tools("host_run"), complete: async messages => {
      repeats++;
      if (repeats < 3) return reply("", [call("host_run", { command: corrected }, `repeat-${repeats}`)]);
      assert(messages.find(row => row.role === "tool" && row.tool_call_id === "repeat-2").content.includes("Skipped."));
      return reply("The probe has already completed.");
    },
  });
  assert.equal(executions, 1);
});

test("explicit implementation recovers from prose and a discussion remains an answer turn", async () => {
  const target = join(home, "recovery.mjs"); let requests = 0;
  const result = await runTurn([], "Fix the helper in recovery.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, allow: true, tools: tools("host_file_write"),
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if (requests <= 2) { assert.equal(options.toolChoice, "required"); assert.equal(options.maxVisibleChars, ACTION_TEXT_LIMIT); }
      if (requests === 1) return reply("Here is a suggested implementation, but no file was edited.");
      if (requests === 2) return reply("", [call("host_file_write", { path: target, content: "export const repaired = true;\n" })]);
      return reply("Updated the helper; its local checks passed.");
    },
  });
  assert.equal(requests, 4); assert(readFileSync(target, "utf8").includes("repaired")); assert.match(result.assistant, /Updated/);
  let discussions = 0;
  await runTurn([], "Explain how to fix recovery.mjs without editing.", () => {}, null, {
    tools: tools("host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      discussions++; assert.notEqual(options.toolChoice, "required"); assert.equal(options.maxVisibleChars, undefined); return reply("Use a small pure function and test its inputs.");
    },
  });
  assert.equal(discussions, 1);
});

test("a provider choice fallback does not repeat the rejected handshake during the same edit turn", async () => {
  let requests = 0; const target = join(home, "choice.mjs");
  await runTurn([], "Fix the helper in choice.mjs.", () => {}, AbortSignal.timeout(15000), {
    tools: tools("host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests === 1) { assert.equal(options.toolChoice, "required"); return { ...reply("I will describe a fix."), required_choice_fallback: true }; }
      if (requests === 2) { assert.equal(options.toolChoice, "auto"); assert.equal(options.maxVisibleChars, ACTION_TEXT_LIMIT); return reply("", [call("host_file_write", { path: target, content: "export const choice = true;\n" })]); }
      return reply("The helper is fixed and checked.");
    },
  });
  assert.equal(requests, 3);
});

test("unimplemented prose recovery is bounded and cannot claim completion", async () => {
  let requests = 0;
  const result = await runTurn([], "Fix the helper implementation.", () => {}, null, {
    tools: tools("host_file_write"), complete: async () => { requests++; return reply("Here is the code you could paste yourself."); },
  });
  assert.equal(requests, 3); assert.match(result.assistant, /^Incomplete\./); assert(!/^PASS\b/.test(result.assistant));
});

test("an unchanged syntax-only write cannot satisfy an implementation request", async () => {
  const project = join(home, "unchanged-module"); mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
  const file = join(project, "helper.js"), source = "export const helper = () => 42;\n"; writeFileSync(file, source);
  setWorkdir(project); let requests = 0; const events = [];
  try {
    const result = await runTurn([], "Fix the existing helper implementation.", event => events.push(event), AbortSignal.timeout(15000), {
      sessionId: createSession().id, tools: tools("host_file_read", "host_file_write"), complete: async () => {
        requests++;
        if (requests === 1) return reply("", [call("host_file_read", { path: file })]);
        if (requests === 2) return reply("", [call("host_file_write", { path: file, content: source })]);
        return reply("PASS. The implementation is fixed.");
      },
    });
    assert.equal(readFileSync(file, "utf8"), source); assert.equal(requests, 5);
    assert(events.some(row => row.type === "tool_result" && row.name === "host_file_write" && row.ok));
    assert(events.some(row => row.type === "tool_result" && row.verification?.phase === "syntax"));
    assert(!events.some(row => row.type === "tool_result" && row.verification?.status === "passed" && ["runtime", "test", "project"].includes(row.verification?.phase)));
    assert.match(result.assistant, /^Incomplete\./); assert(!/^PASS\b/.test(result.assistant));
  } finally { setWorkdir(home); }
});

test("a fresh real project check can establish unchanged behavior without a forced no-op edit", async () => {
  const project = join(home, "unchanged-verified"); mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node checks.mjs" } }));
  writeFileSync(join(project, "helper.mjs"), "export const answer = () => 42;\n");
  writeFileSync(join(project, "checks.mjs"), 'import assert from "node:assert/strict"; import {answer} from "./helper.mjs"; assert.equal(answer(),42); console.log("behavior assertion passed");\n');
  const session = createSession(); new VerificationLedger(session.id, project).projectChanged(project, projectSnapshot(project).revision);
  setWorkdir(project); let requests = 0, writes = 0;
  try {
    const result = await runTurn([], "Fix the existing helper functionality.", event => { if (event.name === "host_file_write" && event.type === "tool_result" && event.ok) writes++; }, AbortSignal.timeout(20000), {
      sessionId: session.id, tools: tools("host_file_write"), complete: async () => { requests++; return reply("The existing helper passes its declared behavior check; no edit was needed."); },
    });
    assert.equal(requests, 1); assert.equal(writes, 0); assert.match(result.assistant, /no edit was needed/);
    assert(result.messages.some(row => typeof row.content === "string" && row.content.includes('"status":"passed"')));
  } finally { setWorkdir(home); }
});

test("command receipts distinguish running failing tests from reading their historical log", async () => {
  const file = join(home, "failing-test.mjs");
  writeFileSync(file, 'import test from "node:test"; test("fixture failure",()=>{throw new Error("expected fixture assertion");});\n');
  let requests = 0; const events = [], implementation = join(home, "masked-check-helper.mjs");
  const result = await runTurn([], "Fix the helper implementation and verify its tests before reporting.", event => events.push(event), AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_file_write", "host_run"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if (requests === 1) return reply("", [call("host_file_write", { path: implementation, content: "export const helper = true;\n" })]);
      if (requests === 2) return reply("", [call("host_run", { command: `unset NODE_TEST_CONTEXT; node --test --test-reporter=tap '${file}'; echo shell-complete` })]);
      return reply("PASS. All tests passed.");
    },
  });
  assert.equal(requests, 7, "failed verification remains open through bounded recovery");
  assert.match(result.assistant, /^FAIL\./, JSON.stringify(result.messages.filter(row => row.role === "tool")));
  assert.match(result.assistant, /test verification command/);
  assert(events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok === false));
  const log = join(home, "failing-test.log"); writeFileSync(log, "not ok 1 - previous failure\n# fail 1\n");
  requests = 0; const readEvents = [];
  const read = await runTurn([], "Inspect the archived diagnostic text.", event => readEvents.push(event), AbortSignal.timeout(15000), {
    tools: tools("host_run"), complete: async () => ++requests === 1 ? reply("", [call("host_run", { command: `cat '${log}'` })]) : reply("The historical text records a failed test."),
  });
  assert.equal(requests, 2); assert(!/^FAIL\./.test(read.assistant));
  assert(readEvents.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok));
});

test("a run-only request requires observed output and never incurs write debt", async () => {
  const file = join(home, "run-only.mjs"), source = 'console.log("RUN_ONLY_MARKER");\n'; writeFileSync(file, source);
  let requests = 0; const events = [];
  const result = await runTurn([], "Run run-only.mjs and confirm it prints RUN_ONLY_MARKER.", event => events.push(event), AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_run"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; if (requests === 1) assert.equal(options.toolChoice, "required");
      if (requests === 1) return reply("", [call("host_run", { command: `node '${file}'` })]);
      return reply("It printed RUN_ONLY_MARKER.");
    },
  });
  assert.equal(requests, 2); assert.match(result.assistant, /RUN_ONLY_MARKER/); assert(!/^FAIL\b/.test(result.assistant));
  assert.equal(readFileSync(file, "utf8"), source);
  assert(events.some(row => row.type === "tool_result" && row.verification?.status === "passed" && row.verification?.phase === "runtime"));
});

test("a run-only output claim without execution cannot be accepted as proof", async () => {
  const file = join(home, "unrun.mjs"), source = 'console.log("UNRUN_MARKER");\n'; writeFileSync(file, source);
  let requests = 0;
  const result = await runTurn([], "Run unrun.mjs and confirm it prints UNRUN_MARKER.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_run"), complete: async () => { requests++; return reply("PASS. It printed UNRUN_MARKER."); },
  });
  assert.equal(requests, 3); assert.match(result.assistant, /\bIncomplete\./); assert(!/^PASS\b/.test(result.assistant)); assert.equal(readFileSync(file, "utf8"), source);
});

test("execute-only permits the positively named existing script while hiding writes and blocking inline shell", async () => {
  const file = join(home, "execute-only.mjs"), source = 'console.log("EXECUTE_ONLY_MARKER");\n'; writeFileSync(file, source);
  let requests = 0; const events = [];
  const result = await runTurn([], "Run execute-only.mjs without editing.", event => events.push(event), AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_run", "host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
      if (requests === 1) return reply("", [call("host_file_write", { path: file, content: "forbidden" })]);
      if (requests === 2) return reply("", [call("host_run", { command: 'node -e "console.log(1)"' })]);
      if (requests === 3) return reply("", [call("host_run", { command: `node '${file}'` })]);
      return reply("The script printed EXECUTE_ONLY_MARKER; no files were edited.");
    },
  });
  assert.equal(requests, 4); assert.equal(readFileSync(file, "utf8"), source); assert.match(result.assistant, /EXECUTE_ONLY_MARKER/);
  assert.equal(events.filter(row => row.type === "tool_result" && row.name === "host_run" && row.ok).length, 1);
  assert(!events.some(row => row.type === "tool_result" && row.name === "host_file_write" && row.ok));
});

test("execute-only runs the declared test command but not an unrelated build", async () => {
  const project = join(home, "execute-tests"); mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "node checks.cjs", build: "node build.cjs" } }));
  writeFileSync(join(project, "checks.cjs"), 'require("node:assert/strict").equal(2+2,4); console.log("behavior checked");\n');
  writeFileSync(join(project, "build.cjs"), 'require("node:fs").writeFileSync("forbidden-build.txt","not requested");\n');
  setWorkdir(project); let requests = 0; const events = [];
  try {
    const result = await runTurn([], "Run the tests without editing.", event => events.push(event), AbortSignal.timeout(20000), {
      sessionId: createSession().id, tools: tools("host_run", "host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
        requests++; assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
        if (requests === 1) return reply("", [call("host_run", { command: "npm run build" })]);
        if (requests === 2) return reply("", [call("host_run", { command: "npm test" })]);
        return reply("The requested declared tests passed; the build was not run.");
      },
    });
    assert.equal(requests, 3); assert(!/^FAIL\b/.test(result.assistant)); assert.throws(() => readFileSync(join(project, "forbidden-build.txt")));
    assert.equal(events.filter(row => row.type === "tool_result" && row.name === "host_run" && row.ok).length, 1);
  } finally { setWorkdir(home); }
});

test("execute-only needs a real receipt without a literal token and later review-only cancels that nudge", async () => {
  let requests = 0;
  const result = await runTurn([], "Run the tests without editing.", () => {}, null, {
    sessionId: createSession().id, tools: tools("host_run", "host_file_write"), complete: async () => { requests++; return reply("All tests passed."); },
  });
  assert.equal(requests, 3); assert.match(result.assistant, /\bIncomplete\./); assert(!/^PASS\b/.test(result.assistant));
  for (const steering of ["Actually, review only for now.", "Stop running tests.", "Do not run any programs; review only."]) {
    requests = 0; let batch = null;
    const reviewed = await runTurn([], "Run the tests without editing.", () => {}, null, {
      sessionId: createSession().id, tools: tools("host_run", "host_file_write"), takeInput: () => batch, ackInput: () => { batch = null; },
      complete: async (_messages, _cfg, _delta, _signal, options) => {
        requests++;
        if (requests === 1) { batch = { receipt: "review", messages: [{ content: steering }] }; return reply("All tests passed."); }
        assert.notEqual(options.toolChoice, "required"); assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
        return reply("Review only. No execution has been observed.");
      },
    });
    assert.equal(requests, 2); assert.match(reviewed.assistant, /Review only/);
  }
});

test("execute-only never authorizes a negatively named old script beside the positive new script", async () => {
  const old = join(home, "old-scoped.mjs"), current = join(home, "new-scoped.mjs"), sentinel = join(home, "forbidden-old.txt");
  writeFileSync(old, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)},'forbidden');\n`);
  writeFileSync(current, 'console.log("NEW_SCOPED_MARKER");\n'); let requests = 0;
  const result = await runTurn([], "Do not run old-scoped.mjs; run new-scoped.mjs without editing.", () => {}, AbortSignal.timeout(15000), {
    tools: tools("host_run", "host_file_write"), complete: async () => {
      requests++;
      if (requests === 1) return reply("", [call("host_run", { command: `node '${old}'` })]);
      if (requests === 2) return reply("", [call("host_run", { command: `node '${current}'` })]);
      return reply("Only the requested new script ran and printed NEW_SCOPED_MARKER.");
    },
  });
  assert.equal(requests, 3); assert.throws(() => readFileSync(sentinel)); assert.match(result.assistant, /NEW_SCOPED_MARKER/);
});

test("later execute-only steering narrows an edit task and binds fresh human execution scope", async () => {
  const script = join(home, "later-execution.mjs"); writeFileSync(script, 'console.log("LATER_EXECUTION");\n');
  const target = join(home, "not-edited.mjs"); let requests = 0, batch = null;
  const result = await runTurn([], "Fix not-edited.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_run", "host_file_write"), takeInput: () => batch, ackInput: () => { batch = null; },
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests === 1) { batch = { receipt: "execute", messages: [{ content: "Stop editing; run later-execution.mjs without editing." }] }; return reply("", [call("host_file_write", { path: target, content: "stale" })]); }
      assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
      if (requests === 2) return reply("", [call("host_run", { command: `node '${script}'` })]);
      return reply("The requested script printed LATER_EXECUTION.");
    },
  });
  assert.equal(requests, 3); assert.throws(() => readFileSync(target)); assert.match(result.assistant, /LATER_EXECUTION/);
});

test("read-only dispatch blocks a positional hostname setter before the process boundary", async () => {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const spawn = childProcess.spawn, execFileSync = childProcess.execFileSync;
  let transports = 0, approvals = 0, requests = 0;
  const denySetter = (original) => (...args) => {
    if (args.flat().some(value => typeof value === "string" && /hostname\s+collar-review-fixture/.test(value))) {
      transports++; throw Error("Forbidden setter transport in fixture");
    }
    return original(...args);
  };
  childProcess.spawn = denySetter(spawn); childProcess.execFileSync = denySetter(execFileSync); syncBuiltinESMExports();
  setApprovalNotifier(event => { if (event.type === "approval") { approvals++; resolveApproval(event.request.id, false); } });
  try {
    const result = await runTurn([], "Read-only: review the current setup.", () => {}, null, {
      tools: tools("host_run"), complete: async () => ++requests === 1
        ? reply("", [call("host_run", { command: "hostname collar-review-fixture" })]) : reply("The setter was not run.") });
    assert.equal(requests, 2); assert.equal(transports, 0); assert.equal(approvals, 0); assert.match(result.assistant, /not run/);
  } finally {
    childProcess.spawn = spawn; childProcess.execFileSync = execFileSync; syncBuiltinESMExports();
    setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
  }
});

for (const steering of ["Stop editing; review only.", "Stop editing and review the proposed fix.", "Please stop editing and just review the current patch."]) {
  test(`new human review-only steering supersedes pending and subsequent mutations: ${steering}`, async () => {
    const target = join(home, `steer-${Math.random().toString(16).slice(2)}.mjs`);
    let requests = 0, batch = null, writes = 0;
    const result = await runTurn([], `Fix ${target}.`, event => { if (event.type === "tool_result" && event.name === "host_file_write" && event.ok) writes++; }, AbortSignal.timeout(15000), {
      sessionId: createSession().id, tools: tools("host_file_write"),
      takeInput: () => batch, ackInput: () => { batch = null; },
      complete: async (messages, _cfg, _delta, _signal, options) => {
        requests++;
        if (requests === 1) { batch = { receipt: "stage", messages: [{ content: steering }] }; return reply("", [call("host_file_write", { path: target, content: "export const stale = true;\n" }, "stale")]); }
        assert.notEqual(options.toolChoice, "required"); assert.equal(options.maxVisibleChars, undefined);
        assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
        if (requests === 2) return reply("", [call("host_file_write", { path: target, content: "export const forbidden = true;\n" }, "forbidden")]);
        assert(messages.find(row => row.role === "tool" && row.tool_call_id === "stale").content.includes("Not executed"));
        assert(messages.find(row => row.role === "tool" && row.tool_call_id === "forbidden").content.includes("review-only"));
        return reply("Review only: no edits were made.");
      },
    });
    assert.equal(requests, 3); assert.equal(writes, 0); assert.match(result.assistant, /Review only/);
  });
}

test("neutral additive steering preserves implementation intent while replanning stale actions", async () => {
  const target = join(home, "neutral.mjs"); let requests = 0, batch = null;
  await runTurn([], "Fix neutral.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_file_write"), takeInput: () => batch, ackInput: () => { batch = null; },
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if (requests === 1) { batch = { receipt: "neutral", messages: [{ content: "Keep comments brief and preserve whitespace." }] }; return reply("", [call("host_file_write", { path: target, content: "stale" })]); }
      if (requests === 2) { assert.equal(options.toolChoice, "required"); return reply("", [call("host_file_write", { path: target, content: "export const current = true;\n" })]); }
      return reply("The helper was updated and checked.");
    },
  });
  assert.equal(requests, 4); assert.match(readFileSync(target, "utf8"), /current/);
});

test("an actual question answer can narrow the active implementation to review-only", async () => {
  const file = join(home, "question-stage.mjs"); let requests = 0;
  const result = await runTurn([], "Fix question-stage.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_file_write"),
    askUser: async () => ({ status: "answered", requestId: "human-stage", answers: [{ id: "stage", answer: "Stop editing and review the proposed fix." }] }),
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests === 1) return reply("", [call("ask_user", { questions: [{ id: "stage", question: "Which stage should I use?" }] }, "question"), call("host_file_write", { path: file, content: "stale" }, "stale-question-edit")]);
      assert.notEqual(options.toolChoice, "required"); assert(!options.tools.some(tool => tool.function.name === "host_file_write"));
      if (requests === 2) return reply("", [call("host_file_write", { path: file, content: "forbidden" }, "late-question-edit")]);
      return reply("Review only; no edits were made.");
    },
  });
  assert.equal(requests, 3); assert.throws(() => readFileSync(file)); assert.match(result.assistant, /Review only/);
});

test("review-only steering between tool calls stops remaining edits and retains a real failed check", async () => {
  const broken = join(home, "stopped.mjs"), forbidden = join(home, "after-stop.mjs");
  let requests = 0, batch = null;
  const result = await runTurn([], "Fix stopped.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_file_write"), takeInput: () => batch, ackInput: () => { batch = null; },
    onProgress: (_rows, action) => { if (action?.name === "host_file_write") batch = { receipt: "stop", messages: [{ content: "Stop editing; review only." }] }; },
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests === 1) return reply("", [call("host_file_write", { path: broken, content: 'throw new Error("fixture runtime failure");\n' }, "first"), call("host_file_write", { path: forbidden, content: "export const forbidden = true;\n" }, "second")]);
      assert.notEqual(options.toolChoice, "required");
      return reply("The recorded runtime check failed. I am reviewing it without further edits.");
    },
  });
  assert.equal(requests, 2); assert.match(result.assistant, /runtime check failed/);
  assert(result.messages.find(row => row.tool_call_id === "second")?.content.includes("Not executed"));
  assert.throws(() => readFileSync(forbidden));
  assert.match(readFileSync(broken, "utf8"), /fixture runtime failure/);
});

test("real source progress continues past the initial cap and Stop prevents the next edit", async () => {
  const target = join(home, "counter.mjs"); let requests = 0;
  const result = await runTurn([], "Implement the counter utility in counter.mjs.", () => {}, AbortSignal.timeout(20000), {
    sessionId: createSession().id, tools: tools("host_file_write"), allow: true,
    complete: async (_messages, _cfg, _delta, _signal, options) => { requests++; const advisory = advisoryReply(options); if (advisory) return advisory; return requests <= 10 ? reply("", [call("host_file_write", { path: target, content: `export const counter = ${requests};\n` }, `write-${requests}`)]) : reply("The counter is updated and checked."); },
  });
  assert.equal(requests, 12); assert.match(readFileSync(target, "utf8"), /counter = 10/); assert.match(result.assistant, /counter/);
  const controller = new AbortController(); requests = 0;
  await assert.rejects(runTurn([], "Update the counter utility in counter.mjs.", () => {}, controller.signal, {
    sessionId: createSession().id, tools: tools("host_file_write"), allow: true,
    complete: async () => { requests++; if (requests === 9) controller.abort(); return reply("", [call("host_file_write", { path: target, content: `export const counter = ${100 + requests};\n` })]); },
  }), { name: "AbortError" });
  assert.equal(requests, 9); assert.match(readFileSync(target, "utf8"), /counter = 108/);
});

test("different read calls do not extend work and the final closeout has a concise output reserve", async () => {
  const source = join(home, "observation.txt"); writeFileSync(source, "fixture observation\n"); let requests = 0;
  await runTurn([], "Inspect these observations.", () => {}, null, {
    sessionId: createSession().id, tools: tools("host_file_read"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests <= 8) return reply("", [call("host_file_read", { path: source, observation: requests }, `read-${requests}`)]);
      assert.equal(options.predict, undefined, "a review/explanation retains its normal answer budget"); assert.deepEqual(options.tools, []); return reply("The observation was read.");
    },
  });
  assert.equal(requests, 9);
});

test("the same verification command can run after each real edit, including its third invocation", async () => {
  const file = join(home, "verified.mjs"), command = `node '${file}'`; let requests = 0;
  const events = [];
  await runTurn([], "Implement the utility in verified.mjs and check each revision.", event => events.push(event), AbortSignal.timeout(20000), {
    sessionId: createSession().id, tools: tools("host_file_write", "host_run"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if (requests <= 8) return requests % 2
        ? reply("", [call("host_file_write", { path: file, content: `export const revision = ${requests};\n` }, `edit-${requests}`)])
        : reply("", [call("host_run", { command }, `check-${requests}`)]);
      return reply("Four source revisions were checked.");
    },
  });
  assert.equal(requests, 10);
  assert.equal(events.filter(row => row.type === "tool_result" && row.name === "host_run" && row.ok).length, 4);
});

test("an unavailable project profile stays informational in actual agent completion", async () => {
  const project = join(home, "no-profile"); mkdirSync(project);
  writeFileSync(join(project, "pyproject.toml"), '[project]\nname="fixture"\n');
  const file = join(project, "utility.mjs"); setWorkdir(project);
  let requests = 0; const events = [];
  try {
    const result = await runTurn([], "Implement utility.mjs.", event => events.push(event), AbortSignal.timeout(15000), {
      sessionId: createSession().id, tools: tools("host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
        requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
        return requests === 1 ? reply("", [call("host_file_write", { path: file, content: "export const utility = true;\n" })])
          : reply("The utility was updated and syntax checked. No project check profile is configured.");
      },
    });
    assert.equal(requests, 3); assert(!/^FAIL\b/.test(result.assistant));
    assert(events.some(row => row.type === "tool_result" && row.skipped && row.unavailable && row.verification?.status === "unavailable"));
    assert(!events.some(row => row.type === "tool_result" && row.verification?.phase === "project" && row.verification?.status === "passed"));
  } finally { setWorkdir(home); }
});

test("natural summary prose after edits is bounded and an empty capped closeout reports receipts without inventing completion", async () => {
  const target = join(home, "summary.mjs"); let requests = 0;
  const result = await runTurn([], "Implement the helper in summary.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: tools("host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      assert.equal(options.maxVisibleChars, ACTION_TEXT_LIMIT, "post-edit natural prose is guarded too");
      if (requests === 1) return reply("", [call("host_file_write", { path: target, content: "export const summary = true;\n" })]);
      if (requests <= 3) return { ...reply("A long narrative prefix that has not completed."), content_limited: true };
      assert.equal(options.predict, CLOSEOUT_TOKENS); assert.deepEqual(options.tools, []); return reply("");
    },
  });
  assert.equal(requests, 5); assert.match(result.assistant, /Saved summary\.mjs/);
  assert.match(result.assistant, /verification passed/); assert.match(result.assistant, /completion was not confirmed/);
  assert(!/^PASS\b/.test(result.assistant));
  const unavailable = observedImplementationResult([{ wrote: true, filePath: "/tmp/example.mjs", passed: false, informational: true, verification: { status: "skipped", phase: "project" } }]);
  assert.match(unavailable, /not established/); assert(!unavailable.includes("project verification passed"));
});

const target = { url: "http://127.0.0.1:19001/v1", model: "fixture-policy-model", key: "fixture", local: true };
const streamOptions = { target, tools: tools("host_file_write"), toolChoice: "required", maxVisibleChars: 100, timeoutMs: 2000 };
writeFileSync(join(home, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));

test("production stream bounds no-action prose and cancels without replay", async () => {
  let cancelled = false, requests = 0, shown = "";
  globalThis.fetch = async (_url, init) => {
    requests++; const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 8192); assert.equal(body.options.num_ctx, 131072); assert.equal(body.temperature, 0);
    assert.equal(body.think, true); assert.equal(body.chat_template_kwargs.enable_thinking, true); assert.equal(body.tool_choice, "required");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(data({ content: "prose ".repeat(1000) }))); }, cancel() { cancelled = true; } }));
  };
  const result = await complete([], { home }, text => { shown += text; }, null, streamOptions);
  assert.equal(result.content_limited, true); assert.equal(result.tool_calls.length, 0); assert.equal(result.content.length, 100);
  assert.equal(shown.length, 100); assert.equal(requests, 1); assert.equal(cancelled, true);
});

test("visible prose policy never cuts a complete function argument or changes its8192-token budget", async () => {
  const args = JSON.stringify({ path: "large.mjs", content: "export const payload = " + JSON.stringify("x".repeat(10000)) + ";\n" });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.max_tokens, 8192); assert.equal(body.options.num_predict, 8192);
    return new Response(data({ content: "Applying the requested edit." }) + data({ tool_calls: [{ index: 0, id: "large", type: "function", function: { name: "host_file_write", arguments: args.slice(0, 5000) } }] }) + data({ tool_calls: [{ index: 0, function: { arguments: args.slice(5000) } }] }) + "data: [DONE]\n\n");
  };
  const result = await complete([], { home }, null, null, streamOptions);
  assert.equal(result.content_limited, undefined); assert.equal(result.tool_calls[0].function.arguments, args);
});

test("production required-choice fallback is explicit and still bounds ignored-action prose", async () => {
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); requests++;
    if (requests === 1) { assert.equal(body.tool_choice, "required"); return new Response("unsupported tool_choice", { status: 400 }); }
    assert.equal(body.tool_choice, "auto"); assert.equal(body.max_tokens, 8192);
    return new Response(data({ content: "prose ".repeat(1000) }) + "data: [DONE]\n\n");
  };
  const result = await complete([], { home }, null, null, streamOptions);
  assert.equal(requests, 2); assert.equal(result.required_choice_fallback, true); assert.equal(result.content_limited, true);
});

test("only the explicit closeout request lowers the reply reserve while preserving context and reasoning", async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); assert.equal(body.max_tokens, CLOSEOUT_TOKENS);
    assert.equal(body.options.num_predict, CLOSEOUT_TOKENS); assert.equal(body.options.num_ctx, 131072);
    assert.equal(body.temperature, 0); assert.equal(body.think, true); assert.equal(body.chat_template_kwargs.enable_thinking, true);
    return new Response(data({ content: "Observed checks passed." }) + "data: [DONE]\n\n");
  };
  await complete([], { home }, null, null, { ...streamOptions, tools: [], toolChoice: "none", requestKind: "closeout", predict: CLOSEOUT_TOKENS });
});

test("production closeout reserve never raises an existing smaller profile budget", async () => {
  const file = join(home, "model-settings.json"), previous = readFileSync(file);
  try {
    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 512, temperature: 0, reasoning: true }] }));
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body); assert.equal(body.max_tokens, 512); assert.equal(body.options.num_predict, 512);
      assert.equal(body.options.num_ctx, 131072); assert.equal(body.temperature, 0); assert.equal(body.think, true);
      return new Response(data({ content: "A concise observed result." }) + "data: [DONE]\n\n");
    };
    await complete([], { home }, null, null, { ...streamOptions, tools: [], toolChoice: "none", requestKind: "closeout", predict: CLOSEOUT_TOKENS });
    await complete([], { home }, null, null, { ...streamOptions, tools: [], toolChoice: "none" });
  } finally { writeFileSync(file, previous); }
});

test("runTurn sends the selected profile's smaller budget to its real closeout path", async () => {
  const file = join(home, "model-settings.json"), previous = readFileSync(file);
  const selected = chatTarget(loadConfig()), destination = join(home, "small-budget.mjs"); let requests = 0;
  try {
    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ url: selected.url, model: selected.model, contextTokens: 131072, outputTokens: 512, temperature: 0, reasoning: true }] }));
    const result = await runTurn([], "Implement small-budget.mjs.", () => {}, AbortSignal.timeout(15000), {
      sessionId: createSession().id, tools: tools("host_file_write"), complete: async (_messages, _cfg, _delta, _signal, options) => {
        requests++; const advisory = advisoryReply(options); if (advisory) { assert.equal(options.predict, 512); return advisory; }
        if (requests === 1) return reply("", [call("host_file_write", { path: destination, content: "export const bounded = true;\n" })]);
        if (requests <= 3) return { ...reply("An unfinished lengthy narrative."), content_limited: true };
        assert.equal(options.requestKind, "closeout"); assert.equal(options.predict, 512); assert.deepEqual(options.tools, []);
        return reply("The helper was saved and locally checked.");
      },
    });
    assert.equal(requests, 5); assert.match(result.assistant, /saved/);
  } finally { writeFileSync(file, previous); }
});
