/**
 * Management Sales and Refund packs for a month, taken from the locked Phase 1 close.
 * Cash and refunds are the open bank lines. Debtors are the Phase 1 customer position
 * after credit notes and discount allowed.
 */

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function isoDate(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function inRange(iso, startDate, endDate) {
  if (!iso) return false;
  if (startDate && iso < startDate) return false;
  if (endDate && iso > endDate) return false;
  return true;
}

function sumField(rows, field) {
  return roundMoney((rows || []).reduce((sum, row) => sum + roundMoney(row[field]), 0));
}

/**
 * @param {object} input
 * @param {boolean} input.periodLocked
 * @param {string} input.startDate
 * @param {string} input.endDate
 * @param {object[]} input.cashRows Phase 1 cash rows (bank date, open treasury only)
 * @param {object[]} input.refundRows Phase 1 refund payouts in the period
 * @param {object[]} input.bankEverLines open refund payouts as at the close, any date
 * @param {object[]} input.branches branch bridge rows
 * @param {object[]} input.customerDebtors Phase 1 goods debtors after adjustments
 * @param {object[]} input.refundHeaders customer refund headers
 * @param {object[]} input.creditApplications
 */
export function buildManagementPhase1View(input = {}) {
  const startDate = isoDate(input.startDate);
  const endDate = isoDate(input.endDate);
  const cashRows = (input.cashRows || [])
    .filter((row) => roundMoney(row.cashNgn) > 0)
    .map((row) => {
      const bankPaidNgn = roundMoney(row.cashNgn);
      const typedAmountNgn = roundMoney(row.amountNgn);
      return {
        dateISO: isoDate(row.bankValueDateISO || row.dateISO),
        customerName: String(row.customerName || ''),
        quotationRef: String(row.quotationRef || ''),
        receiptId: String(row.receiptId || ''),
        bankPaidNgn,
        typedAmountNgn,
        paidDiffers: typedAmountNgn > 0 && typedAmountNgn !== bankPaidNgn,
        status: String(row.status || ''),
        kind: String(row.kind || 'receipt'),
      };
    });
  const refundPaidRows = (input.refundRows || [])
    .filter((row) => roundMoney(row.amountNgn) > 0)
    .map((row) => ({
      dateISO: isoDate(row.dateISO),
      refundId: String(row.refundId || ''),
      customerName: String(row.customerName || ''),
      quotationRef: String(row.quotationRef || ''),
      amountNgn: roundMoney(row.amountNgn),
      status: 'Paid',
    }));

  const bankEver = new Map();
  for (const line of input.bankEverLines || []) {
    const id = String(line.refundId || '').trim();
    const amount = roundMoney(line.amountNgn);
    if (!id || !(amount > 0)) continue;
    bankEver.set(id, roundMoney((bankEver.get(id) || 0) + amount));
  }
  const creditByRefund = new Map();
  for (const app of input.creditApplications || []) {
    const status = String(app.status || '').trim().toLowerCase();
    if (status === 'reversed' || status === 'cancelled') continue;
    if (isoDate(app.reversedAtISO || app.reversed_at_iso)) continue;
    const id = String(app.refundId || app.refund_id || '').trim();
    const amount = roundMoney(app.amountNgn ?? app.amount_ngn);
    if (!id || !(amount > 0)) continue;
    creditByRefund.set(id, roundMoney((creditByRefund.get(id) || 0) + amount));
  }

  const refundUnpaidRows = [];
  for (const header of input.refundHeaders || []) {
    const status = String(header.status || '').trim();
    if (!status || status.toLowerCase() === 'cancelled') continue;
    const requested = isoDate(header.requestedAtISO || header.requested_at_iso);
    if (!inRange(requested, startDate, endDate)) continue;
    const id = String(header.refundId || header.refund_id || '').trim();
    const paid = roundMoney(header.paidAmountNgn ?? header.paid_amount_ngn);
    const approved = roundMoney(header.approvedAmountNgn ?? header.approved_amount_ngn);
    const amount = roundMoney(header.amountNgn ?? header.amount_ngn);
    const recorded = paid > 0 ? paid : approved > 0 ? approved : amount;
    const credit = creditByRefund.get(id) || 0;
    const bank = bankEver.get(id) || 0;
    const unpaidNgn = Math.max(0, roundMoney(recorded - credit - bank));
    if (!(unpaidNgn > 0)) continue;
    const approvedLike = status === 'Approved' || status === 'Paid' || status === 'Partially paid';
    refundUnpaidRows.push({
      dateISO: requested,
      refundId: id,
      customerName: String(header.customerName || header.customer_name || ''),
      quotationRef: String(header.quotationRef || header.quotation_ref || ''),
      amountNgn: unpaidNgn,
      status: approvedLike ? 'Approved – not paid' : status,
    });
  }

  const debtorRows = (input.customerDebtors || [])
    .filter((row) => roundMoney(row.owedNgn) > 0)
    .map((row) => ({
      customerId: String(row.customerId || ''),
      customerName: String(row.customerName || ''),
      owedNgn: roundMoney(row.owedNgn),
      flag: String(row.flag || ''),
    }));

  const cashNgn = sumField(cashRows, 'bankPaidNgn');
  const refundsNgn = sumField(refundPaidRows, 'amountNgn');
  const revenueNgn = sumField(input.branches || [], 'revenueNgn');
  const lockedClose = {
    cashNgn: sumField(input.branches || [], 'cashNgn'),
    refundsNgn: sumField(input.branches || [], 'refundsNgn'),
    revenueNgn,
  };
  const debtorsNgn = sumField(debtorRows, 'owedNgn');
  const periodLocked = Boolean(input.periodLocked);
  const aligned = cashNgn === lockedClose.cashNgn && refundsNgn === lockedClose.refundsNgn && revenueNgn === lockedClose.revenueNgn;
  const alert = periodLocked && !aligned
    ? `September is locked. This report does not match the Phase 1 close (cash ${lockedClose.cashNgn.toLocaleString('en-NG')}, refunds ${lockedClose.refundsNgn.toLocaleString('en-NG')}, revenue ${lockedClose.revenueNgn.toLocaleString('en-NG')}).`
    : '';

  return {
    ok: true,
    periodLocked,
    aligned,
    alert,
    cashNgn,
    refundsNgn,
    revenueNgn,
    debtorsNgn,
    lockedClose,
    cashRows,
    debtorRows,
    refundPaidRows,
    refundUnpaidRows,
  };
}
