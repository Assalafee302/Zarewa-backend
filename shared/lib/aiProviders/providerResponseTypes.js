/**
 * Unified AI provider response contract.
 *
 * @module shared/lib/aiProviders/providerResponseTypes
 */

/** @typedef {'openai' | 'huggingface' | 'ollama' | 'rule_based'} AiProviderId */

/**
 * @param {object} opts
 */
export function buildProviderResponse(opts = {}) {
  return {
    provider: String(opts.provider || 'rule_based'),
    content: String(opts.content || ''),
    confidence:
      opts.confidence != null && Number.isFinite(Number(opts.confidence))
        ? Number(opts.confidence)
        : undefined,
    usage: opts.usage
      ? {
          tokens: opts.usage.tokens != null ? Number(opts.usage.tokens) : undefined,
          cost: opts.usage.cost != null ? Number(opts.usage.cost) : undefined,
        }
      : undefined,
    fallbackUsed: Boolean(opts.fallbackUsed),
    metadata: opts.metadata || undefined,
  };
}

/**
 * Rough token estimate for cost tracking (chars / 4).
 *
 * @param {string} text
 */
export function estimateTokens(text) {
  const len = String(text || '').length;
  return Math.max(1, Math.ceil(len / 4));
}
