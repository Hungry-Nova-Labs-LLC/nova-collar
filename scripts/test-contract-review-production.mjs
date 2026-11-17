import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const cache = fileURLToPath(new URL("../../", import.meta.url));
const root = realpathSync(mkdtempSync(join(cache, "contract-review-production-")));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
for (const key of ["HNL_FAST_URL", "HNL_FAST_MODEL", "HNL_THINK_URL", "HNL_THINK_MODEL", "HNL_CHAT_KEY", "HNL_TOOLS_KEY"]) process.env[key] = "";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No live inference or network in production fixture."); };
const { ensureHome, chatTarget, loadConfig } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { createHarness } = await import("../src/main/harness.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
const { CONTRACT_REVIEW_SYSTEM, contractReviewPacket } = await import("../src/main/contract-review.js");
const { redactSecrets } = await import("../src/main/safe.js");
ensureHome(); setWorkdir(root);
const target = chatTarget(loadConfig());
const profile = { version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] };
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify(profile));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
afterEach(() => { globalThis.fetch = async () => { throw Error("No live provider."); }; setWorkdir(root); });
after(() => { setApprovalNotifier(null); globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); });
const definitions = windowToolDefs({ local: true, remote: false, search: false }).filter(row => ["host_file_write", "host_run"].includes(row.function.name));
const hash = text => createHash("sha256").update(text).digest("hex");
const frame = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const done = content => frame({ content }) + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const tool = (name, args, id) => frame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
  + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
const emptyReview = () => done('{"findings":[],"limitations":[]}');
function fixture(name) { const dir = join(root, name); mkdirSync(dir); setWorkdir(dir); return dir; }
function provider(main, review = emptyReview) {
  const requests = [], reviews = []; let mainCount = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `${target.url}/chat/completions`);
    const body = JSON.parse(options.body); requests.push(body);
    const isReview = body.messages[0]?.content === CONTRACT_REVIEW_SYSTEM;
    if (isReview) {
      reviews.push(body); const response = review(body, reviews.length, options);
      return response instanceof Response ? response : new Response(response);
    }
    return new Response(main(body, ++mainCount));
  };
  return { requests, reviews, mainCount: () => mainCount };
}

test("default-on actual SSE review uses the same selected backend, fresh data, no tools and1536 lower reserve", async () => {
  const dir = fixture("default"), path = join(dir, "feature.mjs"), source = 'console.log("READY");\n', session = createSession(), events = [];
  const flow = provider((_body, n) => n === 1 ? tool("host_file_write", { path, content: source }, "write") : done("Created feature.mjs; its actual runtime check printed READY."), body => {
    assert.equal(body.model, target.model); assert.equal(body.max_tokens, 1536); assert.equal(body.temperature, 0);
    assert.equal(body.think, true); assert.equal(body.chat_template_kwargs.enable_thinking, true);
    assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined); assert.equal(body.messages.length, 2);
    const packet = JSON.parse(body.messages[1].content);
    assert(packet.actualRequest[0].includes("Create feature.mjs")); assert.equal(packet.sources[0].beforeHash, null);
    assert.equal(packet.sources[0].afterHash, hash(source)); assert(packet.receiptSummaries.some(row => row.ok && row.phase === "runtime"));
    return emptyReview();
  });
  const result = await runTurn([], "Create feature.mjs that prints READY.", event => events.push(event), AbortSignal.timeout(10000), { sessionId: session.id, tools: definitions });
  assert.equal(flow.mainCount(), 2); assert.equal(flow.reviews.length, 1); assert.equal(flow.requests.length, 3);
  assert.equal(flow.requests[0].max_tokens, 8192); assert.equal(readFileSync(path, "utf8"), source);
  assert.equal(result.advisoryReview.status, "completed"); assert.equal(result.advisoryReview.advisory, true);
  assert.deepEqual(new VerificationLedger(session.id, dir).debt(), []);
  assert(!events.some(row => row.type === "tool_result" && row.name === "contract_review"));
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), "utf8")), profile);
});

test("one advisory finding can inform a real parent check without replaying writes or creating debt", async () => {
  const dir = fixture("finding"), path = join(dir, "feature.mjs"), session = createSession(), events = [];
  const flow = provider((body, n) => {
    if (n === 1) return tool("host_file_write", { path, content: 'console.log("READY");\n' }, "write");
    if (n === 2) return done("The helper was saved and READY was observed.");
    assert(body.messages.some(row => row.role === "assistant" && String(row.content).includes("<advisory_contract_review>")));
    return n === 3 ? tool("host_run", { command: "node feature.mjs", cwd: dir }, "actual-check") : done("The direct runtime check printed READY; this is the observed result.");
  }, () => done('{"findings":[{"sourceId":"source-1","kind":"verification_gap","message":"A direct follow-up check could clarify the handoff.","evidence":"Only supplied receipt scope should be claimed."}],"limitations":[]}'));
  const result = await runTurn([], "Create feature.mjs that prints READY.", event => events.push(event), AbortSignal.timeout(10000), { sessionId: session.id, tools: definitions });
  assert.equal(flow.reviews.length, 1); assert.equal(flow.mainCount(), 4);
  assert.equal(events.filter(row => row.type === "tool" && row.name === "host_file_write").length, 1);
  assert(events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok && row.detail.includes("READY")));
  assert.deepEqual(new VerificationLedger(session.id, dir).debt(), []);
  assert.equal(result.advisoryReview.findings.length, 1); assert.match(result.assistant, /not verification/);
});

test("an unavailable reviewer gives no extra judgment and preserves the real successful check", async () => {
  const dir = fixture("unavailable"), path = join(dir, "feature.mjs"), session = createSession();
  const flow = provider((_body, n) => n === 1 ? tool("host_file_write", { path, content: 'console.log("READY");\n' }, "write") : done("The saved helper printed READY."), () => { throw Error("fixture review unavailable"); });
  const result = await runTurn([], "Create feature.mjs that prints READY.", () => {}, AbortSignal.timeout(10000), { sessionId: session.id, tools: definitions });
  assert.equal(flow.reviews.length, 1); assert.equal(flow.requests.length, 3);
  assert.equal(result.advisoryReview.status, "unavailable"); assert.match(result.assistant, /no additional judgment/);
  assert.deepEqual(new VerificationLedger(session.id, dir).debt(), []);
});

test("an empty advisory response cannot discharge an actual failed runtime obligation", async () => {
  const dir = fixture("failed"), path = join(dir, "broken.mjs"), session = createSession();
  const flow = provider((_body, n) => n === 1 ? tool("host_file_write", { path, content: 'throw Error("ACTUAL_FAILURE");\n' }, "write") : done("PASS. All checks passed."));
  const result = await runTurn([], "Create broken.mjs and verify its behavior.", () => {}, AbortSignal.timeout(10000), { sessionId: session.id, tools: definitions });
  assert.equal(flow.reviews.length, 1); assert(flow.requests.length < 15);
  assert(!/^PASS\b/.test(result.assistant), result.assistant);
  assert(new VerificationLedger(session.id, dir).debt().some(row => row.includes("broken.mjs") && row.includes("runtime")));
});

test("review-only human steering after a real write suppresses advisory requests", async () => {
  const dir = fixture("steering"), path = join(dir, "feature.mjs"); let batch = null;
  const flow = provider((_body, n) => {
    if (n === 1) return tool("host_file_write", { path, content: 'console.log("READY");\n' }, "write");
    if (n === 2) batch = { receipt: "review-only", messages: [{ content: "Stop editing; review only." }] };
    return done("The recorded source and runtime result are available for review.");
  });
  await runTurn([], "Create feature.mjs that prints READY.", () => {}, AbortSignal.timeout(10000), { sessionId: createSession().id, tools: definitions, takeInput: () => batch, ackInput: () => { batch = null; } });
  assert.equal(flow.reviews.length, 0); assert.equal(flow.mainCount(), 3);
});

test("Stop during an actual advisory SSE request cancels it without replaying a completed write", async () => {
  const dir = fixture("stop"), path = join(dir, "feature.mjs"), controller = new AbortController();
  const flow = provider((_body, n) => n === 1 ? tool("host_file_write", { path, content: 'console.log("READY");\n' }, "write") : done("The helper was saved."), (_body, _n, options) => new Response(new ReadableStream({
    start(stream) { options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true }); setTimeout(() => controller.abort(), 5); },
  })));
  await assert.rejects(runTurn([], "Create feature.mjs that prints READY.", () => {}, controller.signal, { sessionId: createSession().id, tools: definitions }), { name: "AbortError" });
  assert.equal(flow.reviews.length, 1); assert.equal(flow.requests.length, 3); assert.equal(readFileSync(path, "utf8"), 'console.log("READY");\n');
});

test("private cached source getter binds canonical aliases and performs no filesystem lookup", async () => {
  const dir = fixture("cache-getter"), actual = join(dir, "actual"), alias = join(dir, "alias"); mkdirSync(actual); symlinkSync(actual, alias);
  const path = join(alias, "source.mjs"), text = 'console.log("READY");\n', session = createSession(); setWorkdir(alias);
  const gate = createHarness({ sessionId: session.id, localExec: async () => ({ ok: true, exitCode: 0, stdout: "READY", stderr: "" }) });
  const args = { path, content: text }; assert.equal(gate.before("host_file_write", args), null); writeFileSync(path, text);
  await gate.after("host_file_write", args, { ok: true, path, bytes: Buffer.byteLength(text) });
  const fs = createRequire(import.meta.url)("node:fs"), saved = {}, blocked = ["readFileSync", "realpathSync", "statSync", "lstatSync", "existsSync"]; let reads = 0;
  try {
    for (const name of blocked) { saved[name] = fs[name]; fs[name] = () => { reads++; throw Error("Getter must stay cached."); }; }
    syncBuiltinESMExports(); const changes = gate.contractReviewSources();
    assert.equal(changes.snapshots.length, 1); assert.equal(changes.snapshots[0].path, join(actual, "source.mjs"));
    assert.equal(changes.snapshots[0].beforeHash, null); assert.equal(changes.snapshots[0].afterHash, hash(text)); assert.equal(reads, 0);
  } finally { for (const name of blocked) fs[name] = saved[name]; syncBuiltinESMExports(); }
  writeFileSync(path, 'console.log("HUMAN_CHANGE");\n'); gate.debt();
  const stale = gate.contractReviewSources(); assert.equal(stale.snapshots.length, 0); assert(stale.omitted.some(row => /stale/.test(row.reason)));
  gate.finish();
});

test("cached snapshots from another chat never enter this turn's review input", async () => {
  const dir = fixture("session-isolation"), one = createSession(), two = createSession();
  const gates = [one, two].map(session => createHarness({ sessionId: session.id, localExec: async () => ({ ok: true, exitCode: 0, stdout: "READY", stderr: "" }) }));
  for (let index = 0; index < 2; index++) {
    const path = join(dir, `session-${index}.mjs`), text = `console.log("SESSION_${index}");\n`, args = { path, content: text };
    assert.equal(gates[index].before("host_file_write", args), null); writeFileSync(path, text);
    await gates[index].after("host_file_write", args, { ok: true, path, bytes: Buffer.byteLength(text) });
  }
  for (let index = 0; index < 2; index++) {
    const changes = gates[index].contractReviewSources();
    assert.equal(changes.snapshots.length, 1); assert.equal(changes.snapshots[0].path, join(dir, `session-${index}.mjs`));
    assert(!JSON.stringify(changes).includes(`SESSION_${1 - index}`)); gates[index].finish();
  }
});


test("baseline bodies come only from prior cache and remain immutable after repeated canonical-alias edits", async () => {
  const dir = fixture("baseline-cache"), actual = join(dir, "actual"), alias = join(dir, "alias"); mkdirSync(actual); symlinkSync(actual, alias); setWorkdir(alias);
  const path = join(alias, "source.mjs"), secret = "sk-fixtureBaselineValue123456789", before = `export const value = "${secret}";\n`;
  writeFileSync(path, before);
  const gate = createHarness({ sessionId: createSession().id, localExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }) });
  gate.note("host_file_read", { path }, { ok: true, path, text: before });
  for (const value of ["first", "second"]) {
    const content = `export const value = "${value}";\n`, args = { path, content };
    assert.equal(gate.before("host_file_write", args), null); writeFileSync(path, content); await gate.after("host_file_write", args, { ok: true, path });
  }
  const fs = createRequire(import.meta.url)("node:fs"), saved = {}, blocked = ["readFileSync", "realpathSync", "statSync", "lstatSync", "existsSync"]; let reads = 0, changes;
  try {
    for (const name of blocked) { saved[name] = fs[name]; fs[name] = () => { reads++; throw Error("Getter must stay cached."); }; }
    syncBuiltinESMExports(); changes = gate.contractReviewSources();
  } finally { for (const name of blocked) fs[name] = saved[name]; syncBuiltinESMExports(); }
  assert.equal(reads, 0); assert.equal(changes.snapshots[0].beforeHash, hash(before)); assert.equal(changes.snapshots[0].beforeText, before);
  assert.equal(changes.snapshots[0].afterHash, hash('export const value = "second";\n'));
  const packet = contractReviewPacket({ ask: "Preserve the existing behavior while extending source.mjs.", changes }, { redact: redactSecrets });
  assert.equal(packet.sources[0].baselineTextProvided, true); assert(!JSON.stringify(packet).includes(secret)); assert.match(packet.sources[0].beforeExcerpts[0].text, /redacted/);
  gate.finish();
});

test("large cached baseline bodies stay hash-only, and stale cached prior cannot be relabelled as the initial version", async () => {
  const dir = fixture("baseline-large");
  for (const large of [true, false]) {
    const path = join(dir, `${large ? "large" : "stale"}.mjs`), before = 'export const value = 1;\n' + (large ? "// baseline padding\n".repeat(500) : ""), next = before.replace("value = 1", "value = 2");
    writeFileSync(path, before);
    const gate = createHarness({ sessionId: createSession().id, localExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }) });
    gate.note("host_file_read", { path }, { ok: true, path, text: before });
    const args = { path, content: next }; assert.equal(gate.before("host_file_write", args), null); writeFileSync(path, next); await gate.after("host_file_write", args, { ok: true, path });
    const changes = gate.contractReviewSources(), row = changes.snapshots[0];
    assert.equal(row.beforeHash, hash(before));
    if (large) {
      assert.equal(row.beforeText, undefined); assert.match(row.beforeOmission, /not_captured_or_exceeds_bound/);
      const packet = contractReviewPacket({ ask: "Extend the source while preserving existing behavior.", changes }, { redact: redactSecrets });
      assert.equal(packet.sources[0].baselineTextProvided, false); assert.match(packet.sources[0].baselineOmission, /not_captured_or_exceeds_bound/);
    } else {
      // A later read refreshes the mutable prior cache; it cannot overwrite the frozen baseline body.
      gate.note("host_file_read", { path }, { ok: true, path, text: next });
      assert.equal(gate.contractReviewSources().snapshots[0].beforeText, before);
      writeFileSync(path, 'export const value = 999;\n'); gate.debt();
      assert.equal(gate.contractReviewSources().snapshots.length, 0);
    }
    gate.finish();
  }
});

test("baseline capture never retains a fifth file even when older current witnesses become stale", async () => {
  const dir = fixture("baseline-count"), gate = createHarness({ sessionId: createSession().id, localExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }) }), paths = [];
  for (let index = 0; index < 5; index++) {
    const path = join(dir, `source-${index}.mjs`), before = `export const value = ${index};\n`, content = `export const value = ${index + 10};\n`; paths.push(path); writeFileSync(path, before);
    gate.note("host_file_read", { path }, { ok: true, path, text: before });
    assert.equal(gate.before("host_file_write", { path, content }), null); writeFileSync(path, content); await gate.after("host_file_write", { path, content }, { ok: true, path });
  }
  for (const path of paths.slice(0, 4)) writeFileSync(path, 'export const externallyChanged = true;\n');
  gate.debt(); const changes = gate.contractReviewSources();
  assert.equal(changes.snapshots.length, 1); assert.equal(changes.snapshots[0].path, paths[4]);
  assert.equal(changes.snapshots[0].beforeText, undefined); assert.match(changes.snapshots[0].beforeOmission, /not_captured_or_exceeds_bound/);
  gate.finish();
});
