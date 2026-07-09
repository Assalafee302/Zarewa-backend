# Zarewa ERP — Audit & Operations Docs vs Code Alignment Review

**Date:** 2026-07-09
**Docs reviewed:** frontend `docs/SOP/ANNEX-D-COMPLIANCE-AND-AUDIT.md`, `SOP-04-OPERATIONS-STORE.md`; backend `docs/ZAREWA_ERP_OPERATIONAL_REPORT.md`, `docs/OPERATIONS_MANUAL.md`
**Code reviewed:** backend `server/` + `shared/`, frontend `src/`

---

## 1. Relationship between the docs and the software

The SOP set (Annex D, SOP-04) is the *policy layer*: it tells staff and auditors how controls should work. The backend `ZAREWA_ERP_OPERATIONAL_REPORT.md` is a *system description generated from the codebase*, and the code itself is the *enforcement layer*. The three layers are unusually well connected — the SOPs cite real table names (`audit_log`, `coil_control_events`, `work_item_print_snapshots`), real files (`hrBankCrypto.js`), real env flags (`DELIVERY_PAYMENT_GATE`), and real endpoints (`/api/audit/export.ndjson`), and almost all of them exist in code. This is documentation written against the system, not aspiration.

---

## 2. What ALIGNS (verified in code)

| Documented control (Annex D / SOP-04) | Code evidence |
|---|---|
| Audit trail with export for external auditors | `audit_log` + `appendAuditLog` (controlOps.js); **303 distinct audit actions**; `GET /api/audit/export.ndjson` (httpApi.js:9232) |
| Refund segregation: requester ≠ approver, cashier cannot approve | `assertCashierMayNotApproveRefund` (refundHandlers.js) enforced in controlOps.js |
| MD refund gate > ₦1M | `REFUND_MD_APPROVAL_THRESHOLD_NGN = 1_000_000` (shared/workspaceGovernance.js), configurable via `/api/org/governance-limits` |
| Coil control events immutable | Insert-only `coil_control_events`; only UPDATE is linking an incident ID; no deletes. Event kinds match SOP: `head_trim`, `supplier_defect`, `scrap`, `coil.split`, `return_outward`, `return_inward_pool`, `finish_roll` |
| 85 kg tail finish rule | `COIL_TAIL_FINISH_MAX_KG = 85` in code |
| Material incidents: void only, never delete | `status='voided'` + reason, no DELETE statement (materialIncidentOps.js) |
| Period locks | `accounting_period_locks`, `period.lock`/`period.unlock` audit actions, `period.manage` permission (finance_manager) |
| Delivery payment gate off/warn/enforce | `deliveryReleaseGate.js` implements exactly those three modes |
| Governance pack export | `GET /api/reports/governance-pack` CSV |
| Short-receipt MD notification | `notifyMdCoilShortReceipt` (procurementWorkItems.js) wired in writeOps.js GRN path |
| Bank details encrypted at rest | `server/hrBankCrypto.js` exists |
| AP1c revenue recognition to 4000 at production completion | `ap1cProductionRecognition.js` joins GL account `4000` |
| Stock register sign-off with lock + print snapshot | `stockRegisterOps.js` full workflow ending in `locked` |
| Report catalog | receipts-register, revenue-production, refunds-pack, coil-snapshot-capture, md-operations-pack etc. all present in httpApi.js |

**Conclusion:** the three-layer control model (preventive / detective / corrective) described in Annex D genuinely exists in the software.

---

## 3. What does NOT align (findings)

### F1 — Audit export is not "admin only" (HIGH)
Annex D §D.5.4: export is "admin only". Code gates it on `requirePermission('audit.view')` — and `audit.view` is held by **md, finance_manager and cashier** role bundles (auth.js). A cashier can download the entire audit log. Fix either the doc or (better) the gate — restrict export to admin, or strip `audit.view` from cashier.

### F2 — Cashier role bundle breaks the documented SoD matrix (HIGH)
Annex D §D.2 says expense payments are approved by BM/MD and only *executed* by cashier. But the cashier role in auth.js carries `finance.approve`, `finance.reverse`, `treasury.manage`, `audit.view` — commented as "legacy finance perms retained for compatibility until B3". Refunds have a dedicated guard; expenses/payment requests do not appear to. Until Phase B3 lands, the real permission surface is wider than the SOP claims. Auditors testing against Annex D would flag this.

### F3 — Annex D daily review procedure references audit events that don't exist (MEDIUM)
§D.5.1 tells IT Admin to query `audit_log` for four events:
- `login.failed` — **not written to audit_log**. Failed logins only increment `failed_login_count`/lockout on `app_users`. The daily brute-force review as written cannot be run.
- `permission.override` — action doesn't exist; the real action is `user.update_permissions` (plus `/api/admin/permission-overrides-audit` report).
- `admin.data_reset` — exists ✓
- `refund.dual_control.admin_trial` — exists ✓

Fix: either emit `login.failed` audit rows, or rewrite D.5.1 to reference the lockout columns and the real action names.

### F4 — Key preventive controls are OFF by default (MEDIUM)
`.env.example`: `ENFORCE_DUAL_CONTROL_PAYMENTS=0`, `DELIVERY_PAYMENT_GATE=0`. Annex D presents dual control and the delivery gate as live controls; in a default deployment both are inert. Verify the production `.env` actually sets them, and state the required production values in Annex C/D.

### F5 — Stock register workflow: docs show 4 stages, code has more (LOW)
SOP-04 §8 documents store_confirmed → bm_approved → md_approved → locked. `stockRegisterOps.js` inserts **`procurement_costed`** between BM and MD (plus draft/printed states). The doc understates the real workflow; update the SOP table.

### F6 — Terminology drift (LOW)
- SOP-04 calls coil events "CREV"; the human-ID prefix in code is **`CCR`** (humanId.js:219).
- Delivery gate has an extra undocumented flag `DELIVERY_PAYMENT_GATE_STRICT_FINANCE`.

---

## 4. What we learn about the ERP's audit/operations/reporting design

1. **Reverse, don't overwrite.** Ledger reversals, receipt reversals, material-incident voids, coil events — nothing financial is deleted. This is the system's strongest audit property.
2. **Controls are layered:** permission gates (auth.js role bundles) → route guards (requirePermission, finance desk guards) → domain guards (cashier-refund assert, delivery gate, period locks) → detective reporting (governance pack, exception queues, 303 audit actions).
3. **Reporting is the reconciliation spine:** month-end depends on the stock register lock + coil snapshot + report packs; the SOPs correctly route staff to them.
4. **The residual risk is configuration, not code:** the biggest doc/code gaps (F1, F2, F4) are all about permissions and env flags, not missing features. A quarterly "SOP vs auth.js vs .env" reconciliation would close this class of drift.

---

## 5. Recommended actions (priority order)

1. Restrict `/api/audit/export.ndjson` to admin (or a dedicated `audit.export` perm); remove `audit.view` from cashier.
2. Complete the Phase B3 cashier permission cleanup, or add expense/payment-request guards equivalent to the refund guard.
3. Emit `login.failed` (and align `permission.override` naming) so Annex D §D.5.1 is executable as written.
4. Confirm production env sets `DELIVERY_PAYMENT_GATE=enforce` (or warn) and `ENFORCE_DUAL_CONTROL_PAYMENTS=1`; document required values.
5. Update SOP-04 §8 with the `procurement_costed` stage and CCR prefix.
