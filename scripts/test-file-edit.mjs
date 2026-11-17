import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";

const root = mkdtempSync(join(tmpdir(), "collar-focused-edit-"));
const profile = join(root, "profile"), project = join(root, "project"); mkdirSync(profile); mkdirSync(project);
process.env.NOVAPUP_HOME = profile;
process.env.NP_LAYA_MODEL = join(profile, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error("No inference or network is permitted in focused-edit tests."); };
const { ensureHome, loadConfig } = await import("../src/main/config.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { planFileEdit, commitFileEdit } = await import("../src/main/file-edit.js");
const { executeTool, windowToolDefs } = await import("../src/main/tools.js");
const { setApprovalNotifier, resolveApproval, pendingApprovals } = await import("../src/main/approvals.js");
const { createHarness } = await import("../src/main/harness.js");
const { runTurn } = await import("../src/main/agent.js");
const { createSession } = await import("../src/main/sessions.js");
const { listCheckpoints, undoCheckpoint } = await import("../src/main/checkpoints.js");
const { spareDir } = await import("../src/main/spare.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
ensureHome(); setWorkdir(project);
const allow = event => { if (event.type === "approval") resolveApproval(event.request.id, true); };
setApprovalNotifier(allow);
afterEach(() => { setApprovalNotifier(allow); setWorkdir(project); });
after(() => { setApprovalNotifier(null); globalThis.fetch = nativeFetch; rmSync(root, { recursive: true, force: true }); });
const make = (name, content) => { const file = join(project, name); writeFileSync(file, content); return file; };
const edit = (oldText, newText) => ({ oldText, newText });
const args = (path, edits) => ({ path, edits });
const reply = (content = "", tool_calls = []) => ({ content, tool_calls });

// Auxiliary review traffic is explicit; these fixture totals include that one request.
const advisoryReply = options => options?.requestKind === "contract_review" ? { content: '{"findings":[],"limitations":[]}', tool_calls: [] } : null;
const call = (name, value, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(value) } });
const definitions = windowToolDefs({ local: true, search: false, remote: false });
const offered = (...names) => definitions.filter(tool => names.includes(tool.function.name));

test("the exact-edit schema is present on local catalogs and prefers focused changes", () => {
  const definition = definitions.find(tool => tool.function.name === "host_file_edit");
  assert(definition); assert.match(definition.function.description, /Read current content first/);
  assert.match(definition.function.description, /atomic write/); assert.deepEqual(definition.function.parameters.required, ["path", "edits"]);
  assert.match(definitions.find(tool => tool.function.name === "host_file_write").function.description, /new local file/);
});

test("multiple exact edits preserve unrelated UTF-8, BOM, line endings and file mode", () => {
  const original = "\ufeffalpha é\r\nkeep unchanged\r\nomega\r\n", file = make("preserve.txt", original);
  chmodSync(file, 0o754); const before = lstatSync(file);
  const result = commitFileEdit(planFileEdit(file, [edit("alpha", "first"), edit("omega", "last")]));
  assert.equal(result.ok, true); assert.equal(result.changed, true);
  assert.equal(readFileSync(file, "utf8"), "\ufefffirst é\r\nkeep unchanged\r\nlast\r\n");
  assert.equal(statSync(file).mode & 0o777, before.mode & 0o777); assert.equal(statSync(file).uid, before.uid); assert.equal(statSync(file).gid, before.gid);
  assert.notEqual(statSync(file).ino, before.ino, "target replacement uses rename rather than an in-place partial write");
  assert.equal(readFileSync(result.spares[0], "utf8"), original);
  assert(!readdirSync(project).some(name => name.startsWith(".nova-edit-")));
});

test("every replacement validates against the original before any file mutation", () => {
  const cases = [
    ["alpha beta", [edit("alpha", "first"), edit("missing", "bad")], "NO_MATCH"],
    ["same same", [edit("same", "different")], "AMBIGUOUS_MATCH"],
    ["abcdef", [edit("bc", "x"), edit("cd", "y")], "OVERLAPPING_EDITS"],
    ["alpha", [edit("alpha", "beta"), edit("beta", "gamma")], "NO_MATCH"],
    ["alpha", [edit("", "bad")], "INVALID_EDIT"],
  ];
  for (const [index, [source, edits, code]] of cases.entries()) {
    const file = make(`invalid-${index}.txt`, source), before = statSync(file);
    const plan = planFileEdit(file, edits); assert.equal(plan.ok, false); assert.equal(plan.code, code);
    assert.equal(readFileSync(file, "utf8"), source); assert.equal(statSync(file).ino, before.ino); assert(!existsSync(spareDir(file)));
  }
  assert.equal(planFileEdit(12, [edit("x", "y")]).ok, false);
  assert.equal(planFileEdit(make("many.txt", "a"), Array.from({ length: 51 }, () => edit("a", "b"))).ok, false);
});

test("no-op edits leave inode, mtime, backups and target contents unchanged", () => {
  const file = make("noop.txt", "unchanged\n"), before = statSync(file);
  const result = commitFileEdit(planFileEdit(file, [edit("unchanged", "unchanged")]));
  assert.equal(result.ok, true); assert.equal(result.unchanged, true); assert.equal(result.changed, false);
  assert.equal(statSync(file).ino, before.ino); assert.equal(statSync(file).mtimeMs, before.mtimeMs); assert(!existsSync(spareDir(file)));
});

test("source, inode or permission changes after planning fail closed without overwriting", () => {
  const file = make("cas.txt", "before\n"); let plan = planFileEdit(file, [edit("before", "after")]);
  writeFileSync(file, "human change\n"); assert.equal(commitFileEdit(plan).code, "STALE_FILE"); assert.equal(readFileSync(file, "utf8"), "human change\n");
  writeFileSync(file, "before\n"); plan = planFileEdit(file, [edit("before", "after")]);
  const replacement = make("external-replacement.txt", "before\n"); renameSync(replacement, file);
  assert.equal(commitFileEdit(plan).code, "STALE_FILE"); assert.equal(readFileSync(file, "utf8"), "before\n");
  plan = planFileEdit(file, [edit("before", "after")]); chmodSync(file, 0o600);
  assert.equal(commitFileEdit(plan).code, "STALE_FILE");
  assert.equal(commitFileEdit({ ...plan, content: "forged" }).ok, false, "serialized/forged plans cannot bypass preflight");
});

test("path, file-size, encoding and link restrictions are enforced without writes", () => {
  const secret = make(".env", "PRIVATE_VALUE"); assert.equal(planFileEdit(secret, [edit("PRIVATE", "PUBLIC")]).code, "BLOCKED_PATH");
  const binary = make("binary.txt", Buffer.from([0xff, 0x80, 0])); assert.equal(planFileEdit(binary, [edit("x", "y")]).code, "UNSUPPORTED_FILE");
  const readonly = make("readonly.txt", "before"); chmodSync(readonly, 0o444); assert.equal(planFileEdit(readonly, [edit("before", "after")]).code, "READ_ONLY");
  const large = make("large.txt", "x"); truncateSync(large, 8 * 1024 * 1024 + 1); assert.equal(planFileEdit(large, [edit("x", "y")]).code, "FILE_TOO_LARGE");
  const regular = make("link-target.txt", "before"); symlinkSync(regular, join(project, "symbolic.txt")); linkSync(regular, join(project, "hard.txt"));
  assert.equal(planFileEdit(join(project, "symbolic.txt"), [edit("before", "after")]).code, "UNSUPPORTED_FILE");
  assert.equal(planFileEdit(regular, [edit("before", "after")]).code, "UNSUPPORTED_FILE");
  assert.equal(planFileEdit(join(project, "missing.txt"), [edit("x", "y")]).ok, false);
  assert.equal(readFileSync(secret, "utf8"), "PRIVATE_VALUE"); assert.equal(readFileSync(regular, "utf8"), "before");
});

test("outside and broad edits retain real approval, denial and approval-time CAS", async () => {
  const outside = join(root, "outside.txt"); writeFileSync(outside, "before\n"); let requests = 0;
  setApprovalNotifier(event => { if (event.type === "approval") { requests++; resolveApproval(event.request.id, false); } });
  const denied = await executeTool("host_file_edit", args(outside, [edit("before", "after")]), loadConfig());
  assert.equal(denied.held, true); assert.equal(requests, 1); assert.equal(readFileSync(outside, "utf8"), "before\n");
  setApprovalNotifier(event => { if (event.type === "approval") { writeFileSync(outside, "human during approval\n"); resolveApproval(event.request.id, true); } });
  const stale = await executeTool("host_file_edit", args(outside, [edit("before", "after")]), loadConfig());
  assert.equal(stale.held, true); assert.match(stale.error, /changed/); assert.equal(readFileSync(outside, "utf8"), "human during approval\n");
  const broad = make("broad.txt", Array.from({ length: 40 }, (_, i) => `keep line ${i}`).join("\n")); requests = 0;
  setApprovalNotifier(event => { if (event.type === "approval") { requests++; resolveApproval(event.request.id, false); } });
  const blocked = await executeTool("host_file_edit", args(broad, [edit(readFileSync(broad, "utf8"), "replacement")]), loadConfig());
  assert.equal(blocked.held, true); assert.equal(requests, 1); assert.match(readFileSync(broad, "utf8"), /keep line 39/);
});

test("cancellation before commit or while approval is pending never writes", async () => {
  const file = make("stop.txt", "before"), controller = new AbortController(), plan = planFileEdit(file, [edit("before", "after")]);
  controller.abort(); assert.equal(commitFileEdit(plan, { signal: controller.signal }).held, true); assert.equal(readFileSync(file, "utf8"), "before");
  const outside = join(root, "stop-outside.txt"); writeFileSync(outside, "before"); const waiting = new AbortController();
  setApprovalNotifier(event => { if (event.type === "approval") waiting.abort(); });
  assert.equal((await executeTool("host_file_edit", args(outside, [edit("before", "after")]), loadConfig(), { signal: waiting.signal })).held, true);
  assert.equal(pendingApprovals().length, 0); assert.equal(readFileSync(outside, "utf8"), "before");
});

test("harness read-before-edit and protected/verifier rules apply to projected full content", async () => {
  const file = make("guarded.mjs", 'console.log("old");\n'), value = args(file, [edit("old", "new")]);
  const gate = createHarness({ requireEdits: false }); assert.match(gate.before("host_file_edit", value).detail, /Read the current/);
  const read = await executeTool("host_file_read", { path: file }, loadConfig()); await gate.after("host_file_read", { path: file }, read);
  assert.equal(gate.before("host_file_edit", value), null); assert.equal(value.content, undefined, "preflight does not expand the actual tool arguments");
  const protectedGate = createHarness({ ask: "Do not modify guarded.mjs.", requireEdits: false });
  await protectedGate.after("host_file_read", { path: file }, read);
  assert.equal(protectedGate.before("host_file_edit", value).blurb, "protected file");
  const verifier = make("harness.js", "export const value = 1;\n");
  await gate.after("host_file_read", { path: verifier }, await executeTool("host_file_read", { path: verifier }, loadConfig()));
  assert.match(gate.before("host_file_edit", args(verifier, [edit("1", "2")])).blurb, /human review/);
});

test("real lead reads then applies a small edit, checks it, and preserves an undo checkpoint", async () => {
  const file = make("helper.mjs", '// UNRELATED_REGION\nconsole.log("OLD_MARKER");\n'), original = readFileSync(file, "utf8");
  const session = createSession(), events = []; let requests = 0;
  const result = await runTurn([], "Fix helper.mjs so it prints NEW_MARKER.", event => events.push(event), AbortSignal.timeout(15000), {
    sessionId: session.id, tools: offered("host_file_read", "host_file_edit"), complete: async (messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      assert(messages.some(row => typeof row.content === "string" && row.content.includes("prefer host_file_edit")), "the actual request contains the focused-edit preference");
      if (requests === 1) return reply("", [call("host_file_read", { path: file }, "read")]);
      if (requests === 2) { assert(options.tools.some(tool => tool.function.name === "host_file_edit")); return reply("", [call("host_file_edit", args(file, [edit("OLD_MARKER", "NEW_MARKER")]), "edit")]); }
      const receipt = messages.find(row => row.tool_call_id === "edit"); assert(receipt.content.includes("NEW_MARKER"));
      assert(!receipt.content.includes("UNRELATED_REGION"), "tool receipt does not echo full source"); return reply("Updated helper.mjs; it printed NEW_MARKER.");
    },
  });
  assert.equal(requests, 4); assert.match(result.assistant, /NEW_MARKER/); assert.match(readFileSync(file, "utf8"), /UNRELATED_REGION/);
  assert(events.some(event => event.type === "tool_result" && event.name === "host_file_edit" && event.ok));
  const saved = listCheckpoints(session.id); assert.equal(saved.length, 1); assert.equal(saved[0].changes.length, 1);
  assert.equal(undoCheckpoint(session.id, saved[0].id).restored, 1); assert.equal(readFileSync(file, "utf8"), original);
});

test("real lead repairs a failed focused edit rather than reporting it as successful", async () => {
  const file = make("repair.mjs", "export const answer = 1;\n"); let requests = 0; const events = [];
  const result = await runTurn([], "Fix the existing helper implementation.", event => events.push(event), AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: offered("host_file_read", "host_file_edit"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; const advisory = advisoryReply(options); if (advisory) return advisory;
      if (requests === 1) return reply("", [call("host_file_read", { path: file })]);
      if (requests === 2) return reply("", [call("host_file_edit", args(file, [edit("1", ";broken(")]))]);
      if (requests === 3) return reply("", [call("host_file_edit", args(file, [edit(";broken(", "2")]))]);
      return reply("The helper was repaired and syntax checked.");
    },
  });
  assert.equal(requests, 5); assert.match(result.assistant, /repaired/); assert.equal(readFileSync(file, "utf8"), "export const answer = 2;\n");
  assert(events.some(event => event.type === "tool_result" && event.name === "harness" && event.ok === false));
});

test("review-only mode never discloses or executes focused edits", async () => {
  const file = make("review.mjs", "export const answer = 1;\n"); let requests = 0;
  const result = await runTurn([], "Read-only: review the helper.", () => {}, null, {
    tools: offered("host_file_read", "host_file_edit"), complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++; assert(!options.tools.some(tool => tool.function.name === "host_file_edit"));
      return requests === 1 ? reply("", [call("host_file_edit", args(file, [edit("1", "2")]))]) : reply("The helper was reviewed without edits.");
    },
  });
  assert.equal(requests, 2); assert.equal(readFileSync(file, "utf8"), "export const answer = 1;\n"); assert.match(result.assistant, /without edits/);
});

test("later human review-only steering stops both stale and later focused edits", async () => {
  const file = make("steering.mjs", "export const answer = 1;\n"); let requests = 0, batch = null;
  const result = await runTurn([], "Fix steering.mjs.", () => {}, AbortSignal.timeout(15000), {
    sessionId: createSession().id, tools: offered("host_file_read", "host_file_edit"), takeInput: () => batch, ackInput: () => { batch = null; },
    complete: async (_messages, _cfg, _delta, _signal, options) => {
      requests++;
      if (requests === 1) return reply("", [call("host_file_read", { path: file })]);
      if (requests === 2) { batch = { receipt: "review", messages: [{ content: "Stop editing; review only." }] }; return reply("", [call("host_file_edit", args(file, [edit("1", "2")]), "stale")]); }
      assert(!options.tools.some(tool => tool.function.name === "host_file_edit"));
      if (requests === 3) return reply("", [call("host_file_edit", args(file, [edit("1", "3")]), "late")]);
      return reply("Review only; the file remains unchanged.");
    },
  });
  assert.equal(requests, 4); assert.equal(readFileSync(file, "utf8"), "export const answer = 1;\n"); assert.match(result.assistant, /unchanged/);
});

test("a no-op focused edit neither clears failed verification nor creates a checkpoint", async () => {
  const file = make("failed-noop.mjs", 'throw new Error("persisted runtime failure");\n');
  const session = createSession(), gate = createHarness({ sessionId: session.id, requireEdits: false,
    localExec: (command, options = {}) => executeTool("host_run", { command, ...options }, loadConfig()) });
  await gate.after("host_file_read", { path: file }, await executeTool("host_file_read", { path: file }, loadConfig()));
  assert.equal((await gate.verify(file)).ok, false);
  const value = args(file, [edit("persisted runtime failure", "persisted runtime failure")]);
  assert.equal(gate.before("host_file_edit", value), null);
  const result = await executeTool("host_file_edit", value, loadConfig());
  assert.equal(result.unchanged, true); assert.equal(await gate.after("host_file_edit", value, result), null);
  assert(gate.debt().some(item => item.includes("failed-noop.mjs")));
  assert([...new VerificationLedger(session.id, project).entries.values()].some(entry => entry.path.endsWith("failed-noop.mjs") && entry.status === "failed"));
  assert.equal(gate.finish(), null); assert.equal(listCheckpoints(session.id).length, 0);
});

test("out-of-role focused edits are rejected before source filesystem inspection", async () => {
  const file = make("phone-boundary.txt", "before"), fs = createRequire(import.meta.url)("node:fs");
  const saved = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: fs.readFileSync }; let inspections = 0;
  for (const [name, original] of Object.entries(saved)) fs[name] = (...values) => {
    if (String(values[0]) === file) { inspections++; throw Error("Forbidden desktop source inspection in phone fixture"); }
    return original(...values);
  };
  syncBuiltinESMExports();
  try {
    const result = await executeTool("host_file_edit", args(file, [edit("before", "after")]), {}, { role: "phone" });
    assert.equal(result.ok, false); assert.match(result.error, /unavailable on the phone/); assert.equal(inspections, 0);
  } finally { Object.assign(fs, saved); syncBuiltinESMExports(); }
  assert.equal(readFileSync(file, "utf8"), "before");
});

test("focused arguments and receipts stay small for a few-line change in a large source", async () => {
  const source = '// UNRELATED_REGION\n'.repeat(300) + 'export const target = "before";\n', file = make("payload.mjs", source);
  const value = args(file, [edit('target = "before"', 'target = "after"')]);
  assert(JSON.stringify(value).length < JSON.stringify({ path: file, content: source }).length / 10);
  const result = await executeTool("host_file_edit", value, loadConfig());
  assert.equal(result.ok, true); assert(JSON.stringify(result).length < 1000); assert(!JSON.stringify(result).includes("UNRELATED_REGION"));
  assert.equal(readFileSync(file, "utf8").split("UNRELATED_REGION").length, 301);
});
