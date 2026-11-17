import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-current-closeout-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No inference or network allowed."); };
const { ensureHome } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { projectSnapshot } = await import("../src/main/project-verification.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome();
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { setApprovalNotifier(null); globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); });
const definitions = windowToolDefs({ local: true, search: false, remote: false }).filter(row => ["host_file_read", "host_file_write", "host_run"].includes(row.function.name));
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });

// Auxiliary review traffic is explicit; these fixture totals include that one request.
const advisoryReply = options => options?.requestKind === "contract_review" ? { content: '{"findings":[],"limitations":[]}', tool_calls: [] } : null;
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function fixture(name, declared = "") {
  const dir = join(root, name); mkdirSync(dir); setWorkdir(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "feature.mjs"), "export const value = 1;\n");
  for (let i = 0; i < 24; i++) writeFileSync(join(dir, `note-${i}.txt`), `observation ${i}\n`);
  if (declared) {
    mkdirSync(join(dir, ".nova"));
    writeFileSync(join(dir, ".nova/checks.json"), JSON.stringify({ commands: ["node declared-check.cjs"] }));
    writeFileSync(join(dir, "declared-check.cjs"), declared);
  }
  return dir;
}
async function runScenario(name, { cap = true, finalError = false, concurrentChange = false, declared = "", selftest = false } = {}) {
  const dir = fixture(name, declared), session = createSession(), events = [];
  const commands = [
    ["host_file_read", { path: join(dir, "feature.mjs") }],
    ["host_file_write", { path: join(dir, "feature.mjs"), content: "export const value = 2;\n" }],
    ["host_file_write", { path: join(dir, "scratch.swift"), content: "let temporary = 42\n" }],
    ["host_run", { command: `node --input-type=module -e ${quote('import assert from "node:assert/strict"; import {value} from "./feature.mjs"; assert.equal(value,2); console.log("LOCAL_CHECKS_OK");')}`, cwd: dir }],
    ["host_run", { command: "rm scratch.swift", cwd: dir }],
  ];
  if (selftest) {
    writeFileSync(join(dir, "verify-engine"), '#!/bin/sh\nprintf "2 CHECK(S) FAILED\\n"\nexit 1\n');
    commands.push(["host_run", { command: "sh ./verify-engine", cwd: dir }]);
  }
  let requests = 0, readIndex = 0, finalRequests = 0, advisoryRequests = 0, observedCurrentProject = false;
  const result = await runTurn([], "Implement feature.mjs, validate its changed behavior, and clean up the temporary helper.", event => events.push(event), AbortSignal.timeout(25000), {
    sessionId: session.id, tools: definitions, complete: async (messages, _cfg, _delta, _signal, options) => {
      requests++;
      const advisory = advisoryReply(options); if (advisory) { advisoryRequests++; return advisory; }
      if (requests <= commands.length) { const [name, args] = commands[requests - 1]; return reply("", [call(name, args, `tool-${requests}`)]); }
      if (cap && options.tools?.length) return reply("", [call("host_file_read", { path: join(dir, `note-${readIndex++}.txt`) }, `read-${readIndex}`)]);
      finalRequests++;
      observedCurrentProject = messages.some(row => typeof row.content === "string" && row.content.includes('"status":"unavailable"'));
      if (concurrentChange) writeFileSync(join(dir, "note-23.txt"), "changed during final model response\n");
      if (finalError) throw Error("fixture final provider unavailable");
      return reply("Updated feature.mjs; the manual behavior assertions passed. No declared project test suite was available.");
    },
  });
  return { dir, session, events, result, requests, finalRequests, advisoryRequests, observedCurrentProject };
}
function assertHonestCurrent({ dir, session, events, result }) {
  assert.equal(readFileSync(join(dir, "feature.mjs"), "utf8"), "export const value = 2;\n");
  assert.equal(existsSync(join(dir, "scratch.swift")), false);
  assert(events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok && row.detail?.includes("LOCAL_CHECKS_OK")));
  assert(!/FAIL\..*pending.*project/i.test(result.assistant), result.assistant);
  assert(!result.assistant.includes("pending project"), result.assistant);
  const ledger = new VerificationLedger(session.id, dir), project = [...ledger.entries.values()].find(row => row.kind === "project");
  assert.equal(project.status, "unavailable"); assert.equal(project.blocking, false); assert.equal(project.skipped, true);
  assert.equal(project.hash, projectSnapshot(dir).revision);
  assert.deepEqual(ledger.debt(), []);
}

test("normal no-tool closeout reports current manual checks and unavailable profile after helper cleanup", async () => {
  const row = await runScenario("normal", { cap: false });
  assertHonestCurrent(row); assert.equal(row.finalRequests, 1); assert.equal(row.advisoryRequests, 1);
  assert.match(row.result.assistant, /manual behavior assertions passed/);
});

test("cap closeout settles project availability before final prompt and debt-based handoff", async () => {
  const row = await runScenario("cap");
  assertHonestCurrent(row); assert.equal(row.finalRequests, 1); assert.equal(row.advisoryRequests, 1);
  assert.equal(row.observedCurrentProject, true, "final request must receive current unavailable observation");
  assert.match(row.result.assistant, /manual behavior assertions passed/);
});

test("current project revision is rechecked after a concurrent change during final response", async () => {
  const row = await runScenario("concurrent", { concurrentChange: true });
  assertHonestCurrent(row);
});

test("provider error fallback reports current evidence without obsolete pending project debt", async () => {
  const row = await runScenario("provider-error", { finalError: true });
  assertHonestCurrent(row); assert.match(row.result.assistant, /Full task completion was not confirmed/);
});

test("a real declared project failure remains blocking despite successful ad-hoc assertions", async () => {
  const row = await runScenario("declared-failure", { declared: 'throw Error("declared behavior regression");\n' });
  const ledger = new VerificationLedger(row.session.id, row.dir);
  assert(ledger.debt().some(item => item.includes("project")));
  assert([...ledger.entries.values()].some(item => item.kind === "project" && item.status === "failed"));
  assert.match(row.result.assistant, /FAIL|Incomplete/);
});

test("a real selftest failure remains open when unknown project availability settles", async () => {
  const row = await runScenario("selftest-failure", { selftest: true });
  assert(new VerificationLedger(row.session.id, row.dir).debt().some(item => item.includes("test verification command")));
  assert.match(row.result.assistant, /FAIL|Incomplete/);
});

test("later review-only steering never runs project commands and preserves prior real failure", async () => {
  const dir = fixture("review-only", 'require("node:fs").writeFileSync("UNAUTHORIZED", "ran");\n');
  const session = createSession(), ledger = new VerificationLedger(session.id, dir);
  ledger.projectChecked(dir, { ok: false, error: "previous real project failure" }, projectSnapshot(dir).revision);
  let requests = 0, batch = null;
  const result = await runTurn([], "Implement feature.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: session.id, tools: definitions, takeInput: () => batch, ackInput: () => { batch = null; }, complete: async () => {
      requests++;
      if (requests === 1) return reply("", [call("host_file_read", { path: join(dir, "feature.mjs") }, "read")]);
      if (requests === 2) return reply("", [call("host_file_write", { path: join(dir, "feature.mjs"), content: "export const value = 2;\n" }, "write")]);
      if (requests === 3) batch = { receipt: "review-only", messages: [{ content: "Stop editing; review only." }] };
      return reply("Reviewed the current evidence; the previous project failure remains unresolved.");
    },
  });
  assert.equal(existsSync(join(dir, "UNAUTHORIZED")), false);
  assert(new VerificationLedger(session.id, dir).debt().some(item => item.includes("project")));
  assert(!/^PASS\b/.test(result.assistant));
});
