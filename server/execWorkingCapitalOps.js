/**
 * Estimated working capital snapshot for executive dashboard (not statutory; not withdrawable cash).
 */
import { effectiveOutstandingNgn } from '../shared/lib/paymentOutstandingTolerance.js';
import {
  branchWhere,
  listAccountsPayable,
  listPaymentRequests,
  listRefunds,
  listTreasuryAccounts,
  procurementPayablesAging,
} from './readModel.js';

function pendingRefundStatuses() {
  return ['pending', 'submitted', 'awaiting approval'];
}

function isPendingRefundStatus(st) {
  return pendingRefundStatuses().includes(String(st || '').trim().toLowerCase());
}

function isApprovedPaymentRequest(st) {
  return String(st || '').trim().toLowerCase() === 'approved';
}

/**
 * @param {object[]} purchaseOrders
 */
function poCommitmentGapNgn(purchaseOrders) {
  let payables = 0;
  for (const po of purchaseOrders || []) {
    const st = String(po.status || '').toLowerCase();
    if (['cancelled', 'canceled'].includes(st)) continue;
    for (const line of po.lines || []) {
      const ordered =
        (Number(line.qtyOrdered) || 0) *
        (Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0);
      const received =
        (Number(line.qtyReceived) || 0) *
        (Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0);
      payables += Math.max(0, ordered - received);
    }
  }
  return Math.round(payables);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 */
function sumPayrollLiabilityNgn(db, branchScope) {
  try {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_payroll_runs'`).get()) {
      return { amountNgn: null, available: false, note: 'HR payroll tables not available' };
    }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(l.net_ngn), 0) AS c
         FROM hr_payroll_lines l
         INNER JOIN hr_payroll_runs r ON r.id = l.run_id
         WHERE LOWER(TRIM(IFNULL(r.status,''))) IN ('draft','approved','locked')`
      )
      .get();
    return {
      amountNgn: Math.round(Number(row?.c) || 0),
      available: true,
      estimated: true,
      scopeBasis: 'company',
      note: 'Sum of net pay on draft/approved/locked payroll runs (estimated liability).',
    };
  } catch {
    return { amountNgn: null, available: false, note: 'Payroll liability could not be calculated' };
  }
}

/**
 * @param {object} line
 */
function wcLine(line) {
  return {
    id: line.id,
    label: line.label,
    amountNgn: line.amountNgn,
    available: line.available !== false,
    estimated: Boolean(line.estimated),
    scopeBasis: line.scopeBasis || 'branch',
    isCountOnly: Boolean(line.isCountOnly),
    note: line.note || null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{
 *   cashNgn: number;
 *   receivablesNgn: number;
 *   inventoryValueNgn: number;
 *   purchaseOrders?: object[];
 *   pendingOutflowsNgn?: number;
 * }} ctx
 */
export function buildWorkingCapitalSnapshot(db, branchScope, ctx = {}) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  const isAll = scope === 'ALL';

  const treasuryAccounts = listTreasuryAccounts(db, scope);
  const cashNgn = Math.round(
    ctx.cashNgn != null ? Number(ctx.cashNgn) : treasuryAccounts.reduce((s, a) => s + (Number(a.balance) || 0), 0)
  );

  const receivablesNgn = Math.round(Number(ctx.receivablesNgn) || 0);
  const inventoryNgn = Math.round(Number(ctx.inventoryValueNgn) || 0);

  /** @type {object[]} */
  const currentAssets = [
    wcLine({
      id: 'cash',
      label: 'Cash / bank position',
      amountNgn: cashNgn,
      estimated: false,
      scopeBasis: isAll ? 'company' : 'branch',
      note: 'Treasury account balances.',
    }),
    wcLine({
      id: 'receivables',
      label: 'Customer receivables',
      amountNgn: receivablesNgn,
      estimated: false,
      scopeBasis: isAll ? 'company' : 'branch',
      note: 'Outstanding per customer ledger rules (point-in-time).',
    }),
    wcLine({
      id: 'inventory',
      label: 'Estimated inventory value',
      amountNgn: inventoryNgn,
      estimated: true,
      scopeBasis: isAll ? 'company' : 'branch',
      note: 'Coil on hand at landed/unit cost where available.',
    }),
  ];

  let apOutstanding = 0;
  let apAvailable = true;
  try {
    const aps = listAccountsPayable(db, scope);
    apOutstanding = aps.reduce(
      (s, ap) =>
        s + effectiveOutstandingNgn(Number(ap.amountNgn) || 0, Number(ap.paidNgn) || 0),
      0
    );
  } catch {
    apAvailable = false;
  }

  let approvedUnpaidPr = 0;
  try {
    for (const pr of listPaymentRequests(db, scope)) {
      if (!isApprovedPaymentRequest(pr.approvalStatus)) continue;
      const req = Number(pr.amountRequestedNgn) || 0;
      const paid = Number(pr.paidAmountNgn) || 0;
      approvedUnpaidPr += Math.max(0, req - paid);
    }
  } catch {
    approvedUnpaidPr = 0;
  }

  let pendingRefundsNgn = null;
  let pendingRefundsCount = 0;
  let refundsAmountAvailable = true;
  try {
    let sum = 0;
    for (const rf of listRefunds(db, scope)) {
      if (!isPendingRefundStatus(rf.status)) continue;
      pendingRefundsCount += 1;
      const amt =
        Number(rf.approvedAmountNgn) > 0
          ? Number(rf.approvedAmountNgn)
          : Number(rf.amountNgn) || 0;
      sum += Math.max(0, amt);
    }
    pendingRefundsNgn = Math.round(sum);
  } catch {
    refundsAmountAvailable = false;
  }

  const payrollLiab = sumPayrollLiabilityNgn(db, scope);

  const poGap = poCommitmentGapNgn(ctx.purchaseOrders || []);
  const knownOutflows = Math.round(Number(ctx.pendingOutflowsNgn) || 0);

  /** @type {object[]} */
  const currentLiabilities = [
    wcLine({
      id: 'ap',
      label: 'Supplier payables (AP outstanding)',
      amountNgn: apAvailable ? Math.round(apOutstanding) : null,
      available: apAvailable,
      estimated: false,
      scopeBasis: isAll ? 'company' : 'branch',
      note: apAvailable ? 'Accounts payable table.' : 'AP data unavailable.',
    }),
    wcLine({
      id: 'approved_pr',
      label: 'Approved unpaid payment requests',
      amountNgn: Math.round(approvedUnpaidPr),
      available: true,
      estimated: false,
      scopeBasis: isAll ? 'company' : 'branch',
    }),
    wcLine({
      id: 'pending_refunds',
      label: refundsAmountAvailable ? 'Pending refunds (requested)' : 'Pending refunds (count)',
      amountNgn: refundsAmountAvailable ? pendingRefundsNgn : pendingRefundsCount,
      available: true,
      estimated: !refundsAmountAvailable,
      isCountOnly: !refundsAmountAvailable,
      scopeBasis: isAll ? 'company' : 'branch',
      note: refundsAmountAvailable
        ? 'Pending/submitted refund requests.'
        : 'Amount unavailable — showing count only.',
    }),
    wcLine({
      id: 'payroll_liability',
      label: 'Payroll liability (draft/approved runs)',
      amountNgn: payrollLiab.amountNgn,
      available: payrollLiab.available,
      estimated: true,
      scopeBasis: payrollLiab.scopeBasis || 'company',
      note: payrollLiab.note,
    }),
    wcLine({
      id: 'known_outflows',
      label: 'Known outflows (BI pending-outflows proxy)',
      amountNgn: knownOutflows,
      available: knownOutflows > 0,
      estimated: true,
      scopeBasis: isAll ? 'company' : 'branch',
      note: 'Includes approved unpaid PR and PO commitment elements used in cash BI.',
    }),
  ];

  const assetTotal = currentAssets
    .filter((l) => l.available && l.amountNgn != null && !l.isCountOnly)
    .reduce((s, l) => s + (Number(l.amountNgn) || 0), 0);

  const liabilityTotal = currentLiabilities
    .filter((l) => l.available && l.amountNgn != null && !l.isCountOnly)
    .reduce((s, l) => s + (Number(l.amountNgn) || 0), 0);

  const estimatedWorkingCapitalNgn = Math.round(assetTotal - liabilityTotal);
  const ratio =
    liabilityTotal > 0 ? Math.round((assetTotal / liabilityTotal) * 1000) / 1000 : null;

  return {
    label: 'Estimated working capital snapshot',
    notStatutoryAccounts: true,
    notWithdrawableCash: true,
    currentAssets,
    currentLiabilities,
    assetTotalNgn: Math.round(assetTotal),
    liabilityTotalNgn: Math.round(liabilityTotal),
    estimatedWorkingCapitalNgn,
    ratio,
    notes: [
      'Working capital is not the same as free cash.',
      'Not statutory accounts.',
      'Inventory shown at estimated landed/unit cost.',
      'Receivables shown per customer ledger rules.',
      'Do not treat this snapshot as withdrawable cash or safe withdrawal capacity.',
    ],
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ purchaseOrders?: object[]; pendingOutflowsNgn?: number }} ctx
 */
export function buildPayablesOutflowsSummary(db, branchScope, ctx = {}) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  let apOutstanding = 0;
  let aging = null;
  try {
    const aps = listAccountsPayable(db, scope);
    apOutstanding = aps.reduce(
      (s, ap) =>
        s + effectiveOutstandingNgn(Number(ap.amountNgn) || 0, Number(ap.paidNgn) || 0),
      0
    );
    const agingRes = procurementPayablesAging(db, scope);
    if (agingRes?.ok) aging = agingRes.buckets;
  } catch {
    /* optional */
  }

  let approvedUnpaidPr = 0;
  let pendingPrCount = 0;
  try {
    for (const pr of listPaymentRequests(db, scope)) {
      const st = String(pr.approvalStatus || '').trim().toLowerCase();
      if (st === 'approved') {
        const req = Number(pr.amountRequestedNgn) || 0;
        const paid = Number(pr.paidAmountNgn) || 0;
        approvedUnpaidPr += Math.max(0, req - paid);
      }
      if (['pending', 'submitted', 'awaiting approval', ''].includes(st)) pendingPrCount += 1;
    }
  } catch {
    /* optional */
  }

  const poCommitmentGap = poCommitmentGapNgn(ctx.purchaseOrders || []);

  /** @type {string[]} */
  const pressureNotes = [];
  if (apOutstanding > 5_000_000) {
    pressureNotes.push('Supplier AP outstanding is elevated — align payment schedule with treasury.');
  }
  if (approvedUnpaidPr > 3_000_000) {
    pressureNotes.push('Approved payment requests await treasury payout.');
  }
  if (poCommitmentGap > 2_000_000) {
    pressureNotes.push('Open PO commitment gap is a procurement proxy, not booked AP.');
  }

  return {
    label: 'Payables & outflows',
    apOutstandingNgn: Math.round(apOutstanding),
    apAging: aging,
    approvedUnpaidPaymentRequestsNgn: Math.round(approvedUnpaidPr),
    pendingPaymentRequestsCount: pendingPrCount,
    poCommitmentGapNgn: poCommitmentGap,
    poCommitmentLabel: 'Commitment proxy (ordered − received on PO lines)',
    pendingOutflowsNgn: Math.round(Number(ctx.pendingOutflowsNgn) || 0),
    pressureNotes,
    estimated: true,
  };
}
