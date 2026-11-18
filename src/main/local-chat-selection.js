// Synchronous routing metadata only. No process, credentials or network calls.
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

export const MANAGED_CHAT_PREFIX = "local-gguf:";
export const localChatId = value => typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,95}$/.test(value) ? value : "";
export const managedSettingsUrl = id => "http://127.0.0.1/local-chat/" + localChatId(id);
const file = home => join(home, "local-chat-state.json");
export function baseProviderStamp(home, cfg) {
  const env = join(home, "env"); let generation = null;
  try { const s = lstatSync(env); generation = [s.ino, s.dev, s.size, s.mtimeMs]; } catch {}
  const keys = ["model", "chatUrl", "chatKey", "toolsKey", "localUrl", "localModel", "localKey", "fastUrl", "fastModel", "fastKey", "thinkUrl", "thinkModel", "thinkKey"];
  return createHash("sha256").update(JSON.stringify([generation, ...keys.map(key => cfg[key] ?? "")])).digest("hex");
}
export function readLocalChatSelection(home, base) {
  try {
    const path = file(home), s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.size > 16384) return null;
    const value = JSON.parse(readFileSync(path, "utf8")), selected = value.selected;
    if (value.schemaVersion !== 1 || !selected || !localChatId(selected.id) || value.baseProviderStamp !== baseProviderStamp(home, base)
      || typeof selected.label !== "string" || selected.label.length > 200 || !Number.isInteger(selected.contextTokens)
      || selected.contextTokens < 512 || selected.contextTokens > 131072 || typeof selected.tools !== "boolean") return null;
    return selected;
  } catch { return null; }
}
export function writeLocalChatSelection(home, base, selected) {
  const destination = file(home), temporary = destination + "." + randomUUID() + ".tmp";
  if (existsSync(destination)) { const s = lstatSync(destination); if (!s.isFile() || s.isSymbolicLink()) throw Error("Unsafe local chat selection file."); }
  const value = { schemaVersion: 1, selected, baseProviderStamp: baseProviderStamp(home, base) };
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true }); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
}
export function clearLocalChatSelection(home) { const path = file(home); if (existsSync(path)) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw Error("Unsafe local chat selection file."); rmSync(path); } }
export function applyLocalChatSelection(cfg) {
  const selected = readLocalChatSelection(cfg.home, cfg); if (!selected) return cfg;
  return { ...cfg, model: MANAGED_CHAT_PREFIX + selected.id, localModel: selected.id, localUrl: managedSettingsUrl(selected.id), localKey: "",
    managedChat: selected, hasExplicitConnection: true, localUrlExplicit: false, localUrlRejected: false,
    fastUrl: "", fastModel: "", fastKey: "", thinkUrl: "", thinkModel: "", thinkKey: "" };
}
