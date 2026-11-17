import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), "decision-production-")));
process.env.NOVAPUP_HOME = join(root, "profile"); process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8"; process.env.OLLAMA_MODEL = "fixture-local-chat";
for (const key of ["HNL_FAST_URL", "HNL_FAST_MODEL", "HNL_THINK_URL", "HNL_THINK_MODEL", "HNL_CHAT_KEY", "HNL_TOOLS_KEY"]) process.env[key] = "";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No live inference/network in decision adviser fixture."); };
const { ensureHome, chatTarget, loadConfig } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome(); const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model,
  contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { globalThis.fetch = nativeFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, remote: false, search: false }).filter(row => ["host_file_read", "host_file_write", "host_run"].includes(row.function.name));
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });
let seq = 0;
function fixture(enabled = true) {
  const cwd = join(root, String(++seq)); mkdirSync(cwd); setWorkdir(cwd);
  writeFileSync(join(process.env.NOVAPUP_HOME, "decision-adviser.json"), JSON.stringify({ enabled, endpoint: "http://127.0.0.1:9999/decisions", timeoutMs: 1000, maxPerTurn: 1 }));
  writeFileSync(join(cwd, "feature.mjs"), "export const value = 1;\n");
  writeFileSync(join(cwd, "verify.mjs"), 'import assert from "node:assert/strict"; import {value} from "./feature.mjs"; assert.equal(value,2); console.log("REAL_DECISION_REPAIR_OK");\n');
  return { cwd, session: createSession(), events: [] };
}
const ask = "Fix only feature.mjs and verify it using the existing verify.mjs. Keep verification assertions unchanged.";
const firstBatch = f => [call("host_file_read", { path: "feature.mjs" }, "read-source"),
  call("host_run", { command: "node verify.mjs", cwd: f.cwd }, "failed-check"), call("host_file_read", { path: "verify.mjs" }, "read-check")];
async function repair(f, requestDecisionAdvice, { onSecond = () => {} } = {}) {
  let primary = 0;
  const result = await runTurn([], ask, event => f.events.push(event), AbortSignal.timeout(15000), { sessionId: f.session.id, tools, sourcePreload: false, requestDecisionAdvice,
    complete: async (messages, _cfg, _delta, _signal, options) => {
      if (options.requestKind === "contract_review") return reply('{"findings":[],"limitations":[]}');
      primary++;
      if (primary === 1) return reply("", firstBatch(f));
      if (primary === 2) {
        assert(new VerificationLedger(f.session.id, f.cwd).debt().length > 0, "model advice cannot clear actual failed-check debt");
        onSecond(messages);
        return reply("", [call("host_file_write", { path: "feature.mjs", content: "export const value = 2;\n" }, "repair")]);
      }
      if (primary === 3) return reply("", [call("host_run", { command: "node verify.mjs", cwd: f.cwd }, "real-rerun")]);
      return reply("Repaired feature.mjs. The unchanged node verify.mjs printed REAL_DECISION_REPAIR_OK.");
    } });
  assert.equal(readFileSync(join(f.cwd, "feature.mjs"), "utf8"), "export const value = 2;\n");
  assert.deepEqual(new VerificationLedger(f.session.id, f.cwd).debt(), []);
  return result;
}

test("actual native failure settles the entire tool batch before one choice-only untrusted observation", async () => {
  const f = fixture(); let calls = 0;
  await repair(f, async input => {
    calls++; assert(f.events.some(row => row.type === "tool_result" && row.name === "host_run" && row.ok === false));
    assert.equal(f.events.filter(row => row.type === "tool_result" && row.name === "host_file_read").length, 2);
    assert.match(input.state.failure.command, /node verify/); assert.equal(input.state.failure.exitCode, null, "do not invent a numeric exit absent from the native receipt");
    assert(input.state.sources.some(row => row.path === "feature.mjs"));
    assert(!input.actions.some(row => row.id === "report_done" || row.id === "delegate"));
    return { ok: true, choice: "fix_code", elapsedMs: 2 };
  }, { onSecond(messages) {
    const rows = messages.filter(row => String(row.content).includes("<untrusted_decision_advice>"));
    assert.equal(rows.length, 1); assert.equal(rows[0].role, "user"); assert.match(rows[0].content, /suggested next step=fix_code/);
    assert(!rows[0].content.includes("probabilities"));
    const lastTool = messages.findIndex(row => row.tool_call_id === "read-check"); assert(messages.indexOf(rows[0]) > lastTool);
  } });
  assert.equal(calls, 1); assert.equal(f.events.filter(row => row.type === "decision_advice").length, 1);
  assert(!f.events.some(row => row.type === "tool_result" && row.name === "decision_advice"));
});

test("default off, malformed completion choice and unavailable service preserve native repair and verification", async () => {
  for (const mode of ["off", "malformed", "timeout"]) {
    const f = fixture(mode !== "off"); let calls = 0;
    await repair(f, async () => { calls++; return mode === "malformed" ? { ok: true, choice: "report_done" } : { ok: false, reason: "timeout" }; },
      { onSecond(messages) { assert(!messages.some(row => String(row.content).includes("<untrusted_decision_advice>"))); } });
    assert.equal(calls, mode === "off" ? 0 : 1);
    assert(!f.events.some(row => row.type === "decision_advice" && row.status === "completed"));
  }
});

test("actual owner review-only steering during advice discards the late choice and keeps write tools suspended", async () => {
  const f = fixture(); let batch = null, primary = 0, calls = 0;
  await runTurn([], ask, event => f.events.push(event), AbortSignal.timeout(15000), { sessionId: f.session.id, tools, sourcePreload: false,
    takeInput: () => batch, ackInput: () => { batch = null; },
    requestDecisionAdvice: async () => { calls++; batch = { messages: [{ content: "Stop editing; review only." }] }; return { ok: true, choice: "fix_code" }; },
    complete: async (messages, _cfg, _delta, _signal, options) => {
      if (options.requestKind === "contract_review") return reply('{"findings":[],"limitations":[]}');
      primary++; if (primary === 1) return reply("", firstBatch(f));
      assert(!messages.some(row => String(row.content).includes("<untrusted_decision_advice>")));
      assert(!options.tools.some(row => row.function.name === "host_file_write"));
      return reply("The current source remains unchanged. The actual check failed because value was 1; no repair was made after your review-only instruction.");
    } });
  assert.equal(calls, 1); assert.equal(readFileSync(join(f.cwd, "feature.mjs"), "utf8"), "export const value = 1;\n");
  assert(f.events.some(row => row.type === "decision_advice" && row.status === "discarded"));
});

test("Stop during optional advice aborts without replaying or changing the completed source/check", async () => {
  const f = fixture(), controller = new AbortController(); let primary = 0, calls = 0;
  await assert.rejects(runTurn([], ask, event => f.events.push(event), controller.signal, { sessionId: f.session.id, tools, sourcePreload: false,
    requestDecisionAdvice: input => new Promise(resolve => {
      calls++; input.signal.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true }); controller.abort();
    }), complete: async () => { primary++; return reply("", firstBatch(f)); } }), { name: "AbortError" });
  assert.equal(calls, 1); assert.equal(primary, 1); assert.equal(readFileSync(join(f.cwd, "feature.mjs"), "utf8"), "export const value = 1;\n");
  assert(!f.events.some(row => row.type === "decision_advice" && row.status === "completed"));
});
