import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-action-debt-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No provider or network calls in this fixture."); };
const { ensureHome } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const { createHarness } = await import("../src/main/harness.js");
const { VerificationLedger, verificationSource } = await import("../src/main/verification-ledger.js");
const { projectSnapshot } = await import("../src/main/project-verification.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome();
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { setApprovalNotifier(null); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(row => ["host_file_read", "host_file_write", "host_run"].includes(row.function.name));
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function fixture(name) {
  const dir = join(root, name); mkdirSync(dir); setWorkdir(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "first.mjs"), "export const first = 1;\n");
  writeFileSync(join(dir, "second.mjs"), "export const second = 1;\n");
  for (let index = 0; index < 24; index++) writeFileSync(join(dir, `note-${index}.txt`), `observation ${index}`);
  return dir;
}
function sourceChecks() {
  return 'import assert from "node:assert/strict"; import {first} from "./first.mjs"; import {second} from "./second.mjs"; assert.equal(first,2); assert.equal(second,2); console.log("BEHAVIOR_OK");';
}
async function runEnforced(name, { declared = false, failing = false } = {}) {
  const dir = fixture(name), session = createSession(), events = [], counter = join(root, name + "-executions.txt");
  if (declared) {
    mkdirSync(join(dir, ".nova"));
    writeFileSync(join(dir, ".nova/checks.json"), JSON.stringify({ commands: ["node declared.mjs"] }));
    writeFileSync(join(dir, "declared.mjs"), `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)},"run\\n");\n${failing ? 'throw Error("genuine project assertion failed");' : sourceChecks()}\n`);
  }
  const steps = [
    [call("host_file_read", { path: join(dir, "first.mjs") }, "read-first"), call("host_file_read", { path: join(dir, "second.mjs") }, "read-second")],
    [call("host_file_write", { path: join(dir, "first.mjs"), content: "export const first = 2;\n" }, "write-first")],
    [call("host_file_write", { path: join(dir, "second.mjs"), content: "export const second = 2;\n" }, "write-second")],
  ];
  if (!declared) steps.push([call("host_run", { command: `node --input-type=module -e ${quote(sourceChecks())}`, cwd: dir }, "behavior")]);
  let requests = 0, advisoryRequests = 0, forcedAfterReady = 0, observations = 0;
  const result = await runTurn([], "Fix first.mjs and update second.mjs; verify both behaviors before reporting.", event => events.push(event), AbortSignal.timeout(20000), {
    sessionId: session.id, tools, complete: async (_messages, _cfg, _delta, _signal, options) => {
      if (options.requestKind === "contract_review") {
        advisoryRequests++;
        assert.equal(options.toolChoice, "none"); assert.deepEqual(options.tools, []);
        return reply('{"findings":[],"limitations":[]}');
      }
      requests++;
      if (requests <= steps.length) {
        assert.equal(existsSync(counter), false, "project checks must not eagerly run between partial file writes");
        return reply("", steps[requests - 1]);
      }
      // Enforce real required-choice semantics: a compliant model cannot return
      // a prose-only handoff in this mode. Distinct reads keep the fixture finite.
      if (options.toolChoice === "required") {
        forcedAfterReady++;
        return reply("", [call("host_file_read", { path: join(dir, `note-${observations++}.txt`) }, `forced-${observations}`)]);
      }
      return reply("Updated both modules and observed their behavior checks. Any unavailable project profile is a verification limitation.");
    },
  });
  return { dir, session, events, counter, result, requests, advisoryRequests, forcedAfterReady, steps: steps.length };
}

test("a compliant required-choice model can hand off after edits/manual checks with only pending absent-profile debt", async () => {
  const row = await runEnforced("no-profile");
  assert.equal(row.forcedAfterReady, 0, "pending harness-owned project settlement must not force unrelated tool calls");
  assert.equal(row.requests, row.steps + 1); assert.equal(row.advisoryRequests, 1);
  const ledger = new VerificationLedger(row.session.id, row.dir);
  assert.deepEqual(ledger.debt(), []);
  assert([...ledger.entries.values()].some(entry => entry.kind === "project" && entry.status === "unavailable" && entry.blocking === false));
  assert(!/^FAIL|^Incomplete/.test(row.result.assistant), row.result.assistant);
});

test("declared checks run once at the completion boundary, not after each read or partial write", async () => {
  const row = await runEnforced("declared", { declared: true });
  assert.equal(row.forcedAfterReady, 0); assert.equal(row.requests, row.steps + 1); assert.equal(row.advisoryRequests, 1);
  assert.equal(readFileSync(row.counter, "utf8"), "run\n");
  const ledger = new VerificationLedger(row.session.id, row.dir);
  assert.deepEqual(ledger.debt(), []);
  assert([...ledger.entries.values()].some(entry => entry.kind === "project" && entry.status === "passed"));
});

test("a genuine declared failure remains action debt and blocks success without repeated expensive checks", async () => {
  const row = await runEnforced("failed-project", { declared: true, failing: true });
  const ledger = new VerificationLedger(row.session.id, row.dir);
  assert(ledger.debt({ forAction: true }).some(entry => entry.includes("failed") && entry.includes("project")));
  assert.equal(readFileSync(row.counter, "utf8"), "run\n", "unchanged failing source is checked once");
  assert.match(row.result.assistant, /FAIL|Incomplete|Not proven/);
});

test("typed action debt excludes only pending projects, retaining files, commands, real project failure and ledger errors", () => {
  const dir = fixture("typed"), file = join(dir, "first.mjs"), ledger = new VerificationLedger("typed", dir);
  ledger.projectChanged(dir, projectSnapshot(dir).revision);
  assert.equal(ledger.debt().length, 1); assert.deepEqual(ledger.debt({ forAction: true }), []);
  ledger.changed(file);
  assert(ledger.debt({ forAction: true }).some(entry => entry.includes("first.mjs")), "pending test/source files remain actionable");
  ledger.checked(file, { ok: true, phase: "syntax", expectedHash: verificationSource(file).hash });
  ledger.commandChecked(dir, "node verify.mjs", { ok: false, testFailure: true });
  assert(ledger.debt({ forAction: true }).some(entry => entry.includes("test verification command")));
  ledger.projectChecked(dir, { ok: false, error: "actual declared failure" }, projectSnapshot(dir).revision);
  assert(ledger.debt({ forAction: true }).some(entry => entry.includes("project")));
  writeFileSync(ledger.file, "{broken ledger");
  const gate = createHarness({ sessionId: "typed", requireEdits: false });
  assert(gate.actionDebt().some(entry => entry.includes("Cannot restore verification ledger")));
  assert.equal(readFileSync(ledger.file, "utf8"), "{broken ledger");
});

test("protected file constraints and explicit output/API requirements remain action debt", () => {
  const dir = fixture("requirements"), protectedFile = join(dir, "settings.json");
  writeFileSync(protectedFile, '{"unchanged":true}\n');
  const gate = createHarness({ ask: "Fix first.mjs. Add api.mjs exporting dispatch(input). Run check.mjs and confirm it prints TOKEN_OK. Keep settings.json unchanged.", sessionId: "requirements" });
  writeFileSync(protectedFile, '{"changed":true}\n');
  const debt = gate.actionDebt();
  assert(debt.some(entry => entry.includes("protected file changed")));
  assert(debt.some(entry => entry.includes("api.mjs")));
  assert(debt.some(entry => entry.includes("TOKEN_OK")));
});

test("active writers are still blocking and never cause automatic project command execution", async () => {
  const dir = fixture("active-writer"); mkdirSync(join(dir, ".nova"));
  writeFileSync(join(dir, ".nova/checks.json"), JSON.stringify({ commands: ["must-not-run"] }));
  const ledger = new VerificationLedger("active-writer", dir); ledger.projectChanged(dir, projectSnapshot(dir).revision);
  let calls = 0;
  const gate = createHarness({ sessionId: "active-writer", requireEdits: false, trackProjects: true, hasActiveWriters: () => true,
    localExec: async () => { calls++; return { ok: true }; } });
  const proofs = await gate.checkProjects();
  assert.equal(calls, 0); assert.equal(proofs[0].ok, false);
  assert(gate.debt().length); assert(gate.actionDebt().length, "unverified writer skip must not be mistaken for pending settlement");
});
