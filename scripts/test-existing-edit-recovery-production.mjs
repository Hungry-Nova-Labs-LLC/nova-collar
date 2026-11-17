import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "collar-existing-edit-"));
process.env.NOVAPUP_HOME = join(root, "profile"); process.env.NP_LAYA_MODEL = join(root, "absent-model"); process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const savedFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error("No native inference/network permitted."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome(); const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = savedFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(tool => ["host_file_read", "host_file_write", "host_file_edit", "host_run"].includes(tool.function.name));
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
function stream(calls = [], content = "") {
  return new Response((content ? frame({ choices: [{ delta: { content } }] }) : "")
    + frame({ choices: [{ delta: { ...(calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
}
function fixture(name) {
  const dir = join(root, name); mkdirSync(dir); mkdirSync(join(dir, "src")); setWorkdir(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n'); writeFileSync(join(dir, "README.md"), "Fixture context.\n");
  writeFileSync(join(dir, "src/a.mjs"), "export const value = 1;\n"); writeFileSync(join(dir, "src/b.mjs"), "export const value = 2;\n"); return dir;
}
const ask = "Fix the implementation. Scope: change only src/a.mjs, src/b.mjs. Do not modify README.md. Verify the saved behavior locally.";
const opts = () => ({ sessionId: createSession().id, tools, sourcePreload: false });
const wrapped = inspect => async (messages, cfg, delta, signal, options) => {
  if (options.requestKind === "contract_review") return reply('{"findings":[],"limitations":["Advisory only."]}');
  inspect?.(options); return complete(messages, cfg, delta, signal, options);
};

for (const preloaded of [false, true]) test(`real SSE ${preloaded ? "canonical preloaded" : "actual model-read with unknown privacy ban"} source bridge preserves two-file scope and the full implementation budget`, async () => {
  const dir = fixture(preloaded ? "compound-preloaded" : "compound-model-read"), events = [], bodies = [], policies = []; let n = 0;
  const namedRound = preloaded ? 2 : 3;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body); n++;
    if (n === 1) {
      assert.equal(body.messages.some(m => String(m.content).includes("<initial_source_reads>")), preloaded);
      if (!preloaded) return stream([call("host_file_read", { path: "src/a.mjs" }, "a"), call("host_file_read", { path: "src/b.mjs" }, "b")]);
    }
    if (n === namedRound - 1) return stream([call("host_file_read", { path: "README.md" })]);
    if (n === namedRound) { assert.equal(body.tool_choice?.function?.name, "host_file_edit"); return stream([call("host_file_edit", { path: "src/a.mjs", edits: [{ oldText: "value = 1", newText: "value = 4" }] })], "preliminary prose ".repeat(200)); }
    if (n === namedRound + 1) { assert.equal(body.tool_choice, "required"); return stream([call("host_file_edit", { path: "src/b.mjs", edits: [{ oldText: "value = 2", newText: "value = 5" }] })]); }
    if (n === namedRound + 2) return stream([call("host_run", { command: `node --input-type=module -e 'import assert from "node:assert/strict"; import {value as a} from "./src/a.mjs"; import {value as b} from "./src/b.mjs"; assert.equal(a,4); assert.equal(b,5); console.log("BOTH_OK")'`, cwd: dir })]);
    return stream([], "Saved both requested files and observed BOTH_OK from executable assertions. No project suite was declared.");
  };
  const scopedAsk = (preloaded ? "" : "Do not inspect hidden reference material or private profiles. ") + ask;
  const result = await runTurn([], scopedAsk, e => events.push(e), AbortSignal.timeout(15000), { ...opts(), sourcePreload: true, complete: wrapped(o => policies.push(o.maxVisibleChars)) });
  assert.equal(n, namedRound + 3); assert.equal(policies[0], 2400); assert.equal(policies[namedRound - 1], undefined); assert.equal(policies[namedRound], 2400);
  assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 4;\n"); assert.equal(readFileSync(join(dir, "src/b.mjs"), "utf8"), "export const value = 5;\n");
  assert.equal(bodies[namedRound - 1].max_tokens, 8192); assert.equal(bodies[namedRound - 1].options.num_ctx, 131072); assert.deepEqual(bodies[namedRound - 1].tools, bodies[0].tools.filter(tool => tool.function.name === "host_file_edit"));
  assert.deepEqual(bodies[namedRound].tools, bodies[0].tools, "the ordinary next request restores the full ordered catalog");
  assert.equal(bodies.filter(b => b.tool_choice?.function?.name === "host_file_edit").length, 1);
  assert(events.some(e => e.type === "tool_result" && e.name === "host_run" && e.ok && e.detail.includes("BOTH_OK"))); assert.match(result.assistant, /BOTH_OK/);
});

test("real SSE missing-file named recovery retains its full draft opportunity before a structured write", async () => {
  const dir = fixture("new-file"), policies = []; let n = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); n++;
    if (n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]);
    if (n === 2) return stream([], "ordinary implementation prose ".repeat(150));
    if (n === 3) { assert.equal(body.tool_choice.function.name, "host_file_write"); assert.equal(body.max_tokens, 8192); return stream([call("host_file_write", { path: "result.mjs", content: "export function answer(){ return 7; }\n" })], "preliminary prose ".repeat(200)); }
    if (n === 4) return stream([call("host_run", { command: `node --input-type=module -e 'import assert from "node:assert/strict"; import {answer} from "./result.mjs"; assert.equal(answer(),7); console.log("NEW_OK")'`, cwd: dir })]);
    return stream([], "Saved result.mjs and observed NEW_OK. No declared project suite was available.");
  };
  const result = await runTurn([], "Read src/a.mjs. Add result.mjs exporting answer(). Verify it locally.", () => {}, AbortSignal.timeout(15000), { ...opts(), complete: wrapped(o => policies.push(o.maxVisibleChars)) });
  assert.equal(n, 5, result.assistant); assert.equal(policies[1], 2400); assert.equal(policies[2], undefined); assert.equal(readFileSync(join(dir, "result.mjs"), "utf8"), "export function answer(){ return 7; }\n"); assert.match(result.assistant, /NEW_OK/);
});

test("full prose-only named response is not copied to a file and later no-action replies remain bounded", async () => {
  const dir = fixture("prose-only"), events = []; let n = 0;
  globalThis.fetch = async () => { if (++n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]); if (n === 2) return stream([call("host_file_read", { path: "README.md" })]); return stream([], n === 3 ? "still prose without an operation ".repeat(180) : "No implementation was performed after the rejected response."); };
  const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(10000), { ...opts(), complete: wrapped() });
  assert(n > 3 && n <= 8); assert.match(result.assistant, /Incomplete/); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});

test("wrong-path and multi-call named edit batches dispatch no operation", async () => {
  for (const multi of [false, true]) {
    const dir = fixture(multi ? "multi" : "wrong"), events = []; let n = 0;
    globalThis.fetch = async () => { if (++n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]); if (n === 2) return stream([call("host_file_read", { path: "README.md" })]); if(n>3)return stream([],"No implementation was performed after the rejected response."); const calls = [call("host_file_edit", { path: multi ? "src/a.mjs" : "src/b.mjs", edits: [{ oldText: "value = 1", newText: "value = 9" }] }, "first")]; if (multi) calls.push(call("host_file_write", { path: "unrequested.mjs", content: "bad" }, "extra")); return stream(calls); };
    const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(10000), { ...opts(), complete: wrapped() });
    assert(n>3&&n<=8); assert.match(result.assistant, /Incomplete/); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!existsSync(join(dir, "unrequested.mjs"))); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
  }
});

test("human review arriving during a named response invalidates the operation before dispatch", async () => {
  const dir = fixture("review"), events = []; let n = 0, batch = null;
  const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(10000), { ...opts(), takeInput: () => batch, ackInput: () => { batch = null; }, complete: async (_m, _c, _d, _s, options) => {
    if (++n === 1) return reply("", [call("host_file_read", { path: "src/a.mjs" })]);
    if (n === 2) return reply("", [call("host_file_read", { path: "README.md" })]);
    if (n === 3) { assert.equal(options.toolChoice.function.name, "host_file_edit"); batch = { messages: [{ content: "Stop editing; review only." }] }; return reply("", [call("host_file_edit", { path: "src/a.mjs", edits: [{ oldText: "value = 1", newText: "value = 9" }] })]); }
    assert(!options.tools.some(t => t.function.name === "host_file_edit")); return reply("Reviewed without changing source.");
  } });
  assert.equal(n, 4); assert.match(result.assistant, /Reviewed/); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});

test("Stop during the long named response preserves sources and starts no recovery request", async () => {
  const dir = fixture("stop"), events = [], stop = new AbortController(); let n = 0;
  globalThis.fetch = async () => { if (++n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]); if (n === 2) return stream([call("host_file_read", { path: "README.md" })]); return stream([call("host_file_edit", { path: "src/a.mjs", edits: [{ oldText: "value = 1", newText: "value = 9" }] })], "long preliminary prose ".repeat(200)); };
  await assert.rejects(runTurn([], ask, e => { events.push(e); if (n === 3 && e.type === "delta") stop.abort(); }, stop.signal, { ...opts(), complete: wrapped() }), { name: "AbortError" });
  assert.equal(n, 3); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});

test("a requested page or model-packing truncation is not a complete source observation", async () => {
  for (const packing of [false, true]) {
    const dir = fixture(packing ? "packed-partial" : "requested-page"), events = []; let n = 0, named = 0;
    const original = (packing ? "// source visibility filler\n".repeat(1000) : "") + "export const value = 1;\n";
    writeFileSync(join(dir, "src/a.mjs"), original);
    const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(10000), { ...opts(), complete: async (messages, _c, _d, _s, options) => {
      if (typeof options.toolChoice === "object") named++;
      if (++n === 1) return reply("", [call("host_file_read", { path: "src/a.mjs", ...(packing ? {} : { offset: 0, limit: 1 }) }, "partial-read")]);
      if (n === 2) { assert.equal(JSON.parse(messages.find(row => row.tool_call_id === "partial-read").content).read.completeFile, false); return reply("", [call("host_file_read", { path: "README.md" })]); }
      return reply("No implementation was saved.");
    } });
    assert.equal(named, 0); assert.match(result.assistant, /Incomplete/); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), original);
  }
});

test("protected basename alias is excluded before the optional edit hint", async () => {
  const dir = fixture("protected-alias"); let n = 0, named = 0;
  const result = await runTurn([], "Fix src/a.mjs. Keep a.mjs unchanged.", () => {}, AbortSignal.timeout(10000), { ...opts(), complete: async (_m, _c, _d, _s, options) => {
    if (typeof options.toolChoice === "object") named++;
    if (++n === 1) return reply("", [call("host_file_read", { path: "src/a.mjs" })]);
    if (n === 2) return reply("", [call("host_file_read", { path: "README.md" })]);
    return reply("The conflicting protection remains authoritative; no source change was made.");
  } });
  assert.equal(named, 0); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n"); assert.match(result.assistant, /Incomplete/);
});

test("hard handoff discards a buffered named edit without replaying model generation", async () => {
  const dir = fixture("expiry"), events = []; let n = 0, cancelled = false;
  globalThis.fetch = async (_url, options) => {
    if (++n === 1) return stream([call("host_file_read", { path: "src/a.mjs" })]);
    if (n === 2) return stream([call("host_file_read", { path: "README.md" })]);
    if (n === 3) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener("abort", () => { cancelled = true; controller.error(options.signal.reason); }, { once: true });
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: "preliminary prose ".repeat(200) } }] })
        + frame({ choices: [{ delta: { tool_calls: [{ index: 0, ...call("host_file_edit", { path: "src/a.mjs", edits: [{ oldText: "value = 1", newText: "value = 9" }] }) }] } }] })));
    }, cancel() { cancelled = true; } }));
    return stream([], "No matching operation was completed after the interrupted response.");
  };
  const result = await runTurn([], ask, e => events.push(e), AbortSignal.timeout(8000), { ...opts(), budgetMs: 22000, complete: wrapped() });
  assert.equal(n, 3); assert(cancelled); assert.match(result.assistant, /Incomplete/); assert.equal(readFileSync(join(dir, "src/a.mjs"), "utf8"), "export const value = 1;\n");
  assert(!events.some(e => e.type === "tool" && e.name === "host_file_edit"));
});
