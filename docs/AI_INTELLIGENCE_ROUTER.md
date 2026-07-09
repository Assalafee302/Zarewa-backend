# AI Intelligence Router (Phase 3 — Zare Intelligence)

Decision layer that classifies user queries, routes them to the right Knowledge Center search strategy, scores confidence, and optionally synthesizes answers.

Does **not** replace the AI Knowledge Center, hybrid search, or live Zare help chat.

## Architecture

```
POST /api/ai-router/query
        ↓
  intentClassifierService   (rules-based, no ML)
        ↓
  routingEngineService      (intent → search plan)
        ↓
  knowledgeSearchService    (reuse hybrid/keyword/semantic)
        ↓
  confidenceService         (intent + search → mode)
        ↓
  llmSynthesizerService     (optional LLM polish)
        ↓
  routerAnalyticsRepository (query log)
```

## Module layout

```
server/aiIntelligenceRouter/
  services/
    aiRouterService.js           — orchestration
    intentClassifierService.js   — detectIntent, calculateIntentConfidence
    routingEngineService.js      — buildRoutePlan, buildSearchPayload
    confidenceService.js         — combined scoring + response mode
    llmSynthesizerService.js     — synthesizeAnswer (placeholder + optional LLM)
  controllers/aiRouterController.js
  routes/aiRouterRoutes.js
  repository/routerAnalyticsRepository.js
shared/lib/aiIntelligenceRouter/intents.js
```

## Intents

| Intent | Route |
|--------|--------|
| `SOP_REQUEST` | Hybrid search → `sop_article` (+ operational FAQ widen) |
| `SQL_REQUEST` | Keyword search → `sql_example` |
| `TROUBLESHOOTING` | High-recall hybrid → `troubleshooting_example` |
| `GLOSSARY_LOOKUP` | Hybrid → `glossary_term` |
| `CONVERSATION_CHAT` | LLM / rule-based conversational reply |
| `UNKNOWN` | Hybrid fallback (all types) |

## Confidence & response modes

| Combined confidence | Mode | Behavior |
|---------------------|------|----------|
| ≥ 0.75 | `auto` | Top 3 results + synthesized answer |
| 0.45 – 0.75 | `suggest` | Top 2–3 suggestions + draft answer |
| < 0.45 | `fallback` | Wider results or clarification message |

Combined score: **40% intent + 60% search relevance**.

## API

### `POST /api/ai-router/query`

**Permission:** `ai.query.access`, `ai.knowledge.view`, `settings.manage`, or `audit.view`

```json
{
  "query": "How do I record a receipt?",
  "userContext": {
    "role": "cashier",
    "module": "sales",
    "history": []
  }
}
```

**Response:**

```json
{
  "ok": true,
  "intent": "SOP_REQUEST",
  "confidence": 0.81,
  "intentConfidence": 0.72,
  "searchConfidence": 0.86,
  "routeUsed": "knowledge_sop_search",
  "mode": "auto",
  "results": [ ... ],
  "answer": "...",
  "explanation": "Intent: SOP_REQUEST (72%) · ...",
  "fallbackUsed": false,
  "timingMs": 120
}
```

### `GET /api/ai-router/analytics?days=30`

Returns total queries, intent distribution, fallback rate, average confidence, most-used modules.

## Logging

All router logs use prefix `[ai-router]`:

- Intent + route selected
- Confidence + mode
- Execution time
- Fallback usage

## Permissions

| Key | Purpose |
|-----|---------|
| `ai.query.access` | Use AI Intelligence Router |

Administrator role includes this key (also covered by `*`).

## Database

`ai_router_query_log` — analytics for router queries (created by `migrateAiIntelligenceRouter`).

## Backward compatibility

- Knowledge Center CRUD/search APIs unchanged
- Zare help chat (`/api/help/chat`) unchanged
- Router is an **additional** layer for future Zare UI integration

## Future

- Wire Zare `helpAgent.js` to call `routeQuery` for unified intelligence
- ML-based intent classifier behind same interface
- Vector DB (pgvector / Pinecone) without API changes
