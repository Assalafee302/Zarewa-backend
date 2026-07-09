# AI Automation Engine (Phase 5)

Structured action proposals that attach to existing ERP workflows. **AI proposes; humans approve; the system never auto-executes financial, HR, or operational actions.**

## Feature flag

| Variable | Default | Behavior |
|----------|---------|----------|
| `ZARE_AI_AUTOMATION_MODE` | unset / `false` | Suggestions only (Phase 4 behavior) |
| `ZARE_AI_AUTOMATION_MODE=true` | enabled | Creates reviewable `ai_action_proposals` |

Requires `ZARE_AI_UNIFIED_MODE=true` for enriched suggestion hooks to feed the automation router.

## Design principle

> AI can propose. Humans decide. System executes only after approval — and even approval does **not** auto-post memos, expenses, or HR letters.

## Architecture

```
AI suggestion (unified layer)
        │
        ▼
aiAutomationRouterService  (confidence + risk gate)
        │
        ├─ MEMO_DRAFT → office_memo_drafts + proposal
        ├─ EXPENSE_CLASSIFICATION → proposal + prefill
        ├─ HR_LETTER_DRAFT → hr_employment_letters (draft) + proposal
        ├─ WORKFLOW_SUGGESTION → proposal (work_item linked)
        └─ FILING_SUGGESTION → proposal
        │
        ▼
ai_action_proposals (pending)
        │
        ├─ POST …/approve → status approved (audit only)
        └─ POST …/reject  → status rejected
```

## Proposal format

```json
{
  "proposalId": "AIP-…",
  "type": "memo | expense | hr_letter | workflow | filing",
  "title": "…",
  "description": "…",
  "suggestedAction": "review_memo_draft",
  "confidence": 0.72,
  "riskLevel": "low | medium | high",
  "requiredApprovalLevel": "self | branch_manager | finance | hr | md",
  "linkedEntity": { "type": "office_memo_draft", "id": "MDR-…" },
  "status": "pending",
  "createdAt": "…"
}
```

## API endpoints

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/ai-proposals/status` | `ai.proposals.view` |
| POST | `/api/ai-proposals/create` | `ai.proposals.manage` |
| GET | `/api/ai-proposals` | `ai.proposals.view` |
| GET | `/api/ai-proposals/:id` | `ai.proposals.view` |
| POST | `/api/ai-proposals/:id/approve` | `ai.proposals.manage` |
| POST | `/api/ai-proposals/:id/reject` | `ai.proposals.manage` |

Create body (routed automation):

```json
{
  "automationType": "MEMO_DRAFT",
  "confidence": 0.7,
  "payload": { "subject": "…", "body": "…" }
}
```

## Safety controls (`aiSafetyGuardService`)

Blocked automatic actions:

- `payment`, `ledger_post`, `hr_issue`, `memo_submit`, `expense_post`, `auto_pay`, `auto_approve`, `work_item_decision`

Risk levels drive `requiredApprovalLevel`:

| Risk | Typical approval |
|------|------------------|
| low | self |
| medium | finance / branch manager |
| high | HR |

## Integration hooks

| Module | Hook | When automation on |
|--------|------|-------------------|
| Memo assist | `processMemoAutomationHook` | After `/api/help/memo-assist` |
| Expense suggest | `processExpenseAutomationHook` | After `/api/expense-categories/suggest` |
| HR letters | `processHrLetterAutomationHook` | After `/api/hr/employment-letters/ai-suggest` |

Response may include `automationProposal`, `memoDraft`, `expensePrefill`, or `letterDraft` — all with `aiSuggestionOnly: true`.

## Database

Table: `ai_action_proposals` (see `migrateAiAutomationEngine` in `server/migrate.js`)

## Logging

```
[ai-automation] proposal_created {…}
[ai-automation] proposal_approved {…}
[ai-automation] proposal_rejected {…}
```

Audit actions: `ai.proposal.create`, `ai.proposal.approve`, `ai.proposal.reject`

## Files

```
server/aiAutomationEngine/
  config/automationConfig.js
  repository/proposalRepository.js
  services/
    aiActionProposalService.js
    aiAutomationRouterService.js
    aiSafetyGuardService.js
    memoAutomationService.js
    expenseAutomationService.js
    hrLetterAutomationService.js
    workflowAutomationService.js
  bridges/automationHooks.js
  controllers/aiProposalController.js
  routes/aiProposalRoutes.js
```

## Related docs

- [`AI_UNIFICATION_LAYER.md`](AI_UNIFICATION_LAYER.md) — Phase 4
- [`ERP_AI_SYSTEM_MAP.md`](ERP_AI_SYSTEM_MAP.md) — system audit
