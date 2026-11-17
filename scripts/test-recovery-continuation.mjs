import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "collar-recovery-continuation-"));
process.env.NOVAPUP_HOME = join(root, "profile"); process.env.NP_LAYA_MODEL = join(root, "absent-model"); process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error("No native inference/network permitted."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome(); const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(e => { if (e.type === "approval") resolveApproval(e.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = nativeFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(t => ["host_file_read", "host_file_write", "host_file_edit", "host_run"].includes(t.function.name));
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const stream = (calls = [], content = "") => new Response((content ? frame({ choices: [{ delta: { content } }] }) : "")
  + frame({ choices: [{ delta: calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
const wrapped = async (messages, cfg, delta, signal, options) => options.requestKind === "contract_review"
  ? reply('{"findings":[],"limitations":["Advisory only."]}') : complete(messages, cfg, delta, signal, options);
const feedback = "<implementation_recovery_outcome>";
const ask = "Fix src/a.mjs. Scope: change only src/a.mjs. Keep src/b.mjs and check.mjs unchanged. Run node check.mjs to verify the saved behavior.";
function fixture(name) {
  const cwd = join(root, name); mkdirSync(cwd); mkdirSync(join(cwd, "src")); setWorkdir(cwd);
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n'); writeFileSync(join(cwd, "README.md"), "Permitted local context.\n");
  writeFileSync(join(cwd, "src/a.mjs"), "export const value = 1;\n"); writeFileSync(join(cwd, "src/b.mjs"), "export const value = 99;\n");
  writeFileSync(join(cwd, "check.mjs"), 'import assert from "node:assert/strict"; import {value} from "./src/a.mjs"; assert.equal(value,2); console.log("RECOVERED_OK");\n');
  return cwd;
}
const options = session => ({ sessionId: session.id, tools, sourcePreload: false });
const editA = (id = "legitimate-edit") => call("host_file_edit", { path: "src/a.mjs", edits: [{ oldText: "value = 1", newText: "value = 2" }] }, id);

for (const mismatch of ["read", "zero", "unknown", "wrong-path", "multi"]) test(`actual SSE ${mismatch} mismatch is discarded once before ordinary context, edit and real verification`, async () => {
  const cwd = fixture(mismatch), session = createSession(), events = [], bodies = []; let n = 0;
  const ledger = () => new VerificationLedger(session.id, cwd);
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body); bodies.push(body); n++;
    if (n === 1) return stream([call("host_file_read", { path: "src/a.mjs" }, "initial-read")]);
    if (n === 2) return stream([mismatch === "read" ? call("host_file_read", { path: "missing-context.md" }, "missing-context")
      : call("host_run", { command: "node check.mjs", cwd }, "known-failed-check")]);
    if (n === 3) {
      assert.equal(body.tool_choice?.function?.name, "host_file_edit");
      if (mismatch === "read") return stream([call("host_file_read", { path: "README.md" }, "rejected-read")]);
      if (mismatch === "zero") return stream([], "Need more context before an operation. ".repeat(90));
      if (mismatch === "unknown") return stream([call("not_a_permitted_tool", { path: "src/a.mjs" }, "rejected-unknown")]);
      if (mismatch === "wrong-path") return stream([call("host_file_edit", { path: "src/b.mjs", edits: [{ oldText: "value = 99", newText: "value = 0" }] }, "rejected-other")]);
      return stream([editA("rejected-edit"), call("host_file_write", { path: "unrequested.mjs", content: "NEVER_WRITE\n" }, "rejected-extra")]);
    }
    if (n === 4) {
      assert.equal(typeof body.tool_choice, "string"); assert(body.messages.some(m => m.role === "assistant" && String(m.content).includes(feedback)));
      assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), "export const value = 1;\n");
      assert.equal(readFileSync(join(cwd, "src/b.mjs"), "utf8"), "export const value = 99;\n"); assert(!existsSync(join(cwd, "unrequested.mjs")));
      assert(!events.some(e => e.type === "tool" && ["host_file_edit", "host_file_write", "not_a_permitted_tool"].includes(e.name)));
      assert(!events.some(e => e.verification?.status === "passed"));
      if (mismatch !== "read") assert(ledger().debt().length > 0, "rejection cannot erase the real failed check");
      const rejected = body.messages.filter(m => m.role === "tool" && String(m.tool_call_id).startsWith("rejected-"));
      if (mismatch !== "zero") { assert(rejected.length > 0); assert(rejected.every(m => m.content.startsWith("Not executed."))); }
      return stream([call("host_file_read", { path: "README.md" }, "ordinary-new-read")]);
    }
    if (n === 5) return stream([editA()]);
    if (n === 6) return stream([call("host_run", { command: "node check.mjs", cwd }, "real-check")]);
    return stream([], "Saved the requested file and observed RECOVERED_OK from the existing check. No project suite was declared.");
  };
  const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(15000), { ...options(session), complete: wrapped });
  assert.equal(n, 7); assert.equal(bodies.filter(b => typeof b.tool_choice === "object").length, 1); assert.deepEqual(bodies[2].tools, bodies[0].tools.filter(tool => tool.function.name === "host_file_edit"));
  assert.deepEqual(bodies[3].tools, bodies[0].tools, "ordinary recovery resumes with the original full ordered catalog");
  assert.equal(bodies[3].max_tokens, 8192); assert.equal(bodies[3].options.num_ctx, 131072);
  assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), "export const value = 2;\n"); assert.equal(readFileSync(join(cwd, "src/b.mjs"), "utf8"), "export const value = 99;\n"); assert(!existsSync(join(cwd, "unrequested.mjs")));
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_file_edit").length, 1); assert.deepEqual(ledger().debt(), []); assert.match(result.assistant, /RECOVERED_OK/);
});

test("missing-file named recovery also rejects a read without replay and returns to ordinary creation", async () => {
  const cwd = fixture("missing-file"), session = createSession(), events = []; let n = 0;
  writeFileSync(join(cwd, "check.mjs"), 'import assert from "node:assert/strict"; import {answer} from "./result.mjs"; assert.equal(answer(),2); console.log("NEW_RECOVERED_OK");\n');
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body); n++;
    if (n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]);
    if (n === 2) return stream([], "An implementation proposal without an operation. ".repeat(80));
    if (n === 3) { assert.equal(body.tool_choice?.function?.name, "host_file_write"); return stream([call("host_file_read", { path: "README.md" }, "rejected-read")]); }
    if (n === 4) { assert(!existsSync(join(cwd, "result.mjs"))); assert(body.messages.some(m => m.role === "assistant" && String(m.content).includes(feedback))); return stream([call("host_file_read", { path: "README.md" }, "ordinary-read")]); }
    if (n === 5) return stream([call("host_file_write", { path: "result.mjs", content: "export function answer(){return 2;}\n" })]);
    if (n === 6) return stream([call("host_run", { command: "node check.mjs", cwd })]);
    return stream([], "Saved result.mjs and observed NEW_RECOVERED_OK from the existing check.");
  };
  const result = await runTurn([], "Read src/a.mjs. Add result.mjs exporting answer(). Run node check.mjs to verify it. Keep check.mjs unchanged.", e => events.push(e), AbortSignal.timeout(15000), { ...options(session), complete: wrapped });
  assert.equal(n, 7); assert.equal(events.filter(e => e.type === "tool" && e.name === "host_file_write").length, 1); assert.match(result.assistant, /NEW_RECOVERED_OK/);
});

test("human review queued after rejection narrows the very next ordinary request", async () => {
  const cwd = fixture("review"), events = []; let n = 0, batch = null, queued = false;
  const result = await runTurn([], ask, e => { events.push(e); if (!queued && n === 3 && e.type === "retract") { queued = true; batch = { messages: [{ content: "Stop editing; review only." }] }; } }, AbortSignal.timeout(10000), {
    ...options(createSession()), takeInput: () => batch, ackInput: () => { batch = null; }, complete: async (messages, _c, _d, _s, opts) => {
      if (++n === 1) return reply("", [call("host_file_read", { path: "src/a.mjs" })]);
      if (n === 2) return reply("", [call("host_file_read", { path: "README.md" })]);
      if (n === 3) return reply("", [call("host_file_read", { path: "README.md" }, "rejected-read")]);
      assert(!opts.tools.some(t => ["host_file_write", "host_file_edit"].includes(t.function.name))); assert.equal(opts.toolChoice, "auto");
      assert.equal(messages.at(-1).content, "Stop editing; review only."); return reply("Reviewed without changing source or executing a check.");
    },
  });
  assert.equal(n, 4); assert.match(result.assistant, /Reviewed/); assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});

test("Stop after rejection prevents an ordinary continuation request", async () => {
  const cwd = fixture("stop"), stop = new AbortController(), events = []; let n = 0;
  await assert.rejects(runTurn([], ask, e => { events.push(e); if (n === 3 && e.type === "retract") stop.abort(); }, stop.signal, {
    ...options(createSession()), complete: async () => {
      if (++n === 1) return reply("", [call("host_file_read", { path: "src/a.mjs" })]);
      if (n === 2) return reply("", [call("host_file_read", { path: "README.md" })]);
      return reply("", [call("host_file_read", { path: "README.md" }, "rejected-read")]);
    },
  }), { name: "AbortError" });
  assert.equal(n, 3); assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});

test("last-round mismatch grants no extra tool round, progress extension or automatic retry", async () => {
  const cwd = fixture("no-room"), events = []; let n = 0, ordinary = 0, closeouts = 0, named = 0;
  for (let i = 1; i <= 6; i++) writeFileSync(join(cwd, `context-${i}.md`), `Local context ${i}.\n`);
  const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(10000), { ...options(createSession()), complete: async (_m, _c, _d, _s, opts) => {
    n++; if (opts.requestKind === "closeout") { closeouts++; assert.equal(opts.tools.length, 0); return reply("Incomplete. No source change or passing check was observed."); }
    ordinary++; if (ordinary <= 6) return reply("", [call("host_file_read", { path: `context-${ordinary}.md` }, `context-${ordinary}`)]);
    if (ordinary === 7) return reply("", [call("host_file_read", { path: "src/a.mjs" })]);
    assert.equal(ordinary, 8); assert.equal(opts.toolChoice?.function?.name, "host_file_edit"); named++;
    return reply("", [call("host_file_read", { path: "README.md" }, "rejected-last-read")]);
  } });
  assert.equal(ordinary, 8); assert.equal(closeouts, 1); assert.equal(n, 9); assert.equal(named, 1);
  assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit")); assert.match(result.assistant, /Incomplete|FAIL/);
});
