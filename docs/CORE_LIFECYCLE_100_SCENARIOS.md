# Core Lifecycle 100 — Master Test Matrix

**100 interconnected scenarios** linking **Quotation → Payment → Cutting List → Production → Stock → Refund** as one chain (`LC100-001` … `LC100-100`).

Source of truth: `shared/lib/coreLifecycle100Matrix.js`

## Lifecycle chain

```mermaid
flowchart LR
  Q[Quotation LC100-001–020] --> P[Payment LC100-021–035]
  P --> CL[Cutting List LC100-036–050]
  CL --> PR[Production LC100-051–065]
  PR --> ST[Stock LC100-066–075]
  ST --> RF[Refund LC100-076–085]
  RF --> SEC[Security LC100-086–095]
  SEC --> CR[Crash LC100-096–100]
```

Each scenario has `prevId` / `nextId` forming a **single linked chain** from customer create to master integrity check.

## Scenario breakdown

| Range | Module focus | Type | Count |
|-------|-------------|------|-------|
| LC100-001–010 | Smoke golden paths | smoke / e2e | 10 |
| LC100-011–020 | Quotation lifecycle | integration | 10 |
| LC100-021–035 | Payment & ledger | financial / fraud | 15 |
| LC100-036–050 | Cutting list | integration / crash | 15 |
| LC100-051–065 | Production | integration / inventory | 15 |
| LC100-066–075 | Stock / inventory | inventory / e2e | 10 |
| LC100-076–085 | Refunds | financial / fraud | 10 |
| LC100-086–095 | Fraud & security | fraud | 10 |
| LC100-096–100 | Crash & master chain | crash / e2e | 5 |

## Risk coverage

| Risk tag | What it finds | Example scenarios |
|----------|---------------|-------------------|
| `fraud` | Duplicate refunds, self-approval, over-refund | LC100-078, LC100-081, LC100-095 |
| `hack` | Auth bypass, CSRF, RBAC holes | LC100-086, LC100-087, LC100-094 |
| `financial_failure` | Ledger drift, underpay, period lock | LC100-021, LC100-028, LC100-076 |
| `inventory_gap` | Coil reservation, GRN mismatch, WIP | LC100-057, LC100-069, LC100-070 |
| `dual_control` | Same person request+approve+pay | LC100-082, LC100-081 |
| `branch_scope` | Cross-branch data leak | LC100-074, LC100-090 |

## How to run

### Fast (API only, ~2 min, SQLite in-memory)

```powershell
cd Zarewa-backend-main
npm run test:lifecycle100
```

Runs `server/coreLifecycle100.test.js` — chain validation + 8 inline fraud/gate guards.

### Full API suite (~15–30 min)

```powershell
npm run test:lifecycle100:full
```

Adds: transactional scenarios (20), refund security, inventory scenarios, 114-scenario stress matrix.

### With E2E UI smoke (needs MySQL + frontend)

```powershell
$env:ZAREWA_FRONTEND_ROOT="C:\Users\USER\OneDrive\Desktop\Zarewa-frontend-main"
npm run test:e2e -- e2e/core-lifecycle100-smoke.spec.js
```

Or combined:

```powershell
npm run test:lifecycle100:all
```

### Finance stress (live server, 100 scenarios)

```powershell
npm run server
npm run stress:finance100
```

## Test file mapping

| Suite | File | Scenarios covered |
|-------|------|-------------------|
| Master inline guards | `server/coreLifecycle100.test.js` | LC100-028, 036, 042, 054, 086, 088, 090, 100 |
| Transactional | `server/transactionalScenarios.test.js` | TX-01–20 |
| Scenario matrix | `server/scenarioMatrix.test.js` | SCN-001–114 + VAL + HARSH |
| Refund security | `server/refundSecurity.test.js` | LC100-076–082, 089 |
| Inventory | `server/inventoryScenarios.test.js` | LC100-057, 066–072 |
| E2E smoke | `e2e/core-lifecycle100-smoke.spec.js` | LC100-010, 048, 064, 084, 099 |
| E2E full gate | `e2e/complete-gate.spec.js` | LC100-099 |
| E2E refund | `e2e/sales-refund-finance-checklist.spec.js` | LC100-084 |

## Full scenario index

| ID | Title | Modules | Type | Risks |
|----|-------|---------|------|-------|
| LC100-001 | Customer create → quotation Pending | quotation | smoke | — |
| LC100-002 | Quotation totals for new customer | quotation | smoke | — |
| LC100-003 | Full receipt clears balance | quotation, payment | smoke | financial_failure |
| LC100-004 | Cutting list from paid quote | quotation, payment, cutting_list | smoke | inventory_gap |
| LC100-005 | Small flatsheet 10m cutting list | quotation, cutting_list | smoke | — |
| LC100-006 | Split tender receipt | payment | smoke | financial_failure |
| LC100-007 | Advance deposit then apply | payment, quotation | smoke | financial_failure |
| LC100-008 | Quote → pay → cut → production | quotation, payment, cutting_list, production | smoke | — |
| LC100-009 | Overpay → cut → prod → refund | all core | smoke | financial_failure, dual_control |
| LC100-010 | E2E module navigation | all | e2e | — |
| LC100-011 | Quotation expiry 10 days | quotation | integration | financial_failure |
| LC100-012 | Payment blocks expiry | quotation, payment | integration | — |
| LC100-013 | Revive expired quote | quotation | integration | — |
| LC100-014 | Void quotation | quotation | integration | — |
| LC100-015 | MD price exception | quotation | integration | fraud, financial_failure |
| LC100-016 | Quotation recalc | quotation | integration | financial_failure |
| LC100-017 | Refunds blocked flag | quotation, refund | integration | fraud, dual_control |
| LC100-018 | Staff purchase credit | quotation, payment | integration | fraud |
| LC100-019 | Credit exception delivery | quotation, payment, delivery | integration | financial_failure |
| LC100-020 | Payment integrity sync | quotation, payment | integration | financial_failure |
| LC100-021 | Underpayment outstanding | payment, quotation | financial | financial_failure |
| LC100-022 | 99.5% tolerance = Paid | payment, quotation | financial | financial_failure |
| LC100-023 | Overpay advance pool | payment | financial | financial_failure |
| LC100-024 | Auto overpay apply | payment, quotation | financial | financial_failure |
| LC100-025 | Receipt reversal | payment, quotation | financial | financial_failure, dual_control |
| LC100-026 | Advance reversal | payment | financial | financial_failure |
| LC100-027 | Duplicate receipt guard | payment | fraud | fraud, financial_failure |
| LC100-028 | Period lock blocks receipt | payment | fraud | fraud, financial_failure |
| LC100-029 | Delivery payment gate | payment, delivery | financial | financial_failure |
| LC100-030 | Cashier clearance workflow | payment | integration | dual_control |
| LC100-031 | Split 2 treasury accounts | payment | integration | financial_failure |
| LC100-032 | Returning customer overpay | payment, quotation | integration | financial_failure |
| LC100-033 | Returning customer underpay | payment, quotation | integration | financial_failure |
| LC100-034 | Advance partial apply | payment, quotation | integration | financial_failure |
| LC100-035 | FIN100 stress batch | payment, refund | crash | financial_failure |
| LC100-036 | 70% gate blocks cutting list | cutting_list, payment | financial | fraud, financial_failure |
| LC100-037 | Metre alignment with quote | cutting_list, quotation | integration | inventory_gap |
| LC100-038 | One cutting list per quote | cutting_list, quotation | integration | fraud |
| LC100-039 | Register production links job | cutting_list, production | integration | — |
| LC100-040 | Cutting list print audit | cutting_list | integration | — |
| LC100-041 | Blank consumption reconciliation | cutting_list, refund | inventory | inventory_gap |
| LC100-042 | Refund blocks production | cutting_list, production, refund | fraud | fraud, dual_control |
| LC100-043 | Post-prod edit approval | cutting_list, production | fraud | fraud, dual_control |
| LC100-044 | Zero-pay needs MD approval | cutting_list, production, payment | fraud | fraud |
| LC100-045 | 1245.4m / 50 lengths | cutting_list | crash | inventory_gap |
| LC100-046 | Randomized cutting lists | cutting_list, production | crash | inventory_gap |
| LC100-047 | 27 micro lines 3.33m | cutting_list | crash | inventory_gap |
| LC100-048 | Material readiness UI | cutting_list, stock | e2e | inventory_gap |
| LC100-049 | Clear production hold | cutting_list, production | integration | — |
| LC100-050 | Status Draft → In production | cutting_list, production | integration | — |
| LC100-051 | Job Planned → Completed | production | smoke | — |
| LC100-052 | Multi-coil allocation | production, stock | integration | inventory_gap |
| LC100-053 | One coil two jobs | production, stock | inventory | inventory_gap |
| LC100-054 | Start blocked no coil | production, stock | fraud | fraud, inventory_gap |
| LC100-055 | Coil reservation integrity | production, stock | inventory | inventory_gap |
| LC100-056 | Conversion alert sign-off | production | integration | dual_control |
| LC100-057 | Complete draws coil kg | production, stock | inventory | inventory_gap |
| LC100-058 | Accessory usage | production, stock | inventory | inventory_gap |
| LC100-059 | Stone flatsheet usage | production, stock | inventory | inventory_gap |
| LC100-060 | Cancel → refund eligibility | production, refund | integration | — |
| LC100-061 | Completion adjustment | production | integration | dual_control |
| LC100-062 | Recalculate stock | production, stock | inventory | inventory_gap |
| LC100-063 | Offcut pool issue | production, stock | inventory | inventory_gap |
| LC100-064 | E2E production register | production, cutting_list | e2e | — |
| LC100-065 | Material incident → refund | production, stock, refund | integration | financial_failure |
| LC100-066 | GRN coil + stock up | stock | smoke | inventory_gap |
| LC100-067 | GRN over-delivery | stock | integration | inventory_gap |
| LC100-068 | Coil split kg unchanged | stock | inventory | inventory_gap |
| LC100-069 | Reserved blocks over-split | stock, production | fraud | fraud, inventory_gap |
| LC100-070 | WIP + FG receipt | stock, production | inventory | inventory_gap |
| LC100-071 | Stone PO + GRN | stock | integration | inventory_gap |
| LC100-072 | Accessory PO + GRN | stock | integration | inventory_gap |
| LC100-073 | Manual stock adjustment | stock | integration | fraud |
| LC100-074 | Branch inventory isolation | stock | fraud | branch_scope |
| LC100-075 | Month-end stock register | stock | e2e | dual_control |
| LC100-076 | Overpayment refund preview | refund, payment | financial | financial_failure |
| LC100-077 | Unproduced metre preview | refund, production | financial | financial_failure |
| LC100-078 | Duplicate refund blocked | refund | fraud | fraud |
| LC100-079 | Line exceeds category max | refund | fraud | fraud |
| LC100-080 | Amount ≠ lines sum | refund | fraud | fraud |
| LC100-081 | Self-approval blocked | refund | fraud | dual_control |
| LC100-082 | Approver cannot pay | refund, payment | fraud | dual_control |
| LC100-083 | Intelligence data quality | refund, production | integration | financial_failure |
| LC100-084 | E2E refund full chain | refund, payment | e2e | dual_control |
| LC100-085 | Production alignment warnings | refund, production | integration | financial_failure |
| LC100-086 | Unauthenticated → 401 | auth | fraud | hack |
| LC100-087 | CSRF on ledger POST | auth, payment | fraud | hack |
| LC100-088 | Sales cannot pay refund | auth, refund | fraud | hack |
| LC100-089 | Cashier cannot approve | auth, refund | fraud | hack |
| LC100-090 | Cross-branch bulk blocked | auth, quotation | fraud | branch_scope |
| LC100-091 | Ledger rate limit | auth, payment | fraud | hack |
| LC100-092 | Idempotency key | payment | fraud | fraud |
| LC100-093 | Login lockout | auth | fraud | hack |
| LC100-094 | Procurement no finance | auth, payment | fraud | hack |
| LC100-095 | Refund hard cap | refund, payment | fraud | financial_failure |
| LC100-096 | 114-scenario matrix stress | all core | crash | — |
| LC100-097 | Four-way treasury split | payment | crash | financial_failure |
| LC100-098 | Concurrent load test | payment, quotation | crash | — |
| LC100-099 | Complete SOP gate E2E | all core | e2e | dual_control |
| LC100-100 | Master chain integrity | all core | integration | — |

## Relationship diagram (data model)

```
customers
  └── quotations (customer_id)
        ├── ledger_entries / sales_receipts  ← LC100-021–035
        ├── cutting_lists                    ← LC100-036–050
        │     └── production_jobs            ← LC100-051–065
        │           ├── production_job_coils → coil_lots  ← LC100-066–075
        │           └── accessory/stone usage → products
        ├── deliveries                       ← LC100-029
        └── customer_refunds                 ← LC100-076–095
```

## Existing coverage you already had

Before this matrix, Zarewa already had **114 API scenarios** (`scenarioMatrix.test.js`), **20 transactional tests**, **100 finance stress scripts**, and **Playwright E2E packs**. LC100 unifies them into one numbered chain with explicit fraud/financial/inventory risk tags.
