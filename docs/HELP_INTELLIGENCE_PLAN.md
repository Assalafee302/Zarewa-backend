# Runa Intelligence Upgrade — Technical Plan

## Existing assets (keep)
- `help_query_log`, `help_rag_chunks` — telemetry + vector store
- `helpSelfTrain.js`, `helpQueryOps.js` — boosts, logging, personalization
- `helpAgent.js`, `helpRagStore.js`, `helpErpQuery.js`, `helpGuardrails.js`
- `helpKnowledge.js` (44 articles), typo tolerance, clearance

## New / extended modules
| Module | Role |
|--------|------|
| `shared/lib/helpMemory.js` | User / branch / system memory (DB-backed) |
| `shared/lib/helpRecommendEngine.js` | Ranked “Try asking” + predictive hints |
| `shared/lib/helpCoaching.js` | Step-by-step coaching mode |
| `shared/lib/helpGapAnalysis.js` | Gap detection + suggested article drafts |
| `shared/lib/helpAgentIntent.js` | Extended intent router |
| `server/helpAnalytics.js` | ERP activity learning job |
| `server/helpIntelligenceAdmin.js` | Admin dashboard aggregates |
| `server/helpAiService.js` | AI provider abstraction |

## New tables (migrate + schemaSql)
- `help_article_weights` — persisted branch/user/system article weights
- `help_user_memory` — per-user topic preferences & struggle patterns
- `help_branch_memory` — branch workflow patterns
- `help_workflow_events` — aggregated ERP signals from analytics job
- `help_knowledge_gaps` — fallback / bad-feedback queries
- `help_suggested_articles` — admin-review article drafts
- `help_ai_observations` — route/source/timing audit (no secrets)

Feedback remains on `help_query_log` (no duplicate `help_feedback_signal`).

## API changes
- `POST /api/help/chat` — adds `sources`, `coaching` in response
- `GET /api/help/personalization` — uses recommend engine + memory
- `GET /api/help/admin/dashboard` — Runa metrics (settings/audit permission)
- `GET /api/help/admin/gaps` — knowledge gaps
- `GET /api/help/admin/suggestions` — pending article drafts
- `POST /api/help/admin/run-analytics` — manual analytics refresh

## Frontend
- Mirror new shared libs under `src/lib/`
- `HelpChatDock` — coaching UI, pathname personalization refresh, sources
- `RunaIntelligencePanel.jsx` — basic admin view under Settings

## Safety
- No INSERT/UPDATE/DELETE via Runa SQL path (unchanged guardrails)
- Memory stores topics/counts only — no restricted field values
- Suggested articles require admin approval (`status=pending`)
- Analytics job is read-only on ERP tables

## Tests
- Intent router, memory, recommendations, coaching, gaps, analytics, admin aggregates
