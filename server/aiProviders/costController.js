/**
 * AI usage tracking and cost-aware provider selection.
 *
 * @module server/aiProviders/costController
 */

import { readProviderConfig } from './config/providerConfig.js';
import { estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { isOpenAiOnlyTask, isHuggingFacePreferredTask } from './modelRegistry.js';
import { logProvider } from './utils/providerLogger.js';

/** @type {Map<string, { tokens: number; requests: number }>} */
const usageByDay = new Map();

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(provider, taskType) {
  return `${dayKey()}:${provider}:${taskType || 'general'}`;
}

/**
 * @param {string} provider
 * @param {string} taskType
 * @param {number} tokens
 */
export function recordProviderUsage(provider, taskType, tokens = 0) {
  const key = usageKey(provider, taskType);
  const prev = usageByDay.get(key) || { tokens: 0, requests: 0 };
  usageByDay.set(key, {
    tokens: prev.tokens + (Number(tokens) || 0),
    requests: prev.requests + 1,
  });

  logProvider('usage_recorded', {
    provider,
    taskType,
    tokens,
    dayTotal: prev.tokens + tokens,
  });
}

/**
 * Total OpenAI tokens used today (all task types).
 */
export function getOpenAiDailyTokenUsage() {
  const prefix = `${dayKey()}:openai:`;
  let total = 0;
  for (const [key, val] of usageByDay.entries()) {
    if (key.startsWith(prefix)) total += val.tokens;
  }
  return total;
}

/**
 * @returns {boolean}
 */
export function isOpenAiOverDailyLimit() {
  const cfg = readProviderConfig();
  return getOpenAiDailyTokenUsage() >= cfg.openAiDailyTokenLimit;
}

/**
 * Build ordered provider chain with cost overrides.
 *
 * @param {string} taskType
 * @param {{ primary: string; fallback: string|null }} route
 * @returns {string[]}
 */
export function buildProviderChain(taskType, route) {
  const chain = [];
  const task = String(taskType || '').toLowerCase();

  if (isOpenAiOnlyTask(task)) {
    if (route.primary === 'openai' || route.fallback === 'openai') chain.push('openai');
    return chain;
  }

  const cfg = readProviderConfig();
  const openAiOver = isOpenAiOverDailyLimit();

  let primary = route.primary;
  let fallback = route.fallback;

  if (openAiOver && primary === 'openai' && cfg.huggingFaceEnabled) {
    primary = 'huggingface';
    fallback = fallback === 'huggingface' ? 'ollama' : fallback;
    logProvider('cost_redirect', { taskType: task, reason: 'openai_daily_limit', newPrimary: primary });
  }

  if (isHuggingFacePreferredTask(task) && cfg.huggingFaceEnabled && primary !== 'huggingface') {
    primary = 'huggingface';
    fallback = route.primary === 'openai' ? 'openai' : route.fallback;
  }

  if (primary) chain.push(primary);
  if (fallback && fallback !== primary) chain.push(fallback);

  if (cfg.ollamaEnabled && !chain.includes('ollama')) {
    chain.push('ollama');
  }

  return [...new Set(chain.filter(Boolean))];
}

/**
 * @param {string} text
 * @param {string} provider
 * @param {string} taskType
 */
export function recordTextUsage(text, provider, taskType) {
  recordProviderUsage(provider, taskType, estimateTokens(text));
}

/**
 * Reset usage map (tests only).
 */
export function _resetUsageForTests() {
  usageByDay.clear();
}

/**
 * @returns {object}
 */
export function getUsageSummary() {
  const summary = {};
  for (const [key, val] of usageByDay.entries()) {
    summary[key] = { ...val };
  }
  return {
    day: dayKey(),
    openAiDailyTokens: getOpenAiDailyTokenUsage(),
    limit: readProviderConfig().openAiDailyTokenLimit,
    entries: summary,
  };
}
