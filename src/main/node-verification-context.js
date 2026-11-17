import { basename, extname } from "node:path";
import { createHash } from "node:crypto";

// Optional evidence classification only: no execution, filesystem lookup or
// inferred runner. Opaque shell forms conservatively earn no added context.
function shellWords(text) {
  const words = []; let word = "", quote = "", active = false;
  const flush = () => { if (active) words.push(word); word = ""; active = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") { if (++i >= text.length) return null; word += text[i]; active = true; continue; }
    if (quote) {
      if (c === quote) quote = "";
      else { if (quote === '"' && (c === "$" || c === "`")) return null; word += c; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (/[;&|<>\n\r`$(){}]/.test(c)) return null;
    if (/\s/.test(c)) flush(); else { word += c; active = true; }
  }
  if (quote) return null;
  flush(); return words;
}

/** One actual native Node invocation, never a command quoted by echo/cat. */
export function nativeNodeInvocation(command) {
  const text = String(command || "").trim();
  if (!text || text.length > 128 * 1024) return null;
  let header = text, stdin;
  if (text.includes("<<")) {
    // Quoting the delimiter disables shell interpolation of the source body.
    const match = text.match(/^([^\n]*?)\s*<<(['"])([A-Za-z_]\w*)\2\s*\n([\s\S]*?)\n\3\s*$/);
    if (!match) return null;
    [, header, , , stdin] = match;
    if (stdin.split(/\r?\n/).some(line => line === match[3])) return null;
  }
  const words = shellWords(header);
  const executable = words?.shift();
  if (!words || basename(executable || "") !== "node") return null;
  const inline = (kind, source, index, equals = false) => {
    const args = [...words];
    if (kind === "eval") args[index] = equals ? "--eval=<source>" : "<source>";
    return { kind, source, commandIdentity: { executable, args, input: kind } };
  };
  let source;
  for (let i = 0; i < words.length; i++) {
    const arg = words[i];
    if (["-e", "--eval"].includes(arg)) {
      if (stdin !== undefined || words[i + 1] === undefined) return null;
      source = words[++i];
      return inline("eval", source, i);
    }
    if (arg.startsWith("--eval=")) return stdin === undefined ? inline("eval", arg.slice(7), i, true) : null;
    if (["-p", "--print"].includes(arg) || arg.startsWith("--print=")) return null;
    if (arg === "--") {
      const script = words[++i];
      return script === "-" && stdin !== undefined && i === words.length - 1 ? inline("stdin", stdin)
        : stdin === undefined && script ? { kind: "script", script } : null;
    }
    if (["--input-type", "--disable-warning"].includes(arg)) { if (!words[++i]) return null; continue; }
    if (/^--(?:input-type=(?:module|commonjs|module-typescript|commonjs-typescript)|disable-warning=[\w_-]+)$/.test(arg)
      || ["--no-warnings", "--experimental-strip-types", "--no-strip-types"].includes(arg)) continue;
    if (arg === "-" && stdin !== undefined && i === words.length - 1) return inline("stdin", stdin);
    if (arg.startsWith("-")) return null;
    return stdin === undefined ? { kind: "script", script: arg } : null;
  }
  return stdin !== undefined ? inline("stdin", stdin) : null;
}

// Retain literal identities while dropping comments. Slash expressions and
// templates are unsupported rather than guessing regex/division/interpolation.
function jsTokens(source) {
  const out = []; let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i + 2); if (i < 0) break; continue; }
    if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue; }
    if (c === "/" || c === "`") return null;
    if (c === "'" || c === '"') {
      const q = c, start = i; let value = "", escaped = false; i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === "\\") { escaped = true; if (++i >= source.length) return null; }
        value += source[i++];
      }
      if (source[i++] !== q) return null;
      out.push({ value: escaped ? null : value, string: true, start, end: i }); continue;
    }
    const id = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (id) { out.push({ value: id }); i += id.length; continue; }
    out.push({ value: c }); i++;
  }
  return out;
}
const isAssertModule = token => token?.string && /^node:assert(?:\/strict)?$/.test(token.value || "");
const identifier = token => !token?.string && /^[A-Za-z_$][\w$]*$/.test(token?.value || "");
function assertionBinding(statement) {
  const v = statement.map(t => t.value);
  if (v[0] === "import") {
    if (identifier(statement[1]) && v[2] === "from" && isAssertModule(statement[3]) && statement.length === 4) return v[1];
    if (v[1] === "*" && v[2] === "as" && identifier(statement[3]) && v[4] === "from" && isAssertModule(statement[5]) && statement.length === 6) return v[3];
  }
  if (!["const", "let", "var"].includes(v[0]) || !identifier(statement[1]) || v[2] !== "=") return null;
  let rhs = statement.slice(3);
  if (rhs.at(-2)?.value === "." && rhs.at(-1)?.value === "default") rhs = rhs.slice(0, -2);
  while (rhs[0]?.value === "(" && rhs.at(-1)?.value === ")") rhs = rhs.slice(1, -1);
  const r = rhs.map(t => t.value);
  if (r[0] === "require" && r[1] === "(" && isAssertModule(rhs[2]) && r[3] === ")" && r.length === 4) return v[1];
  if (r[0] === "await" && r[1] === "import" && r[2] === "(" && isAssertModule(rhs[3]) && r[4] === ")" && r.length === 5) return v[1];
  return null;
}

/** Require a real node:assert binding and a top-level assertion statement.
 * Dormant functions, printed source, comments and intentional exit(1) do not
 * become tests. Unsupported syntax stays ordinary execution evidence.
 */
export function inlineNodeAssertionCommand(command) {
  const invocation = nativeNodeInvocation(command);
  if (!invocation?.source) return false;
  const tokens = jsTokens(invocation.source);
  if (!tokens) return false;
  const bindings = new Set(); let start = 0, braces = 0, parens = 0, brackets = 0, stopped = false;
  const statement = end => {
    const row = tokens.slice(start, end); start = end + 1;
    if (row[0]?.value === "throw" || row[0]?.value === "process" && row[1]?.value === "."
      && ["exit", "abort"].includes(row[2]?.value) && row[3]?.value === "(") { stopped = true; return false; }
    const binding = assertionBinding(row);
    if (binding) { bindings.add(binding); return false; }
    let index = row[0]?.value === "await" ? 1 : 0;
    if (bindings.has(row[index]?.value)) {
      index++;
      if (row[index]?.value === ".") {
        const method = row[++index]?.value;
        if (/^(?:ok|equal|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|throws|doesNotThrow|rejects|doesNotReject|fail|ifError|match|doesNotMatch)$/.test(method || "")) index++;
      }
      if (row[index]?.value === "(") return true;
    }
    // Reassignment, member overrides, aliasing and other opaque uses can change
    // what a later call means. Do not carry the binding through them.
    for (const binding of bindings) if (row.some(token => !token.string && token.value === binding)) bindings.delete(binding);
    return false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i].value;
    if (tokens[i].string) continue;
    if (v === "{") braces++; else if (v === "}") braces--;
    if (v === "(") parens++; else if (v === ")") parens--;
    if (v === "[") brackets++; else if (v === "]") brackets--;
    if (braces < 0 || parens < 0 || brackets < 0) return false;
    if (v === ";" && !braces && !parens && !brackets) {
      if (statement(i)) return true;
      if (stopped) return false;
    }
  }
  return !braces && !parens && !brackets && statement(tokens.length);
}

/** Explain a proven native-loader error without asserting its missing target
 * exists, changing source, or reclassifying a failed process as unavailable. */
export function nodeResolutionContext(command, result = {}) {
  if (result.ok !== false || result.held || result.skipped || result.unavailable || !nativeNodeInvocation(command)) return null;
  const output = String(result.stderr || "");
  if (!/Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module /.test(output) || !/node:internal\/modules\/esm\//.test(output)) return null;
  const url = output.match(/\burl:\s*['"](file:[^'"\r\n]+)['"]/)?.[1];
  let extensionless = false;
  try { extensionless = Boolean(url && !extname(new URL(url).pathname)); } catch { /* no inferred target */ }
  return {
    kind: "native_node_module_resolution", runner: "native Node ESM", assertionsReached: "not established",
    guidance: extensionless
      ? "Native Node ESM requires explicit file extensions in relative imports, including TypeScript imports. A valid project may use different resolution. Inspect the reported import and use an already available declared project runner when applicable; do not install a runner or change a documented module contract merely to satisfy this probe. This failed command did not establish behavioral assertion results."
      : "Native Node ESM failed to resolve a module. Inspect the exact reported import and existing project runtime configuration; this is a real failed invocation, not evidence that behavioral assertions passed. Do not infer that a missing module exists or install a runner automatically.",
  };
}

/** Exact invocation/program identity except a literal ./relative import may
 * gain/lose its .ts suffix. Preserve all other source bytes (including comments,
 * whitespace/ASI, assertions), executable, flags and script arguments. */
export function inlineNodeCheckIdentity(command) {
  if (String(command || "").length > 4000) return null;
  if (!inlineNodeAssertionCommand(command)) return null;
  const invocation = nativeNodeInvocation(command), tokens = jsTokens(invocation.source), replacements = [];
  const add = token => {
    const value = token?.string && token.value;
    if (typeof value !== "string" || !value.startsWith("./") || /[?#]/.test(value) || value.endsWith("/")) return;
    const ext = extname(value);
    if (ext && ext !== ".ts") return;
    if (ext === ".ts") replacements.push({start:token.start + 1, end:token.end - 1, text:value.slice(0,-3)});
  };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].string || tokens[i].value !== "import" || tokens[i - 1]?.value === ".") continue;
    if (tokens[i + 1]?.value === "(") {
      if (!tokens[i + 2]?.string || tokens[i + 2].value === null || tokens[i + 3]?.value !== ")") return null;
      add(tokens[i + 2]);
    }
    else if (tokens[i + 1]?.string) add(tokens[i + 1]);
    else for (let j = i + 1; j < tokens.length && tokens[j].value !== ";"; j++) {
      if (!tokens[j].string && tokens[j].value === "from" && tokens[j + 1]?.string) { add(tokens[j + 1]); break; }
    }
  }
  let program = invocation.source;
  for (const row of replacements.sort((a,b) => b.start - a.start)) program = program.slice(0,row.start) + row.text + program.slice(row.end);
  return createHash("sha256").update(JSON.stringify({invocation:invocation.commandIdentity,program})).digest("hex");
}

/** Only attributable native loader failures can use import-only supersession.
 * Known assertion/source failures remain exact-command obligations. */
export function nativeNodeTransportIdentity(command, result = {}) {
  if (!nodeResolutionContext(command,result) || result.compilerFailure) return null;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/\b(?:AssertionError|ERR_ASSERTION|SyntaxError|ReferenceError|TypeError)\b|^not ok(?:\s+\d|\s+-)|^#\s*fail\s+[1-9]\d*\b|^\s*[1-9]\d*\s+CHECK(?:\(S\)|S)?\s+FAILED\b|^\s*(?:FAILURES|FAILED)\s*:/im.test(output)) return null;
  return inlineNodeCheckIdentity(command);
}
