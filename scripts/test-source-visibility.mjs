import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-source-visibility-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "absent-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("Live models/network forbidden."); };
const { ensureHome, loadConfig, chatTarget } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { readUserFile } = await import("../src/main/files.js");
const { compactResult, executeTool, windowToolDefs } = await import("../src/main/tools.js");
const { redactSecrets } = await import("../src/main/safe.js");
const { createHarness } = await import("../src/main/harness.js");
const { runTurn } = await import("../src/main/agent.js");
ensureHome(); setWorkdir(root);
after(() => { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); });
const make = (name, text) => { const path = join(root, name); writeFileSync(path, text); return path; };
const packed = (value, max = 4000) => {
  const text = compactResult(value, { max }); assert(text.length <= max, `packed ${text.length} > ${max}`);
  return JSON.parse(text);
};

test("full and local read schemas expose explicit redacted character coordinates", () => {
  for (const local of [true, false]) {
    const definition = windowToolDefs({ local, remote: false }).find(row => row.function.name === "host_file_read");
    assert.equal(definition.function.parameters.properties.offset.type, "integer");
    assert.equal(definition.function.parameters.properties.limit.type, "integer");
    assert.match(definition.function.description, /zero-based character/);
    assert.match(definition.function.description, /partial page is not whole-file coverage/);
  }
});

test("default small reads preserve exact visible text and report complete-file coverage", () => {
  const text = '\uFEFFconst title = "Ω🐙";\r\nexport const result = 42;\r\n', path = make("small.mjs", text);
  const result = readUserFile(path), view = packed(result);
  assert.equal(view.text, text); assert.equal(view.bytes, Buffer.byteLength(text));
  assert.equal(view.read.offset, 0); assert.equal(view.read.totalChars, text.length);
  assert.equal(view.read.totalLines, 3); assert.equal(view.read.endOffset, text.length);
  assert.equal(view.read.completeFile, true); assert.equal(view.read.nextOffset, null);
  assert.equal(view.text_truncated, false); assert.equal(view.packing, undefined);
});

test("4000-character packing reconstructs quote-heavy long-line source without gaps or invented text", () => {
  const text = ('const value = "\\\"Ω🐙\\n"; ' + '"'.repeat(30)).repeat(150) + "\nEND_OF_SOURCE\n";
  const path = make("quote-heavy.mjs", text), before = statSync(path);
  let offset = 0, output = "", pages = 0, hash;
  do {
    const result = readUserFile(path, { offset }), view = packed(result);
    assert.equal(view.ok, true); assert.equal(view.read.offset, offset);
    assert.equal(view.read.endOffset, offset + view.text.length);
    assert.equal(view.read.totalChars, text.length); assert.equal(view.read.totalLines, 3);
    assert.equal(view.read.completeFile, false);
    assert(!/[\uD800-\uDBFF]$/.test(view.text));
    if (hash) assert.equal(view.read.viewSha256, hash); else hash = view.read.viewSha256;
    output += view.text; pages++;
    if (view.read.nextOffset === null) { assert.equal(view.read.eof, true); break; }
    assert(view.read.nextOffset > offset, "every advertised page advances");
    assert.equal(view.packing.truncated, true); assert.equal(view.text_truncated, true);
    offset = view.read.nextOffset;
    assert(pages < 50, "bounded paging should converge");
  } while (true);
  assert(pages > 1); assert.equal(output, text);
  const after = statSync(path); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
});

test("requested ranges stay within the request and update visible line metadata", async () => {
  const text = "first\nsecond line\nthird line", path = make("range.txt", text);
  const raw = await executeTool("host_file_read", { path, offset: 6, limit: 7 }, loadConfig());
  const view = packed(raw);
  assert.equal(view.text, "second "); assert.equal(view.read.offset, 6); assert.equal(view.read.endOffset, 13);
  assert.equal(view.read.startLine, 2); assert.equal(view.read.endLine, 2);
  assert.equal(view.read.nextOffset, 13); assert.equal(view.read.completeFile, false);
  assert.equal(view.read.totalChars, text.length); assert.equal(view.read.totalLines, 3);
});

test("paging redacts the entire view before slicing and never leaks a partial secret", () => {
  const secret = "sk-fixturePrivateValue123456789", text = `before ${secret} after\n`, path = make("redacted.txt", text);
  const expected = redactSecrets(text); let output = "";
  for (let offset = 0; offset < expected.length; offset++) {
    const view = packed(readUserFile(path, { offset, limit: 1 }));
    assert.equal(view.text, expected.slice(offset, offset + 1)); output += view.text;
  }
  assert.equal(output, expected); assert(!output.includes(secret));
  assert.equal(packed(readUserFile(make(".env", secret))).ok, false);
});

test("range errors are explicit; empty files and directories keep honest metadata", () => {
  const path = make("empty.txt", "");
  const empty = packed(readUserFile(path));
  assert.equal(empty.read.totalChars, 0); assert.equal(empty.read.totalLines, 0);
  assert.equal(empty.read.completeFile, true); assert.equal(empty.read.nextOffset, null);
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { offset: 1 }, { limit: 0 }, { limit: 80001 }, { limit: "4" }]) assert.equal(readUserFile(path, options).ok, false);
  const unicode = make("emoji.txt", "🐙tail");
  assert.equal(readUserFile(unicode, { offset: 1 }).ok, false);
  assert.equal(readUserFile(unicode, { offset: 0, limit: 1 }).ok, false);
  assert.equal(readUserFile(unicode, { offset: 0, limit: 2 }).text, "🐙");
  const dir = packed(readUserFile(root)); assert.equal(dir.directory, true); assert(Array.isArray(dir.entries));
});

test("pages expose changed redacted view identity without granting write or verification credit", () => {
  const path = make("changing.mjs", "export const value = 1;\n"), gate = createHarness({ requireEdits: false });
  const one = readUserFile(path, { limit: 5 }); gate.note("host_file_read", { path }, one);
  assert.deepEqual(gate.progressState(), []); assert.equal(one.read.completeFile, false);
  writeFileSync(path, "export const value = 2;\n");
  const two = readUserFile(path, { offset: one.read.nextOffset, limit: 5 });
  assert.notEqual(one.read.viewSha256, two.read.viewSha256);
});

test("large failure receipts stay valid and retain typed status plus output tails", () => {
  const raw = { ok: false, held: false, exitCode: 7, testFailure: true, noTests: false,
    stdout: "START_STDOUT\n" + "a".repeat(10000) + "\nLAST_STDOUT",
    stderr: "START_STDERR\n" + "b".repeat(10000) + "\nLAST_STDERR", diagnostic: "A real check failed." };
  const original = structuredClone(raw), view = packed(raw);
  assert.equal(view.ok, false); assert.equal(view.exitCode, 7); assert.equal(view.testFailure, true); assert.equal(view.noTests, false);
  assert.match(view.stdout, /START_STDOUT/); assert.match(view.stdout, /LAST_STDOUT/);
  assert.match(view.stderr, /START_STDERR/); assert.match(view.stderr, /LAST_STDERR/);
  assert.equal(view.stdout_truncated, true); assert.equal(view.stderr_truncated, true);
  assert.equal(view.packing.truncated, true); assert.deepEqual(raw, original);
});

test("oversized structured metadata is explicitly omitted instead of corrupting JSON or status", () => {
  const raw = { ok: false, unavailable: true, exitCode: 3, diagnostic: "unavailable check", data: { rows: Array.from({ length: 1000 }, (_, i) => ({ i, text: "x".repeat(100) })) } };
  const view = packed(raw);
  assert.equal(view.ok, false); assert.equal(view.unavailable, true); assert.equal(view.exitCode, 3);
  assert.equal(view.packing.truncated, true); assert(view.packing.omittedFields.includes("data"));
  for (const max of [1, 2, 4, 16, 64, 128]) packed(raw, max);
});

test("image fields stay placeholders and redacted data stays redacted in packed JSON", () => {
  const secret = "sk-fixturePrivateValue123456789", raw = { ok: true, image: "x".repeat(20000), dataUrl: "data:abc", data: { image: "b".repeat(20000), note: secret }, note: secret };
  const text = compactResult(raw, { max: 4000 }), view = JSON.parse(text);
  assert.match(view.image, /image 20000 chars/); assert.equal(view.dataUrl, "[image]");
  assert(!text.includes(secret)); assert.equal(view.note, "[redacted]");
});

test("the actual local runTurn receives parseable bounded pages and dispatches nextOffset", async () => {
  const path = make("production-read.mjs", 'const text = "\\n\\\"";\n'.repeat(5000));
  const definitions = windowToolDefs({ local: true, remote: false }).filter(row => row.function.name === "host_file_read");
  let requests = 0, nextOffset;
  const call = args => ({ id: `read-${requests}`, type: "function", function: { name: "host_file_read", arguments: JSON.stringify(args) } });
  const result = await runTurn([], "Inspect observations and give a concise account of the evidence.", () => {}, AbortSignal.timeout(10000), {
    pack: "host", tools: definitions, complete: async messages => {
      requests++;
      if (requests === 1) return { content: "", tool_calls: [call({ path })] };
      const receipt = messages.filter(row => row.role === "tool").at(-1), view = JSON.parse(receipt.content);
      assert(receipt.content.length <= 16000); assert.equal(view.read.completeFile, false);
      if (requests === 2) {
        nextOffset = view.read.nextOffset; assert(nextOffset > 0);
        return { content: "", tool_calls: [call({ path, offset: nextOffset, limit: 128 })] };
      }
      assert.equal(view.read.offset, nextOffset); assert.equal(view.text.length, 128);
      return { content: "Two partial source pages were inspected; whole-file coverage was not established.", tool_calls: [] };
    },
  });
  assert.equal(requests, 3); assert.match(result.assistant, /partial source pages/);
});

test("a large configured local window inspects a medium source in one read without changing its model budget", async () => {
  const target = chatTarget(loadConfig()), settings = join(process.env.NOVAPUP_HOME, "model-settings.json");
  const text = "export const preservedValue = 42;\n".repeat(220) + "// FINAL_SOURCE_MARKER\n";
  const path = make("medium-source.mjs", text);
  writeFileSync(settings, JSON.stringify({ version: 1, profiles: [{ url: target.url, model: target.model, contextTokens: 131072, outputTokens: 8192 }] }));
  try {
    const definitions = windowToolDefs({ local: true, remote: false }).filter(row => row.function.name === "host_file_read");
    let requests = 0;
    await runTurn([], "Inspect the provided source and report the observations.", () => {}, AbortSignal.timeout(10000), {
      tools: definitions, complete: async messages => {
        if (++requests === 1) return { content: "", tool_calls: [{ id: "medium-read", type: "function", function: { name: "host_file_read", arguments: JSON.stringify({ path }) } }] };
        const receipt = messages.filter(row => row.role === "tool").at(-1), view = JSON.parse(receipt.content);
        assert(receipt.content.length > 4000 && receipt.content.length <= 16000);
        assert.equal(view.text, text); assert.equal(view.read.completeFile, true);
        assert.equal(view.read.nextOffset, null);
        return { content: "The source was inspected in full.", tool_calls: [] };
      },
    });
    assert.equal(requests, 2);
    const profile = JSON.parse(readFileSync(settings, "utf8")).profiles[0];
    assert.equal(profile.contextTokens, 131072); assert.equal(profile.outputTokens, 8192);
  } finally { rmSync(settings, { force: true }); }
});
