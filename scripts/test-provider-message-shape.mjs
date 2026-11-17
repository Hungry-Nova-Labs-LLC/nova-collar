import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-message-shape-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Native inference/network forbidden in this fixture."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { createSession } = await import("../src/main/sessions.js");
const { lastContextSnapshot, budgetContext, estimatedTokens } = await import("../src/main/context.js");
const { windowToolDefs } = await import("../src/main/tools.js");
ensureHome();
afterEach(() => { globalThis.fetch = async () => { throw Error("Unexpected native request."); }; });
after(() => { globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); });

const target = { url: "http://127.0.0.1:11999/v1", model: "fixture-model", key: "fixture", local: true };
const config = { home: process.env.NOVAPUP_HOME };
const saveProfile = lane => writeFileSync(join(config.home, "model-settings.json"), JSON.stringify({ version: 1, profiles: [
  { url: lane.url, model: lane.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true },
] }));
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const answer = (content = "Observed.") => new Response(data({ choices: [{ delta: { content }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
const budgetHint = "<turn_time_budget>\nQuoted controller time observation.\n</turn_time_budget>";
const scopeHint = '<user_declared_source_scope>\n{"paths":["src/a.mjs","src/new.mjs"],"readsPerformed":0,"fileExistence":"not_checked"}\n</user_declared_source_scope>';
const input = () => [{ role: "system", content: "Keep scope and permission boundaries." }, { role: "user", content: "Implement the requested change." },
  { role: "assistant", content: budgetHint }, { role: "assistant", content: scopeHint }];
function providerResponse(body) {
  let trailing = 0;
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "assistant"; i--) trailing++;
  if (trailing >= 2) return rejectShape();
  // Match the native adapter distinction: one assistant tail is an intentional
  // prefill, while a completed user/tool request starts a fresh model response.
  return answer(trailing === 1 ? body.messages.at(-1).content : "Observed.");
}
const rejectShape = () => new Response(JSON.stringify({ error: { message: "Cannot have 2 or more assistant messages at the end of the list.", type: "invalid_request_error" } }), { status: 400 });

test("plain controller assistant groups coalesce without mutating or dropping quoted content", async () => {
  const { coalesceAssistantContext } = await import("../src/main/provider-messages.js");
  const rows = input(), original = structuredClone(rows);
  const wire = coalesceAssistantContext(rows);
  assert.deepEqual(rows, original);
  assert.deepEqual(wire.map(row => row.role), ["system", "user", "assistant"]);
  assert.equal(wire.at(-1).content, budgetHint + "\n\n" + scopeHint);
  assert.deepEqual(coalesceAssistantContext(wire), wire);
  for (const row of original) assert(wire.some(next => next.role === row.role && next.content.includes(row.content)));
});

test("tool identity, reasoning, multipart and unknown fields are exact ordering boundaries", async () => {
  const { coalesceAssistantContext } = await import("../src/main/provider-messages.js");
  const calls = [{ id: "call-1", type: "function", function: { name: "host_file_read", arguments: '{"path":"a.mjs"}' } }];
  const rich = [
    { role: "assistant", content: "Calling.", tool_calls: calls },
    { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
    { role: "assistant", content: "Answer.", reasoning_content: "Private reasoning field remains unchanged." },
    { role: "assistant", content: [{ type: "text", text: "Multipart." }] },
    { role: "assistant", content: "Named.", name: "fixture" },
    { role: "assistant", content: "Unknown metadata.", extra: true },
  ];
  const rows = rich.flatMap(row => [{ role: "assistant", content: budgetHint }, row, { role: "assistant", content: scopeHint }, { role: "user", content: "Boundary." }]);
  assert.deepEqual(coalesceAssistantContext(rows), rows);
  assert.deepEqual(rows.find(row => row.tool_calls).tool_calls, calls);
});

test("trusted continuation is fixed, idempotent and absent for direct prefill or rich assistant tails", async () => {
  const { providerRequestContext, APP_CONTINUATION_CUE } = await import("../src/main/provider-messages.js");
  const original = input(), prepared = providerRequestContext(original, { controllerContinuation: true });
  assert.deepEqual(prepared.tailMessages, [{ role: "user", content: APP_CONTINUATION_CUE }]);
  assert.match(APP_CONTINUATION_CUE, /App-generated.*not new human input, permission or scope/);
  const full = [...prepared.messages, ...prepared.tailMessages];
  assert.deepEqual(providerRequestContext(full, { controllerContinuation: true }), { messages: full, tailMessages: [] });
  assert.deepEqual(providerRequestContext(original).tailMessages, []);
  assert.deepEqual(providerRequestContext(original, { controllerContinuation: "true" }).tailMessages, []);
  for (const field of [{ reasoning_content: "reason" }, { tool_calls: [] }, { name: "x" }, { extra: true }]) {
    const rich = [{ role: "assistant", content: "An intentional rich prefill.", ...field }];
    assert.deepEqual(providerRequestContext(rich, { controllerContinuation: true }), { messages: rich, tailMessages: [] });
  }
  assert.deepEqual(original, input());
});

test("direct complete preserves intentional assistant prefill without trusted runTurn opt-in", async () => {
  saveProfile(target); let sent;
  globalThis.fetch = async (_url, options) => { sent = JSON.parse(options.body); return providerResponse(sent); };
  const result = await complete(input(), config, null, undefined, { target, tools: [], timeoutMs: 2000 });
  assert.equal(result.content, budgetHint + "\n\n" + scopeHint);
  assert.equal(sent.messages.at(-1).role, "assistant"); assert.equal(sent.messages.length, 3);
});

test("serialized complete request accepts actual controller adjacency with unchanged selected inference settings", async () => {
  saveProfile(target); const rows = input(), original = structuredClone(rows); let requests = 0, sent;
  const session = createSession();
  globalThis.fetch = async (_url, options) => {
    requests++; sent = JSON.parse(options.body);
    return providerResponse(sent);
  };
  const result = await complete(rows, config, null, undefined, { target, tools: [], sessionId: session.id, timeoutMs: 2000, controllerContinuation: true });
  assert.equal(result.content, "Observed."); assert.equal(requests, 1);
  const { APP_CONTINUATION_CUE } = await import("../src/main/provider-messages.js");
  assert.deepEqual(rows, original); assert.deepEqual(sent.messages, [original[0], original[1], { role: "assistant", content: budgetHint + "\n\n" + scopeHint }, { role: "user", content: APP_CONTINUATION_CUE }]);
  assert.equal(sent.controllerContinuation, undefined); assert.equal(sent.tailMessages, undefined); assert.equal(sent.continue_final_message, undefined);
  assert.equal(sent.max_tokens, 8192); assert.equal(sent.options.num_ctx, 131072); assert.equal(sent.options.num_predict, 8192);
  assert.equal(sent.temperature, 0); assert.equal(sent.think, true); assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: true });
  const snapshot = lastContextSnapshot(session.id);
  assert.equal(snapshot.roles.assistant.messages, 1); assert.equal(snapshot.roles.user.messages, 2); assert.equal(snapshot.conversation.rawMessages, 4); assert.equal(snapshot.conversation.sentMessages, 4);
  assert.equal(snapshot.tokens.messages, estimatedTokens(sent.messages));
});

test("serialized closeout preserves tool-call/result ordering plus budget and harness context", async () => {
  saveProfile(target); let sent;
  const toolCall = { role: "assistant", content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "host_file_read", arguments: '{"path":"a.mjs"}' } }] };
  const receipt = { role: "tool", tool_call_id: "read-1", content: '{"ok":true,"content":"export const a=1"}' };
  const harness = "<harness_observations>\nQuoted failed check for the current source revision.\n</harness_observations>";
  const rows = [...input().slice(0, 2), toolCall, receipt, ...input().slice(2), { role: "assistant", content: harness }];
  globalThis.fetch = async (_url, options) => { sent = JSON.parse(options.body); return providerResponse(sent); };
  const result = await complete(rows, config, null, undefined, { target, tools: [], timeoutMs: 2000, requestKind: "closeout", controllerContinuation: true });
  assert.equal(result.content, "Observed.");
  assert.deepEqual(sent.messages.slice(0, 4), rows.slice(0, 4));
  assert.equal(sent.messages[2].tool_calls[0].id, sent.messages[3].tool_call_id);
  assert.equal(sent.messages[4].content, budgetHint + "\n\n" + scopeHint + "\n\n" + harness);
  assert.equal(sent.messages[5].role, "user");
  assert.equal(sent.max_tokens, 1536); assert.equal(sent.options.num_ctx, 131072);
});

test("compaction retains the genuine current request and tool evidence with the fully budgeted continuation cue", async () => {
  const { providerRequestContext, APP_CONTINUATION_CUE } = await import("../src/main/provider-messages.js");
  const old = [{ role: "system", content: "System." }, { role: "user", content: "old".repeat(900) }, { role: "assistant", content: "old answer" }];
  const receipt = { role: "tool", tool_call_id: "actual-1", content: "Actual current receipt, not an invented framing receipt." };
  const current = [input()[1], { role: "assistant", content: "", tool_calls: [{ id: "actual-1", type: "function", function: { name: "host_file_read", arguments: "{}" } }] }, receipt, ...input().slice(2)];
  const prepared = providerRequestContext([...old, ...current], { controllerContinuation: true });
  const budget = budgetContext(prepared.messages, { contextTokens: 2048, outputTokens: 512, persist: false, tailMessages: prepared.tailMessages });
  assert(budget.compacted > 0); assert(budget.messages.some(row => row.role === "user" && row.content === current[0].content));
  assert.deepEqual(budget.messages.find(row => row.role === "tool"), receipt);
  assert.equal(budget.messages.at(-2).content, budgetHint + "\n\n" + scopeHint);
  assert.equal(budget.messages.at(-1).content, APP_CONTINUATION_CUE);
  assert.equal(budget.estimatedInputTokens, estimatedTokens(budget.messages));
  const large = providerRequestContext([{ role: "user", content: "CURRENT_REQUEST_MUST_SURVIVE".repeat(300) }, ...input().slice(2)], { controllerContinuation: true });
  assert.throws(() => budgetContext(large.messages, { contextTokens: 2048, outputTokens: 512, persist: false, tailMessages: large.tailMessages }), /current request.*exceed/i);
  const exactWithoutCue = estimatedTokens(large.messages) + 512 + 512;
  assert.doesNotThrow(() => budgetContext(large.messages, { contextTokens: exactWithoutCue, outputTokens: 512, persist: false }));
  assert.throws(() => budgetContext(large.messages, { contextTokens: exactWithoutCue, outputTokens: 512, persist: false, tailMessages: large.tailMessages }), /current request.*exceed/i,
    "optional-context admission must reserve the same cue overhead as actual serialization");
});

test("actual runTurn gets a fresh response after budget plus passive Scope context without proof or file I/O credit", async () => {
  const cwd = join(root, "scoped-project"); mkdirSync(cwd); mkdirSync(join(cwd, "src")); setWorkdir(cwd);
  const source = 'export const SENTINEL_PRIVATE_SOURCE=1;\n'; writeFileSync(join(cwd, "src/a.mjs"), source);
  const cfg = loadConfig(); saveProfile(chatTarget(cfg));
  const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(tool => ["host_run", "host_file_read", "host_file_write", "host_file_edit"].includes(tool.function.name));
  const stop = new AbortController(), events = [], session = createSession(); let requests = 0, sent;
  globalThis.fetch = async (_url, options) => {
    requests++; sent = JSON.parse(options.body);
    return providerResponse(sent);
  };
  await assert.rejects(runTurn([], "Do not inspect hidden reference material or private profiles. Implement the requested change. Scope: change only src/a.mjs, src/new.mjs. Do not modify README.md.", event => {
    events.push(event); if (event.type === "delta") stop.abort();
  }, stop.signal, { sessionId: session.id, tools }), { name: "AbortError" });
  assert.equal(requests, 1); assert.deepEqual(sent.messages.map(row => row.role), ["system", "user", "assistant", "user"]);
  assert(sent.messages.at(-2).content.includes("<turn_time_budget>")); assert(sent.messages.at(-2).content.includes("<user_declared_source_scope>"));
  assert.equal(events.find(event => event.type === "delta").text, "Observed.", "a prefix echo is not a fresh response");
  assert(!JSON.stringify(sent.messages).includes("SENTINEL_PRIVATE_SOURCE")); assert.equal(sent.tool_choice, "required");
  assert.deepEqual(sent.tools.filter(tool => tools.some(original => original.function.name === tool.function.name)), tools);
  assert.equal(sent.max_tokens, 8192); assert.equal(sent.options.num_ctx, 131072);
  assert.equal(readFileSync(join(cwd, "src/a.mjs"), "utf8"), source); assert(!existsSync(join(cwd, "src/new.mjs")));
  assert(!events.some(event => event.type === "tool" || event.verification?.status === "passed"));
  const archive = readFileSync(join(config.home, "sessions", "archive", session.id + ".jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).flatMap(row => row.message ? [row.message] : []);
  assert.equal(archive.filter(row => row.role === "assistant").length, 2, "raw durable journal preserves distinct controller observations");
  assert.equal(sent.messages.at(-2).content, archive.filter(row => row.role === "assistant").map(row => row.content).join("\n\n"));
  assert.equal(archive.filter(row => row.role === "user").length, 1, "fixed app cue is not durable human input");
  assert.equal(lastContextSnapshot(session.id).conversation.sentMessages, 4);
});

test("latest human review steering remains authoritative and the wire cue creates no new edit permission", async () => {
  const cwd = join(root, "review-project"); mkdirSync(cwd); setWorkdir(cwd); saveProfile(chatTarget(loadConfig()));
  const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(tool => ["host_run", "host_file_read", "host_file_write"].includes(tool.function.name));
  const review = "Stop editing; review only."; let polls = 0, batch = null, sent, requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; sent = JSON.parse(options.body); return providerResponse(sent); };
  const result = await runTurn([], "Do not inspect hidden reference material. Implement the change. Scope: change only source.mjs.", () => {}, undefined, {
    sessionId: createSession().id, tools,
    takeInput: () => { if (++polls === 2) batch = { messages: [{ content: review }] }; return batch; }, ackInput: () => { batch = null; },
  });
  assert.equal(requests, 1); assert.equal(result.assistant, "Observed.");
  assert.equal(sent.messages.at(-1).role, "user"); assert.equal(sent.messages.at(-1).content, review);
  assert(!sent.tools.some(tool => tool.function.name === "host_file_write")); assert.equal(sent.tool_choice, "auto");
  assert(!existsSync(join(cwd, "source.mjs")));
});
