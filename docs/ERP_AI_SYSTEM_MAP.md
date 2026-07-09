# ERP AI System Map

**Purpose:** Foundation document for Phase 4 automation planning.  
**Scope:** What exists today, how modules connect, and where AI is (and is not) integrated.  
**Rule:** Descriptive audit only — no implementation recommendations beyond safe extension points.

**Last audited:** 2026 (Zarewa backend + frontend workspaces)

---

## 1. System Overview

Zarewa ERP combines **operational business modules** (Office Desk memos, expenses, HR letters, finance, sales, etc.) with **three distinct AI surfaces** that are only partially connected:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER-FACING SURFACES                                 │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│ Zare Help (life-ring)│ AI Assistant dock    │ Settings: Knowledge Center    │
│ HelpChatDock         │ AiAssistantDock      │ KnowledgeCenterPanel          │
│ Works WITHOUT API key│ Requires API key     │ Admin CRUD + hybrid search    │
└──────────┬───────────┴──────────┬───────────┴───────────────┬───────────────┘
           │                      │                           │
           ▼                      ▼                           ▼
    /api/help/*            /api/ai/*              /api/ai-knowledge-center/*
           │                      │                           │
           ▼                      ▼                           ▼
    helpAgent.js           aiAssist.js +            knowledgeService +
    helpKnowledge.js       aiAssistContext.js       embeddingIndexer +
    helpRagStore           (live workspace)         hybridSearchService
           │                      │                           │
           │                      │                           ▲
           │                      │              /api/ai-router/query (NO UI)
           │                      │                           │
           └──────────────────────┴───────────────────────────┘
                    NO CODE PATH between helpAgent ↔ Router ↔ KC (yet)

┌─────────────────────────────────────────────────────────────────────────────┐
│                    NON-AI OPERATIONAL SYSTEMS                                │
├──────────────┬──────────────┬──────────────┬────────────────────────────────┤
│ Office memos │ Expenses     │ HR letters   │ Workspace global search (FTS5)   │
│ work_items   │ payment_req  │ hr_employ…   │ /api/workspace/search          │
└──────────────┴──────────────┴──────────────┴────────────────────────────────┘
```

### High-level facts

| Layer | Technology | Active in production UI? |
|-------|------------|--------------------------|
| Zare Help knowledge | `helpKnowledge.js` (~1,050 articles) + `help_rag_chunks` | **Yes** — primary help path |
| AI Knowledge Center | `aic_knowledge_records` + `aic_knowledge_embeddings` | **Admin only** — Settings tab |
| AI Intelligence Router | Rules intent → KC search → optional LLM | **Backend only** — no frontend |
| General AI dock | OpenAI-compatible chat + workspace context | **Yes** — when `ZAREWA_AI_API_KEY` set |
| Workspace search | SQLite FTS5 + SQL fallback | **Yes** — header + Cmd+K |
| Memo assist | Rule-based + optional LLM | **Yes** — Office compose |

---

## 2. Module Breakdown

### 2.1 Memo System (Office Desk)

**Purpose:** Internal memos, operational records, endorsement workflow, conversion to payment/procurement requests.

#### Entry points (frontend)

| Entry | File |
|-------|------|
| Workspace compose wizard | `src/components/workspace/CreateOfficeRecordWizard.jsx` |
| Compose drawer | `src/components/office/OfficeRecordComposeDrawer.jsx` |
| Gmail-style workspace | `src/components/workspace/GmailStyleWorkspace.jsx` |
| Thread conversation | `src/components/office/OfficeThreadConversationDrawer.jsx` |
| Zare compose assist | `src/components/office/ZareComposeAssistBar.jsx` |
| Smart memo panel | `src/components/office/SmartMemoComposerPanel.jsx` |

#### Data flow

```
User composes memo (wizard / drawer)
    │
    ▼
POST /api/office/threads
    │  Body: subject, body, kind, documentClass, officeKey, toUserIds, payload (smartMemo, guidedForm)
    ▼
officeOps.createOfficeThread
    │  INSERT office_threads (status=open)
    │  INSERT office_messages (first message)
    │  audit_log: office.thread.create
    ▼
ensureWorkItemForOfficeThread (httpApi)
    │  INSERT work_items (source_kind=office_thread)
    │  work_item_visibility for sender/recipients
    │  UPDATE office_threads.related_work_item_id
    ▼
Inbox: GET /api/work-items
```

**Draft path:** `PUT /api/office/compose-drafts` → `office_memo_drafts` (`officeDraftOps.js`)

**Conversion to expense:** `POST /api/office/threads/:id/convert-payment-request` → `expenses` + `payment_requests`

#### Approval workflow

| Stage | Mechanism | API |
|-------|-----------|-----|
| BM endorsement | Work item decision | `POST /api/work-items/:id/decisions` (`endorse` / `return` / `close`) |
| BM edit | Versioned patch | `PATCH /api/office/threads/:id` → `office_record_versions` |
| Route metadata | Informational only | `computeOfficeApprovalRoute` → stored in `payload_json.approvalRoute` |
| Finance approval | Separate payment-request flow | See §2.2 |

#### Backend services

| File | Role |
|------|------|
| `server/officeOps.js` | Thread CRUD, messages, conversions |
| `server/officeRecordOps.js` | BM edit, approval-route enrichment |
| `server/officeDraftOps.js` | Compose drafts |
| `server/officeFilingOps.js` | AI filing extract → `office_thread_filing` |
| `server/workItems.js` | Unified inbox mirror |
| `shared/lib/smartMemoComposer.js` | Memo type detection, checklists |
| `shared/lib/memoAssist.js` | Rule-based assist |
| `server/helpMemoAssist.js` | HTTP handler for memo assist |
| `server/aiAssist.js` | LLM polish + filing extract |
| `shared/lib/officeApprovalRouting.js` | Approval step computation |

#### Database tables

| Table | Role |
|-------|------|
| `office_threads` | Memo header (subject, body, status, payload_json) |
| `office_messages` | Thread messages |
| `office_thread_reads` | Read tracking |
| `office_thread_filing` | AI/manual filing metadata |
| `office_memo_drafts` | Per-user compose drafts |
| `office_record_versions` | BM edit history |
| `work_items` + related | Unified inbox, decisions, SLA, filing |
| `approval_actions` | Payment-request approvals (post-conversion) |

#### AI / text assistance (existing)

| Feature | Endpoint / file | Type |
|---------|-----------------|------|
| Memo classify, improve, checklist, route | `POST /api/help/memo-assist` | Rules + optional LLM |
| Memo polish (formal/shorter/grammar) | `POST /api/office/ai/polish-memo` | LLM when key set |
| Expense category suggest | `POST /api/expense-categories/suggest` + memo-assist action | Heuristics |
| AI filing extract | `POST /api/office/threads/:id/ai-file` | LLM extract → `office_thread_filing` |
| Zare compose chips | `ZareComposeAssistBar` → opens Zare + `memoAssistApi.js` | UI integration |

**Router awareness:** `intentClassifierService.js` maps `memo|office|filing` keywords to module `office` — but Router is **not called** from memo UI today.

---

### 2.2 Expenses System

**Purpose:** Record operational spend, approve payment requests, pay from treasury, post to GL.

#### Entry points

| Entry | File |
|-------|------|
| Finance desk | `src/pages/Account.jsx` |
| Workspace quick action | `src/components/workspace/WorkspaceExpenseQuickActions.jsx` |
| Memo conversion | `OfficeThreadConversationDrawer.jsx` |
| Category picker | `src/components/office/ExpenseCategorySelect.jsx` |

#### Data flow — Path A (direct posted expense)

```
POST /api/expenses  (finance.post | expenses.create)
    ▼
writeOps.insertExpenseEntry
    │  validate category (shared/expenseCategories.js)
    │  assign category_lane
    │  INSERT expenses
    │  GL post (if policy applies)
    │  capex → fixed asset sync
    ▼
audit_log: expense.create
```

#### Data flow — Path B (payment request)

```
POST /api/payment-requests  (or memo convert-payment-request)
    ▼
controlOps.insertPaymentRequest
    │  INSERT expenses (type "Payment request (pending payout)")
    │  INSERT payment_requests (approval_status "Pending")
    ▼
POST /api/payment-requests/:id/decision  (finance.approve)
    ▼
POST /api/payment-requests/:id/pay  (finance.pay)
    │  treasury debit, GL posting
```

#### Categorization

| Layer | File |
|-------|------|
| Canonical categories | `shared/expenseCategories.js` |
| Role policy | `shared/expenseCategoryPolicy.js` |
| Lanes (operational/capex/etc.) | `shared/expenseCategoryLanes.js` |
| GL mapping | `shared/lib/expenseCategoryGlMap.js` |
| Suggest API | `POST /api/expense-categories/suggest` → `expenseCategorySuggestions.js` |

**Automatic categorization:** Heuristic/rule-based only. No ML. Memo-assist and expense-suggest share suggestion logic.

#### Database tables

| Table | Role |
|-------|------|
| `expenses` | Expense rows |
| `payment_requests` | Approval/payout workflow |
| `setup_expense_categories` | Master data |
| `treasury_movements` | Payout debits |
| `approval_actions` | Approval audit |

#### Reporting

| Report | Endpoint |
|--------|----------|
| Expenses pack | `GET /api/reports/expenses-pack` |
| Category exceptions | `GET /api/reports/expense-category-exceptions` |
| Monthly alert | `GET /api/reports/expense-category-monthly-alert` |

#### AI integration today

| Used | Not used |
|------|----------|
| Memo-assist `suggest_expense_category` | AI Router |
| `POST /api/expense-categories/suggest` | Knowledge Center |
| Zare help articles about expense workflows | Automated posting |

---

### 2.3 Letters / Documents System

Two distinct document systems exist.

#### A. HR official letters

| Layer | Path |
|-------|------|
| Templates | `server/hrLetterTemplates.js` |
| Workflow | `server/hrLetterWorkflowOps.js` |
| Routes | `server/hrApi.js` |
| UI | `src/pages/hr/HrLetters.jsx`, `HrDocumentsHub.jsx` |

**Storage:** `hr_employment_letters` (+ workflow columns via migration)

**Flow:** draft → HR review → GM review → MD approve → issue → PDF/DOCX export

**Formatting:** `shared/lib/simpleTextPdf.js` (PDF), HTML-as-Word (DOCX)

**Key endpoints:** `/api/hr/employment-letters/*` (generate, submit, review, issue, pdf, docx)

**AI integration:** None for letter generation. Templates are static string builders.

#### B. Office memos / operational documents

| Layer | Path |
|-------|------|
| Compose templates | `shared/officeComposeTemplates.js` |
| Filing numbers | `filingNumberOps.js`, `referenceIssuance.js` (`ZR/{branch}/{domain}/{yy}/{seq}`) |
| Print | `src/lib/officeDeskPrint.js`, `officeMemoPackPrint.js` |

**Storage:** `office_threads`, `work_items`, `office_thread_filing`

**AI integration:** Filing extract (`ai-file`), memo polish — not full document generation.

#### C. HR staff document uploads

**Storage:** `hr_staff_documents` (base64 in DB) — file storage, not generated letters.

---

### 2.4 Chatbot / Help System (Zare)

**Brand:** Zare — life-ring help guide. **Does not** approve or post ERP actions.

#### What is ACTIVE in production

| Component | Status |
|-----------|--------|
| `HelpChatDock` + `ZareHelpFab` | **Active** — all authenticated users |
| `shared/lib/helpKnowledge.js` | **Active** — ~45 curated + ~1,000 operational FAQs |
| `POST /api/help/chat` → `helpAgent.js` | **Active** — server path |
| Local instant answers in browser | **Active** — mirrored `src/lib/helpKnowledge.js` |
| `help_rag_chunks` embeddings | **Active** when API key set (separate from KC embeddings) |
| AI Knowledge Center | **Not in chat path** |
| AI Router | **Not in chat path** |

#### User query flow (HelpChatDock)

```
User types question
    │
    ▼
Client: classifyAgentRoute + detectHelpIntent (mirrored libs)
    │
    ├─ preferServer = false AND local match score ≥ 4?
    │       └─ YES → tryLocalAnswer (helpKnowledge.js) → optional POST /api/help/log-query
    │
    └─ preferServer = true when:
           erp_data | hybrid route, follow-up, complex query, low score, workflow intent
           AND external AI enabled for some cases
    │
    ▼
POST /api/help/chat
    │
    ▼
helpAgent.js (runHelpAgent)
    ├─ Transaction help, briefing, business analysis (special routes)
    ├─ classifyZareIntent + classifyAgentRoute
    ├─ retrieveHelpContext (help_rag_chunks) + matchHelpArticles (helpKnowledge.js)
    ├─ queryErpData (read-only SQL tools) when erp_data/hybrid
    ├─ synthesizeHelpReply (rule-based)
    └─ optional postChatCompletions (when ZAREWA_AI_API_KEY set)
    │
    ▼
Response + logId → POST /api/help/signal (👍/👎)
```

#### Parallel knowledge stores (important)

| Store | Location | Powers |
|-------|----------|--------|
| **Legacy/live help KB** | `helpKnowledge.js` + `help_rag_chunks` | Zare chat (production) |
| **AI Knowledge Center** | `aic_knowledge_records` + `aic_knowledge_embeddings` | Settings admin, AI Router only |

These are **not synchronized**. Deploy updates help KB via code; KC updates via admin UI.

#### Help API surface

| Endpoint | Used by |
|----------|---------|
| `GET /api/help/status` | HelpChatDock |
| `GET /api/help/personalization` | HelpChatDock |
| `POST /api/help/chat` | HelpChatDock |
| `POST /api/help/signal` | HelpChatDock |
| `POST /api/help/log-query` | HelpChatDock (local answers) |
| `POST /api/help/memo-assist` | Office compose |
| `GET /api/help/admin/dashboard` | ZareIntelligencePanel (Settings) |

---

### 2.5 AI Systems (All Layers)

#### Layer map

| Phase | Module | Path | Frontend usage |
|-------|--------|------|----------------|
| — | Zare help + RAG | `helpAgent.js`, `helpRagStore.js`, `helpEmbeddings.js` | HelpChatDock |
| — | General AI dock | `aiAssist.js`, `aiAssistContext.js` | AiAssistantDock |
| 1 | AI Knowledge Center | `server/aiKnowledgeCenter/` | KnowledgeCenterPanel (Settings) |
| 2 | Embeddings + hybrid search | `embeddingService.js`, `hybridSearchService.js` | KC admin search only |
| 3 | AI Intelligence Router | `server/aiIntelligenceRouter/` | **None** |

#### AI Knowledge Center architecture

```
KnowledgeCenterPanel (Settings)
    │
    ├─ CRUD → knowledgeService → aic_knowledge_records
    │         └─ on create/update → embeddingIndexerService (async)
    │
    └─ Search → knowledgeSearchService
                  ├─ keyword (SQL LIKE)
                  ├─ semantic (cosine on aic_knowledge_embeddings)
                  └─ hybrid (40% keyword + 60% semantic, top 10)
```

**Embedding provider:** `embeddingService.js` — OpenAI-compatible API or local TF fallback (256-dim).

#### AI Router architecture

```
POST /api/ai-router/query  (no UI caller)
    │
    ▼
intentClassifierService.detectIntent
    │
    ▼
routingEngineService.buildRoutePlan
    │  SOP → sop_article hybrid
    │  SQL → sql_example keyword
    │  TROUBLESHOOTING → troubleshooting_example high-recall hybrid
    │  GLOSSARY → glossary_term hybrid
    │  CHAT → llmSynthesizerService (rules / optional LLM)
    │  UNKNOWN → hybrid fallback
    ▼
knowledgeSearchService.searchKnowledge  (reuses KC — no duplication)
    │
    ▼
confidenceService → mode: auto | suggest | fallback
    │
    ▼
llmSynthesizerService.synthesizeAnswer (optional)
    │
    ▼
insertRouterQueryLog → ai_router_query_log
```

#### LLM usage summary

| Feature | LLM when key set? | Provider config |
|---------|-------------------|-----------------|
| Zare help generation | Yes | `ZAREWA_AI_HELP_MODEL` |
| Zare help RAG embeddings | Yes | `ZAREWA_AI_EMBEDDING_MODEL` |
| AI Assistant dock | Yes | `ZAREWA_AI_MODEL` |
| Memo polish | Yes | `ZAREWA_AI_POLISH_MODEL` |
| Office AI filing extract | Yes | `aiAssist.js` |
| KC embeddings | Yes (or local fallback) | `embeddingService` |
| AI Router synthesis | Yes (or rule draft) | `llmSynthesizerService` |
| Memo-assist rules | No (LLM optional overlay) | `memoAssist.js` |

**Single config hub:** `server/aiAssist.js` + env vars documented in `docs/ENVIRONMENT.md`.

#### Connection diagram (current vs intended)

```
CURRENT:
  helpAgent ──► helpKnowledge.js + help_rag_chunks
  aiRouter  ──► aic_knowledge_records (internal only)
  (no edge between helpAgent and aiRouter)

NOT CONNECTED:
  helpKnowledge.js ──X──► aic_knowledge_records
  HelpChatDock     ──X──► /api/ai-router/query
  memoAssist       ──X──► aiRouter (only shared intent patterns in classifier rules)
```

---

### 2.6 Search System

#### A. Workspace global search (primary ERP search)

| Aspect | Detail |
|--------|--------|
| **UI** | App header search, `WorkspaceCommandPalette` (Cmd+K) |
| **API** | `GET /api/workspace/search?q=` |
| **Primary engine** | SQLite **FTS5** `workspace_search_fts` |
| **Fallback** | SQL `LIKE` per entity (`workspaceSearchOps.js`) |
| **Offline** | Client scan of bootstrap snapshot (`workspaceSearchLocal.js`) |
| **Scoring** | BM25 + `scoreWorkspaceSearchMatch` (typo tolerance) |

**Indexed entity kinds:** customer, quotation, receipt, purchase_order, supplier, cutting_list, coil, production_job, delivery, refund, product, payment_request, expense, gl_journal, hr_staff

**Also searched (SQL only):** `work_item`, static `nav` commands

**Tables:** `workspace_search_fts`, `workspace_search_misses` (zero-hit log)

**AI:** None. Pure database FTS + heuristics.

#### B. AI Knowledge Center search

| Mode | Technology |
|------|------------|
| keyword | SQL LIKE on `aic_knowledge_records` |
| semantic | Vector cosine on `aic_knowledge_embeddings` |
| hybrid | Weighted merge (40/60) |

**UI:** Settings → AI Knowledge Center only.

#### C. Zare help search

| Layer | Technology |
|-------|------------|
| Article match | Token scoring + typo tolerance (`helpKnowledge.js`) |
| Server RAG | `help_rag_chunks` + optional OpenAI embeddings |
| ERP data | `helpErpQuery.js` (guarded SQL) |

**Not using:** KC hybrid search, AI Router.

#### D. Module-local search

| Module | Method |
|--------|--------|
| Coil lots | `GET /api/coil-lots/search` (SQL LIKE) |
| Customers | Client `customerPickerSearch.js` |
| Operations inbox | Client filter on loaded rows |
| HR directory | Client filter + saved views |
| Work items inbox | Server filter on `workItemSearchBlob` |

---

### 2.7 Zare AI Entry Points (UI → API)

| UI surface | Who sees it | API called | Knowledge source |
|------------|-------------|------------|------------------|
| **HelpChatDock** (life-ring) | All users | `/api/help/*` | `helpKnowledge.js` + helpAgent |
| **ZareHelpFab** | All users | Opens HelpChatDock | Same |
| **openZare()** from workspace, compose, etc. | Contextual | Same as HelpChatDock | Same |
| **ZareComposeAssistBar** | Office compose | `/api/help/memo-assist` + opens Zare | memoAssist + help |
| **AiAssistantDock** (sparkles) | Non-CEO + AI enabled | `/api/ai/chat` | Live workspace bootstrap |
| **AiAskButton** | Various toolbars | Opens AiAssistantDock | Same |
| **KnowledgeCenterPanel** | Settings admins | `/api/ai-knowledge-center/*` | KC database |
| **ZareIntelligencePanel** | Settings admins | `/api/help/admin/*` | Help analytics (gaps, feedback) |
| **OfficeRecordComposeDrawer** | Office users | `/api/office/ai/polish-memo` | LLM polish |
| **AI Router** | — | `/api/ai-router/query` | **No UI** |

#### HelpChatDock server vs local decision

Server (`POST /api/help/chat`) is preferred when:

- Agent route is `erp_data` or `hybrid`
- Follow-up with long history
- External AI enabled AND (complex query OR low match score OR workflow/clarify intent)

Otherwise local `helpKnowledge.js` answer is used if score ≥ 4 (or greeting/thanks/meta).

#### Fallback flows

| Failure | Behavior |
|---------|----------|
| `/api/help/chat` fails | HelpChatDock falls back to local KB synthesis |
| No AI API key | Zare still works (local KB + rule synthesis); AI dock hidden/disabled |
| KC semantic search, no embeddings | Keyword-only or local TF vectors after reindex |
| AI Router, no KC records | Empty results, `fallback` mode, clarification message |

---

## 3. Current AI Integration Points

### Where AI is already used

| Business area | AI feature | Integration depth |
|---------------|------------|-------------------|
| Zare help chat | Optional LLM + RAG embeddings | **Deep** — production |
| Office memos | polish, filing extract, memo-assist | **Medium** — compose only |
| Expenses | Category suggestion (heuristics + memo-assist) | **Light** — suggest only |
| General workspace | AI Assistant dock | **Medium** — separate product |
| Settings | KC admin + Zare intelligence dashboard | **Admin only** |
| AI Router | Query routing | **Backend only** — no UI |

### Where AI is NOT used

| Area | Gap |
|------|-----|
| Expense approval decisions | Fully manual RBAC workflow |
| Payment posting | No AI validation layer |
| HR letter generation | Static templates only |
| Workspace FTS search | No semantic/AI ranking |
| Work item routing | Rule-based SLA, no AI |
| Procurement / sales workflows | No AI Router integration |
| Report generation | SQL aggregates only |

### Duplicate or overlapping logic

| Overlap | Systems involved | Risk |
|---------|------------------|------|
| **Dual knowledge bases** | `helpKnowledge.js` vs `aic_knowledge_records` | Content drift; double maintenance |
| **Dual embedding indexes** | `help_rag_chunks` vs `aic_knowledge_embeddings` | Different models, different stores |
| **Dual intent classifiers** | `helpZareIntent.js` / `helpAgentIntent.js` vs `intentClassifierService.js` | Inconsistent routing if merged carelessly |
| **Dual search stacks** | Help article scoring vs KC hybrid vs FTS workspace | No unified retrieval API |
| **Dual LLM synthesis** | `helpSynthesize.js` + helpAgent LLM vs `llmSynthesizerService` | Similar prompts, different callers |
| **Memo assist vs Router** | `memoAssist.js` vs Router `office` module hints | Router not called from memo UI |
| **Category suggest** | `expenseCategorySuggestions.js` vs memo-assist action | Same heuristics, two entry points (OK) |

---

## 4. Gaps & Risks

### Missing integration points

1. **AI Router has no frontend** — Phase 3 backend is unreachable by staff.
2. **Knowledge Center not fed into Zare chat** — production help ignores `aic_knowledge_records`.
3. **No import pipeline** — `helpKnowledge.js` → KC migration documented but not built.
4. **AI Router analytics** (`GET /api/ai-router/analytics`) — no admin UI.
5. **Help gap drafts** — `help_suggested_articles` review API exists; UI lists but cannot approve/reject.
6. **Expense automation** — no AI review before finance approve/pay.
7. **Letter generation** — no AI drafting; templates only.

### Conflicting systems

| Conflict | Description |
|----------|-------------|
| **help vs KC** | Two sources of truth for “what Zare knows” |
| **help RAG vs KC embeddings** | Different tables, reindex strategies, models |
| **Zare vs AI dock** | Users may confuse life-ring (SOP) vs sparkles (workspace AI) |
| **Local help vs server** | Same question can get different answers (client mirror must stay synced) |

### Redundant logic

- Intent patterns duplicated across `helpZareIntent.js`, `helpAgentIntent.js`, and `intentClassifierService.js`
- LLM system prompts built separately in `helpSynthesize.js`, `helpAgent.js`, `llmSynthesizerService.js`, `aiAssist.js`
- Keyword search implemented in `helpKnowledge.js`, `knowledgeRepository.js`, and `workspaceSearchOps.js`

### Weak points for automation (Phase 4)

| Risk | Why it matters |
|------|----------------|
| **No idempotent automation hooks** | Memos/expenses expect human decisions on `work_items` and `payment_requests` |
| **RBAC scattered** | Permissions per route; automation must respect same gates |
| **Audit trail required** | `audit_log`, `approval_actions` — automation must log, not bypass |
| **Dual KB drift** | Automating answers from wrong store could give outdated SOPs |
| **LLM without guardrails** | `helpErpQuery.js` pattern (SELECT-only) must extend to any automated ERP reads |
| **Async embedding index** | KC records may not be searchable immediately after create |

---

## 5. Recommended Integration Strategy (NO CODE — architecture only)

### 5.1 Where AI Router should plug in (Phase 4 precursor)

**Recommended single choke point:** `helpAgent.js` / `POST /api/help/chat`

```
HelpChatDock
    └─► POST /api/help/chat
            └─► [NEW] optional routeQuery() for knowledge retrieval
                    └─► falls back to existing helpKnowledge path if KC empty/low confidence
```

**Why:** HelpChatDock is the only user-facing AI help surface with full ERP context (`pageContext`, `pathname`, RBAC user). Router already returns structured `intent`, `confidence`, `mode`, `results`, `answer`.

**Do not replace immediately:** Keep `helpKnowledge.js` as fallback until KC import parity is verified.

### 5.2 Where automation layer should attach later

| Automation type | Safe attachment point | Avoid |
|-----------------|----------------------|--------|
| **Suggest memo category / route** | After `memoAssist.js`, before save | Auto-submitting memo |
| **Suggest expense category** | `POST /api/expense-categories/suggest` | Auto-approving payment request |
| **Pre-fill payment request from memo** | After `convert-payment-request` validation | Auto-pay |
| **Answer staff questions** | AI Router → KC → synthesize | Auto-posting ledger |
| **Triage inbox items** | Read `work_items` + suggest priority | Auto `endorse` decision |
| **Search enrichment** | Optional semantic layer on FTS results | Replacing FTS index |
| **Letter draft assist** | New hook in `hrLetterWorkflowOps` draft step | Auto-issue without MD approve |

### 5.3 Safe extension points (existing hooks)

| Extension point | File | Use for Phase 4 |
|-----------------|------|-----------------|
| Help agent orchestration | `server/helpAgent.js` | Wire Router + KC retrieval |
| Memo assist actions | `shared/lib/memoAssist.js` | Add automation suggestions |
| Work item decisions | `server/workItems.js` | Suggest — never auto-decide |
| Expense category suggest | `shared/lib/expenseCategorySuggestions.js` | Enrich with KC glossary |
| Router intent registry | `shared/lib/aiIntelligenceRouter/intents.js` | Add `EXPENSE_REQUEST`, `MEMO_DRAFT` intents |
| KC knowledge types | `KNOWLEDGE_TYPE_REGISTRY` | Add automation playbooks as new types |
| Audit logging | `server/controlOps.js` `appendAuditLog` | All automation must log here |
| Confidence gating | `confidenceService.js` | `auto` vs `suggest` vs `fallback` for automation |
| Design limits | `shared/lib/helpDesignLimits.js` | Enforce no ERP mutations from AI |

### 5.4 Phased integration order (recommended)

1. **Import/sync:** `helpKnowledge.js` → AI Knowledge Center (one-time + ongoing governance)
2. **Wire Router into help chat:** `helpAgent` calls `routeQuery` for retrieval; keep legacy fallback
3. **Unify analytics:** Help query log + Router log + KC stats in one admin dashboard
4. **Memo/expense suggest mode only:** Router `suggest` mode for category/route — no auto actions
5. **Automation playbooks as KC records:** New knowledge type `automation_playbook` (future type registry)
6. **Phase 4 automation:** Event-driven workers on `work_items` / `payment_requests` state changes — always human confirm

### 5.5 Principles for Phase 4

1. **Human-in-the-loop** — match existing Zare principle: guide, never approve/post.
2. **Single retrieval path** — converge on Router + KC; deprecate duplicate help RAG over time.
3. **Confidence-gated automation** — reuse `auto` / `suggest` / `fallback` thresholds.
4. **RBAC inheritance** — automation inherits `req.user` permissions; no elevation.
5. **Audit everything** — mirror `ai_router_query_log` pattern for automation events.
6. **No silent KB publish** — KC `pending_review` status + admin gate (already in design limits).

---

## Appendix A — Key file index

### Backend

| Path | Module |
|------|--------|
| `server/helpAgent.js` | Zare chat orchestration |
| `shared/lib/helpKnowledge.js` | Live help KB |
| `server/helpRagStore.js` | Help RAG index |
| `server/aiKnowledgeCenter/` | Knowledge Center (Phases 1–2) |
| `server/aiIntelligenceRouter/` | AI Router (Phase 3) |
| `server/aiAssist.js` | LLM proxy |
| `server/officeOps.js` | Memos |
| `server/writeOps.js` | Expenses / payments |
| `server/hrLetterWorkflowOps.js` | HR letters |
| `server/workspaceSearchFts.js` | Global FTS search |

### Frontend

| Path | Module |
|------|--------|
| `src/components/HelpChatDock.jsx` | Zare UI |
| `src/components/AiAssistantDock.jsx` | General AI UI |
| `src/components/settings/KnowledgeCenterPanel.jsx` | KC admin |
| `src/components/office/OfficeRecordComposeDrawer.jsx` | Memo compose |
| `src/pages/Account.jsx` | Expenses desk |
| `src/pages/hr/HrLetters.jsx` | HR letters |
| `src/lib/useWorkspaceSearch.js` | Global search hook |

### Documentation cross-reference

| Doc | Topic |
|-----|-------|
| `docs/HELP_ASSISTANT.md` | Zare help architecture |
| `docs/AI_KNOWLEDGE_CENTER.md` | KC Phases 1–2 |
| `docs/AI_INTELLIGENCE_ROUTER.md` | Router Phase 3 |
| `docs/ENVIRONMENT.md` | AI env vars |
| `docs/OFFICE_OPERATIONS_RUNBOOK.md` | Memo operations |

---

## Appendix B — Database tables quick reference

| Table | AI-related? |
|-------|-------------|
| `office_threads`, `office_messages`, `work_items` | Memo workflow |
| `expenses`, `payment_requests` | Expense workflow |
| `hr_employment_letters` | Letters |
| `help_query_log`, `help_rag_chunks`, `help_knowledge_gaps` | Zare help learning |
| `aic_knowledge_records`, `aic_knowledge_embeddings`, `aic_knowledge_versions` | Knowledge Center |
| `ai_router_query_log` | Router analytics |
| `workspace_search_fts`, `workspace_search_misses` | Global search |
| `office_thread_filing`, `office_memo_drafts` | Memo AI/filing |

---

*This document should be updated when Phase 4 wiring begins or when help KB and Knowledge Center are unified.*
