import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "collar-python-context-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No native inference or network permitted."); };
const { complete, runTurn } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval } = await import("../src/main/approvals.js");
ensureHome();
const target = chatTarget(loadConfig());
writeFileSync(join(process.env.NOVAPUP_HOME, "model-settings.json"), JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192, temperature: 0, reasoning: true }] }));
setApprovalNotifier(event => { if (event.type === "approval") resolveApproval(event.request.id, true); });
after(() => { globalThis.fetch = originalFetch; setApprovalNotifier(null); rmSync(root, { recursive: true, force: true }); });
const tools = windowToolDefs({ local: true, search: false, remote: false }).filter(t => ["host_run", "host_file_read"].includes(t.function.name));
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const stream = (calls = [], content = "") => new Response((content ? frame({ choices: [{ delta: { content } }] }) : "")
  + frame({ choices: [{ delta: calls.length ? { tool_calls: calls.map((c, index) => ({ index, ...c })) } : {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");

test("actual Python stdin failure adds bounded redacted source context to the next serialized request after normal result packing", async () => {
  setWorkdir(root);
  const protectedFile = join(root, "check-contract.txt"); writeFileSync(protectedFile, "User-supplied requirements stay unchanged.\n");
  const token = "sk-fixtureSecretValue123456789";
  const command = `cd '${root}' && PYTHONPATH=src python3 - <<'PY_LITERAL'\nprint("x" * 12000)\nvalues = [11, 17]\nmarker = "${token}"\nexpected = 29\nassert sum(values) == expected, (sum(values), expected)\nPY_LITERAL`;
  const events = [], bodies = []; let requests = 0, feedback = "";
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body); bodies.push(body); requests++;
    assert.equal(body.max_tokens, 8192); assert.equal(body.options.num_ctx, 131072);
    if (requests === 1) return stream([call("host_run", { command, cwd: root, timeoutMs: 5000 }, "literal-failure")]);
    const receipt = body.messages.find(row => row.role === "tool" && row.tool_call_id === "literal-failure");
    assert(receipt, "the actual serialized request must retain the failed tool receipt"); feedback = receipt.content;
    assert.match(feedback, /Observed failure:[\s\S]*AssertionError/);
    assert.match(feedback, /"kind":"submitted_literal_python"/);
    assert.match(feedback, /"reportedLine":5/);
    assert.match(feedback, /assert sum\(values\) == expected/);
    assert.match(feedback, /If the check is valid, repair the implementation/);
    assert.match(feedback, /Only a demonstrably mistaken expectation[\s\S]*authored during this task/);
    assert.match(feedback, /Do not weaken user-supplied or protected checks/);
    assert(!feedback.includes(token), "nearby quoted program source must use existing secret redaction");
    assert.match(feedback, /\[redacted\]/);
    const packed = JSON.parse(feedback.split("\n\nObserved failure:")[0]);
    assert.equal(packed.ok, false); assert.equal(packed.testFailure, false, "added context must not create new test classification");
    assert.equal(packed.stdout_truncated, true, "large stdout must exercise the ordinary local result packer");
    assert(packed.stderr.includes("AssertionError"), "raw terminal exception survives alongside quoted source context");
    assert(body.messages.every(row => row.role !== "user" || !String(row.content).includes('"kind":"submitted_literal_python"')), "the quoted source is never promoted into a human instruction");
    return stream([], "The supplied check failed with AssertionError. I have not changed any requirements or files and have not confirmed task success.");
  };
  const result = await runTurn([], "Run the supplied Python command and report the observed outcome. Keep check-contract.txt unchanged. Do not claim a check passed unless its actual result did.", e => events.push(e), AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools, sourcePreload: false,
    complete: (messages, cfg, delta, signal, options) => complete(messages, cfg, delta, signal, options),
  });
  assert(requests >= 2 && requests <= 3); assert(feedback);
  assert.equal(readFileSync(protectedFile, "utf8"), "User-supplied requirements stay unchanged.\n");
  assert.equal(events.filter(e => e.type === "tool" && e.name === "host_run").length, 1);
  assert(!events.some(e => e.type === "tool" && ["host_file_edit", "host_file_write"].includes(e.name)));
  assert(!events.some(e => e.verification?.status === "passed" && e.verification?.phase !== "syntax"));
  assert.match(result.assistant, /failed|Incomplete|not confirmed/i);
});
