/** Focused exact replacements, adapted from Nova Tag's Apache-2.0 edit tool.
 * Plans stay private to this process; no file changes until commitFileEdit. */
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkWrite } from "./guard.js";
import { denySecretPath, redactSecrets } from "./safe.js";
import { holdMessage, keepSpares, mutationHold } from "./spare.js";
import { expandPath, getWorkdir } from "./workdir.js";
import { mutationReview } from "./mutation-review.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EDITS = 50;
const plans = new WeakSet();
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = (error, code = "INVALID_EDIT") => ({ ok: false, code, error: redactSecrets(error) });
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink });

export function planFileEdit(path, edits, { cwd = getWorkdir() } = {}) {
  if (typeof path !== "string" || !path.trim()) return fail("A file path is required.");
  const full = expandPath(path, cwd);
  if (denySecretPath(full)) return fail("Blocked a secrets file.", "BLOCKED_PATH");
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS) return fail(`Provide 1–${MAX_EDITS} exact replacements.`);
  try {
    const stat = lstatSync(full), realPath = realpathSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return fail("Focused edits require a regular file without symlinks or hard links.", "UNSUPPORTED_FILE");
    if (denySecretPath(realPath)) return fail("Blocked a secrets file.", "BLOCKED_PATH");
    if (stat.size > MAX_BYTES) return fail("Focused edits are limited to files of 8 MiB.", "FILE_TOO_LARGE");
    if (!(stat.mode & 0o222)) return fail("The file is read-only.", "READ_ONLY");
    accessSync(realPath, constants.W_OK);
    const bytes = readFileSync(realPath), original = bytes.toString("utf8");
    if (original.includes("\0") || !Buffer.from(original, "utf8").equals(bytes)) return fail("Focused edits require UTF-8 text without NUL bytes.", "UNSUPPORTED_FILE");
    const replacements = [];
    for (const [index, edit] of edits.entries()) {
      if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") return fail(`Edit ${index + 1}: oldText must be nonempty and newText must be a string.`);
      const at = original.indexOf(edit.oldText);
      if (at < 0) return fail(`Edit ${index + 1}: oldText was not found. Nothing changed. All oldText blocks refer to the same original file, never an earlier edit's newText. Combine dependent replacements or send them in separate calls after reading the current content.`, "NO_MATCH");
      if (original.indexOf(edit.oldText, at + 1) >= 0) return fail(`Edit ${index + 1}: oldText is not unique. Add surrounding context. Nothing changed.`, "AMBIGUOUS_MATCH");
      replacements.push({ start: at, end: at + edit.oldText.length, replacement: edit.newText });
    }
    replacements.sort((left, right) => left.start - right.start);
    if (replacements.some((edit, index) => index > 0 && edit.start < replacements[index - 1].end)) return fail("Replacements overlap. Each edit must target a distinct part of the original file. Nothing changed.", "OVERLAPPING_EDITS");
    let cursor = 0, content = "";
    for (const edit of replacements) { content += original.slice(cursor, edit.start) + edit.replacement; cursor = edit.end; }
    content += original.slice(cursor);
    const size = checkWrite(content);
    if (!size.ok) return fail(size.error, "FILE_TOO_LARGE");
    const plan = Object.freeze({ ok: true, path: full, realPath, original, content,
      beforeHash: digest(bytes), afterHash: digest(content), bytes: size.bytes,
      edits: edits.length, changed: content !== original, state: Object.freeze(identity(stat)) });
    plans.add(plan);
    return plan;
  } catch (error) { return fail(error.code === "ENOENT" ? "The file does not exist. Use host_file_write for a new file." : error.message, error.code || "EDIT_READ_FAILED"); }
}

function unchangedSource(plan) {
  try {
    if (realpathSync(plan.path) !== plan.realPath) return false;
    const stat = lstatSync(plan.realPath), now = identity(stat);
    return stat.isFile() && !stat.isSymbolicLink() && Object.keys(plan.state).every(key => now[key] === plan.state[key])
      && digest(readFileSync(plan.realPath)) === plan.beforeHash;
  } catch { return false; }
}

export function commitFileEdit(plan, { tasker = "", allow = false, signal } = {}) {
  if (!plan || !plans.has(plan)) return fail("An intact prepared edit is required.");
  if (signal?.aborted) return { ...fail("Stopped before the edit ran.", "ABORTED"), held: true };
  if (!unchangedSource(plan)) return fail("The file or its permissions changed before the edit. Nothing changed. Read the current file and retry.", "STALE_FILE");
  if (!plan.changed) return { ok: true, unchanged: true, changed: false, path: plan.path, bytes: plan.bytes,
    beforeHash: plan.beforeHash, afterHash: plan.afterHash, edits: plan.edits, text: "The requested replacements leave the file unchanged." };
  const held = mutationHold({ tasker, allow, exists: true, write: true });
  if (held) return { ok: false, held: true, error: holdMessage(held, plan.path), path: plan.path };
  let temp = "", descriptor;
  try {
    const spares = keepSpares(plan.realPath);
    temp = join(dirname(plan.realPath), `.nova-edit-${randomUUID()}.tmp`);
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, plan.content, "utf8");
    if (process.platform !== "win32") fchownSync(descriptor, plan.state.uid, plan.state.gid);
    fchmodSync(descriptor, plan.state.mode & 0o7777);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (signal?.aborted) return { ...fail("Stopped before the edit was committed.", "ABORTED"), held: true };
    // Check again after backup/temp-file preparation, immediately before the
    // one same-directory rename. Never overwrite a changed source snapshot.
    if (!unchangedSource(plan)) return fail("The source changed while preparing the edit. Nothing changed. Read the current file and retry.", "STALE_FILE");
    renameSync(temp, plan.realPath); temp = "";
    let review;
    // Plan creation already validated non-NUL lossless UTF-8. Match the whole
    // writer's previous-source byte bound, using only this approved snapshot.
    // An optional diagnostic must never turn a committed edit into a failure.
    if (plan.state.size <= 80_000 && Buffer.byteLength(plan.original) <= 80_000) {
      try { review = mutationReview(plan.original, plan.content); } catch { /* Keep the actual commit result. */ }
    }
    return { ok: true, changed: true, unchanged: false, path: plan.path, bytes: plan.bytes,
      beforeHash: plan.beforeHash, afterHash: plan.afterHash, edits: plan.edits, spares,
      text: `Applied ${plan.edits} focused edit(s).`, ...(review ? {mutationReview:review} : {}) };
  } catch (error) { return fail(`Edit failed: ${error.message}`, error.code || "EDIT_WRITE_FAILED"); }
  finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
    if (temp) try { unlinkSync(temp); } catch {}
  }
}
