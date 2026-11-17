import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { APP_HOME } from "./config.js";
import { checkWrite, runWatched } from "./guard.js";
import { denySecretPath, redactSecrets } from "./safe.js";
import { holdMessage, keepSpares, mutationHold } from "./spare.js";
import { expandPath, getWorkdir } from "./workdir.js";
import { mutationReview } from "./mutation-review.js";

function expand(path) {
  return expandPath(path, getWorkdir());
}

function gated(path) {
  const full = expand(path);
  const blocked = denySecretPath(full);
  if (blocked) return { ok: false, error: blocked, path: full };
  return { ok: true, path: full };
}

export async function runBash(command, cwd, opts) {
  return runWatched(command, expand(cwd || getWorkdir()), opts);
}

export function readUserFile(path, options = {}) {
  const offset = options?.offset ?? 0, limit = options?.limit ?? 80_000;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 80_000) {
    return { ok: false, error: "offset must be a nonnegative integer; limit must be an integer from 1 to 80000 characters." };
  }
  const gate = gated(path);
  if (!gate.ok) return gate;
  try {
    const stat = statSync(gate.path);
    if (stat.isDirectory()) {
      return { ok: true, path: gate.path, directory: true, entries: readdirSync(gate.path).slice(0, 200) };
    }
    // Coordinates refer to the redacted view, so paging cannot expose a secret
    // by slicing through it before redaction. Keep the default text compatible.
    const view = redactSecrets(readFileSync(gate.path, "utf8"));
    if (offset > view.length || (offset && /[\uDC00-\uDFFF]/.test(view[offset] || "") && /[\uD800-\uDBFF]/.test(view[offset - 1]))) {
      return { ok: false, error: "offset exceeds the text or splits a Unicode character; use the previous nextOffset.", path: gate.path, totalChars: view.length };
    }
    let endOffset = Math.min(view.length, offset + limit);
    if (endOffset && /[\uD800-\uDBFF]/.test(view[endOffset - 1]) && /[\uDC00-\uDFFF]/.test(view[endOffset] || "")) endOffset--;
    if (endOffset === offset && offset < view.length) {
      return { ok: false, error: "limit is too small for the next Unicode character; use a limit of at least 2.", path: gate.path };
    }
    const text = view.slice(offset, endOffset), startLine = view.length ? 1 + (view.slice(0, offset).match(/\n/g)?.length || 0) : 0;
    return { ok: true, path: gate.path, bytes: stat.size, text,
      text_truncated: offset > 0 || endOffset < view.length,
      read: { offset, endOffset, nextOffset: endOffset < view.length ? endOffset : null,
        totalChars: view.length, totalLines: view.length ? 1 + (view.match(/\n/g)?.length || 0) : 0,
        startLine, endLine: startLine + (text.match(/\n/g)?.length || 0),
        eof: endOffset >= view.length, completeFile: offset === 0 && endOffset >= view.length,
        viewSha256: createHash("sha256").update(view).digest("hex") } };
  } catch (error) {
    return { ok: false, error: error.message || "read failed", path: gate.path };
  }
}

export function writeUserFile(path, content, gateOpts = {}) {
  const size = checkWrite(content);
  if (!size.ok) return size;
  const gate = gated(path);
  if (!gate.ok) return gate;
  let exists = false;
  try {
    exists = existsSync(gate.path) && statSync(gate.path).isFile();
  } catch {
    exists = false;
  }
  const held = mutationHold({
    tasker: gateOpts.tasker || "",
    allow: Boolean(gateOpts.allow),
    exists,
    write: true,
  });
  if (held) return { ok: false, held: true, error: holdMessage(held, gate.path), path: gate.path };
  try {
    // Capture only inside the already permitted write path. Large/binary
    // sources earn no synthetic diff or correctness claim.
    const previousBytes = exists && statSync(gate.path).size <= 80_000 ? readFileSync(gate.path) : undefined;
    const previousText = previousBytes?.toString("utf8");
    const previous = previousBytes && !previousBytes.includes(0) && Buffer.from(previousText, "utf8").equals(previousBytes) ? previousText : undefined;
    const spares = exists ? keepSpares(gate.path) : [];
    mkdirSync(dirname(gate.path), { recursive: true });
    writeFileSync(gate.path, content ?? "");
    const review = mutationReview(previous, content ?? "");
    return { ok: true, path: gate.path, bytes: size.bytes, spares, ...(review ? { mutationReview: review } : {}) };
  } catch (error) {
    return { ok: false, error: error.message || "write failed", path: gate.path };
  }
}

export function listDir(path) {
  const gate = gated(path || getWorkdir());
  if (!gate.ok) return gate;
  try {
    return {
      ok: true,
      path: gate.path,
      entries: readdirSync(gate.path, { withFileTypes: true }).slice(0, 300).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
      })),
    };
  } catch (error) {
    return { ok: false, error: error.message || "list failed", path: gate.path };
  }
}

export function writeMemory(name, content) {
  const file = name === "personality" ? "personality.md" : "rules.md";
  return writeUserFile(`${APP_HOME}/${file}`, content);
}
