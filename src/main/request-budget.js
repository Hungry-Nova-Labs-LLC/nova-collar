import { modelMetadata } from "./model-catalog.js";
import { smallModel } from "./split.js";
import { modelRequestSettings } from "./model-settings.js";

const tokens = value => typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;

/** Resolve the window and reply reserve without routing, discovery or writes. */
export function requestBudget(cfg, target, extra = {}) {
  // Discovery metadata is scoped to the exact provider and credential.
  const metadata = modelMetadata(cfg, target);
  const profile = modelRequestSettings(cfg, target);
  const lean = Boolean(target.local || smallModel(target.model));
  const catalogContext = tokens(metadata?.context), catalogOutput = tokens(metadata?.output);
  const explicitContext = tokens(extra.ctx) || tokens(profile.contextTokens);
  const explicitOutput = tokens(extra.predict) || tokens(profile.outputTokens);
  // A local server is explicitly configured with this window in num_ctx. Its
  // budget must use that same effective window, rather than a hosted fallback.
  const contextTokens = target.local
    ? Math.min(catalogContext || Infinity, explicitContext || (target.kind === "managed-chat" ? catalogContext || 8192 : 12288))
    : catalogContext || explicitContext || (lean ? 12288 : 32768);
  const requested = explicitOutput || (target.kind === "managed-chat" ? 4096 : lean ? 1536 : catalogOutput ? 8192 : 0);
  const outputTokens = Math.min(requested || 8192, catalogOutput || Infinity, Math.max(256, Math.floor(contextTokens / 4)));
  return { contextTokens, outputTokens, lean };
}
