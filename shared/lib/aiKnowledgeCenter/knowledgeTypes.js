/**
 * AI Knowledge Center — knowledge type registry and shared constants.
 *
 * Extension point: add new entries to KNOWLEDGE_TYPE_REGISTRY to support additional
 * knowledge types without changing API contracts.
 *
 * @module shared/lib/aiKnowledgeCenter/knowledgeTypes
 */

/** @typedef {'active' | 'pending_review' | 'archived'} KnowledgeStatus */

/** @typedef {'keyword' | 'semantic' | 'hybrid'} KnowledgeSearchMode */

/**
 * Canonical knowledge type identifiers.
 * @readonly
 */
export const KNOWLEDGE_TYPES = Object.freeze({
  SOP_ARTICLE: 'sop_article',
  OPERATIONAL_FAQ: 'operational_faq',
  INTENT_EXAMPLE: 'intent_example',
  CONVERSATION_EXAMPLE: 'conversation_example',
  TROUBLESHOOTING_EXAMPLE: 'troubleshooting_example',
  SQL_EXAMPLE: 'sql_example',
  GLOSSARY_TERM: 'glossary_term',
  PROMPT_TEMPLATE: 'prompt_template',
  EVALUATION_QUESTION: 'evaluation_question',
  AI_MODEL_CONFIG: 'ai_model_config',
});

/**
 * Registry of supported knowledge types with display metadata and stat keys.
 * Future types: append here and redeploy — no API shape change required.
 *
 * @type {Readonly<Record<string, { label: string; statKey: string; description: string }>>}
 */
export const KNOWLEDGE_TYPE_REGISTRY = Object.freeze({
  [KNOWLEDGE_TYPES.SOP_ARTICLE]: {
    label: 'SOP Article',
    statKey: 'sopArticles',
    description: 'Standard operating procedure guides for Zarewa workflows.',
  },
  [KNOWLEDGE_TYPES.OPERATIONAL_FAQ]: {
    label: 'Operational FAQ',
    statKey: 'operationalFaqs',
    description: 'Short operational how-to phrasings and answers.',
  },
  [KNOWLEDGE_TYPES.INTENT_EXAMPLE]: {
    label: 'Intent Example',
    statKey: 'intentExamples',
    description: 'Sample user utterances mapped to agent intents.',
  },
  [KNOWLEDGE_TYPES.CONVERSATION_EXAMPLE]: {
    label: 'Conversation Example',
    statKey: 'conversationExamples',
    description: 'Multi-turn conversation patterns for training and evaluation.',
  },
  [KNOWLEDGE_TYPES.TROUBLESHOOTING_EXAMPLE]: {
    label: 'Troubleshooting Example',
    statKey: 'troubleshootingExamples',
    description: 'Error and correction scenarios with guided resolutions.',
  },
  [KNOWLEDGE_TYPES.SQL_EXAMPLE]: {
    label: 'SQL Example',
    statKey: 'sqlExamples',
    description: 'Read-only ERP query examples for text-to-SQL guardrails.',
  },
  [KNOWLEDGE_TYPES.GLOSSARY_TERM]: {
    label: 'Glossary Term',
    statKey: 'glossaryTerms',
    description: 'ERP terminology definitions for consistent AI responses.',
  },
  [KNOWLEDGE_TYPES.PROMPT_TEMPLATE]: {
    label: 'Prompt Template',
    statKey: 'promptTemplates',
    description: 'Reusable system and user prompt templates for LLM providers.',
  },
  [KNOWLEDGE_TYPES.EVALUATION_QUESTION]: {
    label: 'Evaluation Question',
    statKey: 'evaluationQuestions',
    description: 'Golden questions for RAG and answer quality evaluation.',
  },
  [KNOWLEDGE_TYPES.AI_MODEL_CONFIG]: {
    label: 'AI Model Configuration',
    statKey: 'aiModelConfigs',
    description: 'Provider and model configuration metadata (OpenAI, Gemini, Ollama, HF).',
  },
});

/** @type {ReadonlySet<string>} */
export const KNOWLEDGE_STATUS_VALUES = new Set(['active', 'pending_review', 'archived']);

/** ERP module tags commonly used for filtering. */
export const KNOWLEDGE_MODULE_VALUES = Object.freeze([
  'general',
  'sales',
  'finance',
  'accounting',
  'procurement',
  'operations',
  'production',
  'hr',
  'office',
  'settings',
  'executive',
  'maintenance',
]);

/**
 * @param {string} type
 * @returns {boolean}
 */
export function isKnownKnowledgeType(type) {
  return Object.prototype.hasOwnProperty.call(KNOWLEDGE_TYPE_REGISTRY, String(type || '').trim());
}

/**
 * @returns {string[]}
 */
export function listKnowledgeTypeIds() {
  return Object.keys(KNOWLEDGE_TYPE_REGISTRY);
}

/**
 * @param {string} type
 * @returns {{ label: string; statKey: string; description: string } | null}
 */
export function knowledgeTypeMeta(type) {
  return KNOWLEDGE_TYPE_REGISTRY[String(type || '').trim()] || null;
}
