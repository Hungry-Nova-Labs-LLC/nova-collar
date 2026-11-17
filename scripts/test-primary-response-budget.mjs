import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "collar-primary-budget-"));
process.env.NOVAPUP_HOME = join(root, "profile"); process.env.NP_LAYA_MODEL = join(root, "absent-model"); process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch; globalThis.fetch = async () => { throw Error("No native inference/network allowed."); };
const { runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { createSession } = await import("../src/main/sessions.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { createTurnBudget, isTurnBudgetError } = await import("../src/main/turn-budget.js");
ensureHome(); const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(e => { if (e.type === "approval") resolveApproval(e.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = nativeFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, remote: false, search: false }).filter(t => ["host_file_read", "host_file_write", "host_file_edit", "host_run"].includes(t.function.name));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const call = (name, args, id) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const stream = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
function fixture(name) { const cwd = join(root, name); mkdirSync(cwd); writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n'); setWorkdir(cwd); return cwd; }

test("actual SSE primary call crosses work-end once, dispatches normally and next request receives one priority transition", async () => {
  const cwd = fixture("cross-work"), events = [], bodies = []; let n = 0, abortedFirst = false;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (++n === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "saved-once", type: "function", function: { name: "host_file_write", arguments: '{"path":"fresh.mjs",' } }] } }] })));
      const timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"export const value = 4;\\n"}' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n")); controller.close(); }, 1200);
      options.signal.addEventListener("abort", () => { abortedFirst = true; clearTimeout(timer); try { controller.error(options.signal.reason); } catch {} }, { once: true });
    } }));
    return stream({ content: "Saved fresh.mjs. Syntax passed; behavior was not independently tested." });
  };
  const result = await runTurn([], "Implement fresh.mjs exporting value 4.", e => events.push(e), AbortSignal.timeout(12000), { sessionId: createSession().id, tools, sourcePreload: false, budgetMs: 21000 });
  assert.equal(abortedFirst, false); assert.equal(n, 2); assert.equal(readFileSync(join(cwd, "fresh.mjs"), "utf8"), "export const value = 4;\n");
  assert.equal(events.filter(e => e.type === "tool_result" && e.name === "host_file_write" && e.ok).length, 1);
  assert.deepEqual(events.filter(e => e.type === "turn_budget").map(e => e.phase), ["work", "verification"]);
  assert(bodies[1].messages.some(m => String(m.content).includes("phase=verification"))); assert.deepEqual(bodies[0].tools, bodies[1].tools);
  assert.equal(bodies[0].max_tokens, 8192); assert.equal(bodies[0].options.num_ctx, 131072); assert.equal(bodies[0].temperature, 0); assert.equal(bodies[0].think, true);
  assert(!events.some(e => e.verification?.status === "passed" && ["runtime", "test", "project"].includes(e.verification.phase)), "clock routing must not create behavioral proof");
  assert.match(result.assistant, /fresh.mjs/); assert(!result.assistant.includes("response was cancelled"));
});

test("actual SSE hard handoff discards buffered calls and awaits latest human input before checkpoint finish", async () => {
  const cwd = fixture("hard-end"), events = [], source = "export const value = 1;\n"; let n = 0, transportAborted = false, acknowledged = false, batch = null, checkpointEarly = false;
  globalThis.fetch = async (_url, options) => {
    if (++n === 1) return stream({ tool_calls: [call("host_file_write", { path: "fresh.mjs", content: source }, "first-save")] });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { tool_calls: [call("host_file_write", { path: "never.mjs", content: "NEVER_DISPATCH" }, "pending")] } }] })));
      options.signal.addEventListener("abort", () => { transportAborted = true; batch = { messages: [{ content: "Stop editing; review only." }] }; try { controller.error(options.signal.reason); } catch {} }, { once: true });
    } }));
  };
  const result = await runTurn([], "Implement fresh.mjs exporting value 1.", e => { events.push(e); if (e.type === "checkpoint" && (!transportAborted || !acknowledged)) checkpointEarly = true; }, AbortSignal.timeout(10000), {
    sessionId: createSession().id, tools, sourcePreload: false, budgetMs: 17000,
    takeInput: () => batch, ackInput: async () => { await new Promise(resolve => setTimeout(resolve, 20)); acknowledged = true; batch = null; },
  });
  assert.equal(n, 2); assert(transportAborted); assert(acknowledged); assert.equal(checkpointEarly, false); assert(events.some(e => e.type === "checkpoint"));
  assert.equal(readFileSync(join(cwd, "fresh.mjs"), "utf8"), source); assert(!existsSync(join(cwd, "never.mjs")));
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_file_write").length, 1); assert.match(result.assistant, /Incomplete/);
});

test("external Stop interrupts primary SSE before dispatch without a recovery request", async () => {
  const cwd = fixture("stop"), stop = new AbortController(), events = []; let n = 0;
  globalThis.fetch = async (_url, options) => {
    n++; return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { tool_calls: [call("host_file_write", { path: "never.mjs", content: "NEVER_DISPATCH" }, "pending")] } }] })));
      options.signal.addEventListener("abort", () => { try { controller.error(options.signal.reason); } catch {} }, { once: true });
      setTimeout(() => stop.abort(), 10);
    } }));
  };
  await assert.rejects(runTurn([], "Implement never.mjs.", e => events.push(e), stop.signal, { sessionId: createSession().id, tools, sourcePreload: false, budgetMs: 21000 }), { name: "AbortError" });
  assert.equal(n, 1); assert(!existsSync(join(cwd, "never.mjs"))); assert(!events.some(e => e.type === "tool" && e.name === "host_file_write"));
});

test("optional helper cutoff remains work-end while primary grace grants no new authority or proof", async () => {
  let now = 0; const optional = createTurnBudget({ budgetMs: 600000, startedAt: 0, wallStartedAt: 0, now: () => now });
  await assert.rejects(optional.run(async () => { now = 435001; return "late optional judgment"; }, { optional: true }), error => isTurnBudgetError(error) && error.phase === "work");
  assert.equal(optional.optionalAvailable(), false); optional.dispose();
  now = 0; const primary = createTurnBudget({ budgetMs: 600000, startedAt: 0, wallStartedAt: 0, now: () => now });
  assert.equal(await primary.run(async () => { now = 450000; return "response only"; }, { verification: true }), "response only");
  assert.equal(primary.snapshot().phase, "verification"); assert.equal(primary.optionalAvailable(), false);
  await assert.rejects(primary.run(async () => { now = 585000; return "too late"; }, { verification: true }), error => isTurnBudgetError(error));
  primary.dispose();
});
