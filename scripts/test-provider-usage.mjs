import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportedUsage } from "../src/main/provider-usage.js";
const home = mkdtempSync(join(tmpdir(), "collar-usage-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
after(() => rmSync(home, { recursive: true, force: true }));
test("provider counters stay distinct from estimates and reject malformed values", () => {
  assert.equal(reportedUsage({ input: 50, output: 10 }), null);
  assert.equal(reportedUsage({ prompt_tokens: "50", completion_tokens: 10 }), null);
  assert.equal(reportedUsage({ prompt_tokens: -1, completion_tokens: 10 }), null);
  assert.deepEqual(reportedUsage({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 3 } }),
    { reported: true, inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 20, reasoningTokens: 3 });
  assert.deepEqual(reportedUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 5 } }), { reported: true, inputTokens: 0, outputTokens: 0 });
});
test("real completion requests usage and retains a terminal usage-only SSE event", async () => {
  const { complete } = await import("../src/main/agent.js");
  const previous = globalThis.fetch, observed = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream_options.include_usage, true);
    return new Response('data: {"choices":[{"delta":{"content":"Ready."}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":5,"total_tokens":128}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const reply = await complete([{ role: "user", content: "Hello." }], { home }, null, null,
      { target: { url: "https://fixture.invalid/v1", model: "fixture", key: "fixture", local: false }, tools: [], onUsage: value => observed.push(value) });
    assert.equal(reply.content, "Ready.");
    assert.deepEqual(reply.usage, { reported: true, inputTokens: 123, outputTokens: 5, totalTokens: 128 });
    assert.equal(observed.length, 1); assert.equal(observed[0].model, "fixture");
  } finally { globalThis.fetch = previous; }
});
