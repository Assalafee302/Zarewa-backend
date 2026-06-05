# Accounting Policy v1 — AP1c (Receipt & production GL)

**Status:** AP1c-0 dry-run live; **AP1c-1** = receipt GL metadata tagging (no GL amount/account changes).

## AP1c-1 — Receipt GL metadata (`gl_receipt_policy_meta`)

Each `CUSTOMER_RECEIPT_GL` journal can have one metadata row recording:

| Field | Purpose |
|-------|---------|
| `policy_basis` | `legacy_ar_at_receipt`, `policy_v1_deposit_before_production`, `policy_v1_ar_after_production`, `unknown` |
| `credited_account_code` | Actual Cr account from journal lines (`1200` or `2500`) |
| `production_completed_at_receipt` | Inferred from quotation production completion vs receipt date |
| `quotation_ref`, `ledger_entry_id`, `receipt_id` | Links for reversal and dry-run |

- Boot migration creates the table and **backfills** existing receipt journals (no line changes).
- `tryPostCustomerReceiptGl` writes metadata after each post (GL lines unchanged: still Cr **1200**).
- Dry-run prefers metadata; falls back to journal-line inference when missing.
- Health: `accountingPolicyV1Ap1cMetadata: enabled`.

Management-approved customer GL timing under Policy v1. AP1a (labels/diagnostics) and AP1b (delivery payment gate warn/enforce) are already live without changing receipt or production journals.

## Journal rules (target state — AP1c-1+)

### Customer receipts (treasury posted)

| Timing | Debit | Credit | Basis |
|--------|-------|--------|--------|
| Payment **before** production completion | 1000 Cash | **2500** Customer deposits / unearned revenue | Deposit on account |
| Payment **after** production completion | 1000 Cash | **1200** Accounts receivable | Reduces post-production receivable |

Reversals must mirror the original credit account (2500 vs 1200) once AP1c-4 is enabled.

### Production completion recognition

When a production job completes (metres-based earn, capped at quotation total):

1. **Release deposits** — Dr **2500**, amount = `min(earnedNgn, policyDepositsNgn + advanceAppliedNgn)` where `policyDepositsNgn` is cash attributed to the quote that should sit in 2500 under Policy v1.
2. **Recognize revenue** — Cr **4000** for full `earnedNgn`.
3. **Post-production AR** — Dr **1200** only for `arPart = max(0, earnedNgn − release2500Ngn − legacyBridgeNgn)`.

**Current production GL (pre-AP1c):** releases only `ADVANCE_APPLIED` from 2500; `arPart = earned − min(earned, advanceApplied)`. Receipts that credited **1200** before production are not bridged — risk of AR overstatement at production.

## Legacy bridge

Receipts posted **before AP1c** that credited **1200** while production was **not** complete:

- Under Policy v1 they should have credited **2500**.
- At production, that amount must **not** create a second Dr **1200** (legacy bridge reduces `arPart`).
- AP1c-0 **does not** reclassify historical journals. Bridge amounts appear in dry-run only.

## Dry-run before enablement (AP1c-0)

- `GET /api/finance/ap1c-dry-run` — read-only aggregates and capped samples (no customer names).
- Simulators in `shared/lib/ap1cSimulator.js` — pure functions, no DB writes.
- Enable posting only after **Head of Accounts** and **MD** review dry-run summary.

**AP1c-0 explicitly excludes:**

- Changes to `tryPostCustomerReceiptGl`, `tryPostProductionRecognitionGlTx`, or receipt reversal posting.
- Reclassification journals (`RECLASS_PRE_PRODUCTION_RECEIPTS` stays off).
- Delivery enforcement changes.

## Feature flags (all default `0`)

| Variable | Phase | Effect |
|----------|-------|--------|
| `ACCOUNTING_POLICY_V1_RECEIPT_GL` | AP1c-2 | Status-dependent receipt Cr 2500 / 1200 |
| `ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE` | AP1c-3 | Full deposit release at production |
| `ACCOUNTING_POLICY_V1_LEGACY_BRIDGE` | AP1c-3 | Reduce production Dr 1200 for legacy pre-prod receipts |
| `RECLASS_PRE_PRODUCTION_RECEIPTS` | AP1c-5+ | Optional one-off reclass (not AP1c-0) |
| `ACCOUNTING_POLICY_V1_DIAGNOSTICS` | AP1a | UI + trial-exceptions AP1c summary |

Health: `accountingPolicyV1Ap1c: "dry-run-v1"` when AP1c-0 module is deployed.

## Sign-off

Before enabling `ACCOUNTING_POLICY_V1_RECEIPT_GL` or `ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE` on production:

1. Head of Accounts reviews dry-run counts and samples.
2. MD confirms trial impact and rollback plan.
3. Document exceptions (quotes with mixed legacy/new receipts).

## Remaining phases

| Phase | Scope |
|-------|--------|
| AP1c-0 | Dry-run diagnostics (this document) |
| AP1c-1 | Receipt policy metadata for reversals |
| AP1c-2 | Receipt GL by production status |
| AP1c-3 | Production release + legacy bridge posting |
| AP1c-4 | Reversal account selection from metadata |
| AP1c-5/6 | Reports, optional reclass |

See `docs/ACCOUNTING_POLICY_V1.md` for revenue timing and delivery gate.
