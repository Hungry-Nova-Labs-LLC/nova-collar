import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "nova-session-history-"));
process.env.NOVAPUP_HOME = join(root, "legacy-profile");
process.env.NP_LAYA_MODEL = join(root, "no-model");
globalThis.fetch = async () => { throw new Error("History fixtures cannot call providers or the network."); };
const { archiveSessionHistory, seedSessionHistory, sessionHistoryStatus, recallSessionHistory, clipArchivedToolResults, CONTEXT_RECALL_TOOL } = await import("../src/main/session-history.js");
after(() => rmSync(root, { recursive: true, force: true }));

const profile = name => join(root, name);
const archiveFile = (home, id) => join(home, "sessions", "archive", `${id}.jsonl`);
const digest = text => createHash("sha256").update(text).digest("hex");
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const exchange = content => [
  { role: "user", content: "Read the fixture evidence." },
  { role: "assistant", content: "", tool_calls: [call("read-1", "host_file_read", { path: "fixture.txt", identifier: "ARGUMENT_NONCE_5721" })] },
  { role: "tool", tool_call_id: "read-1", content },
];

test("turn snapshots append immutable receipts with stable IDs, hashes and explicit revisions", () => {
  const home = profile("snapshots"), id = "chat-snapshot1", rows = exchange(JSON.stringify({ ok: true, text: "ORIGINAL_EVIDENCE_794" }));
  const first = archiveSessionHistory(id, rows, { home, scope: "turn-one" });
  assert.equal(first.ok, true); assert.equal(first.appended, 3);
  const original = readFileSync(archiveFile(home, id));
  const repeated = archiveSessionHistory(id, structuredClone(rows), { home, scope: "turn-one" });
  assert.equal(repeated.appended, 0); assert.deepEqual(repeated.entries, first.entries);
  assert.deepEqual(readFileSync(archiveFile(home, id)), original);
  const changed = structuredClone(rows); changed[2].content = JSON.stringify({ ok: false, error: "ACTUAL_CHECK_FAILURE_714" });
  const revised = archiveSessionHistory(id, changed, { home, scope: "turn-one" });
  assert.equal(revised.appended, 1); assert.equal(revised.entries[0].id, first.entries[0].id);
  assert.notEqual(revised.entries[2].id, first.entries[2].id);
  assert.deepEqual(readFileSync(archiveFile(home, id)).subarray(0, original.length), original, "old bytes were never rewritten");
  const old = recallSessionHistory(id, { id: first.entries[2].id }, { home });
  assert.equal(old.results[0].current_revision, false); assert.match(old.results[0].excerpt, /ORIGINAL_EVIDENCE/);
  const current = recallSessionHistory(id, { id: revised.entries[2].id }, { home });
  assert.equal(current.results[0].current_revision, true); assert.equal(current.results[0].status, "failed");
  assert.match(current.results[0].excerpt, /ACTUAL_CHECK_FAILURE/);
  const duplicate = archiveSessionHistory(id, [...changed, changed[0]], { home, scope: "turn-one" });
  assert.notEqual(duplicate.entries[0].id, duplicate.entries[3].id, "identical repeated human messages remain distinct occurrences");
  const nextTurn = archiveSessionHistory(id, [changed[0]], { home, scope: "turn-two" });
  assert.notEqual(nextTurn.entries[0].id, duplicate.entries[0].id);
  assert.equal(sessionHistoryStatus(id, { home }).entries, 6);
  if (process.platform !== "win32") {
    assert.equal(statSync(archiveFile(home, id)).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, "sessions", "archive")).mode & 0o777, 0o700);
  }
});

test("exact ID reads paginate complete redacted text and search assistant tool arguments locally", () => {
  const home = profile("pagination"), id = "chat-pagination", text = JSON.stringify({ ok: true, text: "BEGIN_" + "\u0001\\\"🙂".repeat(1000) + "_TAIL_NONCE_974" });
  const saved = archiveSessionHistory(id, exchange(text), { home, scope: "turn-pagination" });
  const found = recallSessionHistory(id, { query: "ARGUMENT_NONCE_5721" }, { home });
  assert.equal(found.results[0].role, "assistant"); assert.match(found.results[0].excerpt, /identifier/);
  const named = recallSessionHistory(id, { query: "TAIL_NONCE_974", name: "host_file_read" }, { home });
  assert.equal(named.results.length, 1); assert.equal(named.results[0].id, saved.entries[2].id);
  let offset = 0, actual = "", pages = 0;
  do {
    const result = recallSessionHistory(id, { id: saved.entries[2].id, offset, limit: 4800 }, { home });
    assert.equal(result.ok, true); assert(JSON.stringify(result).length <= 6000);
    const row = result.results[0];
    assert.equal(row.sha256, digest(text)); assert.equal(row.total_chars, text.length);
    assert(row.excerpt.length > 0); actual += row.excerpt; pages++;
    if (row.next_offset === null) break;
    assert(row.next_offset > offset); offset = row.next_offset;
  } while (pages < 100);
  assert(pages > 1); assert.equal(actual, text);
  assert.equal(recallSessionHistory(id, { query: ".*" }, { home }).results.length, 0, "search terms are literal, not executable regexes");
});

test("recall is restricted to the trusted current chat/profile and does not expose archive paths or reasoning", () => {
  const home = profile("current-profile"), foreign = profile("foreign-profile"), id = "chat-current1", other = "chat-other0001";
  const secret = "sk-historyfixturecredential123456789";
  const first = archiveSessionHistory(id, [{ role: "assistant", content: `Safe text ${secret}`, reasoning_content: "PRIVATE_REASONING_NONCE_888" }], { home, scope: "one" });
  const otherSaved = archiveSessionHistory(other, [{ role: "user", content: "OTHER_CHAT_NONCE_514" }], { home, scope: "one" });
  archiveSessionHistory(id, [{ role: "user", content: "OTHER_PROFILE_NONCE_749" }], { home: foreign, scope: "one" });
  const raw = readFileSync(archiveFile(home, id), "utf8");
  assert(!raw.includes(secret)); assert(!raw.includes("PRIVATE_REASONING_NONCE"));
  const own = recallSessionHistory(id, { id: first.entries[0].id }, { home });
  assert.match(own.results[0].excerpt, /\[redacted\]/);
  assert(!JSON.stringify(own).includes(home)); assert(!JSON.stringify(sessionHistoryStatus(id, { home })).includes(home));
  assert.equal(recallSessionHistory(id, { id: otherSaved.entries[0].id }, { home }).ok, false);
  for (const query of ["OTHER_CHAT_NONCE", "OTHER_PROFILE_NONCE", "PRIVATE_REASONING_NONCE"]) assert.deepEqual(recallSessionHistory(id, { query }, { home }).results, []);
  for (const args of [{ query: "safe", sessionId: other }, { query: "safe", home: foreign }, { path: archiveFile(foreign, id) }, { query: "safe", file: "/etc/passwd" }]) assert.equal(recallSessionHistory(id, args, { home }).ok, false);
  assert.equal(archiveSessionHistory("../foreign", [], { home, scope: "one" }).ok, false);
  assert.equal(sessionHistoryStatus("bot-helper001", { home }).ok, false);
  const absent = profile("not-created"); assert.equal(recallSessionHistory(id, { query: "x" }, { home: absent }).ok, false); assert(!existsSync(absent), "read-only recall never creates a profile");
  // Even copying another profile's file into this chat cannot expand scope.
  writeFileSync(archiveFile(home, id), readFileSync(archiveFile(foreign, id)));
  assert.equal(recallSessionHistory(id, { query: "OTHER_PROFILE" }, { home }).code, "ARCHIVE_SCOPE");
});

test("failed and interrupted receipts remain explicit; corrupt archives cannot yield partial success or be replaced", () => {
  const home = profile("failures"), id = "chat-failures1";
  const rows = [
    { role: "tool", tool_call_id: "failed", name: "host_run", content: JSON.stringify({ ok: false, error: "Verification failed: case 17" }) },
    { role: "tool", tool_call_id: "unknown", name: "host_run", content: "Interrupted action: outcome unknown. Inspect before retrying." },
    { role: "tool", tool_call_id: "wrapper", name: "host_run", content: JSON.stringify({ ok: true, stdout: "Verification failed: " + "diagnostic ".repeat(500) }) },
  ];
  const saved = archiveSessionHistory(id, rows, { home, scope: "failure-turn" });
  assert.equal(recallSessionHistory(id, { id: saved.entries[0].id }, { home }).results[0].status, "failed");
  assert.equal(recallSessionHistory(id, { id: saved.entries[1].id }, { home }).results[0].status, "unknown");
  assert.equal(recallSessionHistory(id, { id: saved.entries[2].id }, { home }).results[0].status, "failed", "successful wrappers cannot hide failed-check diagnostics");
  const view = clipArchivedToolResults([...rows, { role: "user", content: "Recent exact request " + "r".repeat(3000) }], saved.entries, { keepRecentChars: 1024, maxToolChars: 1024 });
  assert.equal(view.messages[2], rows[2]); assert.equal(view.archived.length, 0);
  const file = archiveFile(home, id), good = readFileSync(file, "utf8"), corrupt = good.replace("case 17", "case 18");
  writeFileSync(file, corrupt);
  assert.equal(recallSessionHistory(id, { role: "tool" }, { home }).code, "ARCHIVE_CORRUPT");
  assert.equal(archiveSessionHistory(id, rows, { home, scope: "next" }).ok, false);
  assert.equal(seedSessionHistory(id, rows, { home }).ok, false); assert.equal(readFileSync(file, "utf8"), corrupt);
  writeFileSync(file, good.slice(0, -1));
  assert.equal(recallSessionHistory(id, { role: "tool" }, { home }).code, "ARCHIVE_CORRUPT");
});

test("storage symlinks and unsafe file permissions fail closed without reading or mutating foreign files", { skip: process.platform === "win32" }, () => {
  const home = profile("symlinks"), foreign = profile("symlink-foreign"), id = "chat-symlinks1";
  archiveSessionHistory(id, [{ role: "user", content: "FOREIGN_SOURCE_NONCE_491" }], { home: foreign, scope: "one" });
  const original = readFileSync(archiveFile(foreign, id));
  mkdirSync(home); mkdirSync(join(home, "sessions"));
  symlinkSync(join(foreign, "sessions", "archive"), join(home, "sessions", "archive"), "dir");
  assert.equal(recallSessionHistory(id, { query: "FOREIGN" }, { home }).ok, false);
  assert.equal(archiveSessionHistory(id, [{ role: "user", content: "new" }], { home, scope: "one" }).ok, false);
  assert.deepEqual(readFileSync(archiveFile(foreign, id)), original);
  const fileHome = profile("file-symlink"); mkdirSync(join(fileHome, "sessions", "archive"), { recursive: true });
  symlinkSync(archiveFile(foreign, id), archiveFile(fileHome, id));
  const result = recallSessionHistory(id, { query: "FOREIGN" }, { home: fileHome }); assert.equal(result.ok, false); assert(!JSON.stringify(result).includes(foreign));
  const profileLink = profile("profile-link"); symlinkSync(foreign, profileLink, "dir"); assert.equal(sessionHistoryStatus(id, { home: profileLink }).ok, false);
  chmodSync(archiveFile(foreign, id), 0o644); assert.equal(sessionHistoryStatus(id, { home: foreign }).ok, false);
});

test("live, dead and unknown writer locks fail closed; controlled maintenance permits an intact resume", () => {
  const home = profile("locks"), id = "chat-locks001", rows = [{ role: "user", content: "saved before restart" }];
  archiveSessionHistory(id, rows, { home, scope: "one" });
  const file = archiveFile(home, id), before = readFileSync(file), lock = `${file}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.equal(archiveSessionHistory(id, rows, { home, scope: "two" }).code, "ARCHIVE_BUSY");
  assert.equal(sessionHistoryStatus(id, { home }).code, "ARCHIVE_BUSY");
  assert.deepEqual(readFileSync(file), before); assert(existsSync(lock));
  const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
  writeFileSync(lock, JSON.stringify({ pid: deadPid }));
  assert.equal(archiveSessionHistory(id, rows, { home, scope: "two" }).code, "ARCHIVE_BUSY");
  assert.deepEqual(readFileSync(file), before); assert(existsSync(lock), "automatic stale-lock deletion cannot race a live replacement");
  writeFileSync(lock, "unknown owner"); assert.equal(archiveSessionHistory(id, rows, { home, scope: "two" }).code, "ARCHIVE_BUSY");
  unlinkSync(lock); // Explicit fixture-owned maintenance with all writers stopped.
  const resumed = archiveSessionHistory(id, [...rows, { role: "assistant", content: "continued deliberately" }], { home, scope: "one" });
  assert.equal(resumed.ok, true); assert.equal(resumed.appended, 1); assert(!existsSync(lock));
  assert.deepEqual(readFileSync(file).subarray(0, before.length), before);
});

test("whole-record rollback cannot silently lose a receipt or promote an obsolete revision", () => {
  const home = profile("rollback"), id = "chat-rollback1", initial = [{ role: "user", content: "Initial request" }];
  const first = archiveSessionHistory(id, initial, { home, scope: "one" }); assert.equal(first.ok, true);
  const firstBytes = readFileSync(archiveFile(home, id));
  const revised = archiveSessionHistory(id, [{ role: "user", content: "Corrected request" }], { home, scope: "one" }); assert.equal(revised.ok, true);
  const file = archiveFile(home, id), complete = readFileSync(file);
  writeFileSync(file, firstBytes); // Still valid JSONL, complete records, valid forward chain.
  assert.equal(sessionHistoryStatus(id, { home }).code, "ARCHIVE_CORRUPT");
  assert.equal(recallSessionHistory(id, { id: first.entries[0].id }, { home }).ok, false);
  assert.equal(archiveSessionHistory(id, initial, { home, scope: "two" }).ok, false);
  assert.deepEqual(readFileSync(file), firstBytes);
  writeFileSync(file, complete);
  assert.equal(recallSessionHistory(id, { id: revised.entries[0].id }, { home }).results[0].current_revision, true);
  unlinkSync(file); assert.equal(sessionHistoryStatus(id, { home }).code, "ARCHIVE_CORRUPT");
});

test("legacy session JSON stays compatible while surviving old text is seeded once and remains after trimming", async () => {
  const { createSession, readSession, saveSession } = await import("../src/main/sessions.js");
  const { cleanModelHistory } = await import("../src/main/model-history.js");
  const { ensureHome } = await import("../src/main/config.js"); ensureHome();
  const session = createSession(), rows = Array.from({ length: 20 }, (_, index) => [{ role: "user", content: `Legacy request ${index} LEGACY_NONCE_${index}` }, { role: "assistant", content: `Legacy reply ${index}` }]).flat();
  const seed = seedSessionHistory(session.id, rows); assert.equal(seed.ok, true); assert.equal(seed.seeded, true);
  assert.match(seed.legacy, /previously discarded history is unavailable/);
  saveSession(session.id, rows, { modelMessages: rows });
  const json = join(process.env.NOVAPUP_HOME, "sessions", `${session.id}.json`), before = readFileSync(json);
  assert.deepEqual(readSession(session.id).modelMessages, cleanModelHistory(rows));
  assert(!readSession(session.id).modelMessages.some(row => row.content.includes("LEGACY_NONCE_0")));
  assert.match(recallSessionHistory(session.id, { query: "LEGACY_NONCE_0" }).results[0].excerpt, /Legacy request 0/);
  assert.equal(seedSessionHistory(session.id, [{ role: "user", content: "must not replace legacy" }]).seeded, false);
  assert.deepEqual(readFileSync(json), before, "archive reads and migration never rewrite the legacy session JSON");
  assert.equal(sessionHistoryStatus(session.id).entries, 40);
});

test("fixed-size model clips require matching archived references and never hide failed/recent evidence", () => {
  const home = profile("clips"), id = "chat-clips001";
  const rows = exchange(JSON.stringify({ ok: true, text: "OLD_RECEIPT_NONCE_32_" + "x".repeat(20000) }));
  rows.push({ role: "tool", tool_call_id: "failed-later", name: "check", content: JSON.stringify({ ok: false, error: "failed test " + "f".repeat(12000) }) });
  rows.push({ role: "user", content: "Most recent exact request " + "r".repeat(3000) });
  const original = structuredClone(rows), saved = archiveSessionHistory(id, rows, { home, scope: "clips-turn" });
  const first = clipArchivedToolResults(rows, saved.entries, { keepRecentChars: 1024, maxToolChars: 1024 });
  assert.deepEqual(rows, original); assert.equal(first.archived.length, 1); assert.equal(first.messages[2].content.length, 1024);
  assert.match(first.messages[2].content, new RegExp(saved.entries[2].id)); assert.match(first.messages[2].content, new RegExp(saved.entries[2].sha256));
  assert.equal(first.messages[3], rows[3]); assert.equal(first.messages[4], rows[4]);
  const expanded = [...rows, { role: "user", content: "Another turn " + "n".repeat(3000) }], added = archiveSessionHistory(id, expanded, { home, scope: "clips-turn" });
  assert.equal(clipArchivedToolResults(expanded, added.entries, { keepRecentChars: 1024, maxToolChars: 1024 }).messages[2].content, first.messages[2].content, "adding context cannot resize an older clip");
  assert.equal(clipArchivedToolResults(rows, [], { keepRecentChars: 1024, maxToolChars: 1024 }).archived.length, 0);
  const bad = structuredClone(saved.entries); bad[2].sha256 = "0".repeat(64);
  assert.equal(clipArchivedToolResults(rows, bad, { keepRecentChars: 1024, maxToolChars: 1024 }).archived.length, 0);
  assert.equal(recallSessionHistory(id, { id: saved.entries[2].id, offset: 0, limit: 4800 }, { home }).results[0].sha256, digest(rows[2].content));
});

test("arguments, content size and complete result budgets are bounded without side effects", () => {
  const home = profile("bounds"), id = "chat-bounds01";
  for (const args of [null, [], { query: "x", offset: 1 }, { query: "x", id: "entry-" + "a".repeat(32) }, { role: "system" }, { query: "x", max_results: 4 }, { query: "x", limit: 4801 }, { query: "x", offset: -1 }, { query: "x".repeat(501) }, {}]) assert.equal(recallSessionHistory(id, args, { home }).ok, false);
  for (const rows of [[{ role: "system", content: "system source" }], [{ role: "user", content: { silently: "lost" } }], [{ role: "user", content: [{ type: "unknown", data: "unsupported" }] }], [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }]]) assert.equal(archiveSessionHistory(id, rows, { home, scope: "bad" }).ok, false);
  assert(!existsSync(home));
  const saved = archiveSessionHistory(id, [{ role: "user", content: "\u0001".repeat(15000) }], { home, scope: "good" });
  const page = recallSessionHistory(id, { id: saved.entries[0].id, limit: 4800 }, { home });
  assert.equal(page.ok, true); assert(JSON.stringify(page).length <= 6000); assert(page.results[0].excerpt.length > 0); assert(page.results[0].next_offset > 0);
  assert.equal(CONTEXT_RECALL_TOOL.parameters.additionalProperties, false);
  assert(!("sessionId" in CONTEXT_RECALL_TOOL.parameters.properties)); assert(!("path" in CONTEXT_RECALL_TOOL.parameters.properties));
});
