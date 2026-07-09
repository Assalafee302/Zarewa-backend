# AI Knowledge Center

Enterprise knowledge store for the Zare ERP Assistant. This module is the **single source of truth** for AI knowledge going forward. It does **not** replace the existing Zare help system (`helpKnowledge.js`, RAG, operational catalog) — those continue to power live chat unchanged.

## Purpose

| Today | Future |
|-------|--------|
| Admin CRUD for structured AI knowledge | Feed RAG index and Zare retrieval |
| Version history and audit trail | Export fine-tuning / Hugging Face datasets |
| Keyword search | Semantic search via `aic_knowledge_embeddings` |
| Placeholder embedding rows | OpenAI, Gemini, Ollama, HF embedding providers |

## Architecture (clean layers)

```
shared/lib/aiKnowledgeCenter/knowledgeTypes.js   ← type registry (extensible)
server/aiKnowledgeCenter/
  models/knowledgeRecordModel.js                 ← row mapping, ID generation
  repository/knowledgeRepository.js              ← SQLite access only
  validators/knowledgeValidator.js               ← input validation
  services/knowledgeService.js                   ← create / update / archive / list
  services/knowledgeSearchService.js             ← keyword + semantic placeholder
  services/knowledgeStatsService.js              ← dashboard statistics
  controllers/knowledgeController.js             ← thin HTTP handlers
  routes/knowledgeRoutes.js                      ← Express routes + permissions
  index.js                                       ← module entry
```

**Controllers contain no business logic.** All rules live in services; all SQL in the repository.

## Knowledge types

| Type ID | Label |
|---------|--------|
| `sop_article` | SOP Article |
| `operational_faq` | Operational FAQ |
| `intent_example` | Intent Example |
| `conversation_example` | Conversation Example |
| `troubleshooting_example` | Troubleshooting Example |
| `sql_example` | SQL Example |
| `glossary_term` | Glossary Term |
| `prompt_template` | Prompt Template |
| `evaluation_question` | Evaluation Question |
| `ai_model_config` | AI Model Configuration |

**Adding a type:** append to `KNOWLEDGE_TYPE_REGISTRY` in `shared/lib/aiKnowledgeCenter/knowledgeTypes.js` and mirror in `frontend/src/lib/aiKnowledgeCenter/knowledgeTypes.js`. No API contract change.

## Record metadata

Every record includes:

- `id` — `AKC-…` unique identifier
- `knowledgeType`, `title`, `category`, `module`
- `tags[]`, `keywords[]`
- `content` — JSON payload (type-specific fields)
- `bodyText` — denormalized searchable text
- `createdBy`, `createdByName`, `createdAt`, `updatedAt`
- `version` — incremented on each update
- `status` — `active` | `pending_review` | `archived`
- `metadata` — optional JSON extension bag

## Database schema

### `aic_knowledge_records`

Primary knowledge table.

### `aic_knowledge_versions`

Immutable snapshots per version (audit + rollback reference).

### `aic_knowledge_embeddings` (future-ready)

Placeholder rows with `status = pending`. When embeddings are implemented:

1. Compute vector via provider
2. Store in `embedding_json`
3. Set `status = ready`
4. Wire `runSemanticSearch()` in `knowledgeSearchService.js`

**No embeddings are computed in this release.**

## API

Base path: `/api/ai-knowledge-center`

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | `/stats` | view | Dashboard statistics |
| GET | `/types` | view | Knowledge type registry |
| GET | `/records` | view | List with filters |
| GET | `/records/:id` | view | Single record |
| GET | `/records/:id/versions` | view | Version history |
| POST | `/records` | manage | Create |
| PATCH | `/records/:id` | manage | Update (new version) |
| POST | `/records/:id/archive` | manage | Archive |
| POST | `/search` | view | Keyword / semantic / hybrid search |

**View permissions:** `ai.knowledge.view`, `settings.manage`, or `audit.view`  
**Manage permissions:** `ai.knowledge.manage` or `settings.manage`

### Search modes

```json
POST /api/ai-knowledge-center/search
{
  "query": "how to record receipt",
  "mode": "keyword",
  "knowledgeType": "sop_article",
  "module": "sales",
  "limit": 25
}
```

- `keyword` — title, body, keywords, tags
- `semantic` — cosine similarity over `aic_knowledge_embeddings` (requires indexed vectors)
- `hybrid` — weighted fusion: **40% keyword + 60% semantic**, top 10 results

`POST /api/ai-knowledge-center/reindex` — backfill pending/failed embeddings (manage permission).

### Phase 2 — Embeddings (active)

| Service | Role |
|---------|------|
| `embeddingService.js` | Pluggable adapters: OpenAI-compatible API or local TF fallback |
| `embeddingIndexerService.js` | Index on create/update (async), `reindexAllKnowledge()` |
| `hybridSearchService.js` | Weighted merge for hybrid mode |
| `embeddingRepository.js` | Vector persistence + `content_hash` skip unchanged |

Configure provider via existing env vars (`ZAREWA_AI_API_KEY`, `ZAREWA_AI_BASE_URL`, `ZAREWA_AI_EMBEDDING_MODEL`). Without an API key, local 256-dim fallback embeddings still enable semantic + hybrid search offline.

## Admin UI

**Settings → AI Knowledge Center** (`/settings/knowledge-center`)

- Statistics cards (total, by type, pending, archived)
- Filterable knowledge list
- Keyword / hybrid search
- Reindex embeddings button
- Create / edit modal with JSON content editor
- Version history modal
- Archive action

Same access gate as Zare intelligence (`settings.manage`, `audit.view`, or `*`).

## Permissions

| Key | Role |
|-----|------|
| `ai.knowledge.view` | Read knowledge center |
| `ai.knowledge.manage` | Create, update, archive |

Administrator role includes both keys explicitly (also covered by `*`).

## Audit

Mutations write to `audit_log`:

- `ai_knowledge.create`
- `ai_knowledge.update`
- `ai_knowledge.archive`

## Migration notes

### New installs

Tables are created via `server/schemaSql.js` (greenfield) and `migrateAiKnowledgeCenter()` in `server/migrate.js` (existing DBs).

### Upgrading an existing deployment

1. Deploy backend — boot migration runs automatically on next API start
2. Deploy frontend — new Settings tab appears for authorized users
3. **No data migration from `helpKnowledge.js` is performed automatically** — existing Zare articles remain in JS files until a future import job is run
4. Verify: `GET /api/ai-knowledge-center/stats` returns `{ ok: true, stats: { totalKnowledge: 0, ... } }`

### Optional manual verification

```bash
cd Zarewa-backend-main
npm test -- server/aiKnowledgeCenter/knowledgeCenter.test.js
```

### Future integration checklist

- [ ] Import script: `helpKnowledge.js` → `aic_knowledge_records`
- [x] Embedding indexer job → `aic_knowledge_embeddings` (Phase 2)
- [x] Semantic + hybrid search in `knowledgeSearchService.js`
- [ ] Zare `helpRagStore.js` reads from Knowledge Center instead of JS files
- [ ] Export endpoint for HF datasets / fine-tuning JSONL
- [ ] Sync approved `help_suggested_articles` drafts into Knowledge Center

## Extension points

| Hook | Location |
|------|----------|
| New knowledge type | `KNOWLEDGE_TYPE_REGISTRY` |
| Semantic search | `runSemanticSearch()` in `knowledgeSearchService.js` |
| Embedding provider | `embeddingService.js` adapters |
| Hybrid ranking | `hybridSearchService.js` |
| RAG chunking | Future `knowledgeRagIndexerService.js` |
| Provider configs | `ai_model_config` records + env overlay |
| Import from legacy help | Future `knowledgeImportService.js` |

## Related docs

- `docs/HELP_ASSISTANT.md` — live Zare help system (unchanged)
- `docs/ENVIRONMENT.md` — AI provider env vars (for future LLM integration)
