import {createHash} from "node:crypto";
import {basename, isAbsolute, relative, resolve, sep} from "node:path";
import {sourceScopePlan} from "./source-preload.js";
import {authoredAssertionSource} from "./authored-checks.js";

const HASH = /^[a-f0-9]{64}$/;
const knownHash = value => typeof value === "string" && HASH.test(value);
const CODE = /\.(?:py|[cm]?js|[cm]?ts|tsx|go|swift|json|sh|bash)$/i;
const HELPER = /(?:^|[/_.-])(?:tests?|specs?|verify|verification|checks?)(?=[/_.-]|$)/i;
const inside = (root, path) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const hash = text => createHash("sha256").update(text).digest("hex");

/** Optional draft-budget heuristic only. Every input is supplied by the private
 * harness cache: no reads, probes, path canonicalization or success verdicts.
 * An unknown initial revision, alias outside the original lexical cwd, or
 * ambiguous protected basename conservatively keeps the optional guard on.
 */
export function createRequestedSourceProgress({ask, cwd, protectedPaths = [], denyPath} = {}) {
  const root = typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd) : "";
  const scope = sourceScopePlan(ask);
  const protectedNames = new Set(protectedPaths.filter(path => typeof path === "string").map(path => basename(path).toLowerCase()));
  const blocked = path => { try { return typeof denyPath !== "function" || Boolean(denyPath(path)); } catch { return true; } };
  const candidate = path => root && inside(root, path) && CODE.test(path) && !HELPER.test(relative(root, path).replaceAll("\\", "/"))
    && !protectedNames.has(basename(path).toLowerCase()) && !blocked(path);
  const targets = ["blanket", "specific"].includes(scope.readRestriction) || !root ? []
    : scope.paths.map(path => resolve(root, path)).filter(candidate);
  return ({cwd: currentCwd, snapshots = [], aliases = new Map()} = {}) => {
    if (!root || currentCwd !== root || !targets.length || !Array.isArray(snapshots) || !(aliases instanceof Map)) return false;
    for (const source of snapshots.slice(0, 500)) {
      if (!source || source.authorizedSave !== true || typeof source.path !== "string" || !isAbsolute(source.path)
        || typeof source.currentPath !== "string" || !isAbsolute(source.currentPath)) continue;
      const path = resolve(source.path), currentPath = resolve(source.currentPath);
      if (!candidate(path) || !candidate(currentPath)) continue;
      if (!targets.some(target => target === path || target === currentPath || aliases.get(target) === currentPath)) continue;
      if (!knownHash(source.initialHash) || !knownHash(source.currentHash) || !knownHash(source.savedHash)
        || source.initialHash === source.currentHash || source.savedHash !== source.currentHash) continue;
      const text = source.text;
      if (typeof text !== "string" || text.length > 80_000 || Buffer.byteLength(text) > 80_000
        || authoredAssertionSource(path, text) || hash(text) !== source.currentHash) continue;
      return true;
    }
    return false;
  };
}
