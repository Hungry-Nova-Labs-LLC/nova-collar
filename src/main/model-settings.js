// Explicit per-endpoint/model inference settings, following Tag's model-profile
// approach. This file has no provider routes, credentials or model defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
const endpoint = (value) => String(value || "").replace(/\/+$/, "");
const integer = (value, min, max) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function profile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 512) return null;
  let url;
  try {
    url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  } catch { return null; }
  const out = { url: endpoint(url.href), model: value.model.trim() };
  for (const [name, min, max] of [["contextTokens", 512, 2_000_000], ["outputTokens", 32, 131_072]]) {
    if (value[name] === undefined) continue;
    if (!integer(value[name], min, max)) return null;
    out[name] = value[name];
  }
  if (value.temperature !== undefined) {
    if (typeof value.temperature !== "number" || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) return null;
    out.temperature = value.temperature;
  }
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "boolean") return null;
    out.reasoning = value.reasoning;
  }
  if (value.reasoningEffort !== undefined) {
    if (!efforts.has(value.reasoningEffort)) return null;
    out.reasoningEffort = value.reasoningEffort;
  }
  return out;
}

export function modelRequestSettings(cfg, target) {
  if (!cfg?.home || !target?.model || !target?.url) return {};
  try {
    const text = readFileSync(join(cfg.home, "model-settings.json"), "utf8");
    if (text.length > 262_144) return {};
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > 128) return {};
    const rows = data.profiles.map(profile).filter(Boolean);
    return rows.find((row) => row.url === endpoint(target.profileUrl || target.url) && row.model === (target.profileModel || target.model)) || {};
  } catch { return {}; }
}

export function applyModelRequestSettings(body, settings = {}) {
  if (body.temperature === undefined && settings.temperature !== undefined) body.temperature = settings.temperature;
  if (typeof settings.reasoning === "boolean") body.chat_template_kwargs = { enable_thinking: settings.reasoning };
  if (efforts.has(settings.reasoningEffort)) body.reasoning_effort = settings.reasoningEffort;
  return body;
}
