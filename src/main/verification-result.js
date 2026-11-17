/** Recognize output attributable to one direct compiler, optionally passed
 * through a bounded head/tail filter and followed by an exit-status annotation.
 * A compile-and-run chain has mixed output and deliberately does not qualify. */
export function compilerExecutionCommand(command) {
  const segments = [], words = [];
  let word = "", quote = "", escaped = false;
  const flush = () => { if (word) words.push(word); word = ""; };
  const next = separator => { flush(); if (words.length) segments.push({ words: words.splice(0), separator }); };
  const text = String(command || "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "`" || (char === "$" && text[i + 1] === "(") || (char === "<" && text[i + 1] === "<")) return false;
    if (char === "&" && /[<>]$/.test(word)) { word += char; continue; }
    if (/[;|&()\n]/.test(char)) {
      const separator = text[i + 1] === char && /[&|]/.test(char) ? char + text[++i] : char;
      next(separator); continue;
    }
    if (/\s/.test(char)) { flush(); continue; }
    word += char;
  }
  if (quote || escaped) return false;
  next();
  const executable = value => String(value || "").split(/[\\/]/).at(-1);
  const isCompiler = tokens => {
    const args = [...tokens];
    if (executable(args[0]) === "env") args.shift();
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] || "")) args.shift();
    if (executable(args[0]) === "xcrun") args.shift();
    let name = executable(args.shift());
    if (name === "npx" && args[0] === "--no-install") { args.shift(); name = executable(args.shift()); }
    if (args.includes("--help") || args.includes("--version")) return false;
    if (/^(?:swiftc|clang\+\+|clang|gcc|g\+\+|cc|c\+\+|rustc|javac|tsc)$/.test(name)) return true;
    if (/^python(?:3(?:\.\d+)?)?$/.test(name)) {
      const index = args.indexOf("-m");
      return index >= 0 && !args.slice(0, index).includes("-c")
        && args.slice(0, index).every(arg => arg.startsWith("-"))
        && ["py_compile", "compileall"].includes(args[index + 1]);
    }
    if (name === "node") {
      for (const arg of args) {
        if (["--check", "-c"].includes(arg)) return true;
        if (!arg.startsWith("-") || ["-e", "--eval", "-p", "--print", "--"].includes(arg)) return false;
      }
    }
    return false;
  };
  if (!segments.length || !isCompiler(segments[0].words)) return false;
  for (let i = 1; i < segments.length; i++) {
    const [name, ...args] = segments[i].words;
    const separator = segments[i - 1].separator;
    const tool = executable(name);
    if (separator === "|" && ["head", "tail"].includes(tool)
      && (args.length === 1 && /^-\d+$/.test(args[0])
        || args.length === 2 && args[0] === "-n" && /^\d+$/.test(args[1]))) continue;
    if ([";", "\n"].includes(separator) && tool === "echo" && args.length === 1
      && /^(?:compile(?:r)?\s+)?(?:exit|status)(?:\s+code)?:\s*(?:\$\?|\$\{PIPESTATUS\[0\]\})$/.test(args[0])
      && i === segments.length - 1) continue;
    return false;
  }
  return !segments.at(-1).separator || [";", "\n"].includes(segments.at(-1).separator);
}

const compilerErrorPatterns = [
  /^.*\.(?:swift|[cm]?tsx?|c|h|cc|cpp|cxx|hpp|m|mm|java|rs|py):\d+(?::\d+)?:\s*(?:fatal\s+)?error:\s*\S/im,
  /^.*\.[cm]?tsx?\(\d+,\d+\):\s*error TS\d+:\s*\S/im,
  /^(?:error TS\d+:|error\[E\d+\]:)\s*\S/im,
  /^(?:swiftc|clang(?:\+\+)?|gcc|g\+\+|cc|c\+\+|rustc|javac):\s*(?:fatal\s+)?error:\s*\S/im,
  /^error:\s*(?:emit-(?:module|library)|link|compile) command failed\b/im,
  /^error:\s*aborting due to [1-9]\d* previous errors?\b/im,
  /^(?:SyntaxError|IndentationError|TabError):\s*\S/m,
];

/** Interpret process evidence without treating ordinary error words as failures.
 * Compiler diagnostics require a known compiler invocation; a successful data
 * program or log reader printing the same text retains its actual exit result. */
export function executionEvidence(raw = {}, { test = false, compiler = false } = {}) {
  const stdout = String(raw.stdout ?? raw.output ?? raw.text ?? "");
  const stderr = String(raw.stderr ?? ""), error = String(raw.error ?? "");
  const code = [raw.exitCode, raw.code, raw.status].find(value => typeof value === "number");
  const output = `${stdout}\n${stderr}\n${error}`;
  const failure = test && [
    /^not ok(?:\s+\d|\s+-)/im,
    /^#\s*fail\s+[1-9]\d*\b/im,
    /^FAILED\s*\([^\n]*(?:failures|errors)=[1-9]\d*/m,
    /^=+[^\n]*\b[1-9]\d*\s+failed\b[^\n]*=+\s*$/im,
    /^(?:Tests|Test Suites):[^\n]*\b[1-9]\d*\s+failed\b/im,
    /^\s*[1-9]\d*\s+CHECK(?:\(S\)|S)?\s+FAILED\b/im,
    /^\s*(?:FAILURES|FAILED)\s*:\s*(?:[1-9]\d*|\[\s*(?!\])\S)/im,
  ].find(pattern => pattern.test(output));
  const noTests = Boolean(raw.noTests || (test && /\bno tests ran\b|\bcollected 0 items\b|\bRan 0 tests\b|^#\s*tests\s+0\s*$|\bnode:test run\(\) is being called recursively within a test file\.\s*skipping running files\b|^\s*Error:\s*no test specified\s*$|^npm\s+(?:ERR!|error)\s+Missing script:\s*["']test(?::[^"']+)?["']|^(?:[^\s:]+[/\\])?python(?:3(?:\.\d+)?)?:\s*can't open file\s+['"][^'"\r\n]+['"]:\s*\[Errno 2\]\s*No such file or directory/im.test(output)));
  const unavailable = Boolean(raw.skipped || raw.unavailable || noTests);
  // Known tests fail from their actual process result, regardless of their
  // chosen footer format. An unstarted/empty check is unavailable, not proof
  // that application assertions ran and failed.
  const testFailure = Boolean(test && !raw.held && raw.killed !== "stop" && !unavailable
    && (failure || raw.ok === false || (code !== undefined && code !== 0)));
  const compilerMatch = compiler && compilerErrorPatterns.map(pattern => output.match(pattern)).find(Boolean);
  const compilerDiagnostic = compilerMatch ? compilerMatch[0].slice(0, 600) : "";
  const ok = (code === undefined ? raw.ok === true : code === 0 && raw.ok !== false)
    && !raw.killed && !raw.held && !testFailure && !unavailable && !compilerMatch;
  const diagnostic = noTests ? "No tests were executed; the requested test check is unavailable."
    : failure && testFailure ? "The command reported failing test assertions."
    : testFailure ? code !== undefined && code !== 0 ? `Test command exited with status ${code}.` : "The test command failed."
      : compilerMatch ? `Compiler diagnostic: ${compilerDiagnostic}`
      : code !== undefined && code !== 0 ? `Process exited with status ${code}.` : error || stderr;
  return { ...raw, ok, stdout, stderr, error, ...(code !== undefined ? { exitCode: code } : {}),
    testFailure, noTests, ...(noTests ? { skipped: true, unavailable: true } : {}),
    compilerFailure: Boolean(compilerMatch), compilerDiagnostic, diagnostic };
}
