# Zarewa Help Assistant (Zare) — how-to guide & SOPs

**Zare** is the life-ring **how-to guide** inside Zarewa — friendly SOPs, screen-by-screen steps, and workflow rules.

**Zare is not an approver and does not perform ERP actions in chat.** Staff always click Approve, Save, Post, and Pay themselves. Zare explains *how* and *why* (including who normally approves).

The help chatbot (life-ring button) is designed to work **without OpenAI or any external AI key**. Optional external AI only adds paraphrasing for unusual questions; the core is a **built-in knowledge base + pattern learning**.

## What it is (and is not)

| Built in | Not included |
|----------|----------------|
| 45+ curated SOPs + **1000** operational Q&A phrasings (`helpOperationalCatalog.js`) | Approving or posting on behalf of users |
| Keyword + route + learned boost matching | ChatGPT Free subscription |
| Query logging and branch-level learning | Automatic product code changes |
| User reactions (👍/👎), read time, follow-ups | Legal/financial advice |
| Work-pattern hints from `audit_log` | Doing ERP mutations from chat |
| Approval **rule** explanations (who/when) | Acting as approver in the UI |

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
ZAREWA_AI_HELP_MODEL=gpt-4o
ZAREWA_AI_POLISH_MODEL=gpt-4o-mini
ZAREWA_AI_EMBEDDING_MODEL=text-embedding-3-small
# OpenAI (default base):
# ZAREWA_AI_BASE_URL=https://api.openai.com/v1
# Gemini (OpenAI-compatible):
# ZAREWA_AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
# ZAREWA_AI_HELP_MODEL=gemini-2.0-flash
```

With a key: Zare uses **full RAG + LLM generation** (ChatGPT/Gemini-quality answers grounded in guides) and **AI memo polish** on Improve / Formal / Shorter / Grammar.

Without a key: local keyword RAG + rule-based synthesis + rule-based memo assist still work; frontier generation and AI polish are off.

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
| `shared/lib/helpKnowledge.js` | Curated articles + operational catalog merge + retrieval scoring |
| `shared/lib/helpOperationalCatalog.js` | 1000 operational how-to phrasings (10 templates × ~100 topics) |
| `shared/lib/helpSynthesize.js` | Smart conversational answers (intent, step selection, pace) |
| `shared/lib/helpDesignLimits.js` | Four non-negotiable Runa design limits + RBAC filters |
| `shared/lib/helpBehaviorLearn.js` | Reading pace, audit→article mapping |
| `shared/lib/helpRecommend.js` | Coaching hints, prompt merging |
| `server/helpChat.js` | RAG pipeline orchestration |
| `server/helpQueryOps.js` | Logging, boosts, personalization |

## Knowledge base

Each article: `id`, `title`, `keywords[]`, `answer`, `steps[]`, `links[]`.

**~45 curated articles** plus **1000 operational Q&A** entries from `buildOperationalHelpArticles()` (merged into `HELP_ARTICLES` at load). Curated guides win ties over operational FAQs when scores are close.

**To add a deep guide:** edit the `CORE_HELP_ARTICLES` block in `shared/lib/helpKnowledge.js`, add a test in `helpKnowledge.test.js`, sync to `frontend/src/lib/`.

**To extend operational coverage:** edit topic rows in `shared/lib/helpOperationalCatalog.js` (10 question templates per topic; catalog caps at 1000 entries), copy to frontend `src/lib/`, run `helpOperationalCatalog.test.js`.

## Operational catalog (1000 questions)

`helpOperationalCatalog.js` defines **~100 topics** across Sales, Finance, Procurement, Operations, Manager, Settings, HR, Workspace, Memos, and General — each with **10 natural phrasings** (e.g. “How do I…”, “Steps to…”, “SOP for…”). The builder stops at **1000** articles so Zare can match how staff actually ask.

Every answer is **guide-only**: numbered steps, deep links into Zarewa, and a reminder that **you** approve, save, and post — Zare does not.

**“Training” Zare** on this catalog does **not** mean fine-tuning a model in ERP. After deploy:

1. Articles load into `HELP_ARTICLES` — instant keyword/RAG retrieval.
2. Staff 👍/👎 on answers updates `helpSelfTrain` weights toward the best article id.
3. Unmatched questions appear in the admin gap report → add curated topics or new rows in the catalog.
4. Optional `ZAREWA_AI_API_KEY` only polishes wording; guardrails still forbid mutations from chat.

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
