# Regression checklist — Accounts & finance (Tracks A–G)

Run after changes to `Account.jsx`, bank reconciliation components, treasury, receipts, payments, GL, or related APIs.

## Treasury & movements

- Create a treasury movement; confirm it appears on **Treasury** and **Movements** tabs.
- Internal transfer between two accounts posts and balances.

## Receipts & daily bank recon

- Open **Receipts & recon**; verify receipt list loads and filters.
- **Daily bank line queue** (`AccountBankReconciliationPanel`): list loads, manual line `POST`, status `PATCH`, export; `ws.refresh()` runs after mutations.

## Payments

- Create or view payment request / expense flow used in your branch; ensure no console errors.

## Audit

- **Audit** tab: checklist renders; **Manual GL journal** posts a balanced two-line entry (with optional cost center); period lock errors surface with readable messages.

## GL & reports

- **Reports** → GL pilot: trial balance loads; optional cost center filter; prior-period column; activity drill-down lines.
- **Reports** → GL audit pack Excel export includes `costCenter` on activity lines when present.

## RBAC smoke

- User without `finance.view` cannot open GL pilot on Reports.
- User without `finance.post` does not see manual journal card on Audit.
