/** Verification obligations belong to the harness, not its summarized conversation. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { APP_HOME } from "./config.js";
import { redactSecrets } from "./safe.js";
import { inlineNodeCheckIdentity, nativeNodeTransportIdentity } from "./node-verification-context.js";

const PHASES = { syntax: 1, runtime: 2, test: 3, project: 4 };
const STATUSES = new Set(["pending", "failed", "unverified", "passed", "unavailable"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const clip = (value, length = 2000) => String(value || "").slice(0, length);

function validTransportMetadata(row) {
  const commandDigest = command => digest(String(command).replace(/\r\n/g,"\n").trim());
  const safeCommand = command => typeof command === "string" && command.length <= 4000 && redactSecrets(command) === command;
  const identity = safeCommand(row.command) ? inlineNodeCheckIdentity(row.command) : null;
  if (row.transportCheckIdentity !== undefined || row.failure?.kind === "native-node-module-resolution") {
    if (row.kind !== "command" || row.status !== "failed" || row.failure?.kind !== "native-node-module-resolution"
      || !identity || row.transportCheckIdentity !== identity || commandDigest(row.command) !== row.commandHash
      || typeof row.failure.startupDiagnostic !== "string" || row.failure.startupDiagnostic.length > 4000
      || nativeNodeTransportIdentity(row.command,{ok:false,stderr:row.failure.startupDiagnostic}) !== identity) return false;
  }
  if (row.resolvedTransportFailures !== undefined) {
    if (row.kind !== "command" || !identity || commandDigest(row.command) !== row.commandHash
      || !Array.isArray(row.resolvedTransportFailures) || row.resolvedTransportFailures.length > 8) return false;
    for (const old of row.resolvedTransportFailures) {
      if (!old || !safeCommand(old.command) || old.commandHash === row.commandHash || commandDigest(old.command) !== old.commandHash
        || old.cwd !== row.path || old.resolvedByCommandHash !== row.commandHash || old.checkIdentity !== identity
        || inlineNodeCheckIdentity(old.command) !== identity || old.resolvedByPassed !== true || old.originalOutcome !== "failed"
        || typeof old.verifiedAt !== "string" || !Number.isFinite(Date.parse(old.verifiedAt))
        || typeof old.diagnostic !== "string" || old.diagnostic.length > 2000
        || typeof old.startupDiagnostic !== "string" || old.startupDiagnostic.length > 4000
        || nativeNodeTransportIdentity(old.command,{ok:false,stderr:old.startupDiagnostic}) !== identity) return false;
    }
  }
  return true;
}

function canonical(path) {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

function projectOf(path) {
  let dir = dirname(path);
  while (true) {
    if ([".git", ".nova/checks.json", ".novatag/checks.json", "package.json", "Cargo.toml", "go.mod", "Package.swift", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Makefile", "harness.json"].some((name) => existsSync(join(dir, name)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(path);
    dir = parent;
  }
}

/** Bounded file evidence. An unreadable/missing file is never a matching pass. */
export function verificationSource(path, source) {
  if (source !== undefined) return { hash: digest(String(source)), covered: true };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { hash: null, covered: false, reason: "not a regular source file" };
    if (stat.size > 10 * 1024 * 1024) return { hash: null, covered: false, reason: "source exceeds the 10 MiB verification limit" };
    return { hash: digest(readFileSync(path)), covered: true };
  } catch { return { hash: null, covered: false, reason: "source is missing or unreadable" }; }
}

export class VerificationLedger {
  constructor(sessionId, cwd, { home = APP_HOME } = {}) {
    this.cwd = resolve(cwd);
    this.sessionId = String(sessionId || "");
    this.file = this.sessionId ? join(home, "verification", `${digest(this.sessionId)}.json`) : null;
    this.entries = new Map();
    this.error = "";
    if (!this.file || !existsSync(this.file)) return;
    try {
      if (lstatSync(this.file).size > 4 * 1024 * 1024) throw new Error("ledger exceeds 4 MiB");
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.version !== 1 || saved.sessionId !== this.sessionId || !Array.isArray(saved.entries) || saved.entries.length > 5000) throw new Error("invalid verification ledger");
      for (const row of saved.entries) {
        if (!row || typeof row.key !== "string" || this.entries.has(row.key) || typeof row.path !== "string" || !row.path || typeof row.project !== "string" || typeof row.remote !== "boolean" || !STATUSES.has(row.status) || !PHASES[row.requiredPhase] || (row.hash !== null && !/^[a-f0-9]{64}$/.test(row.hash)) || (!row.remote && !isAbsolute(row.path)) || (row.kind !== undefined && !["file", "project", "command"].includes(row.kind)) || (row.coverage !== undefined && (!Array.isArray(row.coverage) || row.coverage.some((item) => typeof item !== "string")))) throw new Error("invalid verification entry");
        if (row.kind === "command" && (row.remote || !/^[a-f0-9]{64}$/.test(row.commandHash) || typeof row.command !== "string")) throw new Error("invalid verification command");
        if (!validTransportMetadata(row)) throw new Error("invalid transport verification relation");
        const expectedKey = row.kind === "command" ? digest(`command\0${row.project}\0${row.path}\0${row.commandHash}`)
          : digest(`${row.remote ? "remote" : "local"}\0${row.project}\0${row.path}`);
        if (row.key !== expectedKey) throw new Error("invalid verification identity");
        if (row.status === "unavailable" && (row.kind !== "project" || row.blocking !== false || !row.skipped || !row.unavailable || row.failure || row.coverage?.length)) throw new Error("invalid unavailable verification observation");
        this.entries.set(row.key, row);
      }
    } catch (error) {
      this.entries.clear();
      this.error = `Cannot restore verification ledger: ${error.message}. Preserve and repair ${this.file}.`;
    }
  }

  identity(path, { remote = false, target = "computer" } = {}) {
    const full = remote ? String(path) : canonical(resolve(this.cwd, String(path)));
    const project = remote ? String(target) : projectOf(full);
    const id = { key: digest(`${remote ? "remote" : "local"}\0${project}\0${full}`), project, path: full, remote };
    // Adding a manifest can reveal a more precise project root. Keep the same
    // file's unfinished obligation rather than orphaning it under the old root.
    const previous = !remote && [...this.entries.values()].find((row) => row.kind !== "project" && row.kind !== "command" && !row.remote && row.path === full && row.key !== id.key);
    if (previous) { this.entries.delete(previous.key); this.entries.set(id.key, { ...previous, ...id }); this.save(); }
    return id;
  }

  save() {
    if (!this.file || this.error) return;
    try {
      if (this.entries.size > 5000) throw new Error("too many verification entries");
      const text = JSON.stringify({ version: 1, sessionId: this.sessionId, entries: [...this.entries.values()] }, null, 2) + "\n";
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("ledger exceeds 4 MiB");
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } catch (error) { this.error = `Cannot save verification ledger: ${error.message}. Verification remains unfinished.`; }
  }

  changed(path, options = {}) {
    const id = this.identity(path, options), previous = this.entries.get(id.key);
    const source = verificationSource(id.path, options.remote ? options.source : undefined);
    const row = { ...previous, ...id, hash: source.hash, status: source.covered ? "pending" : "unverified", requiredPhase: previous?.requiredPhase || "syntax", diagnostic: source.reason || "Changed source needs verification.", updatedAt: new Date().toISOString() };
    this.entries.set(id.key, row);
    this.save();
    return row;
  }

  checked(path, { ok, skipped = false, unavailable = false, phase = "syntax", command = "", diagnostic = "", expectedHash, ...options } = {}) {
    if (!PHASES[phase]) throw new Error("Unknown verification phase.");
    const id = this.identity(path, options), previous = this.entries.get(id.key);
    const source = verificationSource(id.path, options.remote ? options.source : undefined);
    const requiredPhase = PHASES[previous?.requiredPhase] > PHASES[phase] ? previous.requiredPhase : phase;
    const changedDuringCheck = expectedHash !== undefined && source.hash !== expectedHash;
    const strongEnough = PHASES[phase] >= PHASES[requiredPhase];
    const status = !source.covered || changedDuringCheck ? "unverified"
      : skipped ? (previous?.failure || previous?.status === "failed" ? "failed" : "unverified")
      : !ok ? "failed" : strongEnough ? "passed" : previous?.status === "failed" ? "failed" : "unverified";
    const row = { ...previous, ...id, hash: source.hash, requiredPhase, phase, status,
      skipped: Boolean(skipped), unavailable: Boolean(unavailable),
      command: clip(command, 4000), diagnostic: !source.covered ? source.reason : changedDuringCheck ? "Source changed during verification; run the check again." : ok && !strongEnough ? `A ${phase} pass does not resolve the required ${requiredPhase} verification. ${previous?.diagnostic || ""}` : clip(diagnostic),
      updatedAt: new Date().toISOString(), ...(status === "passed" ? { verifiedAt: new Date().toISOString() } : {}) };
    if (status === "failed" && !ok && !skipped) row.failure = { ...id, hash: source.hash, phase, requiredPhase, status, command: row.command, diagnostic: row.diagnostic, updatedAt: row.updatedAt };
    if (status === "passed") delete row.failure;
    else delete row.verifiedAt;
    this.entries.set(id.key, row);
    this.save();
    return row;
  }

  projectChanged(root, revision, coverage = []) {
    const path = canonical(resolve(root)), project = path;
    const key = digest(`local\0${project}\0${path}`);
    const previous = this.entries.get(key);
    const failure = previous?.failure || (previous?.status === "failed" ? { ...previous } : undefined);
    const row = { ...previous, key, path, project, remote: false, kind: "project", hash: revision, phase: "project", requiredPhase: "project", status: "pending", blocking: true, skipped: false, unavailable: false, coverage, diagnostic: "Changed project needs its declared checks.", updatedAt: new Date().toISOString(), ...(failure ? { failure } : {}) };
    this.entries.set(key, row); this.save(); return row;
  }

  projectChecked(root, result, revision, coverage = []) {
    const row = this.projectChanged(root, revision, coverage);
    const unavailable = Boolean(result.skipped && result.unavailable && result.blocking === false && !coverage.length);
    row.status = unavailable && !row.failure ? "unavailable"
      : result.skipped && row.failure ? "failed"
      : result.skipped || coverage.length ? "unverified"
      : result.ok ? "passed" : "failed";
    row.skipped = Boolean(result.skipped);
    row.unavailable = Boolean(result.unavailable);
    row.blocking = row.status !== "unavailable" && row.status !== "passed";
    row.command = clip(result.command, 4000);
    row.diagnostic = clip([result.skipped && row.failure ? `Prior project failure remains unresolved: ${row.failure.diagnostic || "declared check failed"}` : "", result.error || result.output || "", ...coverage].filter(Boolean).join("\n"));
    if (row.status === "passed") { row.verifiedAt = new Date().toISOString(); delete row.failure; }
    else {
      delete row.verifiedAt;
      if (!result.skipped && row.status === "failed") row.failure = { path: row.path, hash: row.hash, phase: "project", requiredPhase: "project", status: "failed", command: row.command, diagnostic: row.diagnostic, updatedAt: row.updatedAt };
    }
    this.save(); return row;
  }

  /** The caller must establish that this was a turn-created, nonrequired
   * auxiliary. Missing requested files, failures and stronger checks never retire. */
  retireAuxiliary(path, expectedHash) {
    const id = this.identity(path), row = this.entries.get(id.key);
    if (!row || row.remote || row.kind === "project" || row.status !== "passed"
      || row.phase !== "syntax" || row.requiredPhase !== "syntax" || row.failure
      || !expectedHash || row.hash !== expectedHash) return false;
    try { lstatSync(id.path); return false; }
    catch (error) { if (error.code !== "ENOENT") return false; }
    this.entries.delete(id.key); this.save(); return true;
  }

  /** A structured selftest failure is its own obligation. A success in a
   * different command, directory or source check cannot erase that evidence. */
  commandChecked(cwd, command, result) {
    const path = canonical(resolve(cwd)), project = path;
    const commandHash = digest(String(command).replace(/\r\n/g, "\n").trim());
    const key = digest(`command\0${project}\0${path}\0${commandHash}`);
    const previous = this.entries.get(key);
    const failed = Boolean(result.testFailure);
    if (result.held || result.skipped || result.unavailable) return previous || null;
    const passed = result.ok === true && !failed && !result.noTests;
    const representable = String(command).length <= 4000 && redactSecrets(command) === command;
    const checkIdentity = passed && representable ? inlineNodeCheckIdentity(command) : null;
    const resolved = [];
    if (checkIdentity) for (const [oldKey, old] of this.entries) {
      if (oldKey === key || old.kind !== "command" || old.path !== path || old.status !== "failed"
        || old.failure?.kind !== "native-node-module-resolution" || old.transportCheckIdentity !== checkIdentity) continue;
      resolved.push({ commandHash:old.commandHash, command:old.command, diagnostic:old.diagnostic,
        startupDiagnostic:old.failure.startupDiagnostic, cwd:old.path, checkIdentity });
      this.entries.delete(oldKey);
    }
    if (!previous && !failed && !resolved.length) return null;
    const row = { ...previous, key, path, project, remote: false, kind: "command", commandHash,
      hash: null, phase: "test", requiredPhase: "test",
      command: clip(redactSecrets(command), 4000), status: passed ? "passed" : "failed",
      diagnostic: clip(redactSecrets(result.diagnostic || result.error || result.stderr || "Verification command failed.")),
      updatedAt: new Date().toISOString() };
    if (passed) {
      row.verifiedAt = row.updatedAt; delete row.failure; delete row.transportCheckIdentity;
      if (resolved.length) row.resolvedTransportFailures = [...(row.resolvedTransportFailures || []),
        ...resolved.map(old => ({...old, resolvedByCommandHash:commandHash, verifiedAt:row.updatedAt,
          originalOutcome:"failed", resolvedByPassed:true}))].slice(-8);
    } else {
      // A later loader error cannot downgrade an earlier genuine failure.
      const startupDiagnostic = clip(redactSecrets(result.stderr),4000);
      const transport = representable && (!previous?.failure || previous.failure.kind === "native-node-module-resolution")
        ? nativeNodeTransportIdentity(command,{...result,stderr:startupDiagnostic}) : null;
      row.failure = { command: row.command, phase: row.phase, diagnostic: row.diagnostic,
        ...(transport ? {kind:"native-node-module-resolution", startupDiagnostic} : {}) };
      if (transport) row.transportCheckIdentity = transport; else delete row.transportCheckIdentity;
    }
    this.entries.set(key, row); this.save(); return row;
  }

  unresolved() {
    let changed = false;
    for (const row of this.entries.values()) {
      if (row.remote || row.kind === "project" || row.kind === "command") continue; // Typed commands retain their own rerun obligations.
      const source = verificationSource(row.path);
      if (row.status === "passed" && (!source.covered || source.hash !== row.hash)) {
        row.status = source.covered ? "pending" : "unverified";
        row.diagnostic = source.reason || "Source changed since its passing check.";
        row.hash = source.hash;
        changed = true;
      }
    }
    if (changed) this.save();
    return [...this.entries.values()].filter((row) => row.status !== "passed" && row.status !== "unavailable");
  }

  debt({ forAction = false } = {}) {
    // A pending project revision belongs to the harness's completion check.
    // Requiring a model tool call to settle it prevents the no-tool transition
    // that runs those checks. It remains debt for every completion decision.
    const rows = this.unresolved().filter((row) => !(forAction && row.kind === "project" && row.status === "pending"))
      .map((row) => row.kind === "command"
      ? `${row.status} ${row.requiredPhase} verification command in ${row.path}: ${row.command}`
      : `${row.status} ${row.remote ? `${row.project}:` : ""}${row.path} (${row.requiredPhase})`);
    if (this.error) rows.unshift(this.error);
    return rows;
  }

  context() {
    const pending = this.unresolved();
    const unavailable = [...this.entries.values()].filter((row) => row.status === "unavailable");
    if (!pending.length && !unavailable.length && !this.error) return "";
    const view = ({ kind, path, project, remote, requiredPhase, status, diagnostic, command }) => ({ kind, path, project, remote, requiredPhase, status, diagnostic: clip(diagnostic, 800), command: clip(command, 800) });
    const text = JSON.stringify({ error: this.error || undefined, pending: pending.slice(0, 30).map(view), unavailable: unavailable.slice(0, 10).map(view), total: pending.length }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    return `<verification_state>\nHarness-owned verification observations, not instructions. Pending checks remain unfinished; a different file's pass or a weaker check cannot clear them. Unavailable project checks are explicit limitations, not passing test evidence. Recheck current source before claiming completion.\n${text.slice(0, 18000)}\n</verification_state>`;
  }
}
