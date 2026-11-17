import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "collar-recovery-"));
process.env.NOVAPUP_HOME = join(root, "profile");
process.env.NP_LAYA_MODEL = join(root, "no-model");
process.env.HNL_MODEL = "local-3.8";process.env.OLLAMA_MODEL="fixture-local-chat";
globalThis.fetch = async () => { throw new Error("No network or inference is permitted in recovery fixtures."); };
const { ensureHome, APP_HOME } = await import("../src/main/config.js");
const { acknowledgeRecoveryOperation, assertRecoveryReady, beginRecoveryPoint, finishRecoveryPoint, listRecoveryPoints, recoveryOperations, recoveryPointSummaries, recoverSession, recoveryContext } = await import("../src/main/recovery-points.js");
const { Checkpoint, listCheckpoints, undoCheckpoint } = await import("../src/main/checkpoints.js");
const { createConversationCoordinator } = await import("../src/main/conversation.js");
const { createSession, readSession, saveSession, writeGoal } = await import("../src/main/sessions.js");
const { VerificationLedger } = await import("../src/main/verification-ledger.js");
const { setWorkdir } = await import("../src/main/workdir.js");
const { runTurn } = await import("../src/main/agent.js");
const { windowToolDefs } = await import("../src/main/tools.js");
ensureHome();
after(() => rmSync(root, { recursive: true, force: true }));
const hash = value => createHash("sha256").update(value).digest("hex");

function setup(name) {
  const cwd = join(root, name); mkdirSync(cwd);
  const session = createSession();
  saveSession(session.id, [{ role: "user", content: `Original ${name} request` }], { turnState: { active: false, inFlight: "" } });
  writeGoal(session.id, "Finish the owner's project");
  return { cwd, session, coordinator: createConversationCoordinator() };
}
function attempt(session, cwd, paths, mutate, options = {}) {
  const point = beginRecoveryPoint(session.id, { cwd, history: options.history || [{ role: "user", content: "Earlier accepted request" }, { role: "assistant", content: "Earlier result" }], goal: "Finish the owner's project", request: options.request || "Try this bounded change" });
  const journal = new Checkpoint(session.id, cwd); journal.track(paths); mutate();
  const saved = journal.finish("finished");
  finishRecoveryPoint(point, saved, options);
  return point;
}

test("a coordinated range restores edits, additions and deletions together and branches without erasing the original", () => {
  const { cwd, session, coordinator } = setup("range");
  const a = join(cwd, "a.txt"), b = join(cwd, "b.txt"), c = join(cwd, "c.txt");
  writeFileSync(a, "accepted a"); writeFileSync(b, "accepted b");
  const ledger = new VerificationLedger(session.id, cwd);
  ledger.changed(a); ledger.checked(a, { ok: true, phase: "test", command: "synthetic behavioral assertion" });
  const point = attempt(session, cwd, [a, b, c], () => { writeFileSync(a, "attempt1"); rmSync(b); writeFileSync(c, "new"); });
  attempt(session, cwd, [a, c], () => { writeFileSync(a, "attempt2"); rmSync(c); });
  const originalBytes = JSON.stringify(readSession(session.id));
  const restored = recoverSession(session.id, point.id, { coordinator });
  assert.equal(restored.ok, true); assert.notEqual(restored.session.id, session.id); assert.equal(restored.restored, 3);
  assert.equal(readFileSync(a, "utf8"), "accepted a"); assert.equal(readFileSync(b, "utf8"), "accepted b"); assert.equal(existsSync(c), false);
  assert.equal(JSON.stringify(readSession(session.id)), originalBytes, "original history/goal/receipts are immutable");
  assert.equal(restored.session.goal, "Finish the owner's project");
  assert(restored.session.modelMessages.some(row => row.content?.includes("Earlier accepted request")));
  const recoveredLedger = new VerificationLedger(restored.session.id, cwd);
  assert.equal([...recoveredLedger.entries.values()][0].status, "pending", "historical passing tests never become current proof");
  assert.equal(recoveryPointSummaries(session.id).find(row => row.id === point.id).verification, "recorded-checks-passed");
  const operation = JSON.parse(readFileSync(join(APP_HOME, "recovery", "operations", `${restored.operationId}.json`))).value;
  assert.equal(operation.state, "complete"); assert.equal(operation.externalActionsReplayed, false);
  assert(operation.undoCheckpointId, "restore itself retains a reversible file journal");
});

test("later user edits block the entire range before any file is changed", () => {
  const { cwd, session, coordinator } = setup("conflict");
  const a = join(cwd, "a.txt"), b = join(cwd, "b.txt"); writeFileSync(a, "before a"); writeFileSync(b, "before b");
  const point = attempt(session, cwd, [a, b], () => { writeFileSync(a, "after a"); writeFileSync(b, "after b"); });
  writeFileSync(b, "owner edit after attempt");
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /Changed since checkpoint/);
  assert.equal(readFileSync(a, "utf8"), "after a"); assert.equal(readFileSync(b, "utf8"), "owner edit after attempt");
});

test("unknown outcomes, active leads, paused input and active commands fail closed", () => {
  const { cwd, session, coordinator } = setup("ownership");
  const file = join(cwd, "a.txt"); writeFileSync(file, "before");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "after"));
  let token = coordinator.start(session.id);
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /already working/);
  coordinator.finish(token);
  assert.throws(() => recoverSession(session.id, point.id, { coordinator, hasActiveWriters: () => true }), /Stop active commands/);
  coordinator.enqueue(session.id, "Keep my queued guidance intact");
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /paused/);
  assert.equal(coordinator.pending(session.id)[0].content, "Keep my queued guidance intact");
  const isolated = setup("unknown"); const unknownFile = join(isolated.cwd, "b.txt"); writeFileSync(unknownFile, "before");
  const uncertain = attempt(isolated.session, isolated.cwd, [unknownFile], () => writeFileSync(unknownFile, "after"), { inFlight: "computer_exec" });
  assert.throws(() => recoverSession(isolated.session.id, uncertain.id, { coordinator: isolated.coordinator }), /unknown outcome|Incomplete/);
  assert.equal(readFileSync(unknownFile, "utf8"), "after");
  const crashed = beginRecoveryPoint(isolated.session.id, { cwd: isolated.cwd, history: [], request: "Crash before completion" });
  assert.equal(listRecoveryPoints(isolated.session.id).find(row => row.id === crashed.id).state, "started");
  assert.throws(() => recoverSession(isolated.session.id, crashed.id, { coordinator: isolated.coordinator }), /incomplete/);
});

test("later action IDs, arguments and outcomes stay pinned after conversation pruning without replay", async () => {
  const { cwd, session, coordinator } = setup("receipts");
  const file = join(cwd, "a.txt"); writeFileSync(file, "before");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "after"), {
    actions: ["host_run"], receipts: [{ id: "historical-shell-42", name: "host_run", arguments: '{"command":"synthetic external mutation"}', status: "recorded-result", result: '{"ok":true,"receipt":"SYNTHETIC_SIDE_EFFECT_RECEIPT"}' }] });
  const result = recoverSession(session.id, point.id, { coordinator });
  const context = recoveryContext(result.session.id);
  assert(context.includes("historical-shell-42")); assert(context.includes("SYNTHETIC_SIDE_EFFECT_RECEIPT"));
  setWorkdir(cwd);
  const laterHistory = Array.from({ length: 20 }, (_, i) => [{ role: "user", content: `later question ${i}` }, { role: "assistant", content: `later answer ${i}` }]).flat();
  let calls = 0;
  await runTurn(laterHistory, "Say acknowledged", () => {}, null, { sessionId: result.session.id, tools: [], complete: async messages => {
    calls++;
    assert(messages[0].content.includes("historical-shell-42"), "recovery evidence survives normal five-turn model-history clipping");
    assert(messages[0].content.includes("SYNTHETIC_SIDE_EFFECT_RECEIPT"));
    return { content: "Acknowledged.", tool_calls: [] };
  } });
  assert(calls > 0); assert.equal(readFileSync(file, "utf8"), "before", "no action was replayed");
});

test("corrupt objects and uncovered paths cannot become successful recovery", () => {
  const { cwd, session, coordinator } = setup("corrupt");
  const file = join(cwd, "a.txt"); writeFileSync(file, "before");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "after"));
  const checkpoint = listCheckpoints(session.id)[0];
  writeFileSync(join(APP_HOME, "checkpoints", "objects", checkpoint.changes[0].before.hash), "damaged");
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /Damaged checkpoint/);
  assert.equal(readFileSync(file, "utf8"), "after");
  const second = setup("uncovered"), large = join(second.cwd, "large.txt"); writeFileSync(large, "not covered");
  const skipped = beginRecoveryPoint(second.session.id, { cwd: second.cwd });
  const limited = new Checkpoint(second.session.id, second.cwd, { maxFileBytes: 2 }); limited.track([large]);
  finishRecoveryPoint(skipped, limited.finish("finished"));
  assert.equal(recoveryPointSummaries(second.session.id)[0].available, false);
  assert.throws(() => recoverSession(second.session.id, skipped.id, { coordinator: second.coordinator }), /Incomplete|incomplete coverage/);
  const record = join(APP_HOME, "recovery", hash(session.id), `${point.id}.json`);
  const altered = JSON.parse(readFileSync(record)); altered.value.goal = "corrupted goal"; writeFileSync(record, JSON.stringify(altered));
  assert.throws(() => listRecoveryPoints(session.id), /checksum/);
});

test("a changed ancestor target is detected even when current bytes match", { skip: process.platform === "win32" }, () => {
  const { cwd, session, coordinator } = setup("symlink");
  const dir = join(cwd, "src"), victim = join(cwd, "victim"); mkdirSync(dir); mkdirSync(victim);
  const file = join(dir, "a.txt"); writeFileSync(file, "before");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "after"));
  renameSync(dir, join(cwd, "moved")); writeFileSync(join(victim, "a.txt"), "after"); symlinkSync(victim, dir, "dir");
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /Changed path/);
  assert.equal(readFileSync(join(victim, "a.txt"), "utf8"), "after");
});

test("a missing or unreadable final file manifest cannot silently turn restoration into a no-op", () => {
  const { cwd, session, coordinator } = setup("missing-manifest");
  const file = join(cwd, "a.txt"); writeFileSync(file, "original unique manifest bytes");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "changed unique manifest bytes"));
  const checkpoint = listCheckpoints(session.id)[0];
  const dir = join(APP_HOME, "checkpoints", hash(session.id).slice(0, 24));
  writeFileSync(join(dir, `${checkpoint.id}.json`), "unreadable checkpoint json");
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /missing or unreadable/);
  assert.equal(readFileSync(file, "utf8"), "changed unique manifest bytes");
});

test("a missing middle manifest with disjoint file changes breaks the predecessor chain", () => {
  const { cwd, session, coordinator } = setup("missing-middle");
  const files = ["a", "b", "c"].map(name => join(cwd, `${name}.txt`));
  for (const file of files) writeFileSync(file, `original ${file}`);
  const first = attempt(session, cwd, [files[0]], () => writeFileSync(files[0], "changed a"));
  const middle = attempt(session, cwd, [files[1]], () => writeFileSync(files[1], "changed b"));
  attempt(session, cwd, [files[2]], () => writeFileSync(files[2], "changed c"));
  const middleRecord = listRecoveryPoints(session.id).find(row => row.id === middle.id);
  rmSync(join(APP_HOME, "checkpoints", hash(session.id).slice(0, 24), `${middleRecord.fileCheckpointId}.json`));
  assert.throws(() => recoverSession(session.id, first.id, { coordinator }), /missing or unreadable/);
  // Even if an entire middle point record vanished too, predecessor continuity
  // catches the gap instead of treating three independent files as one chain.
  rmSync(join(APP_HOME, "recovery", hash(session.id), `${middle.id}.json`));
  assert.throws(() => recoverSession(session.id, first.id, { coordinator }), /predecessor chain/);
  assert.deepEqual(files.map(file => readFileSync(file, "utf8")), ["changed a", "changed b", "changed c"]);
});

test("later human steering and answers survive recovery while generated model context stays excluded", async () => {
  const { cwd, session, coordinator } = setup("human-guidance");
  const file = join(cwd, "a.txt"); writeFileSync(file, "accepted source");
  const initial = readSession(session.id).messages;
  const originalRequest = { role: "user", id: "owner-request-1", content: "Try a file change" };
  saveSession(session.id, [...initial, originalRequest]);
  const point = beginRecoveryPoint(session.id, { cwd, request: originalRequest.content, originalRequestId: originalRequest.id,
    humanMessages: readSession(session.id).messages, history: [{ role: "user", content: "Earlier ordinary conversation" }], goal: "Old goal" });
  const journal = new Checkpoint(session.id, cwd); journal.track([file]); writeFileSync(file, "attempt source");
  const steering = { role: "user", id: "owner-guidance-2", content: "Do not deploy anything; keep this offline and preserve my fixtures." };
  const answer = { role: "user", id: "owner-answer-3", content: "Use only the existing local service." };
  saveSession(session.id, [...initial, originalRequest, steering, answer,
    { role: "user", id: "recovery-context-generated-4", content: "GENERATED_FAKE_HUMAN_CONTEXT" }], { turnState: { active: false, inFlight: "" } });
  writeGoal(session.id, ""); // A later explicit clear must not resurrect the old goal.
  finishRecoveryPoint(point, journal.finish("finished"), { humanMessages: readSession(session.id).messages });
  const result = recoverSession(session.id, point.id, { coordinator });
  const context = recoveryContext(result.session.id);
  assert(context.includes(steering.content)); assert(context.includes(answer.content));
  assert(!context.includes("GENERATED_FAKE_HUMAN_CONTEXT"));
  assert.equal(result.session.goal, "");
  assert(result.session.messages.some(row => row.id === steering.id && row.content === steering.content));
  setWorkdir(cwd);
  await runTurn(Array.from({ length: 20 }, (_, i) => [{ role: "user", content: `later ${i}` }, { role: "assistant", content: "ok" }]).flat(), "Acknowledge the current restrictions", () => {}, null,
    { sessionId: result.session.id, tools: [], complete: async messages => {
      assert(messages[0].content.includes(steering.content)); assert(messages[0].content.includes(answer.content));
      assert(!messages[0].content.includes("GENERATED_FAKE_HUMAN_CONTEXT"));
      return { content: "Acknowledged.", tool_calls: [] };
    } });
});

test("oversize later human guidance blocks recovery before any file write", () => {
  const { cwd, session, coordinator } = setup("guidance-limit");
  const file = join(cwd, "a.txt"); writeFileSync(file, "unique original guidance-limit");
  const point = attempt(session, cwd, [file], () => writeFileSync(file, "changed guidance-limit"));
  saveSession(session.id, [...readSession(session.id).messages, { role: "user", id: "owner-large-guidance", content: "Keep this constraint exactly. ".repeat(760) }]);
  assert.throws(() => recoverSession(session.id, point.id, { coordinator }), /later human guidance exceed/);
  assert.equal(readFileSync(file, "utf8"), "changed guidance-limit");
});

test("an I/O-time conflict blocks subsequent model work until explicit inspection acknowledgement", async () => {
  const { cwd, session, coordinator } = setup("partial");
  const a = join(cwd, "a.txt"), b = join(cwd, "b.txt"); writeFileSync(a, "before a"); writeFileSync(b, "before b");
  const point = attempt(session, cwd, [a, b], () => { writeFileSync(a, "after a"); writeFileSync(b, "after b"); });
  const priorOperations = new Set(readdirSync(join(APP_HOME, "recovery", "operations")));
  let checks = 0;
  assert.throws(() => recoverSession(session.id, point.id, { coordinator, hasActiveWriters: () => {
    checks++; if (checks === 4) writeFileSync(b, "concurrent owner edit"); return false;
  } }), /Changed during recovery/);
  const file = readdirSync(join(APP_HOME, "recovery", "operations")).find(name => !priorOperations.has(name));
  const operation = JSON.parse(readFileSync(join(APP_HOME, "recovery", "operations", file))).value;
  assert.equal(operation.state, "incomplete"); assert(operation.undoCheckpointId);
  assert.equal(readFileSync(b, "utf8"), "concurrent owner edit");
  assert.equal(readSession(session.id).title.startsWith("Recovered:"), false);
  const partial = listCheckpoints(session.id).find(row => row.id === operation.undoCheckpointId);
  assert.deepEqual(partial.changes.map(row => row.path), [a], "a rejected owner-mutated path never enters the recovery undo journal");
  undoCheckpoint(session.id, partial.id);
  assert.equal(readFileSync(a, "utf8"), "after a", "undo reverses only the recovery-owned mutation");
  assert.equal(readFileSync(b, "utf8"), "concurrent owner edit", "ordinary undo preserves the rejected path's owner edit");
  assert.throws(() => assertRecoveryReady(session.id, cwd), /Inspect its current files/);
  assert.throws(() => beginRecoveryPoint(session.id, { cwd }), /Recovery operation/);
  setWorkdir(cwd);
  let modelCalls = 0;
  await assert.rejects(() => runTurn([], "Continue", () => {}, null, { sessionId: session.id, tools: [], complete: async () => { modelCalls++; return { content: "wrong" }; } }), /Recovery operation/);
  assert.equal(modelCalls, 0);
  assert.throws(() => acknowledgeRecoveryOperation(operation.id, "yes", { coordinator }), /inspection note/);
  const beforeAck = [readFileSync(a, "utf8"), readFileSync(b, "utf8")];
  const ack = acknowledgeRecoveryOperation(operation.id, "I inspected both current files and the incomplete operation receipt.", { coordinator });
  assert.equal(ack.recoverySucceeded, false);
  assert.doesNotThrow(() => assertRecoveryReady(session.id, cwd));
  assert.deepEqual([readFileSync(a, "utf8"), readFileSync(b, "utf8")], beforeAck, "inspection acknowledgement changes no workspace file");
  assert.equal(recoveryOperations().find(row => row.id === operation.id).state, "acknowledged");
  assert(recoveryContext(session.id).includes("not a successful restore"));
});

test("completed point copies are bounded while incomplete points and source history remain", () => {
  const { cwd, session } = setup("retention");
  const before = JSON.stringify(readSession(session.id));
  const incomplete = beginRecoveryPoint(session.id, { cwd, request: "Interrupted boundary retained" });
  for (let i = 0; i < 103; i++) {
    const point = beginRecoveryPoint(session.id, { cwd, request: `Synthetic boundary ${i}` });
    finishRecoveryPoint(point, null);
  }
  const records = listRecoveryPoints(session.id);
  assert.equal(records.filter(row => row.state === "complete").length, 100);
  assert(records.some(row => row.id === incomplete.id && row.state === "started"));
  assert.equal(JSON.stringify(readSession(session.id)), before);
  const retention = JSON.parse(readFileSync(join(APP_HOME, "recovery", hash(session.id), "retention.json"))).value;
  assert.equal(retention.originalHistoryAndFileJournalsPreserved, true);
});

test("owner edits after a successful recovery write never become undo-authorized after-state", () => {
  const { cwd, session, coordinator } = setup("postwrite-owner");
  const a = join(cwd, "a.txt"), b = join(cwd, "b.txt"); writeFileSync(a, "original postwrite a"); writeFileSync(b, "original postwrite b");
  const point = attempt(session, cwd, [a, b], () => { writeFileSync(a, "attempt postwrite a"); writeFileSync(b, "attempt postwrite b"); });
  let checks = 0;
  assert.throws(() => recoverSession(session.id, point.id, { coordinator, hasActiveWriters: () => {
    checks++; if (checks === 4) writeFileSync(a, "owner edit after recovery wrote a"); return false;
  } }), /Changed during recovery/);
  const operation = recoveryOperations().find(row => row.sessionId === session.id);
  const undo = listCheckpoints(session.id).find(row => row.id === operation.undoCheckpointId);
  assert.equal(undo.changes.find(row => row.path === a).after.hash, hash("original postwrite a"), "journal records recovery-owned bytes, not the later owner edit");
  assert.throws(() => undoCheckpoint(session.id, undo.id), /Changed since checkpoint/);
  assert.equal(readFileSync(a, "utf8"), "owner edit after recovery wrote a");
});

test("production runTurn records its before-state and actual local tool receipt", async () => {
  const { cwd, session } = setup("production"); setWorkdir(cwd);
  const file = join(cwd, "notes.txt"); writeFileSync(file, "old note");
  const definitions = windowToolDefs({ local: true, search: false, remote: false }).filter(row => ["host_file_read", "host_file_write"].includes(row.function.name));
  let calls = 0; const events = [];
  await runTurn([{ role: "user", content: "Earlier message retained" }, { role: "assistant", content: "Earlier answer" }], "Save the words new note in notes.txt", event => events.push(event), null, { sessionId: session.id, tools: definitions, complete: async () => {
    calls++;
    if (calls === 1) return { content: "", tool_calls: [{ id: "read-note", type: "function", function: { name: "host_file_read", arguments: JSON.stringify({ path: file }) } }] };
    if (calls === 2) return { content: "", tool_calls: [{ id: "write-note", type: "function", function: { name: "host_file_write", arguments: JSON.stringify({ path: file, content: "new note" }) } }] };
    return { content: "Saved notes.txt.", tool_calls: [] };
  } });
  assert.equal(readFileSync(file, "utf8"), "new note");
  const point = listRecoveryPoints(session.id)[0];
  assert.equal(point.state, "complete"); assert(point.fileCheckpointId);
  assert(point.history.some(row => row.content === "Earlier message retained"));
  assert(point.receipts.some(row => row.id === "write-note" && row.status === "recorded-result"));
  assert(events.some(row => row.type === "recovery_point"));
});
