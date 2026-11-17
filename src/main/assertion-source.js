/** Remove Python strings/comments without executing/parsing the user's program.
 * Indentation/newlines remain, so library function bodies are not mistaken for
 * a top-level assertion driver. Unknown/incomplete quoting is conservative.
 */
function pythonCode(source) {
  let out = "", quote = "", triple = false, comment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (comment) { if (ch === "\n") { comment = false; out += ch; } else out += " "; continue; }
    if (quote) {
      if (ch === "\\") { out += " "; if (i + 1 < source.length) out += source[++i] === "\n" ? "\n" : " "; continue; }
      if (ch === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
        out += triple ? "   " : " "; if (triple) i += 2; quote = ""; triple = false;
      } else out += ch === "\n" ? ch : " ";
      continue;
    }
    if (ch === "#") { comment = true; out += " "; continue; }
    if (ch === "'" || ch === '"') { quote = ch; triple = source.slice(i, i + 3) === ch.repeat(3); out += triple ? "   " : " "; if (triple) i += 2; continue; }
    out += ch;
  }
  return out;
}

/** A custom check definition, failure accumulator, real top-level driver calls,
 * and a failure-dependent exit form. No filename or documentation is evidence.
 * prefix=true supports only the already-observed driver prefix of a draft;
 * callers must add independent scratch-scope evidence before limiting it.
 */
export function pythonAssertionDriver(source, {prefix = false} = {}) {
  const code = pythonCode(String(source || "")), lines = code.split("\n");
  const outside = [], functions = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].replaceAll("\t", "        ").length;
    if (current && indent <= current.indent) { functions.push(current); current = null; }
    const def = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (def && !current) { current = {name:def[2],indent,body:[]}; continue; }
    if (current) current.body.push(line);
    else outside.push(line);
  }
  if (current) functions.push(current);
  const driver = outside.join("\n");
  const accumulators = [...driver.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(?:\[\]|0)\s*$/gm)].map(m => m[1]);
  for (const fn of functions) {
    if (fn.indent !== 0) continue;
    if (!/^_?(?:check|assert|expect|verify|test|eq)(?:_\w*)?$/i.test(fn.name)) continue;
    const body = fn.body.join("\n");
    if (!/\bif\b/.test(body)) continue;
    for (const name of accumulators) {
      const updated = new RegExp(`\\b${name}\\s*(?:\\.\\s*append\\s*\\(|\\+=\\s*1\\b)`).test(body);
      if (!updated) continue;
      const calls = driver.match(new RegExp(`^\\s*(?:[A-Za-z_]\\w*\\s*=\\s*)?${fn.name}\\s*\\(`, "gm")) || [];
      if (calls.length < 2) continue;
      if (prefix) return true;
      const directExit = new RegExp(`(?:sys\\.exit|raise\\s+SystemExit)\\s*\\([^\\n)]*\\b${name}\\b`).test(driver);
      const conditionalExit = new RegExp(`^\\s*if\\s+(?:len\\s*\\(\\s*)?${name}\\b[^\\n]*:\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+(?:sys\\.exit|raise\\s+SystemExit)\\s*\\(\\s*[1-9]`, "m").test(driver);
      if (directExit || conditionalExit) return true;
    }
  }
  return false;
}
