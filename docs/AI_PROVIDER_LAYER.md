# AI Provider Layer

Multi-provider plug-in for Zare Intelligence: **OpenAI** (primary), **Hugging Face** (cost-efficient secondary), **Ollama** (local fallback).

> Providers are interchangeable. Orchestration is fixed.

## Feature flag

| Variable | Default | Behavior |
|----------|---------|----------|
| `ZARE_AI_HUGGINGFACE_ENABLED` | unset / `false` | Hugging Face ignored completely |
| `ZARE_AI_HUGGINGFACE_ENABLED=true` | enabled | HF participates in routing per task registry |

## Required environment

| Variable | Purpose |
|----------|---------|
| `HUGGINGFACE_API_KEY` or `HF_TOKEN` or `ZARE_AI_HF_API_KEY` | HF Inference API token |
| `ZAREWA_AI_API_KEY` | OpenAI (or compatible) — unchanged |
| `ZARE_AI_HF_BASE_URL` | Optional; default `https://api-inference.huggingface.co` |
| `ZARE_AI_HF_SELF_HOSTED=true` | Use OpenAI-compatible paths on custom base URL |
| `ZARE_AI_OPENAI_DAILY_TOKEN_LIMIT` | Default `500000`; auto-switch to HF when exceeded |

## Unified response format

```json
{
  "provider": "openai | huggingface | ollama | rule_based",
  "content": "...",
  "confidence": 0.85,
  "usage": { "tokens": 420, "cost": 0.0008 },
  "fallbackUsed": false,
  "metadata": { "taskType": "help_synthesis", "fallbackChain": ["openai"] }
}
```

## Task routing (`modelRegistry.js`)

| Task | Primary | Fallback |
|------|---------|----------|
| `memo_polish`, `hr_letter`, `expense` | Hugging Face | OpenAI |
| `finance_critical`, `approval_logic` | OpenAI | — |
| `router_reasoning`, `help_synthesis` | OpenAI | Hugging Face |
| `embedding`, `search` | HF (`BAAI/bge-small-en-v1.5`) | OpenAI embeddings |

## Models

| Use | Model ID |
|-----|----------|
| General LLM | `mistralai/Mistral-7B-Instruct-v0.3` |
| HR / conversation | `Qwen/Qwen2.5-7B-Instruct` |
| Embeddings | `BAAI/bge-small-en-v1.5`, `intfloat/e5-base-v2` |

## Integration points (additive)

| Module | Change |
|--------|--------|
| `aiOrchestratorService.js` | KC answers enhanced via `routeAIRequest` when providers available |
| `llmSynthesizerService.js` | Provider layer before direct `postChatCompletions` |
| `embeddingService.js` | HF embeddings when flag enabled (falls back to existing adapter) |
| `aiAssist.js` | Memo polish tries HF provider first (dynamic import; OpenAI fallback) |
| `aiRouterService.js` | Passes `lowConfidence` to prefer HF on suggest/fallback modes |

## API

`GET /api/ai/providers/status` — health + daily usage summary (authenticated).

## Logging

```
[ai-provider] route_start {"taskType":"help_synthesis","chain":["openai","huggingface"]}
[ai-provider] route_complete {"provider":"huggingface","fallbackUsed":true,...}
```

## Files

```
server/aiProviders/
  aiProviderRouter.js
  huggingfaceProvider.js
  openaiProvider.js
  ollamaProvider.js
  modelRegistry.js
  embeddingProvider.js
  costController.js
  config/providerConfig.js
  routes/providerRoutes.js
```

## Backward compatibility

- `aiAssist.js` OpenAI path unchanged when HF disabled or fails
- No changes to help agent, automation engine, or KC APIs
- HF is opt-in via `ZARE_AI_HUGGINGFACE_ENABLED`
