/**
 * Task-to-provider model registry.
 *
 * Providers are interchangeable. Orchestration is fixed.
 *
 * @module server/aiProviders/modelRegistry
 */

export const HF_MODELS = Object.freeze({
  MISTRAL_INSTRUCT: 'mistralai/Mistral-7B-Instruct-v0.3',
  QWEN_INSTRUCT: 'Qwen/Qwen2.5-7B-Instruct',
  BGE_SMALL: 'BAAI/bge-small-en-v1.5',
  E5_BASE: 'intfloat/e5-base-v2',
});

/** @typedef {'openai' | 'huggingface' | 'ollama'} ProviderId */

/**
 * @typedef {object} TaskRouteConfig
 * @property {ProviderId} primary
 * @property {ProviderId|null} fallback
 * @property {string} [model]
 * @property {string} [fallbackModel]
 */

/** @type {Record<string, TaskRouteConfig>} */
export const TASK_REGISTRY = Object.freeze({
  memo_polish: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
  hr_letter: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.QWEN_INSTRUCT,
  },
  expense: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
  expense_classification: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
  finance_critical: {
    primary: 'openai',
    fallback: null,
  },
  approval_logic: {
    primary: 'openai',
    fallback: null,
  },
  router_reasoning: {
    primary: 'openai',
    fallback: 'huggingface',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
  help_synthesis: {
    primary: 'openai',
    fallback: 'huggingface',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
  embedding: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.BGE_SMALL,
    fallbackModel: 'text-embedding-3-small',
  },
  search: {
    primary: 'huggingface',
    fallback: 'openai',
    model: HF_MODELS.BGE_SMALL,
  },
  conversation: {
    primary: 'huggingface',
    fallback: 'ollama',
    model: HF_MODELS.QWEN_INSTRUCT,
  },
  default: {
    primary: 'openai',
    fallback: 'huggingface',
    model: HF_MODELS.MISTRAL_INSTRUCT,
  },
});

const HF_PREFERRED_TASKS = new Set([
  'memo_polish',
  'hr_letter',
  'expense',
  'expense_classification',
  'embedding',
  'search',
]);

const OPENAI_ONLY_TASKS = new Set(['finance_critical', 'approval_logic']);

/**
 * @param {string} taskType
 * @returns {TaskRouteConfig}
 */
export function getTaskRouting(taskType) {
  const key = String(taskType || 'default').trim().toLowerCase();
  return TASK_REGISTRY[key] || TASK_REGISTRY.default;
}

/**
 * @param {string} taskType
 */
export function isHuggingFacePreferredTask(taskType) {
  return HF_PREFERRED_TASKS.has(String(taskType || '').toLowerCase());
}

/**
 * @param {string} taskType
 */
export function isOpenAiOnlyTask(taskType) {
  return OPENAI_ONLY_TASKS.has(String(taskType || '').toLowerCase());
}

/**
 * Resolve model id for a provider + task.
 *
 * @param {string} taskType
 * @param {ProviderId} providerId
 */
export function resolveModelForTask(taskType, providerId) {
  const route = getTaskRouting(taskType);
  if (providerId === 'huggingface') return route.model || HF_MODELS.MISTRAL_INSTRUCT;
  if (providerId === 'openai') return null;
  if (providerId === 'ollama') return null;
  return route.model;
}
