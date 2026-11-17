import { execFileSync, spawn } from "node:child_process";
import { arch, freemem, platform, totalmem } from "node:os";
import { allowServiceUrl } from "./safe.js";
import { isEmbeddingOnlyModel, rememberLocalCatalog } from "./model-catalog.js";

const PROBES = [
  { name: "Ollama", url: "http://127.0.0.1:11434", kind: "ollama" },
  { name: "LM Studio", url: "http://127.0.0.1:1234", kind: "openai" },
  { name: "llama.cpp", url: "http://127.0.0.1:8080", kind: "openai" },
  { name: "local model", url: "http://127.0.0.1:8000", kind: "openai" },
];

function which(name) {
  try {
    return execFileSync(platform() === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
  } catch {
    return "";
  }
}

export function memoryPlan() {
  const totalGb = totalmem() / 1024 ** 3;
  const freeGb = freemem() / 1024 ** 3;
  const round = (n) => Math.round(n * 10) / 10;
  let model = null;
  if (totalGb >= 32) model = { name: "qwen2.5:14b", diskGb: 9, runGb: 12 };
  else if (totalGb >= 16) model = { name: "qwen2.5:7b", diskGb: 5, runGb: 8 };
  else if (totalGb >= 8) model = { name: "qwen2.5:3b", diskGb: 2.2, runGb: 4 };
  return {
    totalGb: round(totalGb),
    freeGb: round(freeGb),
    appGb: 0.4,
    layaDiskGb: 1,
    layaRamGb: 2,
    model,
    platform: platform(),
    arch: arch(),
    ollamaBin: Boolean(which("ollama")),
    brew: Boolean(which("brew")),
  };
}

// Discovery never reads another application's profile or scans the LAN.
export function normalizeLocalUrl(input, { binding = false } = {}) {
  try {
    const text = String(input || "").trim();
    if (!text) return "";
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
    if (binding && url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (binding && url.hostname === "[::]") url.hostname = "[::1]";
    if (binding && !url.port) url.port = "11434";
    const checked = allowServiceUrl(url.toString(), "local");
    if (!checked) return "";
    return checked.replace(/\/+$/, "").replace(/(?:\/v1)?$/, "/v1");
  } catch { return ""; }
}

const modelId = value => typeof value === "string" && value.trim().length <= 512
  && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
const objectRows = value => Array.isArray(value) ? value.slice(0,128).filter(row=>row && typeof row === "object" && !Array.isArray(row)) : [];
const chatRow = row => !isEmbeddingOnlyModel(row)
  && !["decision", "reranker", "image", "image-generation", "transcription"].includes(String(row.type || "").toLowerCase());

async function readJson(url, { timeoutMs = 700, apiKey = "", method = "GET", body } = {}) {
  try {
    const response = await fetch(url, {
      method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? {body:JSON.stringify(body)} : {}),
    });
    if ([401,403].includes(response.status)) return {authRequired:true};
    if (!response.ok || Number(response.headers.get("content-length")) > 2_000_000) return null;
    const text = await response.text();
    if (text.length > 2_000_000) return null;
    return {data:JSON.parse(text)};
  } catch { return null; }
}

async function probe(row, {timeoutMs = 700, apiKey = ""} = {}) {
  const url = normalizeLocalUrl(row.url);
  if (!url) return null;
  const base = url.replace(/\/v1$/, "");
  const options = {timeoutMs,apiKey};
  let listed, running, kind = row.kind;
  if (kind === "ollama" || kind === "auto") {
    [listed,running] = await Promise.all([readJson(`${base}/api/tags`,options),readJson(`${base}/api/ps`,options)]);
    if (Array.isArray(listed?.data?.models)) kind = "ollama";
    else if (kind === "auto") kind = "openai";
  }
  const nativeAuthRequired = Boolean(listed?.authRequired);
  let detailRows = [];
  if (kind === "ollama" && Array.isArray(listed?.data?.models)) {
    const loaded = new Set(objectRows(running?.data?.models).map(item=>modelId(item.name || item.model)).filter(Boolean));
    const rows = objectRows(listed.data.models).map(item=>({...item,id:modelId(item.name || item.model)})).filter(item=>item.id);
    // Metadata is read-only. Cap the number of requests and run them in parallel.
    const inspect = [...rows.filter(item=>loaded.has(item.id)),...rows].filter((item,index,all)=>all.findIndex(other=>other.id===item.id)===index).slice(0,24);
    const details = await Promise.all(inspect.map(async item=>[item.id,(await readJson(`${base}/api/show`,{...options,method:"POST",body:{model:item.id}}))?.data]));
    const byId = new Map(details);
    detailRows = rows.map(item=>({...item,...byId.get(item.id),id:item.id,loaded:loaded.has(item.id)}));
  } else if (kind === "openai") {
    listed = await readJson(`${url}/models`,options);
    if (Array.isArray(listed?.data?.data)) {
      let metadata;
      // LM Studio's documented native API supplies model type and loaded state.
      if (row.name === "LM Studio" || row.kind === "auto") {
        metadata = await readJson(`${base}/api/v1/models`,options);
        if (!Array.isArray(metadata?.data?.models)) metadata = await readJson(`${base}/api/v0/models`,options);
      }
      const native = objectRows(Array.isArray(metadata?.data?.models) ? metadata.data.models : metadata?.data?.data);
      const byId = new Map();
      for (const item of native) {
        const id = modelId(item.key || item.id); if (!id) continue;
        const loaded = item.state === "loaded" || (Array.isArray(item.loaded_instances) && item.loaded_instances.length > 0);
        const detail = {...item,loaded}; byId.set(id,detail);
        for (const instance of objectRows(item.loaded_instances)) if (modelId(instance.id)) byId.set(instance.id,detail);
      }
      detailRows = objectRows(listed.data.data).map(item=>({...item,...byId.get(item.id),id:modelId(item.id)})).filter(item=>item.id);
    }
  }
  if (!Array.isArray(listed?.data?.models) && !Array.isArray(listed?.data?.data)) {
    return listed?.authRequired || nativeAuthRequired ? {name:row.name,url,kind,models:[],modelDetails:[],authRequired:true,preferred:Boolean(row.preferred)} : null;
  }
  const unique = new Map();
  for (const item of detailRows.filter(chatRow)) {
    const capabilities = item.capabilities;
    const tools = item.tool_call ?? capabilities?.tools ?? capabilities?.trained_for_tool_use
      ?? (Array.isArray(capabilities) && capabilities.length ? capabilities.includes("tools") : undefined);
    const architecture = item.model_info?.["general.architecture"];
    const context = Number(item.limit?.context ?? item.max_context_length ?? (architecture ? item.model_info?.[`${architecture}.context_length`] : undefined));
    unique.set(item.id,{id:item.id,loaded:item.loaded === true,
      ...(typeof tools === "boolean" ? {tools} : {}),...(Number.isFinite(context) && context > 0 ? {context} : {})});
  }
  rememberLocalCatalog(url,apiKey,[...unique.values()]);
  return {name:row.name,url,kind,models:[...unique.keys()],modelDetails:[...unique.values()],preferred:Boolean(row.preferred),authRequired:false};
}

export function localChatCandidates(report) {
  const rows = new Map();
  for (const server of objectRows(report?.found)) {
    const url = normalizeLocalUrl(server.url); if (!url || server.authRequired) continue;
    for (const id of Array.isArray(server.models) ? server.models : []) {
      const model = modelId(id);
      const detail = objectRows(server.modelDetails).find(row=>row.id===model) || {};
      if (!model || !chatRow({...detail,id:model})) continue;
      const key = `${url}\n${model}`;
      rows.set(key,{url,model,name:server.name || "Local server",loaded:detail.loaded === true,preferred:Boolean(server.preferred)});
    }
  }
  return [...rows.values()];
}

export async function scanLocalModels({ cfg = {}, environment = process.env, probes = PROBES, timeoutMs = 700 } = {}) {
  const wanted = objectRows(probes).map(row=>({...row,url:normalizeLocalUrl(row.url)})).filter(row=>row.url);
  const configured = cfg.localUrlExplicit ? normalizeLocalUrl(cfg.localUrl) : normalizeLocalUrl(environment.OLLAMA_URL);
  const bound = normalizeLocalUrl(environment.OLLAMA_HOST,{binding:true});
  for (const url of [configured,bound].filter(Boolean)) {
    const existing = wanted.find(row=>row.url === url);
    if (existing) existing.preferred = true;
    else wanted.unshift({name:"Configured local server",url,kind:"auto",preferred:true});
  }
  const unique = [...new Map(wanted.map(row=>[row.url,row])).values()];
  const keyUrl = normalizeLocalUrl(cfg.localUrl);
  const found = (await Promise.all(unique.map(row=>probe(row,{timeoutMs,
    apiKey:row.url === keyUrl ? cfg.localKey || "" : ""}).catch(()=>null)))).filter(Boolean);
  return {memory:memoryPlan(),found,hasPreferredEndpoint:unique.some(row=>row.preferred),explicitEndpointRejected:Boolean(cfg.localUrlRejected || (environment.OLLAMA_URL && !normalizeLocalUrl(environment.OLLAMA_URL)) || (environment.OLLAMA_HOST && !bound))};
}

function run(cmd, args, onLine, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    const take = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const text = line.replace(/\s+/g, " ").trim();
        if (text) onLine(text.slice(0, 240));
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, error: code === 0 ? "" : `stopped (${code})` }));
  });
}

async function waitForOllama() {
  for (let i = 0; i < 16; i += 1) {
    const hit = await probe(PROBES[0]);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function ensureOllama(onLine) {
  const plan = memoryPlan();
  if (!plan.model) return { ok: false, error: "This system has under 8 GB of memory. A local model will not fit." };
  const already = await probe(PROBES[0]);
  if (!already && !plan.ollamaBin) {
    if (plan.platform === "win32") return { ok: false, error: "Install Ollama for Windows from https://ollama.com/download/windows, open it, then scan again." };
    if (plan.platform === "darwin" && !plan.brew) return {ok:false,error:"Install Ollama for macOS from https://ollama.com/download/mac, open it, then scan again."};
    onLine(plan.platform === "darwin" ? "Installing Ollama with Homebrew." : "Installing Ollama.");
    const installed = plan.platform === "darwin" && plan.brew
      ? await run("brew", ["install", "ollama"], onLine)
      : await run("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], onLine);
    if (!installed.ok) return installed;
  }
  if (!await probe(PROBES[0])) {
    const bin = which("ollama") || "ollama";
    onLine("Starting Ollama on 127.0.0.1.");
    const child = spawn(bin, ["serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
    });
    child.on("error", () => {});
    child.unref();
    const up = await waitForOllama();
    if (!up) return { ok: false, error: "Ollama did not answer on 127.0.0.1:11434." };
  }
  onLine(`Downloading ${plan.model.name}. About ${plan.model.diskGb} GB.`);
  const pulled = await run(which("ollama") || "ollama", ["pull", plan.model.name], onLine, {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
  });
  if (!pulled.ok) return pulled;
  return { ok: true, url: "http://127.0.0.1:11434/v1", model: plan.model.name };
}
