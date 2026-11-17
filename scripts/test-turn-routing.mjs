import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "collar-routing-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No network is permitted in the routing fixture."); };
const { ensureHome } = await import("../src/main/config.js");
const { createSession } = await import("../src/main/sessions.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { runTurn } = await import("../src/main/agent.js");
const { windowToolDefs } = await import("../src/main/tools.js");
const { toolsForAsk } = await import("../src/main/serve.js");
const { TAG_TURN_BEHAVIOR } = await import("../src/main/tag-behavior.js");
ensureHome(); setWorkdir(home);
after(() => { globalThis.fetch = nativeFetch; rmSync(home, { recursive: true, force: true }); });
const source = join(home, "sample.txt"); writeFileSync(source, "ROUTING_MARKER\n");
const definitions = windowToolDefs({ local: true, search: false, remote: false });
const readOnly = definitions.filter(row => row.function.name === "host_file_read");
const call = (name, args) => ({ id: "fixture-call", type: "function", function: { name, arguments: JSON.stringify(args) } });

for (const constraint of ["Do not inspect any service.", "Avoid checking disk space.", "Do not inspect open ports.", "Do not touch the terminal."]) {
  test(`real lead file access survives an unrelated negative constraint: ${constraint}`, async () => {
    let calls = 0; const events = [];
    const session = createSession();
    const result = await runTurn([], `Read sample.txt and report its marker. ${constraint}`, event => events.push(event), null,
      { sessionId: session.id, pack: "host", tools: readOnly, complete: async (messages) => {
        calls++;
        assert(messages[0].content.includes(TAG_TURN_BEHAVIOR), "the actual model request includes Tag turn behavior, not only its context preview");
        if (calls === 1) return { content: "", tool_calls: [call("host_file_read", { path: source })] };
        const receipt = messages.findLast(row => row.role === "tool" && row.tool_call_id === "fixture-call");
        assert(receipt?.content.includes("ROUTING_MARKER"), "permitted file tool executes through the production dispatcher");
        return { content: "The file contains ROUTING_MARKER.", tool_calls: [] };
      } });
    assert(result.assistant.includes("ROUTING_MARKER"));
    assert(events.some(event => event.type === "tool_result" && event.name === "host_file_read" && event.ok));
    assert.equal(calls, 2);
  });
}

test("a positive service-status request still narrows initial disclosure", () => {
  const choices = windowToolDefs({ local: false, search: false, remote: false }).filter(row => ["host_service_status", "host_file_read"].includes(row.function.name));
  assert.equal(choices.length, 2, "this surface permits both service status and file access");
  assert.deepEqual(toolsForAsk(choices, "Check the nginx service status", []).map(row => row.function.name), ["host_service_status"]);
});

test("a catalog-permitted tool still cannot execute when absent from this request's schemas", async () => {
  const choices = windowToolDefs({ local: false, search: false, remote: false }).filter(row => ["host_service_status", "host_file_read"].includes(row.function.name));
  let calls = 0; const events = [];
  await runTurn([], "Check the nginx service status", event => events.push(event), null,
    { sessionId: createSession().id, tools: choices, complete: async (messages, _config, _delta, _signal, options) => {
      calls++;
      assert(options.tools.some(tool => tool.function.name === "host_service_status"));
      assert(!options.tools.some(tool => tool.function.name === "host_file_read"), "service relevance selected the initial schemas");
      if (calls === 1) return { content: "", tool_calls: [call("host_file_read", { path: source })] };
      const receipt = messages.findLast(row => row.role === "tool");
      assert(receipt.content.includes("not currently disclosed"));
      assert(!receipt.content.includes("ROUTING_MARKER"));
      return { content: "I cannot report the service state because no status tool has run.", tool_calls: [] };
    } });
  assert.equal(calls, 2);
  assert(events.some(event => event.type === "tool_result" && event.name === "host_file_read" && event.ok === false));
  assert(!events.some(event => event.type === "tool_result" && event.name === "host_file_read" && event.ok === true));
});

test("relevance cannot grant an out-of-catalog write", async () => {
  const destination = join(home, "not-authorized.txt"), events = [];
  let calls = 0;
  await runTurn([], "Describe the available read-only tool. Do not inspect any service.", event => events.push(event), null,
    { sessionId: createSession().id, tools: readOnly, complete: async (messages) => {
      calls++;
      if (calls === 1) return { content: "", tool_calls: [call("host_file_write", { path: destination, content: "Must never be written" })] };
      const receipt = messages.findLast(row => row.role === "tool");
      assert(receipt.content.includes("not currently disclosed"));
      return { content: "I cannot perform that write with the offered tools.", tool_calls: [] };
    } });
  assert.equal(existsSync(destination), false);
  assert(events.some(event => event.type === "tool_result" && event.name === "host_file_write" && event.ok === false));
});
