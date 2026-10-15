/**
 * Bank reconciliation statement (Reports round 2, F1). Pure: accounts, treasury movements and bank-statement
 * lines in → one statement per treasury account out.
 *
 * Per account and period:
 *   ERP:  opening → + receipts → − refund payouts → − payments/expenses → ± internal transfers → − charges
 *         (± other) = ERP closing.
 *   Bank: opening (input — the ERP stores no statement balance) + statement lines in the period = bank closing.
 *   Difference = ERP closing − bank closing.
 *
 * Links come from the bank line's `systemMatch` text (treasury movement ids TM-…). A movement is "linked" when
 * any bank line names it. Without a bank opening the statement still ties on movements:
 *   ERP net − bank net = unlinked ERP lines + ERP lines whose bank line is in another period
 *                        − unlinked bank lines − (bank amount − linked ERP amount) on matched lines.
 * `unexplainedNgn` is what is left (expected ₦0).
 */

export const BANK_RECON_SMALL_ITEM_NGN = 50_000;

export const BUCKET_RECEIPTS = 'receipts';
export const BUCKET_REFUNDS = 'refundPayouts';
export const BUCKET_PAYMENTS = 'payments';
export const BUCKET_TRANSFERS = 'transfers';
export const BUCKET_CHARGES = 'charges';
export const BUCKET_OTHER = 'other';

export const BUCKET_LABELS = {
  [BUCKET_RECEIPTS]: '+ Receipts',
  [BUCKET_REFUNDS]: '− Refund payouts',
  [BUCKET_PAYMENTS]: '− Payments and expenses',
  [BUCKET_TRANSFERS]: '± Internal transfers',
  [BUCKET_CHARGES]: '− Bank charges and recon adjustments',
  [BUCKET_OTHER]: '± Other movements',
};

const TYPE_BUCKET = {
  RECEIPT_IN: BUCKET_RECEIPTS,
  ADVANCE_IN: BUCKET_RECEIPTS,
  RECEIPT_REVERSAL_OUT: BUCKET_RECEIPTS,
  ADVANCE_REVERSAL_OUT: BUCKET_RECEIPTS,
  BANK_UNIDENTIFIED_IN: BUCKET_RECEIPTS,
  STAFF_RECOVERY_IN: BUCKET_RECEIPTS,
  STAFF_OBLIGATION_IN: BUCKET_RECEIPTS,
  SUPPLIER_OVERPAYMENT_REVERSAL: BUCKET_RECEIPTS,
  REFUND_PAYOUT: BUCKET_REFUNDS,
  REFUND_COMPANY_CUT_PAYOUT: BUCKET_REFUNDS,
  PAYMENT_REQUEST_OUT: BUCKET_PAYMENTS,
  AP_PAYMENT: BUCKET_PAYMENTS,
  EXPENSE: BUCKET_PAYMENTS,
  TRANSPORT_PAYMENT: BUCKET_PAYMENTS,
  REGISTER_SETTLEMENT_OUT: BUCKET_PAYMENTS,
  OT_PAYOUT: BUCKET_PAYMENTS,
  STAFF_RECOVERY_OUT: BUCKET_PAYMENTS,
  SUPPLIER_OVERPAYMENT: BUCKET_PAYMENTS,
  BANK_UNIDENTIFIED_OUT: BUCKET_PAYMENTS,
  INTERNAL_TRANSFER_IN: BUCKET_TRANSFERS,
  INTERNAL_TRANSFER_OUT: BUCKET_TRANSFERS,
  BANK_RECON_ADJUSTMENT: BUCKET_CHARGES,
};

const BANK_CHARGES_CATEGORY_RE = /^bank\s*charges?$/i;

const day = (v) => String(v || '').slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);
const sum = (list, key = 'amountNgn') => list.reduce((s, x) => s + ngn(x[key]), 0);
const TM_ID_RE = /TM-[A-Z]{2,4}-\d{2}-\d+/gi;

/** Treasury movement ids named in a bank line's systemMatch text. */
export function linkedMovementIds(systemMatch) {
  return [...new Set([...String(systemMatch || '').matchAll(TM_ID_RE)].map((m) => m[0].toUpperCase()))];
}

/** Non-treasury reference on an unlinked bank line ("EXPLAINED:EXP-…", "INV-…", "NOT IN ERP"), as written. */
export function bankLineReference(systemMatch) {
  return String(systemMatch || '').trim();
}

function dayDiff(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
  return Math.abs(x - y) / 86_400_000;
}

/**
 * Movement → bucket. EXPENSE lines in the "Bank charges" expense category count as charges.
 * @param {object} t treasury movement
 * @param {Map<string, object>} expenseById
 */
export function movementBucket(t, expenseById = new Map()) {
  if (t.type === 'EXPENSE') {
    const e = expenseById.get(String(t.sourceId || '').trim());
    if (e && BANK_CHARGES_CATEGORY_RE.test(String(e.category || '').trim())) return BUCKET_CHARGES;
  }
  return TYPE_BUCKET[t.type] || BUCKET_OTHER;
}

/**
 * Greedy one-to-one suggestions: same amount, dates within `maxDays`, nearest date first.
 * @returns {Map<string, {id: string, days: number}>} key = left id
 */
function suggestMatches(left, right, maxDays = 3) {
  const pairs = [];
  for (const l of left) {
    for (const r of right) {
      if (l.amountNgn !== r.amountNgn) continue;
      const d = dayDiff(l.dateISO, r.dateISO);
      if (d <= maxDays) pairs.push({ l: l.id, r: r.id, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d || a.l.localeCompare(b.l) || a.r.localeCompare(b.r));
  const usedL = new Set();
  const usedR = new Set();
  const out = new Map();
  for (const p of pairs) {
    if (usedL.has(p.l) || usedR.has(p.r)) continue;
    usedL.add(p.l);
    usedR.add(p.r);
    out.set(p.l, { id: p.r, days: p.d });
  }
  return out;
}

const severityFor = (amountNgn) => (Math.abs(amountNgn) >= BANK_RECON_SMALL_ITEM_NGN ? 'exception' : 'small');

/**
 * @param {object} input
 * @param {object[]} input.accounts — {id, name, bankName, type, accNo, erpOpeningNgn?, openingBalanceNgn?, balance?}
 *   `erpOpeningNgn` = ERP balance at the start of the period. When absent it is computed as
 *   openingBalanceNgn + movements before startDate (pass the full history then).
 * @param {object[]} input.treasuryMovements — {id, postedAtISO, type, treasuryAccountId, amountNgn, counterpartyName,
 *   reference, sourceKind, sourceId}; must cover the period; lines outside it only help label links.
 * @param {object[]} input.bankLines — {id, bankDateISO, description, amountNgn, status, systemMatch, treasuryAccountId}
 * @param {object[]} [input.expenses] — {expenseID|id, category} to find bank charges
 * @param {Record<string, number>} [input.bankOpeningByAccount] — statement balance at the start, per account id
 * @param {Record<string, number>} [input.bankClosingByAccount] — statement balance at the end (checks the lines)
 * @param {string} input.startDate
 * @param {string} input.endDate
 */
export function buildBankReconStatement(input = {}) {
  const {
    accounts = [],
    treasuryMovements = [],
    bankLines = [],
    expenses = [],
    bankOpeningByAccount = {},
    bankClosingByAccount = {},
    startDate = '',
    endDate = '',
  } = input;
  const inPeriod = (iso) => {
    const d = day(iso);
    return Boolean(d) && (!startDate || d >= startDate) && (!endDate || d <= endDate);
  };
  const expenseById = new Map(expenses.map((e) => [String(e.expenseID || e.id || '').trim(), e]));
  const movementById = new Map(treasuryMovements.map((t) => [String(t.id || '').toUpperCase(), t]));

  // Which bank line names each movement (first one by date, then id).
  const sortedBank = bankLines
    .slice()
    .sort((a, b) => day(a.bankDateISO).localeCompare(day(b.bankDateISO)) || String(a.id).localeCompare(String(b.id)));
  const bankLineByMovement = new Map();
  for (const b of sortedBank) {
    for (const id of linkedMovementIds(b.systemMatch)) if (!bankLineByMovement.has(id)) bankLineByMovement.set(id, b);
  }

  const pages = accounts.map((acc) => {
    const accId = String(acc.id);
    const isCash = String(acc.type || '').trim().toLowerCase() === 'cash';
    const mine = treasuryMovements.filter((t) => String(t.treasuryAccountId) === accId);
    const before = mine.filter((t) => startDate && day(t.postedAtISO) < startDate);
    const period = mine
      .filter((t) => inPeriod(t.postedAtISO))
      .map((t) => ({
        id: String(t.id),
        dateISO: day(t.postedAtISO),
        type: t.type,
        bucket: movementBucket(t, expenseById),
        amountNgn: ngn(t.amountNgn),
        counterparty: String(t.counterpartyName || '').trim(),
        reference: String(t.reference || '').trim(),
        sourceKind: String(t.sourceKind || ''),
        sourceId: String(t.sourceId || ''),
        bankLineId: bankLineByMovement.get(String(t.id).toUpperCase())?.id || '',
      }))
      .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.id.localeCompare(b.id));

    const erpOpeningNgn =
      acc.erpOpeningNgn != null ? ngn(acc.erpOpeningNgn) : ngn(acc.openingBalanceNgn) + sum(before);
    const buckets = Object.fromEntries(
      Object.keys(BUCKET_LABELS).map((k) => [k, { key: k, label: BUCKET_LABELS[k], amountNgn: 0, movementIds: [] }])
    );
    for (const t of period) {
      buckets[t.bucket].amountNgn += t.amountNgn;
      buckets[t.bucket].movementIds.push(t.id);
    }
    const erpNetNgn = sum(period);
    const erpClosingNgn = erpOpeningNgn + erpNetNgn;
    const storedBalanceNgn = acc.balance == null ? null : ngn(acc.balance);

    // --- Bank side -----------------------------------------------------------------------------
    const allBank = sortedBank.filter((b) => String(b.treasuryAccountId) === accId);
    // Cash, or a bank account with no imported statement lines: nothing to reconcile against.
    const noStatement = isCash || allBank.length === 0;
    const coverage = allBank.length
      ? { fromISO: day(allBank[0].bankDateISO), toISO: day(allBank[allBank.length - 1].bankDateISO) }
      : null;
    const bankPeriod = allBank
      .filter((b) => inPeriod(b.bankDateISO))
      .map((b) => ({
        id: String(b.id),
        dateISO: day(b.bankDateISO),
        description: String(b.description || '').trim(),
        amountNgn: ngn(b.amountNgn),
        status: String(b.status || '').trim(),
        systemMatch: String(b.systemMatch || '').trim(),
        movementIds: linkedMovementIds(b.systemMatch),
      }));
    const bankNetNgn = sum(bankPeriod);
    const hasOpening = bankOpeningByAccount[accId] != null && bankOpeningByAccount[accId] !== '';
    const bankOpeningNgn = hasOpening ? ngn(bankOpeningByAccount[accId]) : null;
    const bankClosingNgn = hasOpening ? bankOpeningNgn + bankNetNgn : null;
    const hasStatedClosing = bankClosingByAccount[accId] != null && bankClosingByAccount[accId] !== '';
    const statedClosingNgn = hasStatedClosing ? ngn(bankClosingByAccount[accId]) : null;

    // --- Reconciling items ---------------------------------------------------------------------
    const periodIds = new Set(period.map((t) => t.id.toUpperCase()));
    const claimed = new Set();
    const matchedVariances = [];
    const brokenLinks = [];
    const bankUnlinkedRaw = [];
    for (const b of bankPeriod) {
      if (!b.movementIds.length) {
        bankUnlinkedRaw.push(b);
        continue;
      }
      let erpHere = 0;
      const notes = [];
      for (const id of b.movementIds) {
        const t = movementById.get(id);
        if (!t) {
          notes.push(`${id} not found`);
          brokenLinks.push({ bankLineId: b.id, treasuryMovementId: id, dateISO: b.dateISO, amountNgn: b.amountNgn });
          continue;
        }
        if (String(t.treasuryAccountId) !== accId) {
          notes.push(`${id} is posted to another account`);
          continue;
        }
        if (!periodIds.has(id)) {
          notes.push(`${id} dated ${day(t.postedAtISO)} (outside the period)`);
          continue;
        }
        if (claimed.has(id)) continue;
        claimed.add(id);
        erpHere += ngn(t.amountNgn);
      }
      const diff = b.amountNgn - erpHere;
      if (diff) {
        matchedVariances.push({
          bankLineId: b.id,
          dateISO: b.dateISO,
          description: b.description,
          bankAmountNgn: b.amountNgn,
          erpAmountNgn: erpHere,
          amountNgn: diff,
          movementIds: b.movementIds,
          note: notes.join('; ') || 'Bank amount differs from the linked ERP lines',
        });
      }
    }

    const erpUnlinkedRaw = period.filter((t) => !t.bankLineId);
    const erpTiming = period
      .filter((t) => t.bankLineId && !claimed.has(t.id.toUpperCase()))
      .map((t) => {
        const b = bankLineByMovement.get(t.id.toUpperCase());
        return { ...t, bankDateISO: day(b?.bankDateISO), note: `On the bank statement ${day(b?.bankDateISO)} (${b?.id})` };
      });

    // Unlinked ERP lines that cancel inside the period (a receipt and its reversal: same source, opposite amounts).
    const offsetBy = new Map();
    const bySource = new Map();
    for (const t of erpUnlinkedRaw) {
      if (!t.sourceId) continue;
      const k = `${t.sourceKind}|${t.sourceId}|${Math.abs(t.amountNgn)}`;
      const open = bySource.get(k) || [];
      const i = open.findIndex((o) => o.amountNgn === -t.amountNgn);
      if (i >= 0) {
        const o = open.splice(i, 1)[0];
        offsetBy.set(o.id, t.id);
        offsetBy.set(t.id, o.id);
      } else open.push(t);
      bySource.set(k, open);
    }
    const unmatchedErp = erpUnlinkedRaw.filter((t) => !offsetBy.has(t.id));
    const suggestErp = suggestMatches(unmatchedErp, bankUnlinkedRaw);
    const suggestBank = suggestMatches(bankUnlinkedRaw, unmatchedErp);
    const outsideCoverage = (d) => !coverage || d < coverage.fromISO || d > coverage.toISO;

    const erpUnlinked = noStatement
      ? []
      : erpUnlinkedRaw.map((t) => {
          const s = suggestErp.get(t.id);
          const outside = outsideCoverage(t.dateISO);
          const offset = offsetBy.get(t.id) || '';
          let note = '';
          if (offset) note = `Cancelled by ${offset} in the period (nets to ₦0)`;
          else if (outside) note = 'Outside the bank statement dates loaded';
          return {
            ...t,
            suggestedMatch: s ? s.id : '',
            suggestedMatchNote: s ? `Same amount, ${s.days} day(s) apart` : '',
            offsetMovementId: offset,
            outsideCoverage: outside,
            note,
            severity: offset || outside ? 'review' : severityFor(t.amountNgn),
          };
        });
    const bankUnlinked = bankUnlinkedRaw.map((b) => {
      const s = suggestBank.get(b.id);
      const reference = bankLineReference(b.systemMatch);
      const explained = /^EXPLAINED:/i.test(reference) || b.status === 'Excluded';
      return {
        ...b,
        reference,
        suggestedMatch: s ? s.id : '',
        suggestedMatchNote: s ? `Same amount, ${s.days} day(s) apart` : '',
        severity: explained || b.status === 'Review' ? 'review' : severityFor(b.amountNgn),
      };
    });

    const erpUnlinkedNgn = noStatement ? 0 : sum(erpUnlinkedRaw);
    const erpTimingNgn = sum(erpTiming);
    const bankUnlinkedNgn = sum(bankUnlinked);
    const matchedVarianceNgn = sum(matchedVariances);
    const movementDifferenceNgn = noStatement ? 0 : erpNetNgn - bankNetNgn;
    const unexplainedNgn = noStatement
      ? 0
      : movementDifferenceNgn - (erpUnlinkedNgn + erpTimingNgn - bankUnlinkedNgn - matchedVarianceNgn);

    const counts = (list) => ({
      exceptions: list.filter((x) => x.severity === 'exception').length,
      review: list.filter((x) => x.severity === 'review').length,
      small: list.filter((x) => x.severity === 'small').length,
      smallNgn: sum(list.filter((x) => x.severity === 'small')),
    });

    return {
      account: {
        id: acc.id,
        name: String(acc.name || '').trim(),
        bankName: String(acc.bankName || '').trim(),
        accNo: String(acc.accNo || '').trim(),
        type: String(acc.type || '').trim(),
      },
      isCash,
      hasBankStatement: !noStatement,
      coverage,
      erp: {
        openingNgn: erpOpeningNgn,
        buckets: Object.values(buckets),
        netNgn: erpNetNgn,
        closingNgn: erpClosingNgn,
        movementCount: period.length,
        storedBalanceNgn,
      },
      bank: {
        openingNgn: bankOpeningNgn,
        linesNetNgn: bankNetNgn,
        lineCount: bankPeriod.length,
        closingNgn: bankClosingNgn,
        statedClosingNgn,
        statedClosingDiffNgn: hasStatedClosing && hasOpening ? statedClosingNgn - bankClosingNgn : null,
      },
      differenceNgn: bankClosingNgn == null ? null : erpClosingNgn - bankClosingNgn,
      openingDifferenceNgn: bankOpeningNgn == null ? null : erpOpeningNgn - bankOpeningNgn,
      movementDifferenceNgn,
      reconciling: {
        erpUnlinkedNgn,
        erpTimingNgn: noStatement ? 0 : erpTimingNgn,
        bankUnlinkedNgn,
        matchedVarianceNgn,
        unexplainedNgn,
      },
      erpUnlinked,
      erpTiming: noStatement ? [] : erpTiming,
      bankUnlinked,
      matchedVariances,
      brokenLinks,
      counts: { erpUnlinked: counts(erpUnlinked), bankUnlinked: counts(bankUnlinked) },
      movements: period,
      bankLines: bankPeriod,
    };
  });

  return { startDate, endDate, pages };
}
