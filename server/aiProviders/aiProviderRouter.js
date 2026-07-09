/**
 * Multi-provider AI router — selects OpenAI, Hugging Face, or Ollama per task.
 *
 * Providers are interchangeable. Orchestration is fixed.
 *
 * @module server/aiProviders/aiProviderRouter
 */

import { buildProviderResponse, estimateTokens } from '../../shared/lib/aiProviders/providerResponseTypes.js';
import { getTaskRouting, resolveModelForTask } from './modelRegistry.js';
import { buildProviderChain, recordProviderUsage } from './costController.js';
import { readProviderConfig, isProviderLayerAvailable } from './config/providerConfig.js';
import { logProvider } from './utils/providerLogger.js';
import * as hf from './huggingfaceProvider.js';
import * as openai from './openaiProvider.js';
import * as ollama from './ollamaProvider.js';

/**
 * @param {string} providerId
 */
function isProviderAvailable(providerId) {
  const cfg = readProviderConfig();
  switch (providerId) {
    case 'huggingface':
      return cfg.huggingFaceEnabled;
    case 'openai':
      return cfg.openAiEnabled && openai.isOpenAiProviderAvailable();
    case 'ollama':
      return cfg.ollamaEnabled && ollama.isOllamaProviderAvailable();
    default:
      return false;
  }
}

/**
 * @param {string} providerId
 * @param {object} params
 */
async function invokeProvider(providerId, params) {
  const { prompt, options, taskType } = params;
  const model = options.model || resolveModelForTask(taskType, providerId);

  const genOptions = {
    ...options,
    model: model || undefined,
    systemPrompt: options.systemPrompt || params.context?.systemPrompt,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  };

  switch (providerId) {
    case 'huggingface':
      return hf.generateText(prompt, genOptions);
    case 'openai':
      return openai.generateText(prompt, genOptions);
    case 'ollama':
      return ollama.generateText(prompt, genOptions);
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

/**
 * Build prompt from task context.
 *
 * @param {string} prompt
 * @param {object} [context]
 */
function buildPrompt(prompt, context = {}) {
  const parts = [String(prompt || '').trim()];
  if (context.draft) {
    parts.push('\n\nDraft to improve:\n', String(context.draft).slice(0, 6000));
  }
  if (context.retrievedKnowledge) {
    parts.push('\n\nKnowledge:\n', String(context.retrievedKnowledge).slice(0, 8000));
  }
  if (context.results?.length) {
    const ctx = context.results
      .slice(0, 3)
      .map((r, i) => `[${i + 1}] ${r.title}\n${String(r.bodyText || '').slice(0, 400)}`)
      .join('\n\n');
    parts.push('\n\nRetrieved knowledge:\n', ctx);
  }
  return parts.join('').trim();
}

/**
 * Rule-based fallback when all providers fail.
 *
 * @param {object} context
 */
function ruleBasedFallback(context = {}) {
  if (context.draft) return String(context.draft);
  if (context.fallbackText) return String(context.fallbackText);
  return 'I could not generate a response right now. Please try again or use the manual workflow.';
}

/**
 * Main provider routing entry.
 *
 * @param {object} request
 * @param {string} request.taskType
 * @param {string} request.prompt
 * @param {object} [request.context]
 * @param {object} [request.options]
 */
export async function routeAIRequest(request = {}) {
  const started = Date.now();
  const taskType = String(request.taskType || 'default').trim().toLowerCase();
  const context = request.context && typeof request.context === 'object' ? request.context : {};
  const options = request.options && typeof request.options === 'object' ? request.options : {};
  const fullPrompt = buildPrompt(request.prompt, context);

  if (!fullPrompt) {
    return buildProviderResponse({
      provider: 'rule_based',
      content: ruleBasedFallback(context),
      fallbackUsed: true,
    });
  }

  if (!isProviderLayerAvailable()) {
    logProvider('layer_unavailable', { taskType });
    return buildProviderResponse({
      provider: 'rule_based',
      content: ruleBasedFallback(context),
      fallbackUsed: true,
      metadata: { reason: 'no_providers_configured' },
    });
  }

  const route = getTaskRouting(taskType);
  const chain = buildProviderChain(taskType, route).filter(isProviderAvailable);

  if (!chain.length) {
    logProvider('no_providers_for_task', { taskType, route });
    return buildProviderResponse({
      provider: 'rule_based',
      content: ruleBasedFallback(context),
      fallbackUsed: true,
    });
  }

  logProvider('route_start', { taskType, chain, promptLen: fullPrompt.length });

  const attempted = [];
  let lastError = null;

  for (let i = 0; i < chain.length; i += 1) {
    const providerId = chain[i];
    attempted.push(providerId);

    try {
      const systemPrompt =
        options.systemPrompt ||
        context.systemPrompt ||
        defaultSystemPrompt(taskType);

      const result = await invokeProvider(providerId, {
        prompt: fullPrompt,
        context,
        options: { ...options, systemPrompt },
        taskType,
      });

      const content = String(result.content || '').trim();
      if (!content) {
        throw new Error('Empty provider response');
      }

      const tokens = result.usage?.tokens || estimateTokens(fullPrompt) + estimateTokens(content);
      recordProviderUsage(providerId, taskType, tokens);

      logProvider('route_complete', {
        taskType,
        provider: providerId,
        fallbackUsed: i > 0,
        fallbackChain: attempted,
        latencyMs: Date.now() - started,
        tokens,
      });

      return buildProviderResponse({
        ...result,
        content,
        fallbackUsed: i > 0,
        metadata: {
          ...(result.metadata || {}),
          taskType,
          fallbackChain: attempted,
          latencyMs: Date.now() - started,
        },
      });
    } catch (e) {
      lastError = e;
      logProvider('provider_failed', {
        taskType,
        provider: providerId,
        error: String(e?.message || e),
        attempt: i + 1,
      });
    }
  }

  logProvider('route_fallback_rules', {
    taskType,
    fallbackChain: attempted,
    latencyMs: Date.now() - started,
    lastError: String(lastError?.message || lastError),
  });

  return buildProviderResponse({
    provider: 'rule_based',
    content: ruleBasedFallback(context),
    fallbackUsed: true,
    metadata: {
      taskType,
      fallbackChain: attempted,
      latencyMs: Date.now() - started,
    },
  });
}

/**
 * @param {string} taskType
 */
function defaultSystemPrompt(taskType) {
  switch (taskType) {
    case 'memo_polish':
      return 'You polish internal office memos. Preserve facts. Be professional and concise.';
    case 'hr_letter':
      return 'You draft formal HR letters. Use professional tone. Never invent employee data.';
    case 'expense':
    case 'expense_classification':
      return 'You assist with expense categorization hints. Do not approve or post transactions.';
    case 'finance_critical':
    case 'approval_logic':
      return 'You provide careful financial guidance. Never authorize payments or approvals.';
    case 'router_reasoning':
    case 'help_synthesis':
      return (
        'You are Zare, the Zarewa ERP how-to assistant. Answer using provided knowledge only. ' +
        'Be concise. Never invent ERP data. Remind users they perform actions themselves.'
      );
    default:
      return 'You assist Zarewa ERP users. Be accurate and concise.';
  }
}

export { getUsageSummary } from './costController.js';
export { healthCheckProviders } from './healthCheck.js';
