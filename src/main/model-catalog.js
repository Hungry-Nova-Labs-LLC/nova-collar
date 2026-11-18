import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TTL = 5 * 60_000;
const catalogs = new Map();
const pending = new Map();
const attempts = new Map();
const errors = new Map();
const localCatalogs = new Map();
const endpoint = (cfg) => String(cfg.chatUrl || "").replace(/\/+$/, "");
// Scope discovery to the provider AND account without persisting a credential.
const scope = (cfg) => createHash("sha256").update(JSON.stringify([endpoint(cfg), cfg.chatKey || cfg.toolsKey || ""])).digest("hex");
const cacheKey = (cfg) => `${cfg.home}:${scope(cfg)}`;
const file = (cfg) => join(cfg.home, "model-catalog.json");

// A mixed service inventory may contain embedding models. Input modalities
// such as text/image/audio do not make an embedding endpoint a chat model.
export function isEmbeddingOnlyModel(row) {
  const id = String(row?.id || row?.name || row?.model || row?.key || "").trim().toLowerCase();
  const embeddingKinds = new Set(["embedding", "embeddings", "text-embedding", "text-embeddings", "feature-extraction"]);
  if ([row?.type, row?.kind, row?.task].some(value => embeddingKinds.has(String(value || "").trim().toLowerCase().replaceAll("_", "-")))) return true;
  const capabilities = row?.capabilities;
  if (Array.isArray(capabilities)) {
    const kinds = capabilities.map(value => String(value).toLowerCase());
    if (kinds.some(value => embeddingKinds.has(value)) && !kinds.some(value => ["completion", "chat"].includes(value))) return true;
  }
  if (capabilities?.chat === false && (capabilities.embedding === true || capabilities.embeddings === true)) return true;
  // Older local APIs and saved catalogs may omit model type/capabilities.
  return /(?:^|[/_.:-])(?:embeddinggemma(?:[-_]?\d+)?|nomic[-_]embed(?:[-_]|$)|text[-_]embedding|mxbai[-_]embed|all[-_]minilm|bge[-_]|snowflake[-_]arctic[-_]embed|jina[-_]embeddings?)/.test(id);
}

export function catalogModels(body) {
  if (!Array.isArray(body?.data)) throw new Error("Invalid model catalog");
  const rows = new Map();
  for (const row of body.data) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || id === "local-3.8" || id.length > 512 || /[\x00-\x1f\x7f]/.test(id) || isEmbeddingOnlyModel(row)) continue;
    const description = String(row.description || "").slice(0, 1000);
    const tools = row.tool_call ?? row.capabilities?.tools;
    const context = Number(row.limit?.context);
    const output = Number(row.limit?.output);
    rows.set(id, {
      id, label: description.split(/ [—–] /)[0] || id,
      description, hint: tools === false ? "chat only" : "hosted",
      ...(typeof tools === "boolean" ? { tools } : {}),
      ...(Number.isFinite(context) && context > 0 ? { context } : {}),
      ...(Number.isFinite(output) && output > 0 ? { output } : {}),
    });
  }
  if (!rows.size) throw new Error("No models returned");
  return [...rows.values()];
}

export function getCatalog(cfg) {
  if (!cfg.chatUrl) return null;
  const key = cacheKey(cfg);
  if (!catalogs.has(key)) {
    try {
      const saved = JSON.parse(readFileSync(file(cfg), "utf8"));
      if (saved.scope === scope(cfg) && Number.isFinite(saved.updatedAt) && saved.models?.length) {
        // Revalidate disk contents. Preserve metadata using the wire shape.
        const models = catalogModels({ data: saved.models.map(row => ({ ...row, tool_call: row.tools, limit: row })) });
        catalogs.set(key, { ...saved, models });
      }
    } catch { /* First launch or damaged cache: fall back to saved model IDs. */ }
  }
  return catalogs.get(key) || null;
}

export function catalogState(cfg) {
  const catalog = getCatalog(cfg);
  return {
    modelScanError: errors.get(cacheKey(cfg)) || "",
    modelCatalogUpdatedAt: catalog?.updatedAt || null,
  };
}

export async function refreshCatalog(cfg, { force = false } = {}) {
  if (cfg.managedChat) return getCatalog(cfg);
  if (!cfg.chatUrl) return null;
  const key = cacheKey(cfg);
  if (pending.has(key)) return pending.get(key);
  const cached = getCatalog(cfg);
  const now = Date.now();
  if (!force && (now - (cached?.updatedAt || 0) < TTL || now - (attempts.get(key) || 0) < 60_000)) return cached;
  attempts.set(key, now);
  const request = (async () => {
    try {
      const token = cfg.chatKey || cfg.toolsKey;
      const response = await fetch(`${endpoint(cfg)}/models`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = catalogModels(await response.json());
      const catalog = { scope: scope(cfg), updatedAt: Date.now(), models };
      catalogs.set(key, catalog);
      errors.delete(key);
      try { writeFileSync(file(cfg), JSON.stringify(catalog), { mode: 0o600 }); } catch { /* Discovery works even if cache storage is unavailable. */ }
      return catalog;
    } catch (error) {
      const reason = /^HTTP \d+$|^No models returned$|^Invalid model catalog$/.test(error.message) ? error.message : "server unavailable";
      errors.set(key, `Hosted model refresh failed: ${reason}.${cached ? " Showing the last saved catalog." : " Showing saved model choices."}`);
      return cached;
    } finally { pending.delete(key); }
  })();
  pending.set(key, request);
  return request;
}

export function modelMetadata(cfg, target) {
  if (target.managedMetadata) return target.managedMetadata;
  if (target.local) return localCatalogs.get(scope({chatUrl:target.url,chatKey:target.key || "ollama"}))?.find(row=>row.id === target.model) || null;
  return getCatalog({ ...cfg, chatUrl: target.url, chatKey: target.key, toolsKey: "" })?.models.find(row => row.id === target.model) || null;
}

// Local discovery is read-only and memory-scoped to the exact endpoint/account.
// Credentials never appear in catalog rows, disk caches or public state.
export function rememberLocalCatalog(url, apiKey, rows) {
  const clean = rows.filter(row=>typeof row.id === "string" && !isEmbeddingOnlyModel(row)).map(row=>({
    id:row.id,
    ...(typeof row.tools === "boolean" ? {tools:row.tools} : {}),
    ...(Number.isFinite(row.context) && row.context > 0 ? {context:row.context} : {}),
  }));
  localCatalogs.set(scope({chatUrl:url,chatKey:apiKey || "ollama"}),clean);
}
