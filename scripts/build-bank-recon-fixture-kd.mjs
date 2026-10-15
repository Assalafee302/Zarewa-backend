#!/usr/bin/env node
/**
 * Build the Kaduna Sep 2026 bank-reconciliation fixture from the frontend sales/expenses fixtures
 * (both cut from the ERP export `zarewa-entered-data (8).xlsx`). No database access.
 *
 *   node scripts/build-bank-recon-fixture-kd.mjs [frontendRoot]
 */
import fs from 'node:fs';
import path from 'node:path';

const fe = process.argv[2] || path.resolve(process.cwd(), '../Zarewa-frontend-main');
const dir = path.join(fe, 'src/lib/__fixtures__/kd-2026-09');
const sales = JSON.parse(fs.readFileSync(path.join(dir, 'salesReportSource.json'), 'utf8'));
const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expensesReportSource.json'), 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? '']));
const out = {
  _meta: { source: 'zarewa-entered-data (8).xlsx via frontend kd-2026-09 fixtures', branch: 'BR-KD' },
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  accounts: sales.treasuryAccounts.map((a) => pick(a, ['id', 'name', 'bankName', 'type', 'accNo'])),
  treasuryMovements: sales.treasuryMovements.map((t) =>
    pick(t, ['id', 'postedAtISO', 'type', 'treasuryAccountId', 'amountNgn', 'reference', 'counterpartyName', 'sourceKind', 'sourceId'])
  ),
  bankLines: sales.bankRecon.map((b) => pick(b, ['id', 'bankDateISO', 'description', 'amountNgn', 'status', 'systemMatch', 'treasuryAccountId'])),
  expenses: (exp.expenses || []).map((e) => pick(e, ['expenseID', 'category'])),
};
const target = path.join(process.cwd(), 'shared/lib/__fixtures__/kd-2026-09/bankReconSource.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log(target, out.accounts.length, out.treasuryMovements.length, out.bankLines.length, out.expenses.length);

// Refund report fixture: refunds only (treasury + bank lines come from bankReconSource.json).
const refundsOut = {
  _meta: out._meta,
  startDate: out.startDate,
  endDate: out.endDate,
  refunds: sales.refunds.map((r) =>
    pick(r, ['refundID', 'customerID', 'customer', 'quotationRef', 'reasonCategory', 'amountNgn', 'status', 'requestedAtISO', 'approvedAmountNgn', 'paidAmountNgn', 'paidAtISO', 'creditAppliedNgn'])
  ),
};
const refundTarget = path.join(process.cwd(), 'shared/lib/__fixtures__/kd-2026-09/refundReportSource.json');
fs.writeFileSync(refundTarget, JSON.stringify(refundsOut));
console.log(refundTarget, refundsOut.refunds.length);
