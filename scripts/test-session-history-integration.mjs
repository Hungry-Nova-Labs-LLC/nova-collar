import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "collar-recall-integration-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
globalThis.fetch = async () => { throw Error("No network is permitted in this integration fixture."); };
const { ensureHome } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { runTurn } = await import("../src/main/agent.js");
const { recallSessionHistory, sessionHistoryStatus } = await import("../src/main/session-history.js");
ensureHome(); setWorkdir(home);
after(() => rmSync(home, { recursive: true, force: true }));

test("the real lead can recall a receipt removed from its normal model view", async () => {
  const session = createSession(), history = [];
  for (let n = 0; n < 16; n++) {
    history.push({ role: "user", content: `Earlier request ${n}` },
      { role: "assistant", content: "", tool_calls: [{ id: `read-${n}`, type: "function", function: { name: "host_file_read", arguments: '{"path":"example.txt"}' } }] },
      { role: "tool", tool_call_id: `read-${n}`, content: n === 0 ? "ORIGINAL_RECEIPT_MARKER followed by preserved source text." : `Later receipt ${n}` },
      { role: "assistant", content: `Earlier result ${n}` });
  }
  let calls = 0, retrieved;
  const result = await runTurn(history, "Recall the original receipt marked ORIGINAL_RECEIPT_MARKER and report it as historical evidence.", () => {}, null,
    { sessionId: session.id, tools: [], complete: async (messages, _cfg, _delta, _signal, options) => {
      calls++;
      if (calls === 1) {
        assert(options.tools.some(tool => tool.function.name === "context_recall"));
        assert(!messages.some(row => row.role === "tool" && String(row.content).includes("ORIGINAL_RECEIPT_MARKER")), "old receipt is outside the initial model window");
        return { content: "", tool_calls: [{ id: "recall", type: "function", function: { name: "context_recall", arguments: '{"query":"ORIGINAL_RECEIPT_MARKER","role":"tool"}' } }] };
      }
      const wire = messages.findLast(row => row.role === "tool" && row.tool_call_id === "recall");
      assert(wire, "recall executes through the production lead tool dispatcher");
      retrieved = JSON.parse(wire.content);
      assert(retrieved.results[0].excerpt.includes("ORIGINAL_RECEIPT_MARKER"));
      return { content: "The archived original receipt contains ORIGINAL_RECEIPT_MARKER. This is historical source evidence.", tool_calls: [] };
    } });
  assert(result.assistant.includes("ORIGINAL_RECEIPT_MARKER"));
  assert.equal(retrieved.kind, "archived_session_source_data");
  assert(sessionHistoryStatus(session.id).entries > history.length);
  assert(recallSessionHistory(session.id, { query: "historical source evidence", role: "assistant" }).results.length > 0, "the final answer is archived before the lead returns");
  assert.equal(recallSessionHistory(session.id, { query: "x", session_id: "another-chat" }).ok, false);
});
