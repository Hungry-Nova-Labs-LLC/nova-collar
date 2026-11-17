import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = realpathSync(mkdtempSync(join(tmpdir(), "collar-possible-helper-")));
process.env.NOVAPUP_HOME = join(root, "profile"); process.env.NP_LAYA_MODEL = join(root, "absent-model"); process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error("No native inference/network allowed."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { createSession } = await import("../src/main/sessions.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { authoredAssertionSource } = await import("../src/main/authored-checks.js");
ensureHome(); const target = chatTarget(loadConfig()); writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(e => { if (e.type === "approval") resolveApproval(e.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = savedFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, remote: false, search: false }).filter(t => ["host_file_read", "host_file_write", "host_file_edit", "host_run"].includes(t.function.name));
const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const call = (name, args, id) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const stream = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
const driver = 'import { value } from "./src/library.mjs";\nlet failures = 0;\nconst eq = (got: unknown, want: unknown): void => { if (JSON.stringify(got) !== JSON.stringify(want)) { failures++; } };\neq(value, 1); eq(2, 2);\nprocess.exit(failures === 0 ? 0 : 1);\n';
function project(name) { const cwd = join(root, name); mkdirSync(cwd); mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n'); writeFileSync(join(cwd, "src/library.mjs"), 'export const value = 0;\n'); setWorkdir(cwd); return cwd; }
const wrapped = (messages, cfg, delta, signal, options) => options.requestKind === "contract_review"
  ? Promise.resolve({ content: '{"findings":[],"limitations":["Advisory only."]}', tool_calls: [] }) : complete(messages, cfg, delta, signal, options);

test("actual saved custom-arrow helper reaches the next SSE request only as conditional unexecuted-source advice", async () => {
  const cwd = project("custom-driver"), events = []; let n = 0, found = false;
  assert.equal(authoredAssertionSource("verify.ts", driver), false);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); n++; assert.equal(body.max_tokens, 8192); assert.equal(body.options.num_ctx, 131072);
    if (n === 1) return stream({ tool_calls: [call("host_file_read", { path: "src/library.mjs" }, "read")] });
    if (n === 2) return stream({ tool_calls: [call("host_file_edit", { path: "src/library.mjs", edits: [{ oldText: "value = 0", newText: "value = 1" }] }, "edit")] });
    if (n === 3) return stream({ tool_calls: [call("host_file_write", { path: "verify.ts", content: driver }, "helper")] });
    const receipt = body.messages.find(row => row.role === "tool" && row.tool_call_id === "helper"); assert(receipt);
    assert.match(receipt.content, /possible_saved_verification_helper/); found = true;
    assert.match(receipt.content, /If it is intended for verification and the current user scope permits/);
    assert.match(receipt.content, /Saving or syntax parsing does not establish execution/);
    assert(!receipt.content.includes("contains authored assertions"), "the weak cue must not upgrade the existing strong classifier");
    assert(!body.messages.some(row => row.role === "user" && String(row.content).includes("possible_saved_verification_helper")));
    return stream({ content: "Incomplete. Saved the requested library change and a possible helper. The helper was parsed but execution was not established; no behavioral verification pass is claimed." });
  };
  const result = await runTurn([], "Fix src/library.mjs by exporting value 1, preserving the existing interface.", e => events.push(e), AbortSignal.timeout(15000), { sessionId: createSession().id, tools, sourcePreload: false, complete: wrapped });
  assert(found); assert(n >= 4 && n <= 5); assert.equal(readFileSync(join(cwd, "verify.ts"), "utf8"), driver);
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_run").length, 0);
  assert.equal(events.filter(e => e.type === "source_advisory" && e.kind === "possible_verification_helper").length, 1);
  assert(!events.some(e => e.verification?.status === "passed" && ["runtime", "test", "project"].includes(e.verification.phase)));
  assert.match(result.assistant, /Incomplete|not established/);
});

test("current review-only human steering prevents a buffered helper write and any new cue or execution", async () => {
  const cwd = project("review"), events = []; let n = 0, batch = null;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); n++;
    if (n === 1) { batch = { messages: [{ content: "Stop editing; review only. Do not run programs." }] }; return stream({ tool_calls: [call("host_file_write", { path: "verify.ts", content: driver }, "blocked-helper")] }); }
    assert(!body.tools.some(t => ["host_file_write", "host_file_edit"].includes(t.function.name)));
    assert(!body.messages.some(row => String(row.content).includes("possible_saved_verification_helper")));
    return stream({ content: "Reviewed only. No helper was saved and no program was executed." });
  };
  await runTurn([], "Fix src/library.mjs.", e => events.push(e), AbortSignal.timeout(10000), { sessionId: createSession().id, tools, sourcePreload: false, complete: wrapped, takeInput: () => batch, ackInput: () => { batch = null; } });
  assert(!existsSync(join(cwd, "verify.ts"))); assert(!events.some(e => e.type === "source_advisory" && e.kind === "possible_verification_helper"));
  assert(!events.some(e => e.type === "tool" && ["host_file_write", "host_file_edit", "host_run"].includes(e.name)));
});
