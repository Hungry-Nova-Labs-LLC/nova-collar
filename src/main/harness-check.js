import { ROOT } from "./config.js";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { executionEvidence } from "./verification-result.js";
export { executionEvidence } from "./verification-result.js";
import { isWindows, quoteShell } from "./platform.js";
import { runBash } from "./files.js";
import { denySecretPath } from "./safe.js";
import { expandPath, getWorkdir } from "./workdir.js";
import { nodeResolutionContext } from "./node-verification-context.js";

export const CODE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".go", ".swift", ".json", ".sh", ".bash"]);
export const PAGE = new Set([".html", ".htm", ".css"]);
export const TUI = /\b(curses|textual|blessed|prompt_toolkit|urwid|npyscreen)\b/i;
const CRASH = /\b(Traceback|SyntaxError|ReferenceError|TypeError|panic:|FATAL EXCEPTION|Exception:)\b/;
const VERIFIER = /(?:^|\/)(?:harness|harness-check|intuition|safe)\.js$|(?:^|\/)harness\.json$/i;
const RUNTIME_VERIFIERS = new Set(["verification-ledger.js", "verification-result.js", "methodology.js", "conversation.js", "context.js", "context-info.js", "instruction-context.js", "helper-context.js", "skills.js", "project-memory.js", "project-map.js", "project-verification.js", "checkpoints.js"]);

export function isCodePath(path) {
  return CODE.has(extname(String(path || "")).toLowerCase());
}

export function isPagePath(path) {
  return PAGE.has(extname(String(path || "")).toLowerCase());
}

export function isVerifierPath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (VERIFIER.test(normalized) || /(?:^|\/)(?:\.nova|\.novatag)\/checks\.json$/i.test(normalized)) return true;
  const full = expandPath(path, getWorkdir()).replace(/\\/g, "/");
  const runtime = join(ROOT, "src", "main").replace(/\\/g, "/") + "/";
  return full.startsWith(runtime) && RUNTIME_VERIFIERS.has(basename(full));
}

export function isTestPath(path) {
  const base = basename(String(path || "")).toLowerCase();
  return /(?:^test_.*|_test)\.py$/.test(base) || /\.test\.(js|mjs|cjs|ts)$/.test(base) || /_test\.go$/.test(base);
}

export function isTuiSource(path, source = "") {
  return TUI.test(source) || TUI.test(basename(String(path || "")));
}

/** A desktop window. Node still has to start it; a comment that says electron does not count. */
export function isWindowSource(path, source = "") {
  const text = String(source || "");
  return /\brequire\s*\(\s*['"]electron['"]\s*\)/.test(text)
    || /\bfrom\s+['"]electron['"]/.test(text)
    || /\bBrowserWindow\b/.test(text);
}

/** The reply describes a printout the last tool did not produce. */
export function inventedPrint(answer, detail) {
  const said = String(answer || "");
  const err = String(detail || "");
  const hit = said.match(/\bprinted\s+["']?([^"'\n]{3,80})/i);
  if (!hit) return false;
  const claim = hit[1].replace(/[.\s]+$/g, "").trim().toLowerCase();
  if (!claim) return false;
  return !err.toLowerCase().includes(claim.slice(0, 48));
}

export function expectFromAsk(text) {
  const out = [];
  const add = (value) => {
    const item = String(value || "").trim();
    if (item && !out.includes(item)) out.push(item);
  };
  const raw = String(text || "");
  for (const hit of raw.matchAll(/\bprints?\s+["']([^"']{1,40})["']/gi)) add(hit[1]);
  for (const hit of raw.matchAll(/\bprints?\s+(\d+)\b/gi)) add(hit[1]);
  for (const hit of raw.matchAll(/\boutput(?:s)?\s+["']([^"']{1,40})["']/gi)) add(hit[1]);
  return out.slice(0, 4);
}

export function missExpect(stdout, expects) {
  const blob = String(stdout || "");
  return (expects || []).filter((item) => !blob.includes(item));
}

export function verifyCommand(path, { expand = true } = {}) {
  const full = expand ? expandPath(path, getWorkdir()) : String(path || "");
  const ext = extname(full).toLowerCase();
  const windows = expand && isWindows;
  const q = quoteShell(full, windows);
  if (ext === ".py") return { full, command: `${windows ? "python" : "python3"} -m py_compile ${q}` };
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node --check ${q}` };
  if (ext === ".tsx") return { full, unavailable: "TSX needs the project's declared compiler/typecheck; native stripping does not cover JSX." };
  if ([".ts", ".mts", ".cts"].includes(ext)) {
    // Node's --check path does not itself strip TS on every supported release.
    // Strip without transforms, then parse text without running it. MTS is
    // always ESM; CTS is always CommonJS. Preserve the existing TS parse mode.
    const inputType = ext === ".cts" ? "commonjs" : "module";
    const script = `import * as module from "node:module"; import { readFileSync } from "node:fs"; import { spawnSync } from "node:child_process";\nif (typeof module.stripTypeScriptTypes !== "function") { console.error("NOVA_TS_UNAVAILABLE: native TypeScript syntax stripping is unavailable"); process.exit(73); }\nlet source;\ntry { source = module.stripTypeScriptTypes(readFileSync(${JSON.stringify(full)}, "utf8"), { mode: "strip" }); } catch (error) { if (error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") { console.error("NOVA_TS_UNAVAILABLE: this syntax requires the declared project compiler"); process.exit(73); } throw error; }\nconst checked = spawnSync(process.execPath, ["--check", "--input-type=${inputType}"], { input: source, encoding: "utf8", maxBuffer: 1024 * 1024 });\nif (checked.error) throw checked.error;\nprocess.stdout.write(checked.stdout || ""); process.stderr.write(checked.stderr || ""); process.exit(checked.status ?? 1);`;
    return { full, command: `node --input-type=module -e ${quoteShell(script, windows)}`, syntaxOnly: true, nativeTypescript: true };
  }
  if (ext === ".go") return { full, command: windows ? `gofmt -e ${q} | Out-Null; if ($LASTEXITCODE -eq 0) { go build -o NUL ${q} }` : `gofmt -e ${q} >/dev/null && go build -o /dev/null ${q}` };
  if (ext === ".swift") return { full, command: `swiftc -frontend -parse ${q}`, syntaxOnly: true };
  if (ext === ".json") return { full, command: `${windows ? "python" : "python3"} -c 'import json,sys; json.load(open(sys.argv[1]))' ${q}` };
  if (ext === ".sh" || ext === ".bash") return { full, command: `bash -n ${q}` };
  return null;
}

function pythonModule(full) {
  let dir = dirname(full), root = dir;
  while (existsSync(join(root, "__init__.py"))) root = dirname(root);
  if (root === dir) {
    for (let candidate = dir, depth = 0; depth < 6; depth++, candidate = dirname(candidate)) {
      if (basename(candidate) === "src") { root = candidate; break; }
      if (dirname(candidate) === candidate) break;
    }
  }
  if (root === dir && !existsSync(join(dir, "__init__.py"))) return null;
  const parts = relative(root, full).slice(0, -3).split(sep);
  if (parts.at(-1) === "__init__") parts.pop();
  if (!parts.length || parts.some(part => !/^[A-Za-z_]\w*$/.test(part))) return null;
  return { root, module: parts.join("."), cwd: basename(root) === "src" ? dirname(root) : root };
}

function apiPlan(full, api, module, windows) {
  const valid = value => typeof value === "string" && value.split(".").every(part => /^[A-Za-z_]\w*$/.test(part));
  if (!valid(api.symbol) || (api.method !== undefined && !valid(api.method))) return { full, unavailable: "Requested API names must be identifier paths." };
  const marker = `NOVA_API_${randomUUID().replaceAll("-", "")}`;
  if (extname(full).toLowerCase() === ".py") {
    const root = module?.root || dirname(full);
    const load = module ? `_module = importlib.import_module(${JSON.stringify(module.module)})`
      : `_spec = importlib.util.spec_from_file_location("_nova_verified_module", ${JSON.stringify(full)})\n_module = importlib.util.module_from_spec(_spec)\nsys.modules[_spec.name] = _module\n_spec.loader.exec_module(_module)`;
    const script = `import sys, importlib, importlib.util, inspect\nsys.path.insert(0, ${JSON.stringify(root)})\n${load}\n_target = _module\nfor _part in ${JSON.stringify(api.symbol.split("."))}:\n    _target = getattr(_target, _part)\nassert callable(_target), "Requested export is not callable"\n${api.method ? `for _part in ${JSON.stringify(api.method.split("."))}:\n    _target = getattr(_target, _part)\nassert callable(_target), "Requested method is not callable"\n` : ""}${api.variadicPositional || api.variadicKeyword ? `try:\n    _signature = inspect.signature(_target)\nexcept (ValueError, TypeError):\n    print(${JSON.stringify(marker + "_UNAVAILABLE")})\n    sys.exit(73)\n${api.variadicPositional ? 'assert any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in _signature.parameters.values()), "Missing variadic positional parameter"\n' : ""}${api.variadicKeyword ? 'assert any(p.kind == inspect.Parameter.VAR_KEYWORD for p in _signature.parameters.values()), "Missing variadic keyword parameter"\n' : ""}` : ""}print(${JSON.stringify(marker)})\n`;
    return { full, command: `${windows ? "python" : "python3"} -B -c ${quoteShell(script, windows)}`, cwd: module?.cwd || root, library: true, apiMarker: marker, runtime: "python-import" };
  }
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extname(full).toLowerCase())) {
    const script = `const m = await import(${JSON.stringify(pathToFileURL(full).href)});\nconst parts = ${JSON.stringify(api.symbol.split("."))};\nlet target = m[parts[0]] ?? m.default?.[parts[0]] ?? (m.default?.name === parts[0] ? m.default : undefined);\nfor (const part of parts.slice(1)) target = target?.[part];\nif (typeof target !== "function") throw Error("Requested export is not callable");\n${api.method ? `const method = ${JSON.stringify(api.method.split("."))};\nlet member = target?.prototype?.[method[0]];\nif (member === undefined) {\n  for (let owner = target; owner && owner !== Function.prototype; owner = Object.getPrototypeOf(owner)) {\n    if (Object.hasOwn(owner, method[0])) { member = target[method[0]]; break; }\n  }\n}\nfor (const part of method.slice(1)) member = member?.[part];\nif (typeof member !== "function") { console.log(${JSON.stringify(marker + "_UNAVAILABLE")}); process.exit(73); }\n` : ""}console.log(${JSON.stringify(marker)});`;
    return { full, command: `node --input-type=module -e ${quoteShell(script, windows)}`, apiMarker: marker, library: true, runtime: "native-node" };
  }
  return { full, unavailable: "No runtime API inspection is available for this language." };
}

export function runCommand(path, source = "", { expand = true, api } = {}) {
  const full = expand ? expandPath(path, getWorkdir()) : String(path || "");
  if (isVerifierPath(full)) return null;
  const ext = extname(full).toLowerCase();
  const windows = expand && isWindows;
  const q = quoteShell(full, windows);
  const python = windows ? "python" : "python3";
  const module = expand && ext === ".py" ? pythonModule(full) : null;
  if (api && !expand) return { full, unavailable: "Remote API imports need target-specific project context; no local import plan is assumed." };
  if (api) return apiPlan(full, api, module, windows);
  const pythonScript = (script) => `${python} -B -c ${quoteShell(script, windows)}`;
  const prefix = module ? `import sys; sys.path.insert(0, ${JSON.stringify(module.root)}); ` : "";
  if (isWindowSource(full, source) && (ext === ".js" || ext === ".mjs" || ext === ".cjs")) {
    return { full, command: `node ${q}`, window: true };
  }
  if (isTuiSource(full, source)) return null;
  if (isTestPath(full)) {
    if (ext === ".py") {
      const unitImports = /\b(?:import\s+unittest|from\s+unittest\s+import)\b/.test(source) && /\bTestCase\b/.test(source);
      const caseAliases = [...source.matchAll(/\bTestCase\s+as\s+(\w+)/g)].map(match => match[1]);
      const otherTestClass = [...source.matchAll(/^class\s+(Test\w*)\s*(?:\(([^)]*)\))?\s*:/gm)].some(match => !/\bTestCase\b/.test(match[2] || "") && !caseAliases.some(name => (match[2] || "").split(/\s*,\s*/).includes(name)));
      const pureUnittest = unitImports && !/^(?:async\s+)?def\s+test\w*\s*\(/m.test(source) && !/\bpytest\b/.test(source) && !otherTestClass;
      if (pureUnittest) {
        const root = module?.root || dirname(full), name = module?.module || basename(full, ".py");
        return { full, command: pythonScript(`import sys, unittest; sys.path.insert(0, ${JSON.stringify(root)}); suite = unittest.defaultTestLoader.loadTestsFromName(${JSON.stringify(name)}); result = unittest.TextTestRunner().run(suite); sys.exit(not result.wasSuccessful())`), cwd: module?.cwd || root, test: true };
      }
      return { full, command: module ? pythonScript(`${prefix}import pytest; sys.exit(pytest.main(["-q", ${JSON.stringify(full)}]))`) : `${python} -m pytest -q ${q}`, cwd: module?.cwd, test: true, runner: "pytest" };
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node --test ${q}`, test: true };
    if (ext === ".go") return { full, command: `go test ${q}`, test: true };
  }
  if (ext === ".py" && module) {
    const main = /if\s+__name__\s*==\s*['"]__main__['"]/.test(source);
    return { full, command: pythonScript(`${prefix}${main ? `import runpy; runpy.run_module(${JSON.stringify(module.module)}, run_name="__main__", alter_sys=True)` : `import importlib; importlib.import_module(${JSON.stringify(module.module)})`}`), cwd: module.cwd, library: !main };
  }
  if (ext === ".py") return { full, command: `${python} ${q}` };
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node ${q}` };
  if (ext === ".sh" || ext === ".bash") return { full, command: `bash ${q}` };
  return null;
}

function shaped(raw) {
  return executionEvidence(raw);
}

const unavailable = (path, command, reason) => ({ ok: false, skipped: true, unavailable: true, blocking: true, status: "unavailable", path, command, blurb: `check unavailable ${path}`, error: reason });
const missingTool = (output) => /(?:swiftc|pytest|python3?|node|tsc):\s*(?:command not found|not found)|(?:spawn\s+(?:swiftc|pytest|python3?|node|tsc)\s+ENOENT)|No module named ['"]?pytest|(?:swiftc|python3?|node|tsc)['"]?\s+is not recognized|(?:env:\s*['"]?(?:python3?|node|swiftc)['"]?:\s*No such file)/i.test(output);

function judged(result, path, kind) {
  const err = String(result.stderr || result.error || result.stdout || "").trim();
  if (result.ok) return { ok: true, path, blurb: `${kind} ok ${path}`, stdout: result.stdout.slice(0, 400) };
  return { ok: false, held: result.held, path, error: err.slice(-800) || `${kind} failed`, blurb: `${kind} failed ${path}` };
}

export async function verifyPath(path, extra = {}) {
  const expand = extra.expand !== false;
  const plan = verifyCommand(path, { expand });
  if (!plan) return null;
  if (plan.unavailable) return unavailable(plan.full, "", plan.unavailable);
  if (expand && denySecretPath(plan.full)) return { ok: false, path: plan.full, error: "blocked a secrets file" };
  const run = extra.exec || ((command) => runBash(command));
  const result = shaped(await run(plan.command));
  if (plan.nativeTypescript && !result.ok && /NOVA_TS_UNAVAILABLE|ERR_UNKNOWN_BUILTIN_MODULE|bad option:.*input-type/.test(`${result.stderr}\n${result.error}`)) return unavailable(plan.full, plan.command, "Native TypeScript syntax checking is unavailable; use the declared project compiler.");
  if (!result.ok && missingTool(`${result.stderr}\n${result.error}`)) return unavailable(plan.full, plan.command, result.error || result.stderr);
  const checked = judged(result, plan.full, plan.syntaxOnly ? "syntax parse" : "compile");
  return { ...checked, command: plan.command, syntaxOnly: Boolean(plan.syntaxOnly) };
}

export async function probePath(path, source = "", extra = {}) {
  const expand = extra.expand !== false;
  const expect = extra.expect || [];
  const plan = runCommand(path, source, { expand, api: extra.api });
  if (!plan) return null;
  if (plan.unavailable) return unavailable(plan.full, "", plan.unavailable);
  if (expand && denySecretPath(plan.full)) {
    return { ok: false, path: plan.full, error: "blocked a secrets file", blurb: `run blocked ${plan.full}` };
  }
  const run = extra.exec || ((command, options) => runBash(command, options?.cwd, { timeoutMs: 3500 }));
  const result = executionEvidence(await run(plan.command, { cwd: plan.cwd, timeoutMs: 3500 }), { test: plan.test });
  const resolution = nodeResolutionContext(plan.command, result);
  const out = `${result.stdout}\n${result.stderr}\n${result.error}`;
  if ([".ts", ".mts", ".cts"].includes(extname(plan.full).toLowerCase()) && !result.ok && /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(out)) return unavailable(plan.full, plan.command, "This TypeScript module needs the declared project compiler/runtime.");
  if (plan.apiMarker && result.stdout.split(/\r?\n/).includes(plan.apiMarker + "_UNAVAILABLE")) return unavailable(plan.full, plan.command, "Requested API cannot be inspected without additional execution context.");
  if (!result.ok && missingTool(`${result.stderr}\n${result.error}`)) return unavailable(plan.full, plan.command, result.error || result.stderr);
  if (result.noTests) return unavailable(plan.full, plan.command, "No tests were executed.");
  if (!result.ok && CRASH.test(out)) {
    return { ok: false, path: plan.full, command: plan.command, error: out.trim().slice(-800), blurb: `run failed ${plan.full}` };
  }
  if (result.killed === "timeout") {
    if (plan.window && !CRASH.test(out)) {
      return { ok: true, path: plan.full, command: plan.command, blurb: `window stayed open ${plan.full}`, stdout: result.stdout.slice(0, 400) };
    }
    return { ok: false, path: plan.full, command: plan.command, error: "timed out", blurb: `run hung ${plan.full}` };
  }
  if (!result.ok && !plan.test && /usage:/i.test(out) && /(?:arguments? (?:are |is )?required|following arguments are required)/i.test(out)) return unavailable(plan.full, plan.command, "Program requires command-line arguments; no runtime pass was established.");
  if (!result.ok) {
    return {
      ok: false,
      held: result.held,
      path: plan.full,
      command: plan.command,
      error: String(result.diagnostic || result.stderr || result.error || "run failed").slice(-800),
      blurb: `run failed ${plan.full}`,
      ...(resolution ? { verificationContext: resolution } : {}),
    };
  }
  const missing = missExpect(result.stdout, expect);
  if (missing.length) {
    return { ok: false, path: plan.full, command: plan.command, error: `missing output: ${missing.join(", ")}`, blurb: `run missed ${missing.join(", ")}` };
  }
  if (plan.apiMarker && !result.stdout.split(/\r?\n/).includes(plan.apiMarker)) return unavailable(plan.full, plan.command, "Runtime exited before the requested API checks completed.");
  return {
    ok: true,
    path: plan.full,
    blurb: plan.apiMarker ? `API import/callability ok ${plan.full} (behavior and consumer integration not tested)`
      : plan.test ? `test ok ${plan.full}` : plan.library ? `package import ok ${plan.full}` : `run ok ${plan.full}`,
    stdout: result.stdout.split(/\r?\n/).filter(line => line !== plan.apiMarker).join("\n").slice(0, 400),
    command: plan.command,
    ...(plan.apiMarker ? { apiVerified: true, verificationScope: "api-shape", runtime: plan.runtime } : {}),
  };
}

export function readJobSpec(dir = getWorkdir()) {
  const file = join(dir, "harness.json");
  if (!existsSync(file) || denySecretPath(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const check = String(raw.check || raw.command || "").trim().slice(0, 240);
    const expect = String(raw.expect || "").trim().slice(0, 80);
    if (!check || /(?:\brm\b|\bcurl\b|\bwget\b|\byes\b|while\s)/i.test(check)) return null;
    return { check, expect };
  } catch {
    return null;
  }
}

export async function runJobSpec(spec, extra = {}) {
  if (!spec?.check) return null;
  const run = extra.exec || ((command) => runBash(command, undefined, { timeoutMs: 15_000 }));
  const result = shaped(await run(spec.check));
  const out = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    return { ok: false, held: result.held, path: "harness.json", blurb: "job check failed", error: String(result.stderr || result.error || "check failed").slice(0, 800) };
  }
  if (spec.expect && !out.includes(spec.expect)) {
    return { ok: false, path: "harness.json", blurb: `job missed ${spec.expect}`, error: `harness.json expect ${JSON.stringify(spec.expect)} not in output` };
  }
  return { ok: true, path: "harness.json", blurb: "job check ok", stdout: result.stdout.slice(0, 400) };
}

export function shellTargets(command, base = getWorkdir()) {
  const found = [];
  const cmd = String(command || "");
  for (const hit of cmd.matchAll(/(?:>>?|tee(?:\s+-a)?)\s*["']?([^\s"'|&;]+)/g)) {
    if (isCodePath(hit[1])) found.push(expandPath(hit[1], base));
  }
  for (const hit of cmd.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"]w/g)) {
    if (isCodePath(hit[1])) found.push(expandPath(hit[1], base));
  }
  return [...new Set(found)];
}

export function unreadExisting(path, prior) {
  const full = expandPath(path, getWorkdir());
  if (prior?.has(full) || prior?.has(path)) return false;
  if (isVerifierPath(full)) return false;
  try {
    if (!existsSync(full)) return false;
    const text = readFileSync(full, "utf8");
    return text.length >= 200 || text.split("\n").length >= 8;
  } catch {
    return false;
  }
}

export function snapshotIfExists(path, prior) {
  const full = expandPath(path, getWorkdir());
  if (prior.has(full) || !existsSync(full)) return;
  try {
    prior.set(full, readFileSync(full, "utf8"));
  } catch {
    /* unreadable */
  }
}

export function censorPass(text, debt) {
  if (!debt?.length) return String(text || "");
  return String(text || "").replace(/^\s*PASS\b.*$/gm, "FAIL (harness still open)");
}
