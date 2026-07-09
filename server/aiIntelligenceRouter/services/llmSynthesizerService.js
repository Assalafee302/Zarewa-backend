/**
 * AI Intelligence Router — LLM answer synthesis (placeholder / optional).
 *
 * Extension point: wire OpenAI, Gemini, Ollama, Hugging Face when enabled.
 *
 * @module server/aiIntelligenceRouter/services/llmSynthesizerService
 */

import { readAiAssistConfig, postChatCompletions, normalizeCompletionContent } from '../../aiAssist.js';
import { routeAIRequest } from '../../aiProviders/aiProviderRouter.js';
import { isProviderLayerAvailable } from '../../aiProviders/config/providerConfig.js';

/**
 * Format top knowledge records into a readable draft without LLM.
 *
 * @param {string} query
 * @param {Array<Record<string, unknown>>} results
 * @returns {string}
 */
export function formatResultsAsDraft(query, results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) {
    return `I could not find knowledge articles matching "${String(query || '').slice(0, 120)}". Try rephrasing or ask your supervisor.`;
  }

  const lines = [`**Answer draft** for: "${String(query || '').slice(0, 200)}"`, ''];
  list.slice(0, 3).forEach((rec, i) => {
    const title = String(rec.title || 'Untitled');
    const body =
      String(rec.bodyText || '').trim() ||
      String(rec.content?.answer || rec.content?.definition || rec.content?.summary || '').trim();
    lines.push(`**${i + 1}. ${title}**`);
    if (body) lines.push(body.slice(0, 600));
    lines.push('');
  });
  lines.push('_You perform all approvals and postings in Zarewa yourself._');
  return lines.join('\n').trim();
}

/**
 * Synthesize a human-readable answer from search results.
 * Uses frontier LLM when configured; otherwise rule-based formatting.
 *
 * @param {string} query
 * @param {Array<Record<string, unknown>>} results
 * @param {object} [opts]
 * @returns {Promise<{ answer: string; synthesized: boolean; provider?: string }>}
 */
export async function synthesizeAnswer(query, results, opts = {}) {
  const draft = formatResultsAsDraft(query, results);
  const cfg = readAiAssistConfig();

  if (opts.skipLlm) {
    return { answer: draft, synthesized: false, provider: 'rule_based' };
  }

  const context = results
    .slice(0, 3)
    .map((r, i) => {
      const body =
        String(r.bodyText || '').trim() ||
        JSON.stringify(r.content || {}).slice(0, 400);
      return `[${i + 1}] ${r.title}\n${body}`;
    })
    .join('\n\n');

  const taskType = opts.lowConfidence ? 'router_reasoning' : 'help_synthesis';

  if (isProviderLayerAvailable() && results.length) {
    try {
      const routed = await routeAIRequest({
        taskType,
        prompt: String(query || '').slice(0, 2000),
        context: {
          draft,
          results,
          retrievedKnowledge: context,
          systemPrompt:
            'You are Zare, the Zarewa ERP how-to assistant. Answer using ONLY the retrieved knowledge below. ' +
            'Be concise, use numbered steps when helpful. Never invent ERP data. ' +
            'Remind the user they click Approve/Save/Post themselves.',
        },
        options: { maxTokens: 900, temperature: 0.35 },
      });
      if (routed?.content?.trim() && routed.provider !== 'rule_based') {
        return {
          answer: routed.content.trim(),
          synthesized: true,
          provider: routed.provider,
          fallbackUsed: routed.fallbackUsed,
        };
      }
    } catch (e) {
      console.warn('[ai-router] provider synthesis failed, trying direct LLM', e?.message || e);
    }
  }

  if (!cfg.enabled) {
    return { answer: draft, synthesized: false, provider: 'rule_based' };
  }

  try {
    const { ok, json } = await postChatCompletions(cfg, {
      model: cfg.helpModel || cfg.model,
      messages: [
        {
          role: 'system',
          content:
            'You are Zare, the Zarewa ERP how-to assistant. Answer using ONLY the retrieved knowledge below. ' +
            'Be concise, use numbered steps when helpful. Never invent ERP data. ' +
            'Remind the user they click Approve/Save/Post themselves.',
        },
        {
          role: 'user',
          content: `Question: ${String(query || '').slice(0, 2000)}\n\nRetrieved knowledge:\n${context.slice(0, 8000)}`,
        },
      ],
      max_tokens: 900,
      temperature: 0.35,
    });

    if (ok) {
      const answer = normalizeCompletionContent(json?.choices?.[0]?.message);
      if (String(answer).trim()) {
        return { answer: String(answer).trim(), synthesized: true, provider: cfg.provider };
      }
    }
  } catch (e) {
    console.warn('[ai-router] LLM synthesis failed, using draft', e?.message || e);
  }

  return { answer: draft, synthesized: false, provider: 'rule_based_fallback' };
}

/**
 * Placeholder for pure conversation without knowledge hits.
 *
 * @param {string} query
 * @returns {Promise<{ answer: string; synthesized: boolean }>}
 */
export async function synthesizeConversationReply(query) {
  const q = String(query || '').trim().toLowerCase();
  if (/^(hi|hello|hey|salam)\b/.test(q)) {
    return {
      answer:
        'Hi — I\'m **Zare**, your Zarewa how-to guide. Ask *how do I…* for SOPs, or describe a problem and I\'ll find the right steps. You always perform actions in the app yourself.',
      synthesized: false,
    };
  }
  if (/^(thanks|thank you)\b/.test(q)) {
    return { answer: 'You\'re welcome. Ask anytime you need workflow help.', synthesized: false };
  }
  if (/\b(who are you|what are you|what can you do)\b/.test(q)) {
    return {
      answer:
        'I\'m **Zare** — I explain Zarewa workflows and SOPs from the AI Knowledge Center. I don\'t approve, post, or save on your behalf.',
      synthesized: false,
    };
  }

  const cfg = readAiAssistConfig();
  if (cfg.enabled) {
    const r = await synthesizeAnswer(query, [], { skipLlm: false });
    if (r.synthesized) return r;
  }

  return {
    answer: 'Tell me what you need help with in Zarewa — for example *how do I record a receipt?* or *what is GRN?*',
    synthesized: false,
  };
}
