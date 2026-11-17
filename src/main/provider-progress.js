// Protocol helpers adapted from Nova Tag's OpenAI provider, Apache-2.0.
// Metadata describes observed provider state; it never authorizes tools.
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function providerError(value, { status, retryAfter } = {}) {
  let body = value;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = { message: body }; }
  }
  const detail = body?.error && typeof body.error === "object" ? body.error : body;
  const message = String(detail?.message || detail?.code || (typeof value === "string" ? value : "Provider request failed")).slice(0, 800);
  const error = new Error(message || `HTTP ${status}`);
  error.name = "ProviderError";
  if (Number.isInteger(status)) error.status = status;
  else if (Number.isInteger(detail?.status)) error.status = detail.status;
  if (typeof detail?.code === "string") error.code = detail.code.slice(0, 160);
  if (typeof detail?.retryable === "boolean") error.retryable = detail.retryable;
  error.retryAfterMs = Math.max(retryAfterMs(retryAfter), retryAfterMs(detail?.retry_after_seconds));
  return error;
}

export function queueStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["queued", "admitted"].includes(value.state)
    || !Number.isFinite(value.wait_ms) || value.wait_ms < 0 || value.wait_ms > 1_800_000) return null;
  if (value.position !== undefined && (!Number.isInteger(value.position) || value.position < 1 || value.position > 1024)) return null;
  const event = { state: value.state, waitMs: value.wait_ms };
  if (value.state === "queued" && value.position !== undefined) event.position = value.position;
  for (const [field, target] of [["request_id", "requestId"], ["backend", "backend"]]) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== "string" || !value[field] || value[field].length > 160 || /[\x00-\x1f\x7f]/.test(value[field])) return null;
    event[target] = value[field];
  }
  return event;
}
