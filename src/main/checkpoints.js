/** Per-turn file versions. Manifests reference shared content-addressed blobs. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { APP_HOME } from "./config.js";

const ROOT = join(APP_HOME, "checkpoints");
const OBJECTS = join(ROOT, "objects");
const IGNORE = new Set([".git", ".novapup", ".nova-collar-public", "node_modules", "__pycache__", ".venv", "target", "dist", "build"]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifestDir = (sessionId) => join(ROOT, hash(String(sessionId)).slice(0, 24));
function canonical(file) {
  try { return realpathSync(file); } catch {
    const parent = dirname(file); return parent === file ? file : join(canonical(parent), basename(file));
  }
}

function snapshot(file, maxBytes) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error("file exceeds checkpoint size limit");
    const data = readFileSync(file);
    return { hash: hash(data), mode: stat.mode & 0o777, data, realPath: canonical(file) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function store(snapshot) {
  if (!snapshot) return null;
  mkdirSync(OBJECTS, { recursive: true, mode: 0o700 });
  const file = join(OBJECTS, snapshot.hash);
  try { writeFileSync(file, snapshot.data, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return { hash: snapshot.hash, mode: snapshot.mode };
}

export class Checkpoint {
  constructor(sessionId, cwd, options = {}) {
    this.sessionId = sessionId; this.cwd = cwd; this.before = new Map(); this.directories = new Set(); this.skipped = [];
    this.maxBytes = options.maxFileBytes || 10 * 1024 * 1024;
    this.maxTotal = options.maxTotalBytes || 50 * 1024 * 1024;
    this.bytes = 0;
  }

  track(paths) {
    for (const given of paths) {
      const file = resolve(this.cwd, String(given));
      try {
        if (existsSync(file) && lstatSync(file).isDirectory()) {
          if (this.directories.has(file)) continue;
          this.walk(file, (entry) => this.capture(entry));
          this.directories.add(file);
        } else if (!existsSync(file) && String(given).endsWith("/")) {
          this.directories.add(file);
        } else this.capture(file);
      } catch (error) { this.skipped.push(`${file}: ${error.message}`); }
    }
  }

  walk(dir, visit) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) this.walk(file, visit);
      else if (entry.isFile()) visit(file);
      if (this.before.size >= 500) throw new Error("checkpoint file count limit reached");
    }
  }

  capture(file) {
    if (this.before.has(file)) return;
    if (this.before.size >= 500) throw new Error("checkpoint file count limit reached");
    // An unseen file under a directory already captured was created this turn.
    const added = [...this.directories].some((dir) => file.startsWith(dir + sep));
    const before = added ? null : snapshot(file, this.maxBytes);
    if (this.bytes + (before?.data.length || 0) > this.maxTotal) throw new Error("checkpoint memory limit reached");
    this.bytes += before?.data.length || 0;
    this.before.set(file, before);
  }

  finish(reason, { expectedAfter } = {}) {
    const changes = [];
    let afterBytes = 0;
    for (const dir of this.directories) {
      try { this.walk(dir, (file) => { if (!this.before.has(file)) this.before.set(file, null); }); } catch (error) { if (error.code !== "ENOENT") this.skipped.push(`${dir}: ${error.message}`); }
    }
    for (const [file, before] of this.before) {
      try {
        const after = expectedAfter?.has(file) ? expectedAfter.get(file) : snapshot(file, this.maxBytes);
        if (before && after && before.realPath !== after.realPath) throw new Error("source path changed through a symlink or moved ancestor");
        if (before?.hash === after?.hash && before?.mode === after?.mode) continue;
        afterBytes += after?.data.length || 0;
        if (afterBytes > this.maxTotal) throw new Error("checkpoint final size limit reached");
        changes.push({ path: file, realPath: before?.realPath || after?.realPath || canonical(file), kind: !before ? "added" : !after ? "deleted" : "edited", before: store(before), after: store(after) });
      } catch (error) { this.skipped.push(`${file}: ${error.message}`); }
    }
    if (!changes.length && !this.skipped.length) return null;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    const previous = listCheckpoints(this.sessionId);
    const sequence = Math.max(0, ...previous.map(row => Number.isSafeInteger(row.sequence) ? row.sequence : 0)) + 1;
    const manifest = { version: 1, id, sequence, previousId: previous[0]?.id || null, sessionId: this.sessionId, cwd: this.cwd, ts: new Date().toISOString(), reason, changes, skipped: this.skipped };
    const dir = manifestDir(this.sessionId); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  }
}

export function listCheckpoints(sessionId) {
  const dir = manifestDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse().flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(dir, name), "utf8"))]; } catch { return []; }
  }).sort((a, b) => (Number(b.sequence) || 0) - (Number(a.sequence) || 0) || String(b.id).localeCompare(String(a.id)));
}

/** Preflight a whole newest-first rollback range before changing any file.
 * The resulting virtual state checks intermediate revisions, including files
 * created in one turn and deleted in a later turn. No missing coverage is safe
 * to treat as a complete working-state restore.
 */
export function planCheckpointRestore(sessionId, ids) {
  if (!Array.isArray(ids) || ids.length > 500 || new Set(ids).size !== ids.length) throw new Error("Invalid checkpoint restore range.");
  const saved = listCheckpoints(sessionId), byId = new Map(saved.map(row => [row.id, row]));
  if (ids.some((id, index) => saved[index]?.id !== id)) throw new Error("Restore must include the latest checkpoints in order.");
  const states = new Map(), originals = new Map();
  let totalBytes = 0;
  for (const id of ids) {
    const manifest = byId.get(id);
    if (!manifest || manifest.sessionId !== sessionId || !Array.isArray(manifest.changes)
      || !Array.isArray(manifest.skipped) || manifest.skipped.length) throw new Error("Checkpoint coverage is incomplete; inspect skipped paths before recovery.");
    const next = saved[saved.findIndex(row => row.id === id) + 1]?.id || null;
    if (manifest.previousId !== next) throw new Error("Checkpoint predecessor chain is missing or unreadable; restore stopped.");
    for (const change of manifest.changes) {
      if (!change || typeof change.path !== "string" || resolve(change.path) !== change.path
        || !change.realPath || canonical(change.path) !== change.realPath) throw new Error(`Changed path since checkpoint: ${change?.path || "unknown"}. Restore stopped.`);
      if (!states.has(change.path)) {
        if (states.size >= 500) throw new Error("Recovery file count limit reached.");
        const current = snapshot(change.path, 10 * 1024 * 1024);
        totalBytes += current?.data.length || 0;
        originals.set(change.path, current);
        states.set(change.path, current);
      }
      const current = states.get(change.path);
      if (current?.hash !== change.after?.hash || current?.mode !== change.after?.mode) throw new Error(`Changed since checkpoint: ${change.path}. Restore stopped.`);
      let before = null;
      if (change.before) {
        if (!/^[a-f0-9]{64}$/.test(change.before.hash) || !Number.isInteger(change.before.mode)) throw new Error("Invalid checkpoint object.");
        const data = readFileSync(join(OBJECTS, change.before.hash));
        if (data.length > 10 * 1024 * 1024 || hash(data) !== change.before.hash) throw new Error(`Damaged checkpoint for ${change.path}`);
        totalBytes += data.length;
        before = { ...change.before, realPath: change.realPath, data };
      }
      if (totalBytes > 100 * 1024 * 1024) throw new Error("Recovery size limit reached.");
      states.set(change.path, before);
    }
  }
  const entries = [...states].map(([path, target]) => ({ path, target, current: originals.get(path) }));
  if (entries.reduce((sum, row) => sum + (row.current?.data.length || 0), 0) > 50 * 1024 * 1024
    || entries.reduce((sum, row) => sum + (row.target?.data.length || 0), 0) > 50 * 1024 * 1024) throw new Error("Recovery reverse-journal size limit reached.");
  return { sessionId, ids: [...ids], cwd: ids.length ? byId.get(ids.at(-1)).cwd : "", entries };
}

export function restoreCheckpointPlan(plan, { assertIdle = () => {} } = {}) {
  assertIdle();
  // Reload manifests and blobs rather than trusting a caller-modified plan.
  const checked = planCheckpointRestore(plan.sessionId, plan.ids);
  const undo = new Checkpoint(plan.sessionId, checked.cwd || process.cwd());
  const owned = new Map();
  let failure, journal;
  try {
    for (const { path, target, current } of checked.entries) {
      assertIdle();
      const live = snapshot(path, 10 * 1024 * 1024);
      if (live?.hash !== current?.hash || live?.mode !== current?.mode || canonical(path) !== (current?.realPath || target?.realPath || canonical(path))) throw new Error(`Changed during recovery: ${path}. Restore stopped.`);
      if (live?.hash === target?.hash && live?.mode === target?.mode) continue;
      undo.track([path]);
      if (!undo.before.has(path) || undo.skipped.length) throw new Error(`Could not preserve a reverse checkpoint for ${path}. Restore stopped.`);
      if (!target) { if (live) rmSync(path); owned.set(path, null); continue; }
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.nova-recovery-${randomUUID()}`;
      try {
        writeFileSync(tmp, target.data, { mode: target.mode, flag: "wx" });
        chmodSync(tmp, target.mode); renameSync(tmp, path);
        owned.set(path, { ...target, realPath: current?.realPath || target.realPath });
      } finally { if (existsSync(tmp)) rmSync(tmp); }
    }
    for (const [path, expected] of owned) {
      const live = snapshot(path, 10 * 1024 * 1024);
      if (live?.hash !== expected?.hash || live?.mode !== expected?.mode
        || expected?.realPath && canonical(path) !== expected.realPath) throw new Error(`Changed during recovery: ${path}. Inspect the partial recovery before continuing.`);
    }
  } catch (error) { failure = error; }
  finally {
    // A rejected/untouched path belongs to the owner, not this partial restore.
    // Persist only committed mutations, using exactly our written bytes as the
    // AFTER state so a later owner edit can never become undo-authorized data.
    for (const path of undo.before.keys()) if (!owned.has(path)) undo.before.delete(path);
    journal = undo.finish(failure ? "recovery-incomplete" : `recover:${plan.ids.join(",")}`, { expectedAfter: owned });
  }
  if (failure) { failure.recoveryCheckpointId = journal?.id || null; throw failure; }
  return { restored: checked.entries.length, checkpoint: journal };
}

export function undoCheckpoint(sessionId, id) {
  const manifest = listCheckpoints(sessionId).find((c) => id ? c.id === id : c.changes.length > 0);
  if (!manifest) throw new Error("No matching checkpoint.");
  const restore = [];
  // Validate everything first: do not overwrite subsequent user edits or corrupt blobs.
  for (const change of manifest.changes) {
    if (change.realPath && canonical(change.path) !== change.realPath) throw new Error(`Changed path since checkpoint: ${change.path}. Restore stopped.`);
    const current = snapshot(change.path, 100 * 1024 * 1024);
    if (current?.hash !== change.after?.hash || current?.mode !== change.after?.mode) throw new Error(`Changed since checkpoint: ${change.path}. Restore stopped.`);
    let data = null;
    if (change.before) {
      data = readFileSync(join(OBJECTS, change.before.hash));
      if (hash(data) !== change.before.hash) throw new Error(`Damaged checkpoint for ${change.path}`);
    }
    restore.push({ ...change, data });
  }
  const undo = new Checkpoint(sessionId, manifest.cwd);
  undo.track(restore.map((r) => r.path));
  for (const change of restore) {
    if (!change.before) { rmSync(change.path); continue; }
    mkdirSync(dirname(change.path), { recursive: true });
    const tmp = `${change.path}.novapup-${randomUUID()}`;
    writeFileSync(tmp, change.data, { mode: change.before.mode });
    chmodSync(tmp, change.before.mode);
    renameSync(tmp, change.path);
  }
  return { restored: restore.length, checkpoint: undo.finish(`undo:${manifest.id}`) };
}
