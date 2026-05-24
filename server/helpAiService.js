import { readAiAssistConfig, postChatCompletions, normalizeCompletionContent } from './aiAssist.js';
import { readEmbeddingConfig, embedTexts } from './helpEmbeddings.js';

export function readRunaAiConfig() {
  const chat = readAiAssistConfig();
  const embed = readEmbeddingConfig();
  return {
    chatEnabled: chat.enabled,
    chatModel: chat.model,
    embeddingEnabled: embed.enabled,
    embeddingModel: embed.embeddingModel,
    mode: chat.enabled ? 'ai_enhanced' : 'local_intelligence',
  };
}

export async function polishRunaReply(opts) {
  const cfg = readAiAssistConfig();
  if (!cfg.enabled) return null;
  try {
    const res = await postChatCompletions(cfg, {
      messages: [
        { role: 'system', content: opts.system },
        ...(Array.isArray(opts.history) ? opts.history.slice(-4) : []),
        { role: 'user', content: opts.user },
      ],
      temperature: 0.3,
      max_tokens: 900,
    });
    return normalizeCompletionContent(res);
  } catch {
    return null;
  }
}

export async function embedRunaTexts(texts) {
  const cfg = readEmbeddingConfig();
  if (!cfg.enabled) return null;
  try {
    return await embedTexts(cfg, texts);
  } catch {
    return null;
  }
}
