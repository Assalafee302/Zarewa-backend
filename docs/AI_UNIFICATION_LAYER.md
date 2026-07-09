# AI Unification Layer (Phase 4)

The unified AI orchestration layer connects Zare Help, AI Intelligence Router, AI Knowledge Center, and module-specific assist hooks behind a single priority flow — without replacing existing systems.

## Feature flag

| Variable | Default | Behavior |
|----------|---------|----------|
| `ZARE_AI_UNIFIED_MODE` | unset / `false` | **Off** — system behaves exactly as before Phase 4 |
| `ZARE_AI_UNIFIED_MODE=true` | enabled | Router → KC → Help → local rules priority chain |

Set in your host environment (same pattern as other `ZAREWA_AI_*` vars). See [`ENVIRONMENT.md`](ENVIRONMENT.md).

## Architecture

```
HelpChatDock → POST /api/help/chat
                    └─ runUnifiedHelpChat (wrapper)
                           ├─ [if unified off] runHelpChat (unchanged)
                           ├─ [if ERP/special route] runHelpChat (unchanged)
                           ├─ try AI Router (confidence ≥ 0.45)
                           ├─ try KC hybrid search
                           └─ fallback runHelpChat

Memo assist → POST /api/help/memo-assist → enrichMemoAssist (additive)
Expense suggest → POST /api/expense-categories/suggest → enrichExpenseSuggest (additive)
HR letters → POST /api/hr/employment-letters/ai-suggest (new, additive)

Gateway → POST /api/ai/query → unifiedQuery()
```

## Priority flow (`unifiedQuery`)

1. **AI Router** — `routeQuery()` when confidence ≥ `CONFIDENCE_MEDIUM` (0.45)
2. **Knowledge Center** — hybrid search on `aic_knowledge_records`
3. **Help knowledge** — `helpKnowledge.js` article match + rule synthesis
4. **Local fallback** — safe generic message

## Unified response format

All unified endpoints return:

```json
{
  "ok": true,
  "source": "router | knowledge_center | help | fallback",
  "intent": "SOP_REQUEST",
  "confidence": 0.72,
  "mode": "auto | suggest | fallback",
  "answer": "…",
  "suggestions": ["…"],
  "metadata": {
    "routeUsed": "sop_hybrid",
    "latency": 120,
    "fallbackUsed": false,
    "fallbackChain": ["router"],
    "moduleOrigin": "help"
  }
}
```

## API endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/ai/query` | Unified gateway for future UI |
| `GET /api/ai/unified/status` | Check if unified mode is enabled |
| `POST /api/hr/employment-letters/ai-suggest` | HR letter tone/template suggestions |

Existing endpoints are **not removed**:

- `POST /api/help/chat`
- `POST /api/ai-router/query`
- `POST /api/ai-knowledge-center/search`
- `POST /api/help/memo-assist`

## Module hooks (suggestion-only)

| Module | Hook | Rule |
|--------|------|------|
| Memos | `enrichMemoAssist` | Suggests type, structure, filing — never auto-submits |
| Expenses | `enrichExpenseSuggest` | Category lane, duplicate hint, policy notes — never auto-posts |
| HR letters | `enrichHrLetterAssist` | Tone, template, grammar — never auto-issues |

**Design principle:** AI suggests, system decides, human approves.

## Logging

All unified operations log with prefix `[ai-unified]`:

```
[ai-unified] query_complete {"source":"router","moduleOrigin":"help","confidence":0.78,...}
```

## Files

```
server/aiUnificationLayer/
  config/unifiedAiConfig.js
  utils/unifiedAiLogger.js
  services/aiOrchestratorService.js
  services/memoUnifiedAssist.js
  services/expenseUnifiedAssist.js
  services/hrLetterUnifiedAssist.js
  routes/unifiedAiRoutes.js
  index.js

shared/lib/aiUnification/unifiedResponseTypes.js
```

## Backward compatibility

- `ZARE_AI_UNIFIED_MODE` off → zero behavior change
- `helpAgent.js` is never modified; wrapper calls it on fallback
- AI Router and Knowledge Center APIs unchanged
- Memo/expense/HR workflows unchanged; enrichments are additive JSON fields (`unifiedAi`, `unifiedSuggestions`, `aiSuggestionOnly`)

## Related docs

- [`ERP_AI_SYSTEM_MAP.md`](ERP_AI_SYSTEM_MAP.md) — pre-Phase-4 audit
- [`AI_INTELLIGENCE_ROUTER.md`](AI_INTELLIGENCE_ROUTER.md) — Phase 3 router
- [`AI_KNOWLEDGE_CENTER.md`](AI_KNOWLEDGE_CENTER.md) — Phase 1–2 knowledge center
