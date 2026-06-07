# Zare Knowledge Update Checklist

Keep **Zare** (in-app help chat) aligned with **policy docs** and **live UI**. Zare reads from code, not from `docs/*.md` automatically.

**Canonical sources**

| What | Backend file | Frontend mirror |
|------|--------------|-----------------|
| Deep guides (~45) | `shared/lib/helpKnowledge.js` | `Zarewa-frontend-main/src/lib/helpKnowledge.js` |
| Operational FAQ (~1000) | `shared/lib/helpOperationalCatalog.js` | `Zarewa-frontend-main/src/lib/helpOperationalCatalog.js` |
| Bot name / principle | `shared/lib/helpBotBrand.js` (if present) | `src/lib/helpBotBrand.js` |
| Refund categories (for consistency) | `shared/refundConstants.js` | `src/shared/refundConstants.js` |

**Policy docs to cross-check**

| Policy | Doc path |
|--------|----------|
| Master operations | `docs/OPERATIONS_MANUAL.md` |
| Access / RBAC | `docs/ACCESS_CONTROL.md`, `docs/RBAC_MATRIX.md` |
| Phase 10 desks | `docs/ROLE_DASHBOARD_MATRIX.md`, `docs/RBAC_FINANCE_DESK.md` |
| Refunds | `docs/REFUND_OPERATIONS.md` |
| Payments | `docs/PAYMENT_POSTING_SOP.md`, `docs/PAYMENT_POSTING_RUNBOOK.md` |
| Staff approvals | `docs/STAFF_APPROVALS.md` |
| HR policies | `docs/HR/*.md` |
| Help architecture | `docs/HELP_ASSISTANT.md` |

---

## Process (every policy or UI release)

Use this checklist **before go-live** whenever finance desks, refunds, HR routes, or RBAC change.

### Step 1 — Identify what changed

- [ ] Read git diff or release notes for `server/auth.js`, finance desk guards, refund handlers, HR routes.
- [ ] List affected **roles**, **routes**, **thresholds**, and **approval chains**.
- [ ] Mark items **P0** (wrong navigation / wrong who-approves) vs **P1** (missing depth) vs **P2** (nice-to-have).

### Step 2 — Update Zare knowledge (code)

- [ ] Edit **`shared/lib/helpKnowledge.js`** — curated articles (IDs stable; extend `steps`, `answer`, `links`).
- [ ] Edit **`helpOperationalCatalog.js`** — 10 phrasings per new topic; fix broken `links[].to`.
- [ ] Copy both files to **frontend** `src/lib/` (same content).
- [ ] If refund categories changed, sync **`refundConstants.js`** (see `frontend/docs/SYNC_FROM_BACKEND.md`).

### Step 3 — Tests

- [ ] Backend: `npm test -- helpKnowledge helpOperationalCatalog helpSynthesize` (from backend root).
- [ ] Frontend: `npm test` if help tests exist.
- [ ] Manual: ask Zare 5 questions from the **Verification script** below; confirm links open correct pages.

### Step 4 — RAG re-index (production)

- [ ] Deploy backend (startup re-indexes `help_rag_chunks` via `helpRagStore.js` when embeddings configured).
- [ ] Or run analytics refresh: Settings → **Zare intelligence** → **Run analytics**.
- [ ] Confirm `GET /api/help/status` shows expected `articleCount`.

### Step 5 — Close the loop

- [ ] Settings → **Zare intelligence** — review top **knowledge gaps** (fallback queries).
- [ ] Add curated articles for top 3 unmatched questions.
- [ ] Note completion date and owner in **Release log** (bottom of this doc).

---

## P0 — Fix now (known stale content)

These are confirmed mismatches between Zare and current system (Phase 10 + HR consolidation).

### P0.1 Finance desk navigation

| Article ID | Issue | Fix |
|------------|-------|-----|
| `refund` | Steps say payout in "Finance → Payments" only | Add: **Cashier** pays at **`/cashier`** (Refund payouts queue); **Accountant** may use **`/accounts`** Payments tab |
| `refund-approval-workflow` | Same — `/accounts` only | Step 3: Cashier → **Cashier desk** → pay approved refund; link `{ to: '/cashier' }` |
| `finance-receipt-clearance` | May omit cashier desk | Add cashier **Confirm payment received** at `/cashier` |
| `record-receipt` | OK for sales posting | Add note: clearance is **not** done in Sales — cashier/finance confirms |

**New curated article to add** (`helpKnowledge.js`):

```javascript
{
  id: 'cashier-desk-workflow',
  title: 'Cashier desk — confirm receipts and pay refunds',
  keywords: ['cashier', 'cashier desk', '/cashier', 'confirm receipt', 'refund payout', 'clearance'],
  answer: 'The Cashier desk is for **execution**: confirm bank deposits on receipts and **pay** approved refunds and payment requests. Cashiers **request** refunds in Sales but **cannot approve** them.',
  steps: [
    'Open **Cashier** from the sidebar (`/cashier`).',
    '**Confirm payment received** — match each pending receipt to bank/cash evidence.',
    '**Pay approved refunds** — only refunds already Approved; enter treasury account and post payout.',
    '**Pay approved payment requests** — expenses and other approved PRs.',
    'If a button is missing, your role may not have finance.pay — escalate to Accountant or MD.',
  ],
  links: [
    { label: 'Cashier desk', to: '/cashier' },
    { label: 'Sales — Refunds', to: '/sales', state: { focusSalesTab: 'refund' } },
  ],
}
```

**New curated article:**

```javascript
{
  id: 'accounting-desk-workflow',
  title: 'Accounting desk — reconciliation and month-end',
  keywords: ['accounting desk', '/accounting', 'accountant', 'reconciliation', 'month end', 'GL'],
  answer: 'The Accounting desk (`/accounting`) is for **Accountant / Head of Accounts**: reconciliation exceptions, AP diagnostics, costing readiness, GL pilot — not day-to-day receipt confirmation (that is Cashier).',
  steps: [
    'Open **Accounting** from the sidebar (`/accounting`).',
    'Review Overview KPIs: recon warnings, treasury drift, AP difference.',
    'Use **Reconciliation** tab for receipt/deposit tie-out and month-end pack.',
    'Branch managers and cashiers are redirected away from this desk by design (Phase 10).',
  ],
  links: [
    { label: 'Accounting desk', to: '/accounting' },
    { label: 'Reports', to: '/reports' },
  ],
}
```

### P0.2 HR route corrections (`helpOperationalCatalog.js`)

Replace broken links (staff consolidated under **Employees** hub):

| Wrong link | Correct link | Notes |
|------------|--------------|-------|
| `/hr/staff` | `/hr/employees` | Directory + register |
| `/hr/recruiting` | `/hr/recruitment` | Recruitment hub |
| `/hr/reports` | `/hr/analytics` | HQ analytics (or `/executive-hr/reports` for MD) |
| `/hr/loans` | `/hr/payroll` | Loans managed in payroll hub |
| `/hr/letters` | `/hr/documents` | Employment letters in documents hub |

Add **Team HR** and **Executive HR** topics (10 phrasings each):

| Topic | Route | Who |
|-------|-------|-----|
| Branch manager endorse leave/loan | `/team-hr/requests` | `sales_manager` |
| MD payroll sign-off | `/executive-hr/approvals` | `md` |
| Executive benefits | `/executive-hr/benefits` | `md` |
| Employee self-service | `/my-profile/leave`, `/my-profile/loans` | all staff |

### P0.3 Role → home dashboard

Add operational FAQ rows (or one curated article `role-dashboard-home`):

| Role | Primary route | Zare should say |
|------|---------------|-----------------|
| `sales_manager` | `/manager` | Branch manager control tower — not main HR |
| `cashier` | `/cashier` | Cashier desk — not Accounting |
| `finance_manager` | `/accounting` | Accounting desk |
| `md` | `/exec` | Executive Command Centre |
| `hr_admin` / `gmhr` | `/hr/dashboard` | HQ HR |
| `sales_staff` | `/` or `/sales` | Workspace / Sales |

Source: `docs/ROLE_DASHBOARD_MATRIX.md`.

---

## P1 — Refund governance (map from `REFUND_OPERATIONS.md`)

Extend article **`refund-headroom-categories`** and **`refund-approval-workflow`**:

| Policy point | Add to Zare |
|--------------|-------------|
| **Request → approve → pay** | Explicit: Sales/cashier **request**; BM/MD/finance.approve **approve**; finance.pay **pays** only |
| **Cashier cannot approve** | Sentence in every refund article + operational FAQ |
| **Receipt clearance gate** | Refunds blocked until all quote receipts **Cleared** — link `finance-receipt-clearance` |
| **MD executive threshold** | Default **₦1,000,000** — Settings → Governance; MD required above threshold |
| **Duplicate category** | Second refund **same category** on same quote rejected; different category allowed |
| **Order cancellation after delivery** | Blocked by design — mention in cancellation FAQ |
| **Multi-category refunds** | Categories are separate entitlements; shared headroom cap |
| **Preview is advisory** | "System-suggested lines are starting points only" — approver checklist |
| **Approver checklist** | Bullets: quote total, sync paid, produced metres, audit flags, evidence |
| **12 categories** | List from `shared/refundConstants.js` `REFUND_REASON_CATEGORY_VALUES` |
| **Staged payouts** | Payout cannot exceed approved balance; partial payouts OK |

**New operational FAQ topics** (10 templates each):

- "Why can't cashier approve refund"
- "Refund blocked receipts not cleared"
- "MD threshold refund"
- "Duplicate refund category same quotation"
- "Order cancellation refund after delivery"

---

## P1 — Payment & treasury (map from payment SOPs)

| Article / topic | Update |
|-----------------|--------|
| `record-receipt` | High-value **≥ ₦100,000** double confirm |
| `duplicate-payment-alert` | Override needs audit reason |
| `receipt-reversal-process` | Reverse → re-post; never overwrite history |
| `finance-receipt-clearance` | Pending → Cleared; link cashier desk |
| New: `payment-request-thresholds` | Office PR: BM ≤ **₦200,000** default; above → MD |

---

## P1 — Phase 10 access restrictions

Add curated article **`phase10-module-access`** (keywords: forbidden, greyed out, can't access accounting):

| Role | Must NOT access (Zare explains why) |
|------|-------------------------------------|
| Branch manager | `/hr`, `/executive-hr`, `/accounting`, broad `/accounts` |
| Cashier | `/accounting`, GL/audit on `/accounts` |
| Accountant | Branch production ops, cashier desk (default) |
| CEO | Customer line screens — exec summary only |
| Staff | `/team-hr` unless granted |

Link: `{ label: 'Staff approvals', to: '/settings/guide' }` if guide exists, else Settings.

---

## P2 — Depth & executive topics

| Topic | Source doc | Zare action |
|-------|------------|-------------|
| Material exceptions / offcuts | `MATERIAL_EXCEPTIONS_SOP.md` | Extend `material-incident-workflow` |
| Month-end close | `MONTH_END_CLOSE.md` | New article + link Accounting desk |
| Payroll lock chain | `HR/HR-POLICY-PAYROLL.md` | Curated: prepare → GM → MD → lock → export |
| Executive Command Centre | `EXEC_COMMAND_CENTRE.md` | New: `/exec` KPIs (read-only for CEO) |
| Delivery payment gate | `ACCESS_CONTROL.md` | New FAQ: `DELIVERY_PAYMENT_GATE` warn/enforce |
| Price list admin | OPERATIONS 6.3 | Link `/price-list`, `/pricing-policy` |
| Custom permission overrides | `ROLE_DASHBOARD_MATRIX.md` | Settings → Team |

---

## Policy → article mapping (maintain this table)

When you edit a policy doc, update the matching Zare row.

| Policy document | Primary Zare articles | Catalog section |
|-----------------|----------------------|-----------------|
| `OPERATIONS_MANUAL.md` | All core workflows | General |
| `REFUND_OPERATIONS.md` | `refund`, `refund-approval-workflow`, `refund-headroom-categories` | Sales / Manager |
| `PAYMENT_POSTING_SOP.md` | `record-receipt`, `finance-receipt-clearance`, `receipt-reversal-process` | Finance |
| `ROLE_DASHBOARD_MATRIX.md` | **NEW** `cashier-desk-workflow`, `accounting-desk-workflow`, `phase10-module-access` | Settings / General |
| `RBAC_FINANCE_DESK.md` | Same desk articles | Finance |
| `STAFF_APPROVALS.md` | `refund-approval-workflow`, `cannot-approve-troubleshoot` | Manager |
| `HR/HR-POLICY-LEAVE.md` | HR leave catalog rows | HR |
| `HR/HR-POLICY-PAYROLL.md` | HR payroll + executive HR rows | HR |
| `ACCESS_CONTROL.md` | `all-branches-view-blocked`, clearance articles | General |

---

## Verification script (manual UAT for Zare)

Ask Zare these questions after each update. Expected behaviour: correct **route links**, correct **role** language, **no** promise to post/approve for user.

| # | Question | Pass criteria |
|---|----------|---------------|
| 1 | How do I pay an approved refund as cashier? | Mentions **`/cashier`**, not approve |
| 2 | Where does the accountant reconcile month-end? | **`/accounting`**, not cashier desk |
| 3 | Who approves customer refunds? | BM/MD/finance.approve — not cashier |
| 4 | Why is my refund blocked? | Receipt clearance and/or headroom |
| 5 | MD threshold for refunds? | Governance ~₦1M executive sign-off |
| 6 | Register new employee in HR | Link **`/hr/employees`** not `/hr/staff` |
| 7 | Branch manager endorse leave | **`/team-hr/requests`** |
| 8 | MD payroll sign-off | **`/executive-hr/approvals`** |
| 9 | Why can't I open Accounting? | Role restriction (cashier/BM) |
| 10 | Record customer receipt | Sales → Payments; clearance separate step |

Log failures in Settings → **Zare intelligence** gaps; add catalog rows within 48h.

---

## Admin: knowledge gap workflow

Weekly (or after major release):

1. [ ] Open **Settings → Zare intelligence** (requires settings/audit permission).
2. [ ] Review **fallback** / low 👍 rate queries (last 30 days).
3. [ ] For each top gap: add curated article **or** 10 operational phrasings.
4. [ ] Review **suggested articles** — approve/reject only; **never auto-publish** (`helpDesignLimits.js`).
5. [ ] SQL (optional):  
   `SELECT query_text, COUNT(*) FROM help_query_log WHERE source='fallback' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`

---

## Naming cleanup (docs vs product)

- [ ] Replace remaining **"Runa"** in internal docs with **"Zare"** where user-facing (`HELP_INTELLIGENCE_PLAN.md`, `helpDesignLimits.js` comments).
- [ ] Keep `HELP_BOT_NAME = 'Zare'` as single product name in UI.

---

## Release log

| Date | Owner | Changes | Verified |
|------|-------|---------|----------|
| 2026-06-07 | Cursor | **P0 done:** Cashier/Accounting desk articles, Phase 10 access + role home, refund/clearance route fixes, HR link corrections, frontend sync | ☑ tests |
| _YYYY-MM-DD_ | | P1 refund governance bullets | ☐ |
| | | P2 payroll / exec HR catalog topics | ☐ |

---

## Quick copy commands (Windows)

After editing backend shared libs:

```powershell
# From Zarewa-backend-main
$be = "C:\Users\USER\OneDrive\Desktop\Zarewa-backend-main\shared\lib"
$fe = "C:\Users\USER\OneDrive\Desktop\Zarewa-frontend-main\src\lib"
Copy-Item "$be\helpKnowledge.js" "$fe\helpKnowledge.js" -Force
Copy-Item "$be\helpOperationalCatalog.js" "$fe\helpOperationalCatalog.js" -Force
```

Then run tests and deploy both apps.

---

*Related: `docs/HELP_ASSISTANT.md`, `docs/ZAREWA_ERP_OPERATIONAL_REPORT.md` Section 9 (page routes).*
