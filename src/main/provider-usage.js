// Provider-reported counters, kept distinct from local context estimates.
// Follows Nova Tag's usage-accounting boundary; no text is treated as usage.
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function reportedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTokens = count(value.prompt_tokens), outputTokens = count(value.completion_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const total = count(value.total_tokens);
  const cached = count(value.prompt_tokens_details?.cached_tokens);
  const reasoning = count(value.completion_tokens_details?.reasoning_tokens);
  return { reported: true, inputTokens, outputTokens,
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cached !== undefined && cached <= inputTokens ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning <= outputTokens ? { reasoningTokens: reasoning } : {}) };
}
