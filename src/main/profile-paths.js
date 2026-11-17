// Keep the main app and its credential guards on the same legacy profile.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function runtimeElectronApp() {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return null;
  try { return createRequire(import.meta.url)("electron").app || null; }
  catch { return null; }
}

// Source tests and previews may opt into an isolated home. Installed main
// builds retain ~/.novapup; a leftover preview variable cannot move user data.
export function mainProfileHome({ userHome = homedir(), override = process.env.NOVAPUP_HOME, packaged = Boolean(runtimeElectronApp()?.isPackaged) } = {}) {
  const requested = String(override || "").trim();
  return requested && !packaged ? resolve(requested) : join(userHome, ".novapup");
}
