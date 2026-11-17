import {isAbsolute} from "node:path";
import {toolSig} from "./laya-loop.js";

/** Bind only display identity to the effective cwd before dispatch; no I/O. */
export function commandIdentityForDisplay(raw, cwd, resolveDirectory) {
  try {
    const args = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.command !== "string"
      || !args.command || typeof cwd !== "string" || !isAbsolute(cwd)
      || (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd)) || typeof resolveDirectory !== "function") return null;
    const effective = resolveDirectory(args.cwd || ".", cwd);
    if (typeof effective !== "string" || !isAbsolute(effective) || effective.includes("\0")) return null;
    return toolSig("host_run", {...args,cwd:effective});
  } catch { return null; }
}

/** Display selection only: never removes receipts or changes verification debt. */
export function lastUnresolvedFailureForDisplay(trail) {
  const successful = new Set();
  for (let i = (Array.isArray(trail) ? trail.length : 0) - 1; i >= 0; i--) {
    const row = trail[i];
    if (!row || row.informational || row.name === "laya" || row.name === "ground") continue;
    const exact = row.name === "host_run" && typeof row.executionIdentity === "string" && /^host_run:[a-f0-9]{64}$/i.test(row.executionIdentity);
    if (exact && row.ok === true && row.executionUnavailable === false && (!row.verification || row.verification.status === "passed")) successful.add(row.executionIdentity);
    if (row.ok === false && !(exact && row.executionFailed === true && successful.has(row.executionIdentity))) return row;
  }
  return undefined;
}
