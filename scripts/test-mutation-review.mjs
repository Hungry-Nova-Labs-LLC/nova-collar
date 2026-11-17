import assert from "node:assert/strict";
import { test } from "node:test";
import { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mutationReview } from "../src/main/mutation-review.js";

const root = mkdtempSync(join(tmpdir(), "collar-mutation-review-"));
process.env.NOVAPUP_HOME = join(root, "profile");
const { writeUserFile } = await import("../src/main/files.js");
after(() => rmSync(root, { recursive: true, force: true }));

test("whole-file review exposes a removed compatibility branch without issuing a verdict", () => {
  const before = "export function normalize(value) {\n  if (value < 0) value += 10;\n  return value;\n}\n";
  const after = "export function normalize(value) {\n  return Math.round(value);\n}\n";
  const review = mutationReview(before, after);
  assert.equal(review.informational, true);
  assert.match(review.removedExcerpt, /if \(value < 0\)/);
  assert.match(review.removedExcerpt, /return value/);
  assert.equal(review.removedLines, 2);
  assert.equal(review.addedLines, 1);
  assert(!Object.hasOwn(review, "passed"));
  assert(!Object.hasOwn(review, "verification"));
});

test("new files and identical replacements do not invent a removal review", () => {
  assert.equal(mutationReview(undefined, "new\n"), null);
  assert.equal(mutationReview("same\n", "same\n"), null);
  const added = mutationReview("a\n", "a\nb\n");
  assert.equal(added.removedLines, 0);
  assert.equal(added.addedLines, 1);
});

test("quoted source is redacted and large removals carry truthful bounded omissions", () => {
  const source = 'const key = "sk-proj-' + 'a'.repeat(60) + '";\n';
  const review = mutationReview(source.repeat(25), "replacement\n", { maxChars: 300 });
  assert(!JSON.stringify(review).includes('a'.repeat(60)));
  assert(review.removedExcerpt.length <= 300);
  assert(review.omittedRemovedLines > 0);
  assert.equal(review.shownRemovedLines + review.omittedRemovedLines, review.removedLines);
  assert.equal(mutationReview("a\n".repeat(601), "b").removedExcerpt, undefined);
});

test("permitted whole-file writes expose the actual removed source while new, held and secret writes do not", () => {
  const path = join(root, "existing.mjs");
  const before = "export function keep(value) {\n  if (value == null) return 0;\n  return value;\n}\n";
  const after = "export function keep(value) { return value; }\n";
  writeFileSync(path, before);
  const held = writeUserFile(path, after, { tasker: "user" });
  assert.equal(held.held, true); assert.equal(held.mutationReview, undefined);
  assert.equal(readFileSync(path, "utf8"), before);
  const result = writeUserFile(path, after, { tasker: "user", allow: true });
  assert.equal(result.ok, true); assert.equal(readFileSync(path, "utf8"), after);
  assert.match(result.mutationReview.removedExcerpt, /if \(value == null\) return 0/);
  assert.equal(result.mutationReview.informational, true);
  assert.equal(writeUserFile(join(root, "new.mjs"), "export const newFile = true;\n").mutationReview, undefined);
  const secret = writeUserFile(join(root, ".env"), "fake\n");
  assert.equal(secret.ok, false); assert.equal(secret.mutationReview, undefined);
});

test("oversized and non-UTF-8 previous files do not manufacture text excerpts", () => {
  for (const [name, bytes] of [["large.txt", Buffer.alloc(80_001, 120)], ["binary.txt", Buffer.from([255, 254, 1])]]) {
    const path = join(root, name); writeFileSync(path, bytes);
    const result = writeUserFile(path, "replacement\n", { allow: true });
    assert.equal(result.ok, true); assert.equal(result.mutationReview, undefined);
  }
});
