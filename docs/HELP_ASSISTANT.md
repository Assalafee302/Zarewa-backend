# Zarewa Help Assistant — self-contained guide system

The help chatbot (life-ring button) is designed to work **without OpenAI or any external AI key**. Optional external AI only adds paraphrasing for unusual questions; the core is a **built-in knowledge base + pattern learning**.

## What it is (and is not)

| Built in | Not included |
|----------|----------------|
| 25+ procedural workflow articles | Neural-network / LLM training on your server |
| Keyword + route + learned boost matching | ChatGPT Free subscription |
| Query logging and branch-level learning | Automatic product code changes |
| Coaching hints from live workspace metrics | Legal/financial advice |

This is **practical pattern learning**: the system remembers which guides staff use, surfaces gaps when questions fail to match, and nudges users based on dashboard attention flags — not deep machine learning.

## Architecture

```
HelpChatDock (frontend)
  ├─ Local match → shared/lib/helpKnowledge.js (instant, offline)
  └─ POST /api/help/chat
        ├─ matchHelpArticles + learnedBoosts
        ├─ insertHelpQueryLog (help_query_log table)
        └─ optional external AI (ZAREWA_AI_API_KEY)
```

### Key files

| File | Role |
|------|------|
| `shared/lib/helpKnowledge.js` | Articles, matching, formatting (mirror in frontend `src/lib/helpKnowledge.js`) |
| `shared/lib/helpRecommend.js` | Coaching hints, prompt merging |
| `server/helpChat.js` | Server answer pipeline + logging |
| `server/helpQueryOps.js` | Log inserts, learned boosts, personalization |
| `server/schemaSql.js` | `help_query_log` table |

## Knowledge base

Each article: `id`, `title`, `keywords[]`, `answer`, `steps[]`, `links[]`.

**44 articles** covering sales, finance, procurement, operations, manager, settings, and error recovery (see `HELP_ARTICLES` in code).

**To add a guide:** edit `shared/lib/helpKnowledge.js`, add a test in `helpKnowledge.test.js`, copy file to frontend.

## Pattern learning (how it “learns”)

1. Every server help answer writes one row to `help_query_log`:
   - user, branch, role, pathname, query text
   - matched article ids, source (`kb` / `ai` / `fallback`), score

2. **`computeHelpLearnedBoosts`** aggregates successful matches per branch (90-day window) and adds weight to article scores.

3. **`listHelpKnowledgeGaps`** lists frequent unmatched queries — candidates for new articles.

4. **`buildHelpCoachingHints`** reads bootstrap snapshot (`productionMetrics`, `operationsInventoryAttention`, open refunds) and suggests relevant guides proactively.

5. Bootstrap includes **`helpPersonalization`**: merged quick prompts + coaching hints for the signed-in user.

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
| `GET /api/help/personalization?pathname=/sales` | Prompts, coaching hints, learning flags |
| `POST /api/help/chat` | Ask a question (auth required) |

## Future upgrades (not yet implemented)

- Admin UI for gap report and article drafts in DB
- Per-user “recent mistakes” from audit_log correlation
- Embeddings for fuzzy match (still local, no OpenAI)

These can build on `help_query_log` without changing the staff-facing UX.
