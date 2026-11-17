import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "collar-stream-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
const { complete } = await import("../src/main/agent.js");
const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
after(() => rmSync(home, { recursive: true, force: true }));
const config = { home };
const options = { target: { url: "https://fixture.invalid/v1", model: "fixture-model", key: "fixture", local: false }, tools: [], predict: 512, timeoutMs: 2000 };
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;

test("production stream decoder consumes a final UTF-8 data line without a newline", async () => {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Last answer 🐙" }, finish_reason: "stop" }] })}`);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, bytes.length - 10)); controller.enqueue(bytes.slice(bytes.length - 10)); controller.close();
    } }));
  };
  const result = await complete([], config, null, undefined, options);
  assert.equal(result.content, "Last answer 🐙"); assert.equal(result.finish_reason, "stop"); assert.equal(calls, 1);
});

test("finish_reason does not discard the following final provider usage frame", async () => {
  let reported;
  globalThis.fetch = async () => new Response(data({ choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] })
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}`);
  const result = await complete([], config, null, undefined, { ...options, onUsage: value => { reported = value; } });
  assert.equal(result.content, "Done"); assert.equal(result.usage.inputTokens, 7); assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.usage.totalTokens, 10); assert.equal(reported.inputTokens, 7);
});

test("DONE terminates and cancels an otherwise open stream", async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(data({ choices: [{ delta: { content: "Complete" } }] }) + "data: [DONE]\n\n")); },
    cancel() { cancelled = true; },
  }));
  const result = await complete([], config, null, undefined, { ...options, quietTimeoutMs: 100 });
  assert.equal(result.content, "Complete"); assert.equal(cancelled, true);
});

test("truncated EOF rejects partial output without replaying the request", async () => {
  let calls = 0; const emitted = [];
  globalThis.fetch = async () => { calls++; return new Response(data({ choices: [{ delta: { content: "Partial answer" } }] })); };
  await assert.rejects(complete([], config, text => emitted.push(text), undefined, options), { name: "IncompleteResponseError" });
  assert.deepEqual(emitted, ["Partial answer"]); assert.equal(calls, 1);
});

test("a capacity error after a partial answer is not replayed", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(data({ choices: [{ delta: { content: "Started" } }] })
    + data({ error: { code: "queue_full", message: "Capacity failed after output", status: 429 } })); };
  await assert.rejects(complete([], config, null, undefined, { ...options, capacity: { maxWaitMs: 50, baseDelayMs: 1 } }), error => error.code === "queue_full" && error.retryable === false);
  assert.equal(calls, 1);
});
