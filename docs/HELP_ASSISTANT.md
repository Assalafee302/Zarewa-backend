# Zarewa Help Assistant (Runa) — self-contained guide system

**Runa** is the cute workflow buddy in the life-ring button — the name nods to *running* quotes, POs, production jobs, and payments through Zarewa.

The help chatbot (life-ring button) is designed to work **without OpenAI or any external AI key**. Optional external AI only adds paraphrasing for unusual questions; the core is a **built-in knowledge base + pattern learning**.

## What it is (and is not)

| Built in | Not included |
|----------|----------------|
| 25+ procedural workflow articles | Neural-network / LLM training on your server |
| Keyword + route + learned boost matching | ChatGPT Free subscription |
| Query logging and branch-level learning | Automatic product code changes |
| User reactions (👍/👎), read time, follow-ups | Legal/financial advice |
| Work-pattern hints from `audit_log` | |

This is **practical pattern learning**: the system remembers which guides staff use, surfaces gaps when questions fail to match, and nudges users based on dashboard attention flags — not deep machine learning.

## Enterprise architecture (RAG + AI Agent)

```
[User Query]
    ↓
[Agent Router]  — guide | erp_data | hybrid | chitchat
    ↓                    ↓
[Semantic RAG]      [Text-to-SQL / native ERP tools]
 help_rag_chunks     products, quotations, refunds, ledger…
 (text-embedding-3)  (SELECT only + RBAC + branch scope)
    ↓                    ↓
    └──────► [Frontier LLM polish] ◄── secure context only
                    ↓
           [Synthesized answer]
```

| Layer | Module | Role |
|-------|--------|------|
| Vector RAG | `helpRagStore.js`, `helpEmbeddings.js` | Embed guides (`text-embedding-3-small`), cosine search, keyword merge |
| Agent | `helpAgent.js`, `helpAgentIntent.js` | Intent routing, orchestration, session history |
| ERP bridge | `helpErpQuery.js` | Native tools + guarded text-to-SQL |
| Guardrails | `helpGuardrails.js` | Allowlisted tables, SELECT-only, LIMIT 50, RBAC, branch filter |
| Self-train | `helpSelfTrain.js`, `helpUserActivity.js` | Feedback + transaction patterns |

### Configure frontier model (Azure OpenAI / OpenAI / Ollama)

```env
ZAREWA_AI_API_KEY=sk-...
ZAREWA_AI_MODEL=gpt-4o
ZAREWA_AI_EMBEDDING_MODEL=text-embedding-3-small
# Optional enterprise endpoint:
# ZAREWA_AI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1
```

Without a key: local TF vectors + keyword RAG + native ERP tools still work; text-to-SQL and LLM polish are off.

### Security

- Every `/api/help/chat` call is **authenticated** (`requireAuth`).
- SQL runs only after **allowlist + SELECT-only + LIMIT** validation.
- **Branch_id** and **audit self-only** filters injected when applicable.
- **Permissions** checked per table (`sales.view`, `finance.view`, etc.).

## Architecture (RAG — like ChatGPT retrieval + generation)

```
User question
  → Retrieve matching guides (keyword + learned boosts + self-trained query weights)
  → Synthesize conversational reply (helpSynthesize.js) — NOT raw article dump
  → Optional: external AI rephrases using retrieved chunks only (ZAREWA_AI_API_KEY)
  → Log + learn from 👍/👎 (helpSelfTrain.js updates query→article weights)
```

### Key files

| File | Role |
|------|------|
| `shared/lib/helpKnowledge.js` | Articles + retrieval scoring |
| `shared/lib/helpSynthesize.js` | Smart conversational answers (intent, step selection, pace) |
| `shared/lib/helpDesignLimits.js` | Four non-negotiable Runa design limits + RBAC filters |
| `shared/lib/helpBehaviorLearn.js` | Reading pace, audit→article mapping |
| `shared/lib/helpRecommend.js` | Coaching hints, prompt merging |
| `server/helpChat.js` | RAG pipeline orchestration |
| `server/helpQueryOps.js` | Logging, boosts, personalization |

## Knowledge base

Each article: `id`, `title`, `keywords[]`, `answer`, `steps[]`, `links[]`.

**44 articles** covering sales, finance, procurement, operations, manager, settings, and error recovery (see `HELP_ARTICLES` in code).

**To add a guide:** edit `shared/lib/helpKnowledge.js`, add a test in `helpKnowledge.test.js`, copy file to frontend.

## Pattern learning (how it “learns”)

1. Every help answer writes one row to `help_query_log`:
   - user, branch, role, pathname, query text
   - matched article ids, source (`kb` / `ai` / `fallback`), score
   - **response_ms**, **client_draft_ms** (typing time), **session_turn**

2. **Reactions & signals** (`POST /api/help/signal`):
   - 👍 / 👎 feedback with **read_ms** (time before reaction)
   - **follow_up** when the user asks another question without rating
   - **link_click** when they open a guide link from the answer

3. **`computeHelpLearnedBoosts`** — branch-level article weights (90 days), boosted by helpful votes.

4. **`computeUserLearnedBoosts`** — per-user weights from their own history and reactions.

5. **`computeUserTransactionProfile`** — reads **real ERP activity** for the signed-in user (last 14 days):
   - **Quotations** — quotation-related audit actions
   - **Payments / receipts** — `ledger_entries` posted by user (`RECEIPT_IN`, advances)
   - **Refunds** — `customer_refunds` requested by user
   - **Corrections & errors** — receipt reversals, failed/blocked audit entries, error notes
   - **Performance** — activity level (high/normal/low), work pace between actions

6. **`buildTransactionCoachingHints`** — turns that activity into proactive help (e.g. “3 refund(s) you requested recently”).

7. **`computeUserHelpBehaviorProfile`** — help-chat reading pace, helpful rate (👍/👎).

8. Bootstrap **`helpPersonalization`** includes transaction summary, coaching hints, and smart reply context.

## External AI (optional)

Set in backend `.env`:

```env
ZAREWA_AI_API_KEY=sk-...
ZAREWA_AI_MODEL=gpt-4o-mini
```

If unset, complex questions still get multi-article KB answers via `resolveKnowledgeBaseAnswerLoose`.

## Admin / improvement loop

1. Query gaps: `SELECT query_text, COUNT(*) FROM help_query_log WHERE source='fallback' GROUP BY 1 ORDER BY 2 DESC`
2. Turn top gaps into new `HELP_ARTICLES` entries
3. Redeploy — boosts update automatically as staff use help

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/help/status` | Available, article count, whether external AI is on |
| `GET /api/help/personalization?pathname=/sales` | Prompts, coaching hints, behavior profile, work patterns |
| `POST /api/help/chat` | Ask a question; returns `logId` for feedback |
| `POST /api/help/signal` | Record helpful / not_helpful / follow_up / link_click |
| `POST /api/help/log-query` | Log a client-side KB answer (offline instant match) |
| `GET /api/help/admin/dashboard` | Runa metrics (settings/audit permission) |
| `POST /api/help/admin/suggested-articles/:id/review` | Approve/reject draft — does **not** auto-publish |

## Runa design limits (non-negotiable)

Runa may become smarter and more independent, but these boundaries are enforced in code (`helpDesignLimits.js`):

1. **No ERP mutations without user action** — Runa guides, suggests, prepares, and explains. Staff always click the final button or approve the action. ERP SQL is SELECT-only.
2. **No auto-publish help articles** — Gap detection creates `help_suggested_articles` with `status=pending` only. Admins review via API; live guides still require merging into `helpKnowledge.js`.
3. **No neural model training in-app** — Learning uses feedback scores, article ranking, user/branch patterns, and workflow analytics (`helpSelfTrain.js` weights in `app_json_blobs`). Embeddings are inference-only for RAG.
4. **RBAC on memory and live data** — Personalization and recommendations filter by role/clearance even when boosted from past activity.

## Future upgrades

- Admin UI for gap report and article drafts in DB
- Embeddings for fuzzy match (still local, no OpenAI)
