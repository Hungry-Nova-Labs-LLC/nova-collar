import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "collar-thought-recovery-"));
process.env.NOVAPUP_HOME = join(home, "profile");
process.env.NP_LAYA_MODEL = join(home, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Live providers/network forbidden."); };
const { ensureHome, chatTarget, loadConfig } = await import("../src/main/config.js");
const { runTurn, complete } = await import("../src/main/agent.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { createSession } = await import("../src/main/sessions.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
ensureHome(); setWorkdir(home);
const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [
  { url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true },
] }));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("No live provider."); }; setWorkdir(home); });
after(() => { setApprovalNotifier(null); globalThis.fetch = nativeFetch; rmSync(home, { recursive: true, force: true }); });
const definitions = windowToolDefs({ local: true, search: false, remote: false });
const tools = (...names) => definitions.filter(row => names.includes(row.function.name));
const data = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const done = content => data({ content }) + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const call = (name, args, id) => data({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
  + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
// Synthetic repeated fixture text, never a retained live reasoning sample.
const thought = "Fixture repetition marker. ".repeat(20);
const looping = pending => (pending ? data({ tool_calls: [{ index: 0, id: "discarded-call", type: "function", function: pending }] }) : "")
  + data({ reasoning_content: thought });
function fixture(name) { const dir = join(home, name); mkdirSync(dir); setWorkdir(dir); return dir; }
function provider(respond) {
  const requests = [], cancelled = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `${target.url}/chat/completions`);
    const body = JSON.parse(options.body); requests.push(body);
    const index = requests.length - 1;
    const stream = respond(body, index, options);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(stream)); },
      cancel() { cancelled.push(index); },
    }));
  };
  return { requests, cancelled };
}
function noDiscardedReasoning(result, session) {
  assert(!JSON.stringify(result.messages).includes("Fixture repetition marker"));
  const archive = join(process.env.NOVAPUP_HOME, "sessions/archive", `${session.id}.jsonl`);
  if (existsSync(archive)) assert(!readFileSync(archive, "utf8").includes("Fixture repetition marker"));
}

test("production guard remains unchanged and complete still rejects a repeating SSE stream", async () => {
  const { requests, cancelled } = provider(() => looping());
  await assert.rejects(complete([], loadConfig(), null, AbortSignal.timeout(5000), { target, tools: [] }), { name: "ThoughtLoop" });
  assert.equal(requests.length, 1); assert.deepEqual(cancelled, [0]);
});

test("main request gets one fresh same-budget recovery without dispatching partial tool calls", async () => {
  const dir = fixture("recover"), path = join(dir, "not-written.txt"), session = createSession();
  const events = [];
  const { requests, cancelled } = provider((_body, index) => {
    if (!index) return looping({ name: "host_file_write", arguments: JSON.stringify({ path, content: "discard me" }) });
    assert.equal(index, 1, "only one recovery request");
    return done("The recorded observations do not establish completion.");
  });
  const result = await runTurn([], "Inspect the observations and report their limits.", event => events.push(event), AbortSignal.timeout(10000), { sessionId: session.id, pack: "host", tools: tools("host_file_write") });
  assert.equal(requests.length, 2); assert.deepEqual(cancelled, [0, 1]);
  assert.equal(existsSync(path), false); assert.equal(events.filter(row => row.type === "tool" && row.name === "host_file_write").length, 0);
  for (const body of requests) { assert.equal(body.model, target.model); assert.equal(body.max_tokens, 8192); assert.equal(body.temperature, 0); assert.equal(body.chat_template_kwargs.enable_thinking, true); }
  assert.match(requests[1].messages.at(-1).content, /partial tool calls were discarded/);
  assert(!JSON.stringify(requests[1].messages).includes("discarded-call"));
  noDiscardedReasoning(result, session);
});

test("a second main guard returns deterministic Incomplete after exactly two fetches", async () => {
  fixture("twice"); const session = createSession();
  const { requests } = provider(() => looping());
  const result = await runTurn([], "Inspect observations and report their limits.", () => {}, AbortSignal.timeout(10000), { sessionId: session.id, pack: "host", tools: tools("host_file_read") });
  assert.equal(requests.length, 2); assert.match(result.assistant, /^Incomplete\./);
  assert.match(result.assistant, /one permitted recovery/); assert.match(result.assistant, /completion was not confirmed/);
  noDiscardedReasoning(result, session);
});

test("recovery can complete one real edit and its quota is shared across later requests", async () => {
  const dir = fixture("one-quota"), path = join(dir, "feature.mjs"), session = createSession(), events = [];
  const content = "export const enabled = true;\n";
  const { requests } = provider((_body, index) => index === 1
    ? call("host_file_write", { path, content }, "fresh-edit")
    : looping({ name: "host_file_write", arguments: JSON.stringify({ path, content }) }));
  const result = await runTurn([], "Implement feature.mjs and verify it.", event => events.push(event), AbortSignal.timeout(15000), { sessionId: session.id, pack: "host", tools: tools("host_file_write") });
  assert.equal(requests.length, 3, "a later guard cannot open a second recovery allowance");
  assert.equal(readFileSync(path, "utf8"), content);
  assert.equal(events.filter(row => row.type === "tool" && row.name === "host_file_write").length, 1);
  assert.match(result.assistant, /^Incomplete\./); assert.match(result.assistant, /feature\.mjs/);
  noDiscardedReasoning(result, session);
});

test("real completed writes and failed runtime evidence survive the guarded recovery pair", async () => {
  const dir = fixture("failed-evidence"), path = join(dir, "broken.mjs"), session = createSession(), events = [];
  const bad = 'throw new Error("behavior_failure");\n';
  const { requests } = provider((_body, index) => {
    if (!index) return call("host_file_write", { path, content: bad }, "completed-write");
    return looping({ name: "host_file_write", arguments: JSON.stringify({ path, content: 'console.log("fake repair");\n' }) });
  });
  const result = await runTurn([], "Fix broken.mjs and verify its behavior.", event => events.push(event), AbortSignal.timeout(15000), { sessionId: session.id, pack: "host", tools: tools("host_file_write") });
  assert.equal(requests.length, 3, "one normal tool request plus exactly two guarded attempts");
  assert.equal(readFileSync(path, "utf8"), bad); assert.equal(events.filter(row => row.type === "tool" && row.name === "host_file_write").length, 1);
  assert.match(result.assistant, /^Incomplete\./); assert.match(result.assistant, /broken\.mjs/); assert.match(result.assistant, /failed|behavior_failure/);
  assert(new VerificationLedger(session.id, dir).debt().some(row => row.includes("broken.mjs") && row.includes("runtime")));
  assert.match(requests[2].messages.at(-1).content, /verification_state/);
  noDiscardedReasoning(result, session);
});

test("forced closeout recovers once without raising its reserve or rerunning completed tools", async () => {
  const dir = fixture("closeout"), session = createSession(), events = [];
  for (let index = 0; index < 8; index++) writeFileSync(join(dir, `observation-${index}.txt`), `observation ${index}`);
  const { requests } = provider((_body, index) => index < 8
    ? call("host_file_read", { path: join(dir, `observation-${index}.txt`) }, `read-${index}`)
    : looping());
  const result = await runTurn([], "Fix the helper in result.mjs and inspect the local observations.", event => events.push(event), AbortSignal.timeout(15000), { sessionId: session.id, pack: "host", tools: tools("host_file_read", "host_file_write") });
  assert.equal(requests.length, 10, "eight normal rounds then exactly two guarded closeout requests");
  assert.equal(events.filter(row => row.type === "tool" && row.name === "host_file_read" && row.modelRequested !== false).length, 8, "automatic source observations are not replayed model tool calls");
  for (const body of requests.slice(-2)) { assert.equal(body.tool_choice, undefined); assert.equal(body.tools, undefined); }
  assert.equal(requests.at(-2).max_tokens, 1536);
  assert.equal(requests.at(-1).max_tokens, requests.at(-2).max_tokens);
  assert.match(result.assistant, /^Incomplete\./); noDiscardedReasoning(result, session);
});

test("Stop between guarded attempts prevents recovery and preserves AbortError", async () => {
  fixture("stop"); const controller = new AbortController(); let requests = 0;
  provider(() => { requests++; return looping(); });
  await assert.rejects(runTurn([], "Inspect observations.", event => {
    if (event.type === "think") controller.abort();
  }, controller.signal, { pack: "host", tools: tools("host_file_read") }), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("an incomplete non-guard stream remains an error and is never retried", async () => {
  fixture("incomplete"); const { requests } = provider(() => data({ reasoning_content: "A short nonrepeating fixture." }));
  // Unlike the intentionally open guard streams, end this truncated response.
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(data({ reasoning_content: "A short nonrepeating fixture." })); };
  await assert.rejects(runTurn([], "Inspect observations.", () => {}, AbortSignal.timeout(10000), { pack: "host", tools: tools("host_file_read") }), { name: "IncompleteResponseError" });
  assert.equal(requests.length, 1);
});

test("a recovery network error neither switches provider lanes nor starts another request", async () => {
  fixture("no-fallback");
  const env = join(process.env.NOVAPUP_HOME, "env");
  writeFileSync(env, "HNL_FAST_URL=http://127.0.0.1:12001/v1\nHNL_FAST_MODEL=fixture-fast\nHNL_THINK_URL=http://127.0.0.1:12002/v1\nHNL_THINK_MODEL=fixture-think\n");
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    if (requests.length > 1) throw new Error("fixture network failure");
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(looping())); } }));
  };
  try {
    await assert.rejects(runTurn([], "Inspect local observations.", () => {}, AbortSignal.timeout(10000), { pack: "host", tools: tools("host_file_read") }), /fixture network failure/);
    assert.equal(requests.length, 2);
    for (const request of requests) { assert.equal(request.url, "http://127.0.0.1:12001/v1/chat/completions"); assert.equal(request.body.model, "fixture-fast"); }
  } finally { rmSync(env, { force: true }); }
});
