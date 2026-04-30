# Zarewa accounting policies (Phase 0)

This document is the **single reference** for how operational data in Zarewa should be interpreted for management reporting, month-end packs, and (where implemented) general-ledger posting. Finance and operations should use the same vocabulary.

## Revenue (management reporting)

- **Order register / quotation revenue:** Recognise **quotation date** (`quotations.date_iso`). This is the primary “sales booked” view in Reports.
- **Production-attributed revenue:** Allocates each quotation’s total across **all cutting lists for that quotation** by meter share; only lists whose **cutting list date** falls in the period contribute. This is a **management proxy** for value of work released in the period. It is **not** the same as cash collected and may differ from **invoice or delivery** basis used for tax — if those differ in your jurisdiction, keep both definitions and label exports clearly.
- **Official board / tax definition:** Must be chosen and signed off by Finance + MD. Until then, default **operational** reporting uses quotation date for order value and cutting-list allocation for production KPIs.

## Cash vs accounts receivable

- **Cash receipts (customer):** Use **sales receipts** and **treasury movements** tied to customer collections where applicable. The **customer ledger** (`ledger_entries`) is the subledger for types such as `RECEIPT`, `ADVANCE_IN`, `ADVANCE_APPLIED`, `RECEIPT_REVERSAL`, etc.
- **AR / outstanding:** Open quotations are valued using **ledger rules** in `customerLedgerCore` (quotation `paidNgn` vs ledger-attributed payments). “Sales” for P&amp;L (when GL is used) may still be on a different basis than cash.

## Purchases and inventory inflow

- **Goods received:** **GRN / coil receipt date** (`coil_lots.received_at_iso`) drives the **GRN register** and inventory inflow narrative.
- **PO ordered vs received vs paid:** **Ordered** = PO line quantities × agreed prices; **received** = `qty_received` × line price (see procurement reports); **paid** = `supplier_paid_ngn` and treasury — three-way bridge for month-end.
- **Landed cost:** On GRN, the system derives **landed_cost_ngn** and **unit_cost_ngn_per_kg** from PO line pricing (per-kg price preferred when present, else metres × unit price, else received qty × unit price). Legacy lots may have null costs until backfilled.

## Expenses and payables

- **Posted expenses:** **Expense recognition date** = `expenses.date` in expense reports.
- **Payment requests:** **Accrued expense helper** — approved requests with **outstanding unpaid amount** (`amount_requested_ngn` − `paid_amount_ngn`) appear in the accrued payables export for period cut-off; payout is recognised when treasury pays.

## Payroll and GL bridge

- **Payroll journal template:** After a run is **locked** or **paid**, HR Payroll exposes a **GL journal CSV** (Dr salary expense, Cr PAYE, Cr pension, Cr net pay payable) for import or posting into the in-app GL. Account codes in the CSV match seeded `gl_accounts` where applicable.

## General ledger

- **Period:** Journal `period_key` is `YYYY-MM` from `entry_date_iso`. **Period locks** (`accounting_period_locks`) should block back-dating when enforced by control ops.
- **Posting examples:** GRN with landed cost posts **Dr Inventory (raw materials), Cr GRNI** automatically (one entry per coil). Other events may be posted manually via the GL API until further automation is added.

---

*Signed-off policy version should be referenced in internal audit and training materials.*
