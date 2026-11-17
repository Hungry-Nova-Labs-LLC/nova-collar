import { redactSecrets } from "./safe.js";

const STATUS = new Set(["ok", "held", "killed", "skipped", "unavailable", "testFailure", "noTests", "compilerFailure", "exitCode", "code", "status", "changed", "unchanged", "bytes", "directory", "stdout_truncated", "stderr_truncated", "text_truncated"]);

function prefix(text, length) {
  let end = Math.max(0, Math.min(text.length, length));
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end] || "")) end--;
  return text.slice(0, end);
}

function excerpt(text, length, source = false) {
  if (text.length <= length) return text;
  if (source || length < 80) return prefix(text, length);
  const marker = `\n[characters omitted]\n`;
  const head = prefix(text, Math.ceil((length - marker.length) / 2));
  let start = text.length - Math.max(0, length - marker.length - head.length);
  if (/[\uDC00-\uDFFF]/.test(text[start] || "")) start++;
  return head + marker + text.slice(start);
}

/** Offsets always describe the redacted characters actually returned, including
 * a second serialization cut. They never claim a page was the entire file. */
function updateRead(copy) {
  const read = copy.read;
  if (!read || typeof copy.text !== "string" || !Number.isInteger(read.offset) || !Number.isInteger(read.totalChars)) return;
  const endOffset = read.offset + copy.text.length;
  copy.read = { ...read, endOffset, nextOffset: endOffset < read.totalChars ? endOffset : null,
    endLine: read.startLine + (copy.text.match(/\n/g)?.length || 0),
    eof: endOffset >= read.totalChars, completeFile: read.offset === 0 && endOffset >= read.totalChars };
}

/** A result remains parseable JSON within the caller's character budget.
 * Typed process/status fields survive; omitted content is always explicit. */
export function packToolResult(result, { max = 24_000 } = {}) {
  const budget = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 24_000;
  const omitted = () => budget >= 18 ? JSON.stringify({ truncated: true }) : budget >= 4 ? "null" : budget >= 2 ? "{}" : "0";
  if (!result || typeof result !== "object") {
    const text = redactSecrets(String(result ?? ""));
    if (JSON.stringify(text).length <= budget) return JSON.stringify(text);
    return omitted();
  }
  const imageSafe = { ...result };
  if (imageSafe.data && typeof imageSafe.data === "object") {
    imageSafe.data = { ...imageSafe.data };
    if (imageSafe.data.image) imageSafe.data.image = `[image ${String(imageSafe.data.image).length} chars]`;
  }
  if (imageSafe.image) imageSafe.image = `[image ${String(imageSafe.image).length} chars]`;
  if (imageSafe.dataUrl) imageSafe.dataUrl = "[image]";
  const original = redactSecrets(JSON.stringify(imageSafe));
  const copy = JSON.parse(original);
  updateRead(copy);
  const encode = () => JSON.stringify(copy);
  if (encode().length <= budget) return encode();
  const packing = { truncated: true, originalChars: original.length, limit: budget, truncatedFields: [], omittedFields: [], omittedFieldCount: 0 };
  copy.packing = packing;
  const mark = key => {
    if (packing.truncatedFields.length < 12 && !packing.truncatedFields.includes(key)) packing.truncatedFields.push(key.slice(0, 80));
    if (["stdout", "stderr", "text"].includes(key)) copy[`${key}_truncated`] = true;
  };
  const setString = (key, value) => { copy[key] = value; if (key === "text") updateRead(copy); };
  // Shrink strings as strings, never a serialized JSON prefix. Source excerpts
  // retain exact leading text; process output keeps both its head and tail.
  const strings = Object.keys(copy).filter(key => typeof copy[key] === "string" && !STATUS.has(key))
    .sort((a, b) => copy[b].length - copy[a].length);
  for (const key of strings) {
    if (encode().length <= budget) break;
    const text = copy[key]; setString(key, "");
    if (encode().length > budget) {
      const value = excerpt(text, Math.min(text.length, Math.floor(budget / 8)), key === "text");
      setString(key, value); if (value !== text) mark(key); continue;
    }
    mark(key);
    let low = 0, high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setString(key, excerpt(text, middle, key === "text"));
      if (encode().length <= budget) low = middle; else high = middle - 1;
    }
    setString(key, excerpt(text, low, key === "text"));
  }
  // Unusually large structured payloads cannot crowd status out of the receipt.
  // Report bounded omission metadata rather than presenting a broken object.
  const optional = Object.keys(copy).filter(key => key !== "packing" && key !== "read" && !(key === "text" && copy.read) && !STATUS.has(key))
    .sort((a, b) => JSON.stringify(copy[b]).length - JSON.stringify(copy[a]).length);
  for (const key of optional) {
    if (encode().length <= budget) break;
    delete copy[key]; packing.omittedFieldCount++;
    if (packing.omittedFields.length < 12) packing.omittedFields.push(key.slice(0, 80));
  }
  if (encode().length > budget) {
    const status = Object.fromEntries(Object.entries(copy).filter(([key, value]) => STATUS.has(key) && typeof value !== "object" && String(value).length < 40));
    status.packing = { truncated: true, omitted: true };
    const encoded = JSON.stringify(status);
    return encoded.length <= budget ? encoded : omitted();
  }
  return encode();
}
