import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "collar-failed-command-note-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Native inference/network forbidden in this fixture."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { ensureHome, chatTarget, loadConfig } = await import("../src/main/config.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome(); const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = originalFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, remote: false, search: false }).filter(t => ["host_file_read", "host_file_write", "host_file_edit", "host_run"].includes(t.function.name));
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const call = (name, args, id) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const stream = delta => new Response(frame({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
const fixture = name => { const cwd = join(root, name); mkdirSync(cwd); writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n'); setWorkdir(cwd); return cwd; };
const withRealComplete = (messages, cfg, delta, signal, options) => complete(messages, cfg, delta, signal, options);

test("actual SSE budget handoff names the failed Python assertion rather than earlier successful stdout", async () => {
  const cwd = fixture("budget-cause"), events = [], bodies = [], source = "def answer():\n    return 6\n";
  const command = "python3 - <<'CHECK'\nfrom service import answer\nprint('PARTIAL_OK before the check')\nassert answer() == 7, 'contract expected seven'\nCHECK";
  let requests = 0, transportAborted = false;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body); requests++;
    assert.equal(body.max_tokens, 8192); assert.equal(body.options.num_ctx, 131072);
    if (requests === 1) return stream({ tool_calls: [call("host_file_write", { path: "service.py", content: source }, "saved-source")] });
    if (requests === 2) return stream({ tool_calls: [call("host_run", { command, cwd, timeoutMs: 5000 }, "actual-failure")] });
    assert.equal(requests, 3);
    const receipt = body.messages.find(row => row.role === "tool" && row.tool_call_id === "actual-failure");
    assert(receipt); const raw = JSON.parse(receipt.content.split("\n\nObserved failure:")[0]);
    assert.equal(raw.ok, false); assert.match(raw.stdout, /PARTIAL_OK/); assert.match(raw.stderr, /AssertionError/);
    assert.match(receipt.content, /Observed failure:[\s\S]*AssertionError/);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: "Considering the recorded failure." } }] })));
      options.signal.addEventListener("abort", () => { transportAborted = true; try { controller.error(options.signal.reason); } catch {} }, { once: true });
    } }));
  };
  const result = await runTurn([], "Create service.py with answer() returning seven and verify that result. Keep the actual failing check visible.", e => events.push(e), AbortSignal.timeout(12000), {
    sessionId: createSession().id, tools, sourcePreload: false, budgetMs: 19000, complete: withRealComplete,
  });
  assert.equal(requests, 3); assert(transportAborted);
  assert.equal(readFileSync(join(cwd, "service.py"), "utf8"), source, "a budget handoff preserves completed writes even when their behavior is wrong");
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_file_write").length, 1);
  assert.match(result.assistant, /Incomplete/);
  const cause = result.assistant.split("Most recent recorded failure (host_run):")[1] || "";
  assert.match(cause, /AssertionError/); assert(!cause.includes("PARTIAL_OK"), "successful prefix stdout is retained as output, never mislabeled as the failure cause");
  const receipt = result.messages.find(row => row.role === "tool" && row.tool_call_id === "actual-failure");
  assert(receipt?.content.includes('"ok":false')); assert(receipt.content.includes("PARTIAL_OK")); assert(receipt.content.includes("AssertionError"));
  const failedStep = events.find(e => e.type === "tool_result" && e.name === "host_run");
  assert.equal(failedStep?.ok, false); assert.match(failedStep.blurb, /AssertionError/);
});

test("actual next-request Python context balances implementation repair and justified authored-expectation correction", async () => {
  const cwd = fixture("balanced-advice"), events = [], requestShapes = []; let requests = 0;
  const command = "python3 - <<'CHECK'\nvalues = [2, 4]\nobserved = sum(values)\nexpected = 9\nassert observed == expected, (observed, expected)\nCHECK";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    requestShapes.push({toolChoice:body.tool_choice,toolCount:body.tools?.length,maxTokens:body.max_tokens});
    if (requests === 1) return stream({ tool_calls: [call("host_run", { command, cwd }, "comparison-failure")] });
    const receipt = body.messages.find(row => row.role === "tool" && row.tool_call_id === "comparison-failure"); assert(receipt);
    const context = receipt.content.split("App-generated diagnostic context.")[1] || "";
    assert.match(context, /First independently compare[\s\S]*observed value[\s\S]*expected value[\s\S]*input data[\s\S]*user contract/);
    assert.match(context, /If the check is valid, repair the implementation/);
    assert.match(context, /Only a demonstrably mistaken expectation[\s\S]*authored during this task[\s\S]*stated derivation[\s\S]*preserved required coverage/);
    assert.match(context, /Do not weaken user-supplied or protected checks/);
    assert(!context.includes("change correct production code to satisfy"), "do not presume the implementation is correct before comparing it");
    assert.match(context, /This context changes no result, verification debt, permission or scope/);
    assert.equal(JSON.parse(receipt.content.split("\n\nObserved failure:")[0]).ok, false);
    return stream({ content: "FAIL. The submitted Python command raised AssertionError. No code or check was changed and no passing verification was recorded." });
  };
  const result = await runTurn([], "Run a compact local Python check and report the actual observed failure. Do not claim a check passed without evidence.", e => events.push(e), AbortSignal.timeout(10000), {
    sessionId: createSession().id, tools, sourcePreload: false, budgetMs: 25000, complete: withRealComplete,
  });
  assert(requests >= 2 && requests <= 3, JSON.stringify(requestShapes)); assert.match(result.assistant, /FAIL|failed/);
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_run").length, 1);
  assert(!events.some(e => e.type === "tool" && ["host_file_write", "host_file_edit"].includes(e.name)));
  assert(!existsSync(join(cwd, "CHECK")));
});
