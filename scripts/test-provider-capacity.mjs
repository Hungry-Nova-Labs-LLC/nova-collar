import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "collar-provider-capacity-"));
process.env.NOVAPUP_HOME = home;
const { complete } = await import("../src/main/agent.js");
const { CapacityWait, isCapacityError } = await import("../src/main/provider-capacity.js");
const { queueStatus, retryAfterMs } = await import("../src/main/provider-progress.js");
after(() => rmSync(home, { recursive: true, force: true }));

function sse(res, value) { res.write(`data: ${JSON.stringify(value)}\n\n`); }
function answer(res, text = "Finished") {
  if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, { choices: [{ delta: { content: text }, finish_reason: "stop" }] });
  res.end("data: [DONE]\n\n");
}
async function fixture(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      requests.push({ body: JSON.parse(raw), headers: req.headers });
      respond(res, requests.length);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { requests, ask: (options = {}, signal = null, onDelta = null) => complete(
    [{ role: "user", content: "Fixture request" }], { home }, onDelta, signal,
    { tools: [], target: { url, model: "fixture-model", key: "", local: false },
      capacity: { maxWaitMs: 200, baseDelayMs: 5, maxDelayMs: 10 }, ...options }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test("capacity retries have one finite budget and honor Retry-After", async () => {
  let now = 0, calls = 0; const waits = [];
  const capacity = new CapacityWait({ capacity: { maxWaitMs: 100, baseDelayMs: 10, maxDelayMs: 20 } }, {
    now: () => now, random: () => .5, sleep: async ms => { waits.push(ms); now += ms; },
  });
  await assert.rejects(capacity.run(async () => {
    calls++; throw Object.assign(new Error("Busy"), { status: 429, retryAfterMs: 30 });
  }), error => error.code === "CAPACITY_WAIT_EXHAUSTED");
  assert.equal(now, 100); assert.equal(calls, 4); assert.deepEqual(waits, [30, 30, 30, 10]);
  assert.equal(retryAfterMs("1.5"), 1500);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:02 GMT", 1000), 1000);
});

test("queue metadata is validated rather than inferred from provider prose", () => {
  assert.deepEqual(queueStatus({ state: "queued", wait_ms: 12, position: 2, request_id: "request-1", backend: "fixture" }),
    { state: "queued", waitMs: 12, position: 2, requestId: "request-1", backend: "fixture" });
  for (const value of [null, "queued", { state: "thinking", wait_ms: 0 }, { state: "queued", wait_ms: -1 },
    { state: "queued", wait_ms: 1, position: 0 }, { state: "queued", wait_ms: 1, backend: "bad\nvalue" }]) assert.equal(queueStatus(value), null);
});

test("HTTP capacity retries stay on the same model and preserve forced tool choice", async () => {
  const events = [];
  const f = await fixture((res, count) => {
    if (count === 1) { res.writeHead(429, { "content-type": "application/json", "retry-after": ".01" }); res.end(JSON.stringify({ error: { code: "queue_full", message: "Busy", retryable: true } })); }
    else answer(res);
  });
  try {
    const tools = [{ type: "function", function: { name: "fixture_tool", description: "Fixture", parameters: { type: "object", properties: {} } } }];
    assert.equal((await f.ask({ onProviderProgress: event => events.push(event), tools, toolChoice: "required" })).content, "Finished");
    assert.equal(f.requests.length, 2);
    assert(f.requests.every(request => request.body.model === "fixture-model" && request.body.tool_choice === "required"));
    assert.equal(f.requests[0].headers["x-nova-progress"], "1");
    assert(events.some(event => event.state === "retrying" && event.waitMs >= 10));
  } finally { await f.close(); }
});

test("admission metadata resets the active deadline and never becomes assistant text", async () => {
  const events = [];
  const f = await fixture(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { nova_status: { state: "queued", wait_ms: 0, position: 2, request_id: "fixture-admission" } });
    setTimeout(() => sse(res, { nova_status: { state: "admitted", wait_ms: 70, request_id: "fixture-admission" } }), 70);
    setTimeout(() => answer(res, "Only the answer"), 140);
  });
  try {
    const reply = await f.ask({ timeoutMs: 100, onProviderProgress: event => events.push(event) });
    assert.equal(reply.content, "Only the answer"); assert.equal(f.requests.length, 1);
    assert(events.some(event => event.state === "queued" && event.position === 2));
    assert(events.some(event => event.state === "admitted"));
    assert(!JSON.stringify(reply).includes("fixture-admission"));
  } finally { await f.close(); }
});

test("unobserved computation is not mistaken for capacity waiting", async () => {
  const events = [];
  const f = await fixture(res => { res.writeHead(200, { "content-type": "text/event-stream" }); setTimeout(() => answer(res), 40); });
  try {
    assert.equal((await f.ask({ capacity: { maxWaitMs: 10 }, onProviderProgress: event => events.push(event) })).content, "Finished");
    assert(!events.some(event => event.state === "queued" || event.state === "retrying"));
  } finally { await f.close(); }
});

test("Stop cancels capacity backoff without a second request", async () => {
  const controller = new AbortController();
  const f = await fixture(res => { res.writeHead(429); res.end(JSON.stringify({ error: { code: "queue_full", message: "Busy" } })); });
  try {
    await assert.rejects(f.ask({ onProviderProgress: event => { if (event.state === "retrying") controller.abort(); } }, controller.signal), error => error.name === "AbortError");
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("Stop cancels an observed queue and queue expiry has a finite deadline", async () => {
  const controller = new AbortController();
  const f = await fixture(res => { res.writeHead(200, { "content-type": "text/event-stream" }); sse(res, { nova_status: { state: "queued", wait_ms: 0, position: 1 } }); });
  try {
    await assert.rejects(f.ask({ onProviderProgress: event => { if (event.state === "queued") controller.abort(); } }, controller.signal), error => error.name === "AbortError");
    assert.equal(f.requests.length, 1);
    await assert.rejects(f.ask({ capacity: { maxWaitMs: 25 }, onProviderProgress: () => {} }), error => error.code === "CAPACITY_WAIT_EXHAUSTED");
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test("quota, authentication and partial streamed results are never capacity-replayed", async () => {
  for (const [status, code] of [[429, "insufficient_quota"], [401, "authentication_error"], [403, "permission_denied"]]) {
    const f = await fixture(res => { res.writeHead(status); res.end(JSON.stringify({ error: { code, message: "Terminal failure" } })); });
    try {
      await assert.rejects(f.ask(), error => error.status === status && !isCapacityError(error));
      assert.equal(f.requests.length, 1);
    } finally { await f.close(); }
  }
  const seen = [];
  const f = await fixture(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "Partial answer" } }] });
    sse(res, { error: { code: "queue_timeout", status: 429, message: "Lost capacity", retryable: true } }); res.end();
  });
  try {
    await assert.rejects(f.ask({}, null, text => seen.push(text)), error => error.code === "queue_timeout" && error.retryable === false);
    assert.deepEqual(seen, ["Partial answer"]); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("a streaming capacity error before output may retry safely", async () => {
  const f = await fixture((res, count) => {
    if (count > 1) return answer(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { error: { code: "queue_timeout", status: 429, message: "Busy", retryable: true } }); res.end();
  });
  try { assert.equal((await f.ask()).content, "Finished"); assert.equal(f.requests.length, 2); }
  finally { await f.close(); }
});
