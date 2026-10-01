/**
 * Month-end sales pack layout.
 * Cash is treasury by bank date. Credit applied to another receipt is not cash.
 * Net sales deducts only price-concession refunds. Overpayment does not reduce sales.
 * Frontend copies via `npm run sync:shared`.
 */

import { receivableDueOnQuotationFromEntries } from './customerLedgerCore.js';
import {
  formatFromRefundPaymentMethod,
  formatRefundReceiptUsageNote,
  originReceiptIdsForApplication,
  revenueProductionReportRows,
} from './standardReportsSales.js';

const BASIS_NOTE =
  'Figures are as the records stand when this pack is printed. Confirming an old receipt can still change an earlier month until that month is frozen.';

function isoDate(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function inRange(iso, startDate, endDate) {
  if (!iso) return false;
  if (startDate && iso < startDate) return false;
  if (endDate && iso > endDate) return false;
  return true;
}

function monthOf(iso) {
  return iso ? iso.slice(0, 7) : '';
}

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function sumAmount(rows) {
  return roundMoney((rows || []).reduce((s, r) => s + (Number(r.amountNgn) || 0), 0));
}

function isReversedApp(app) {
  const st = String(app?.status || '').trim().toLowerCase();
  if (st === 'reversed' || st === 'cancelled') return true;
  return Boolean(isoDate(app?.reversedAtISO || app?.reversed_at_iso));
}

/**
 * @param {{ month?: string, startDate?: string, endDate?: string }} query
 */
export function resolveSalesMonthEndPeriod(query = {}) {
  const month = String(query.month || '').trim();
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      ok: true,
      startDate: `${month}-01`,
      endDate: `${month}-${String(last).padStart(2, '0')}`,
      month,
    };
  }
  const startDate = isoDate(query.startDate);
  const endDate = isoDate(query.endDate);
  if (!startDate || !endDate || startDate > endDate) {
    return { ok: false, error: 'Provide month=YYYY-MM or startDate and endDate (YYYY-MM-DD).' };
  }
  return {
    ok: true,
    startDate,
    endDate,
    month: startDate.slice(0, 7) === endDate.slice(0, 7) ? startDate.slice(0, 7) : '',
  };
}

function refundCommitmentNgn(refund) {
  const st = String(refund?.status || '').trim();
  if (st === 'Rejected' || st === 'Cancelled') return 0;
  if (st === 'Pending') return Math.max(0, roundMoney(refund.amountNgn));
  const approved = roundMoney(refund.approvedAmountNgn);
  return Math.max(0, approved > 0 ? approved : roundMoney(refund.amountNgn));
}

function refundOutstandingNgn(refund) {
  const st = String(refund?.status || '').trim();
  if (st === 'Pending') return Math.max(0, roundMoney(refund.amountNgn));
  if (st !== 'Approved' && st !== 'Partially paid') return 0;
  const approved = roundMoney(refund.approvedAmountNgn) || roundMoney(refund.amountNgn);
  const paid = roundMoney(refund.paidAmountNgn);
  return Math.max(0, approved - paid);
}

function cashOutFromMovement(row) {
  const type = String(row.type || '');
  const raw = roundMoney(row.amountNgn);
  if (type === 'REFUND_PAYOUT' || type === 'PARTNER_WALLET_PAYOUT' || type === 'REFUND_COMPANY_CUT_PAYOUT') {
    return Math.abs(raw);
  }
  if (type === 'REFUND_PAYOUT_REVERSAL_IN') return -Math.abs(raw);
  return null;
}

function payoutKind(type) {
  if (type === 'PARTNER_WALLET_PAYOUT') return 'Partner wallet';
  if (type === 'REFUND_COMPANY_CUT_PAYOUT') return 'Company cut';
  if (type === 'REFUND_PAYOUT_REVERSAL_IN') return 'Reversal';
  return 'Till/Bank';
}

function treatmentLabel(treatment) {
  if (treatment === 'concession') return 'Reduces sales';
  if (treatment === 'needs_review') return 'Needs a manual look';
  return 'Returns customer money';
}

/**
 * @param {object} input normalized rows already loaded for the branch
 */
export function buildSalesMonthEndPack(input = {}) {
  const startDate = isoDate(input.startDate);
  const endDate = isoDate(input.endDate);
  const refunds = Array.isArray(input.refunds) ? input.refunds : [];
  const refundById = new Map(refunds.map((r) => [String(r.refundId || '').trim(), r]));
  const apps = Array.isArray(input.creditApplications) ? input.creditApplications : [];
  const receiptCatalog = [...(input.receiptCatalog || []), ...(input.receipts || [])];
  const quotations = Array.isArray(input.quotations) ? input.quotations : [];
  const jobs = Array.isArray(input.productionJobs) ? input.productionJobs : [];
  const movements = Array.isArray(input.treasuryMovements) ? input.treasuryMovements : [];

  const exceptions = [];
  const pushEx = (code, recordId, detail, amountNgn) => {
    exceptions.push({
      code,
      recordId: String(recordId || ''),
      detail,
      amountNgn: roundMoney(amountNgn),
    });
  };

  const bankLines = [];
  for (const m of movements) {
    const posted = isoDate(m.postedAtISO);
    if (!inRange(posted, startDate, endDate)) continue;
    const amountNgn = roundMoney(m.amountNgn);
    bankLines.push({
      postedAtISO: posted,
      accountName: String(m.accountName || '').trim() || '—',
      accountNo: String(m.accountNo || '').trim(),
      type: String(m.type || ''),
      reference: String(m.reference || '').trim(),
      counterpartyName: String(m.counterpartyName || '').trim(),
      sourceKind: String(m.sourceKind || ''),
      sourceId: String(m.sourceId || ''),
      amountNgn,
      moneyInNgn: amountNgn > 0 ? amountNgn : 0,
      moneyOutNgn: amountNgn < 0 ? -amountNgn : 0,
      note: String(m.note || '').trim(),
      movementId: String(m.id || ''),
    });
  }
  bankLines.sort((a, b) => a.postedAtISO.localeCompare(b.postedAtISO) || a.accountName.localeCompare(b.accountName) || a.movementId.localeCompare(b.movementId));

  for (const m of input.malformedTreasury || []) {
    pushEx(
      'malformed_treasury_date',
      m.id,
      `Treasury ${m.type || ''} date "${m.postedAtISO || ''}" is not a real date, so it is missing from the bank page.`,
      m.amountNgn
    );
  }

  const creditLines = [];
  for (const app of apps) {
    const created = isoDate(app.createdAtISO);
    const reversed = isoDate(app.reversedAtISO);
    const amountNgn = Math.abs(roundMoney(app.amountNgn));
    if (!amountNgn) continue;
    const refundId = String(app.refundId || '').trim();
    const rowBase = {
      applicationId: String(app.applicationId || ''),
      refundId,
      customer: String(app.customerName || '').trim(),
      sourceQuotationRef: String(app.sourceQuotationRef || '').trim(),
      targetQuotationRef: String(app.targetQuotationRef || '').trim(),
      sourceReceiptId: String(app.sourceReceiptId || '').trim(),
      confirmedAtISO: isoDate(app.confirmedAtISO),
    };
    if (!refundId) {
      pushEx('credit_application_without_refund', rowBase.applicationId, 'Credit application is not tied to one refund.', amountNgn);
    }
    const sourceBranch = String(app.sourceReceiptBranchId || '').trim();
    const appBranch = String(app.branchId || '').trim();
    if (sourceBranch && appBranch && sourceBranch !== appBranch) {
      pushEx(
        'cross_branch_credit',
        rowBase.applicationId,
        `Credit sourced from branch ${sourceBranch} and applied on branch ${appBranch}.`,
        amountNgn
      );
    }
    const originReceiptIds = originReceiptIdsForApplication(app, receiptCatalog);
    const usageNote = formatRefundReceiptUsageNote({
      amountNgn,
      consumingReceiptId: rowBase.sourceReceiptId,
      targetQuotationRef: rowBase.targetQuotationRef,
      originReceiptIds,
      sourceQuotationRef: rowBase.sourceQuotationRef,
    });
    const paymentMethod = formatFromRefundPaymentMethod({
      refundIds: refundId ? [refundId] : [],
      originReceiptIds,
      sourceQuotationRefs: rowBase.sourceQuotationRef ? [rowBase.sourceQuotationRef] : [],
    });
    if (inRange(created, startDate, endDate)) {
      creditLines.push({
        ...rowBase,
        appliedDateISO: created,
        amountNgn,
        lineKind: 'apply',
        originReceiptIds,
        paymentMethod,
        usageNote,
      });
    }
    if (inRange(reversed, startDate, endDate)) {
      creditLines.push({
        ...rowBase,
        appliedDateISO: reversed,
        amountNgn: -amountNgn,
        lineKind: 'reversal',
        originReceiptIds,
        paymentMethod,
        usageNote: `Reversed — ${usageNote}`,
      });
    }
  }
  creditLines.sort(
    (a, b) => a.appliedDateISO.localeCompare(b.appliedDateISO) || a.applicationId.localeCompare(b.applicationId)
  );
  const creditBySourceRefundLines = [...creditLines].sort(
    (a, b) => a.refundId.localeCompare(b.refundId) || a.appliedDateISO.localeCompare(b.appliedDateISO)
  );

  const creditOnReceipt = new Map();
  for (const line of creditLines) {
    if (!line.sourceReceiptId || line.lineKind !== 'apply') continue;
    creditOnReceipt.set(line.sourceReceiptId, (creditOnReceipt.get(line.sourceReceiptId) || 0) + line.amountNgn);
  }

  const receiptLines = [];
  for (const r of input.receipts || []) {
    const dateISO = isoDate(r.dateISO);
    if (!inRange(dateISO, startDate, endDate)) continue;
    const cashNgn = roundMoney(r.amountNgn);
    const creditNgn = roundMoney(creditOnReceipt.get(String(r.id || '')) || 0);
    const linkedTreasuryNgn = roundMoney(r.linkedTreasuryNgn);
    let fundSource = 'Bank/Cash';
    if (creditNgn > 0 && cashNgn <= 0) fundSource = 'Refund credit';
    else if (creditNgn > 0 && cashNgn > 0) fundSource = 'Mixed';
    const linkedCredit = creditLines.filter(
      (line) => line.lineKind === 'apply' && line.sourceReceiptId && line.sourceReceiptId === String(r.id || '')
    );
    const paymentMethod =
      linkedCredit.length > 0
        ? linkedCredit.map((line) => line.paymentMethod).filter(Boolean).join('; ')
        : fundSource === 'Bank/Cash'
          ? 'Bank/Cash'
          : fundSource;
    receiptLines.push({
      receiptId: String(r.id || ''),
      dateISO,
      customer: String(r.customer || '').trim(),
      quotationRef: String(r.quotationRef || '').trim(),
      status: String(r.status || '').trim(),
      cashNgn,
      creditNgn,
      fundSource,
      paymentMethod,
      bankConfirmedAtISO: isoDate(r.bankConfirmedAtISO),
    });
    const cleared = String(r.status || '').trim() === 'Cleared';
    if ((cleared || linkedTreasuryNgn !== 0) && Math.abs(linkedTreasuryNgn - cashNgn) > 1) {
      pushEx(
        'receipt_treasury_mismatch',
        r.id,
        `Receipt book ${cashNgn} and treasury receipt lines ${linkedTreasuryNgn} do not match.`,
        cashNgn - linkedTreasuryNgn
      );
    }
    const confirmed = isoDate(r.bankConfirmedAtISO);
    if (confirmed && monthOf(confirmed) > monthOf(dateISO)) {
      pushEx(
        'confirmed_after_month',
        r.id,
        `Receipt dated ${dateISO} was bank-confirmed on ${confirmed}.`,
        cashNgn
      );
    }
  }
  receiptLines.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.receiptId.localeCompare(b.receiptId));

  const receiptBridgeLines = [];
  for (const link of input.receiptTreasuryLinks || []) {
    const receiptDate = isoDate(link.receiptDateISO);
    const posted = isoDate(link.postedAtISO);
    if (!receiptDate || !posted || monthOf(receiptDate) === monthOf(posted)) continue;
    if (!inRange(receiptDate, startDate, endDate) && !inRange(posted, startDate, endDate)) continue;
    receiptBridgeLines.push({
      receiptId: String(link.receiptId || ''),
      customer: String(link.customer || '').trim(),
      receiptDateISO: receiptDate,
      treasuryDateISO: posted,
      amountNgn: roundMoney(link.amountNgn),
      movementId: String(link.movementId || ''),
    });
  }
  receiptBridgeLines.sort((a, b) => a.receiptDateISO.localeCompare(b.receiptDateISO) || a.movementId.localeCompare(b.movementId));

  for (const row of input.unmatchedReceiptIns || []) {
    const posted = isoDate(row.postedAtISO);
    if (!inRange(posted, startDate, endDate)) continue;
    pushEx(
      'unmatched_receipt_in',
      row.id || row.sourceId,
      `Bank receipt ${row.sourceId || row.id || ''} has no sales receipt.`,
      row.amountNgn
    );
  }
  for (const row of input.lateConfirmations || []) {
    pushEx(
      'confirmed_this_period_for_earlier_receipt',
      row.id,
      `Receipt dated ${isoDate(row.dateISO)} was confirmed on ${isoDate(row.bankConfirmedAtISO)}.`,
      row.amountNgn
    );
  }

  const cashRefundLines = [];
  for (const m of movements) {
    const signed = cashOutFromMovement(m);
    if (signed == null || !signed) continue;
    const posted = isoDate(m.postedAtISO);
    if (!inRange(posted, startDate, endDate)) continue;
    const sourceId = String(m.sourceId || '');
    const refundId = sourceId.split(':')[0];
    cashRefundLines.push({
      movementId: String(m.id || ''),
      postedAtISO: posted,
      type: String(m.type || ''),
      payoutKind: payoutKind(m.type),
      amountNgn: signed,
      accountName: String(m.accountName || '').trim() || '—',
      reference: String(m.reference || '').trim(),
      customer: String(m.counterpartyName || '').trim(),
      refundId,
      sourceKind: String(m.sourceKind || ''),
    });
  }
  cashRefundLines.sort((a, b) => a.postedAtISO.localeCompare(b.postedAtISO) || a.movementId.localeCompare(b.movementId));

  const activeCreditByRefund = new Map();
  const orphanCreditByQuote = new Map();
  for (const app of apps) {
    if (isReversedApp(app)) continue;
    const amountNgn = Math.abs(roundMoney(app.amountNgn));
    if (!amountNgn) continue;
    const refundId = String(app.refundId || '').trim();
    const refund = refundId ? refundById.get(refundId) : null;
    const quote = String(app.sourceQuotationRef || '').trim();
    if (!refund || refund.status === 'Rejected' || refund.status === 'Cancelled') {
      if (quote) orphanCreditByQuote.set(quote, (orphanCreditByQuote.get(quote) || 0) + amountNgn);
    }
    if (refundId) activeCreditByRefund.set(refundId, (activeCreditByRefund.get(refundId) || 0) + amountNgn);
  }

  for (const refund of refunds) {
    const approved = roundMoney(refund.approvedAmountNgn) || roundMoney(refund.amountNgn);
    const paid = roundMoney(refund.paidAmountNgn);
    const credit = roundMoney(refund.creditAppliedNgn);
    const applied = activeCreditByRefund.get(refund.refundId) || 0;
    if (paid > approved + 1 && approved > 0) {
      pushEx('paid_above_approved', refund.refundId, `Paid ${paid} is above approved ${approved}.`, paid - approved);
    }
    const st = String(refund.status || '');
    if ((st === 'Rejected' || st === 'Cancelled') && (credit > 0 || paid > 0)) {
      pushEx('rejected_refund_still_settled', refund.refundId, `${st} refund still has paid ${paid} and credit ${credit}.`, Math.max(paid, credit));
    }
    if (Math.abs(credit - applied) > 1 && (credit > 0 || applied > 0)) {
      pushEx(
        'credit_counter_mismatch',
        refund.refundId,
        `Refund credit counter ${credit} and application rows ${applied} disagree.`,
        credit - applied
      );
    }
  }

  const customersWeOweLines = [];
  for (const q of quotations) {
    const st = String(q.status || '').trim().toLowerCase();
    if (st === 'void' || st === 'cancelled') continue;
    const excess = roundMoney(q.paidNgn) - roundMoney(q.totalNgn);
    if (excess <= 0) continue;
    const quoteId = String(q.id || '');
    let committed = 0;
    for (const refund of refunds) {
      if (String(refund.quotationRef || '') !== quoteId) continue;
      committed += refundCommitmentNgn(refund);
    }
    const orphan = orphanCreditByQuote.get(quoteId) || 0;
    const held = Math.max(0, excess - committed - orphan);
    if (held <= 0) continue;
    customersWeOweLines.push({
      block: 'unrefunded_overpay',
      recordId: quoteId,
      customer: String(q.customer || '').trim(),
      detail: 'Paid more than the quotation. No refund or credit covers this remainder.',
      amountNgn: held,
    });
  }
  for (const refund of refunds) {
    const outstanding = refundOutstandingNgn(refund);
    if (outstanding <= 0) continue;
    customersWeOweLines.push({
      block: 'open_refund',
      recordId: refund.refundId,
      customer: String(refund.customer || '').trim(),
      detail: `${refund.status} refund still unpaid`,
      amountNgn: outstanding,
      quotationRef: String(refund.quotationRef || ''),
    });
  }
  const unappliedAdvancesNgn = Math.max(0, roundMoney(input.unappliedAdvancesNgn));
  if (unappliedAdvancesNgn > 0) {
    customersWeOweLines.push({
      block: 'unapplied_advance',
      recordId: '',
      customer: '',
      detail: 'Customer advances received and not yet applied to a quotation.',
      amountNgn: unappliedAdvancesNgn,
    });
  }
  const walletOpenNgn = input.walletOpenNgn == null ? null : Math.max(0, roundMoney(input.walletOpenNgn));
  if (walletOpenNgn > 0) {
    customersWeOweLines.push({
      block: 'wallet_open',
      recordId: '',
      customer: '',
      detail: 'Partner wallet balance not yet withdrawn.',
      amountNgn: walletOpenNgn,
    });
  }
  const companyCutOpenNgn = input.companyCutOpenNgn == null ? null : Math.max(0, roundMoney(input.companyCutOpenNgn));
  if (companyCutOpenNgn > 0) {
    customersWeOweLines.push({
      block: 'company_cut_open',
      recordId: '',
      customer: 'Company',
      detail: 'Company cut retained and not yet withdrawn.',
      amountNgn: companyCutOpenNgn,
    });
  }
  customersWeOweLines.sort((a, b) => b.amountNgn - a.amountNgn || a.recordId.localeCompare(b.recordId));

  const debtorLines = [];
  for (const q of quotations) {
    const st = String(q.status || '').trim().toLowerCase();
    if (st === 'void' || st === 'cancelled') continue;
    const due = receivableDueOnQuotationFromEntries([], q, jobs);
    if (due <= 0) continue;
    debtorLines.push({
      quotationRef: String(q.id || ''),
      customer: String(q.customer || '').trim(),
      totalNgn: roundMoney(q.totalNgn),
      paidNgn: roundMoney(q.paidNgn),
      balanceDueNgn: due,
      status: String(q.status || ''),
    });
  }
  debtorLines.sort((a, b) => b.balanceDueNgn - a.balanceDueNgn || a.quotationRef.localeCompare(b.quotationRef));

  const revenueRows = revenueProductionReportRows(quotations, jobs, startDate, endDate);
  const revenueNgn = sumAmount(revenueRows.map((r) => ({ amountNgn: r.revenueNgn })));

  const salesTreatmentLines = [];
  const pushTreatment = (dateISO, recordId, refundId, amountNgn, channel) => {
    const refund = refundById.get(refundId);
    const treatment = refund?.salesTreatment || 'customer_money';
    salesTreatmentLines.push({
      dateISO,
      recordId,
      refundId,
      customer: refund?.customer || '',
      quotationRef: refund?.quotationRef || '',
      channel,
      amountNgn,
      salesTreatment: treatment,
      salesTreatmentLabel: treatmentLabel(treatment),
    });
  };
  for (const line of cashRefundLines) {
    if (line.payoutKind === 'Company cut') continue;
    pushTreatment(line.postedAtISO, line.movementId, line.refundId, line.amountNgn, line.payoutKind);
  }
  for (const line of creditLines) {
    pushTreatment(line.appliedDateISO, line.applicationId, line.refundId, line.amountNgn, 'Refund credit');
  }
  salesTreatmentLines.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.recordId.localeCompare(b.recordId));

  const concessionNgn = sumAmount(salesTreatmentLines.filter((r) => r.salesTreatment === 'concession'));
  const bankInNgn = sumAmount(bankLines.map((r) => ({ amountNgn: r.moneyInNgn })));
  const bankOutNgn = sumAmount(bankLines.map((r) => ({ amountNgn: r.moneyOutNgn })));
  const glAccounts = (input.glAccounts || []).map((a) => ({
    code: String(a.code || ''),
    name: String(a.name || ''),
    debitNgn: roundMoney(a.debitNgn),
    creditNgn: roundMoney(a.creditNgn),
    netDebitNgn: roundMoney(a.debitNgn) - roundMoney(a.creditNgn),
  }));

  const unrefundedOverpayNgn = sumAmount(customersWeOweLines.filter((r) => r.block === 'unrefunded_overpay'));
  const openRefundsNgn = sumAmount(customersWeOweLines.filter((r) => r.block === 'open_refund'));
  const owedToCustomersLines = customersWeOweLines.filter((r) => r.block !== 'company_cut_open');

  const cover = {
    bankInNgn,
    bankOutNgn,
    receiptsDatedInMonthNgn: sumAmount(receiptLines.map((r) => ({ amountNgn: r.cashNgn }))),
    receiptCreditAppliedNgn: sumAmount(receiptLines.map((r) => ({ amountNgn: r.creditNgn }))),
    cashRefundsNgn: sumAmount(cashRefundLines),
    creditAppliedNgn: sumAmount(creditLines),
    creditBySourceNgn: sumAmount(creditBySourceRefundLines),
    revenueNgn,
    concessionRefundsNgn: concessionNgn,
    netSalesNgn: revenueNgn - concessionNgn,
    unrefundedOverpayNgn,
    openRefundsNgn,
    unappliedAdvancesNgn,
    walletOpenNgn,
    companyCutOpenNgn,
    customersWeOweNgn: sumAmount(owedToCustomersLines),
    customersWhoOweUsNgn: sumAmount(debtorLines.map((r) => ({ amountNgn: r.balanceDueNgn }))),
    suppliersWeOweNgn: input.suppliersWeOweNgn == null ? null : roundMoney(input.suppliersWeOweNgn),
    glAccounts,
  };

  return {
    ok: true,
    asOfISO: String(input.asOfISO || ''),
    branchScope: input.branchScope || 'ALL',
    period: { startDate, endDate, month: String(input.month || '') },
    basisNote: BASIS_NOTE,
    cover,
    bankLines,
    receiptBridgeLines,
    receiptLines,
    cashRefundLines,
    creditAppliedLines: creditLines,
    creditBySourceRefundLines,
    customersWeOweLines,
    debtorLines,
    revenueLines: revenueRows,
    salesTreatmentLines,
    exceptions,
  };
}

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/** One sheet. Filter the section column in Excel. */
export function salesMonthEndPackToCsv(pack) {
  const lines = [
    csvRow(['section', 'date', 'record', 'party', 'detail', 'moneyInNgn', 'moneyOutNgn', 'amountNgn']),
  ];
  const add = (section, date, record, party, detail, amountNgn, moneyInNgn, moneyOutNgn) => {
    lines.push(csvRow([section, date, record, party, detail, moneyInNgn ?? '', moneyOutNgn ?? '', amountNgn ?? '']));
  };
  add('cover', '', '', '', pack.basisNote, '', '', '');
  for (const [key, value] of Object.entries(pack.cover || {})) {
    if (key === 'glAccounts') continue;
    add('cover', '', key, '', '', value ?? '', '', '');
  }
  for (const a of pack.cover?.glAccounts || []) {
    add('gl', '', a.code, a.name, 'debit minus credit', a.netDebitNgn, a.debitNgn, a.creditNgn);
  }
  for (const r of pack.bankLines || []) {
    add('bank', r.postedAtISO, r.movementId, r.counterpartyName, `${r.accountName} ${r.type} ${r.reference}`.trim(), r.amountNgn, r.moneyInNgn, r.moneyOutNgn);
  }
  for (const r of pack.receiptBridgeLines || []) {
    add('receipt_vs_bank_date', r.receiptDateISO, r.receiptId, r.customer, `Bank date ${r.treasuryDateISO}`, r.amountNgn, '', '');
  }
  for (const r of pack.receiptLines || []) {
    add('receipts', r.dateISO, r.receiptId, r.customer, `${r.paymentMethod || r.fundSource} ${r.quotationRef} credit ${r.creditNgn}`, r.cashNgn, '', '');
  }
  for (const r of pack.cashRefundLines || []) {
    add('cash_refunds', r.postedAtISO, r.refundId || r.movementId, r.customer, r.payoutKind, r.amountNgn, '', '');
  }
  for (const r of pack.creditAppliedLines || []) {
    add('credit_applied', r.appliedDateISO, r.applicationId, r.customer, r.usageNote || `${r.refundId} -> ${r.targetQuotationRef}`, r.amountNgn, '', '');
  }
  for (const r of pack.creditBySourceRefundLines || []) {
    add('credit_by_source_refund', r.appliedDateISO, r.refundId, r.customer, r.applicationId, r.amountNgn, '', '');
  }
  for (const r of pack.customersWeOweLines || []) {
    add('customers_we_owe', '', r.recordId, r.customer, `${r.block} ${r.detail}`, r.amountNgn, '', '');
  }
  for (const r of pack.debtorLines || []) {
    add('customers_who_owe_us', '', r.quotationRef, r.customer, r.status, r.balanceDueNgn, '', '');
  }
  for (const r of pack.salesTreatmentLines || []) {
    add('sales_treatment', r.dateISO, r.refundId, r.customer, r.salesTreatmentLabel, r.amountNgn, '', '');
  }
  for (const r of pack.exceptions || []) {
    add('exceptions', '', r.recordId, '', `${r.code} ${r.detail}`, r.amountNgn, '', '');
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function pdfMoney(n) {
  if (n == null || n === '') return '';
  const v = roundMoney(n);
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toLocaleString('en-NG')}`;
}

/** Cover, exceptions, then the bank tick-off. About 42 lines per page. */
export function salesMonthEndPackToPdfPages(pack) {
  const cover = pack.cover || {};
  const header = [
    'Zarewa month-end sales pack',
    `Period ${pack.period?.startDate || ''} to ${pack.period?.endDate || ''}  Branch ${pack.branchScope || ''}`,
    `Printed ${pack.asOfISO || ''}`,
    pack.basisNote,
    '',
    `Bank in ${pdfMoney(cover.bankInNgn)}    Bank out ${pdfMoney(cover.bankOutNgn)}`,
    `Receipts dated in period (cash) ${pdfMoney(cover.receiptsDatedInMonthNgn)}`,
    `Credit used on another receipt ${pdfMoney(cover.creditAppliedNgn)}`,
    `Cash refunds ${pdfMoney(cover.cashRefundsNgn)}`,
    `Revenue (produced) ${pdfMoney(cover.revenueNgn)}`,
    `Price cuts ${pdfMoney(cover.concessionRefundsNgn)}    Net sales ${pdfMoney(cover.netSalesNgn)}`,
    `Customers we owe ${pdfMoney(cover.customersWeOweNgn)}`,
    `  overpaid, not refunded ${pdfMoney(cover.unrefundedOverpayNgn)}`,
    `  open refunds ${pdfMoney(cover.openRefundsNgn)}`,
    `  advances not applied ${pdfMoney(cover.unappliedAdvancesNgn)}`,
    `Company cut still held (company money) ${cover.companyCutOpenNgn == null ? 'unavailable' : pdfMoney(cover.companyCutOpenNgn)}`,
    `Customers who owe us ${pdfMoney(cover.customersWhoOweUsNgn)}`,
    `Suppliers we owe ${cover.suppliersWeOweNgn == null ? 'unavailable' : pdfMoney(cover.suppliersWeOweNgn)}`,
    'Account balances are a check. Use the figures above for the month.',
  ];
  for (const a of cover.glAccounts || []) {
    header.push(`Account ${a.code} ${a.name} net (debit minus credit) ${pdfMoney(a.netDebitNgn)}`);
  }
  header.push('');
  header.push(`Exceptions ${ (pack.exceptions || []).length }`);
  for (const ex of pack.exceptions || []) {
    header.push(`${ex.code} ${ex.recordId} ${pdfMoney(ex.amountNgn)} ${ex.detail}`.slice(0, 220));
  }
  header.push('');
  header.push('Bank tick-off (full lines are also in the CSV)');
  for (const r of pack.bankLines || []) {
    const dir = r.amountNgn < 0 ? 'OUT' : 'IN';
    header.push(`${r.postedAtISO} ${dir} ${pdfMoney(Math.abs(r.amountNgn))} ${r.accountName} ${r.type} ${r.counterpartyName} ${r.reference}`.slice(0, 220));
  }
  const pages = [];
  for (let i = 0; i < header.length; i += 42) {
    pages.push({ lines: header.slice(i, i + 42) });
  }
  return pages.length ? pages : [{ lines: ['Zarewa month-end sales pack', '(no rows)'] }];
}

export function salesMonthEndPackFilename(pack, ext) {
  const key = pack?.period?.month || `${pack?.period?.startDate || 'period'}_${pack?.period?.endDate || ''}`;
  return `sales-month-end-pack-${key}.${ext}`;
}
