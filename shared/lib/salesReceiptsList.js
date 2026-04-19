/**
 * Merge imported/historical receipts with ledger RECEIPT rows for Sales UI and print history.
 */
import { loadLedgerEntries, amountDueOnQuotation } from './customerLedgerStore.js';
import { companionOverpayNgnByReceiptId } from './customerLedgerCore.js';
import { formatNgn } from './formatNgn.js';

function reversalTargetId(raw) {
  const m = String(raw ?? '').match(/REVERSAL_OF:([A-Za-z0-9-]+)/);
  return m ? m[1] : '';
}

function shortDateFromISO(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [, m, d] = s.split('-');
  if (!d || !m) return '—';
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1];
  return `${d} ${mo}`;
}

/** Cash actually received for a sales receipt (overpay splits use `cashReceivedNgn` from API / merge). */
export function receiptCashReceivedNgn(r) {
  if (!r) return 0;
  if (r.cashReceivedNgn != null) return Math.round(Number(r.cashReceivedNgn) || 0);
  return Math.round(Number(r.amountNgn ?? r.amount_ngn) || 0);
}

/** Map typo/graphical dashes to ASCII hyphen (aligned with server bank recon + Word/PDF paste). */
export function normalizeReceiptMatchDashes(s) {
  return String(s || '')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2212/g, '-');
}

/**
 * First token from bank reconciliation system match (aligned with server `firstSystemMatchToken`).
 * @param {string} [systemMatch]
 */
export function firstBankReconSystemMatchToken(systemMatch) {
  let raw = String(systemMatch ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
  if (!raw) return '';
  let chunk = String(raw.split(/\s+/)[0] || '').trim();
  for (const sep of ['·', '\u2219', '\u2022', '\u2023', '•']) {
    const i = chunk.indexOf(sep);
    if (i !== -1) chunk = chunk.slice(0, i).trim();
  }
  return chunk.trim();
}

/**
 * Find workspace sales receipt row by id or ledger_entry_id token from recon / paste.
 * @param {object[]} receipts
 * @param {string} token
 */
export function findSalesReceiptByMatchToken(receipts, token) {
  const t = normalizeReceiptMatchDashes(String(token || '').trim());
  if (!t) return null;
  const list = Array.isArray(receipts) ? receipts : [];
  return (
    list.find((r) => String(r.id || '') === t) ||
    list.find((r) => String(r.ledgerEntryId || '') === t) ||
    list.find((r) => String(r.id || '').toLowerCase() === t.toLowerCase()) ||
    list.find(
      (r) =>
        String(r.ledgerEntryId || '').trim() &&
        String(r.ledgerEntryId || '').toLowerCase() === t.toLowerCase()
    ) ||
    null
  );
}

/**
 * Inflows posted for this receipt — one row per treasury account split (`LEDGER_RECEIPT` movements).
 * @param {{ id?: string, ledgerEntryId?: string|null }} receiptRow
 * @param {object[]} treasuryMovements workspace `snapshot.treasuryMovements`
 */
export function receiptLedgerReceiptTreasurySplits(receiptRow, treasuryMovements) {
  if (!receiptRow) return [];
  const ids = new Set(
    [receiptRow.id, receiptRow.ledgerEntryId]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
  const mv = Array.isArray(treasuryMovements) ? treasuryMovements : [];
  return mv
    .filter(
      (m) =>
        String(m?.sourceKind || '').trim() === 'LEDGER_RECEIPT' &&
        ids.has(String(m?.sourceId || '').trim()) &&
        Number(m?.amountNgn) > 0
    )
    .slice()
    .sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')))
    .map((m) => ({
      movementId: m.id,
      treasuryAccountId: m.treasuryAccountId,
      accountLabel: [m.accountType, m.accountName].filter(Boolean).join(' — ') || '—',
      amountNgn: Math.round(Number(m.amountNgn) || 0),
      postedAtISO: m.postedAtISO || '',
      reference: m.reference || '',
    }));
}

function quotePaymentHint(quotation) {
  if (!quotation) return { badge: 'No quote link', sub: '' };
  const due = amountDueOnQuotation(quotation);
  if (due <= 0) {
    return { badge: 'Fully paid (ledger)', sub: 'Nothing left due on this quote' };
  }
  return {
    badge: `Balance due ${formatNgn(due)}`,
    sub: `Books show ${quotation.paymentStatus ?? '—'}`,
  };
}

/**
 * Rows for sidebar + main list: newest first. Ledger posts appear immediately after save.
 * @param {object[]} importedReceipts
 * @param {object[]} quotations
 * @param {number} [_ledgerEpoch] bump from parent to recompute
 */
export function mergeReceiptRowsForSales(importedReceipts, quotations, _ledgerEpoch = 0) {
  void _ledgerEpoch;
  const qMap = new Map((quotations || []).map((q) => [q.id, q]));
  const regById = new Map();
  const regByLedgerId = new Map();
  for (const r of importedReceipts || []) {
    if (r?.id) regById.set(String(r.id), r);
    if (r?.ledgerEntryId) regByLedgerId.set(String(r.ledgerEntryId), r);
  }
  const ledgerEntries = loadLedgerEntries();
  const companionOverpay = companionOverpayNgnByReceiptId(ledgerEntries);
  const reversedReceiptIds = new Set(
    ledgerEntries
      .filter((e) => e.type === 'RECEIPT_REVERSAL')
      .map((e) => reversalTargetId(e.bankReference || e.note))
      .filter(Boolean)
  );

  const ledgerRows = ledgerEntries
    .filter((e) => e.type === 'RECEIPT' && e.quotationRef && !reversedReceiptIds.has(e.id))
    .map((e) => {
      const q = qMap.get(e.quotationRef);
      const hint = quotePaymentHint(q);
      const dateISO = (e.atISO || '').slice(0, 10) || '';
      const mirror = regById.get(String(e.id)) || regByLedgerId.get(String(e.id));
      const alloc = Math.round(Number(e.amountNgn) || 0);
      const extra = companionOverpay.get(String(e.id)) || 0;
      const cash = Math.round(alloc + extra);
      return {
        id: e.id,
        source: 'ledger',
        customerID: e.customerID,
        customer: e.customerName || e.customerID,
        quotationRef: e.quotationRef,
        dateISO,
        date: shortDateFromISO(e.atISO),
        amountNgn: alloc,
        quotationAllocatedNgn: extra > 0 ? alloc : undefined,
        cashReceivedNgn: cash,
        amount: formatNgn(cash),
        status: 'Recorded',
        handledBy: '—',
        bankConfirmedAtISO: mirror?.bankConfirmedAtISO ?? null,
        bankConfirmedByUserId: mirror?.bankConfirmedByUserId ?? null,
        bankReceivedAmountNgn: mirror?.bankReceivedAmountNgn ?? null,
        financeDeliveryClearedAtISO: mirror?.financeDeliveryClearedAtISO ?? null,
        _ledgerEntry: e,
        _payBadge: hint.badge,
        _subLabel: 'From customer ledger',
        _detailNote: e.bankReference || e.note || '',
      };
    });

  const ledgerIds = new Set(ledgerRows.map((r) => r.id));

  const importedRows = (importedReceipts || [])
    .filter((r) => {
      if (String(r.status || '').toLowerCase() === 'reversed') return false;
      if (r.ledgerEntryId && reversedReceiptIds.has(String(r.ledgerEntryId))) return false;
      if (ledgerIds.has(r.id)) return false;
      if (r.ledgerEntryId && ledgerIds.has(r.ledgerEntryId)) return false;
      return true;
    })
    .map((r) => {
      const q = r.quotationRef ? qMap.get(r.quotationRef) : null;
      const hint = quotePaymentHint(q);
      const cash =
        r.cashReceivedNgn != null ? Math.round(Number(r.cashReceivedNgn) || 0) : Math.round(Number(r.amountNgn) || 0);
      return {
        ...r,
        source: 'imported',
        dateISO: r.dateISO || r.date || '',
        cashReceivedNgn: cash,
        amount: formatNgn(cash),
        bankConfirmedAtISO: r.bankConfirmedAtISO ?? null,
        bankConfirmedByUserId: r.bankConfirmedByUserId ?? null,
        bankReceivedAmountNgn: r.bankReceivedAmountNgn ?? null,
        financeDeliveryClearedAtISO: r.financeDeliveryClearedAtISO ?? null,
        _payBadge: hint.badge,
        _subLabel: 'Imported history row',
        _detailNote: r.method ? `Method: ${r.method}` : '',
      };
    });

  const merged = [...ledgerRows, ...importedRows];
  merged.sort((a, b) => String(b.dateISO || '').localeCompare(String(a.dateISO || '')));
  return merged;
}

/**
 * Chronological history of payments on one quotation (ledger + imported), for receipt printout.
 * @param {string} quotationId
 * @param {object[]} importedReceipts
 */
export function quotationReceiptPrintHistory(quotationId, importedReceipts = []) {
  if (!quotationId) return [];
  const ledgerEntries = loadLedgerEntries();
  const reversedReceiptIds = new Set(
    ledgerEntries
      .filter((e) => e.type === 'RECEIPT_REVERSAL')
      .map((e) => reversalTargetId(e.bankReference || e.note))
      .filter(Boolean)
  );

  const companionPrint = companionOverpayNgnByReceiptId(ledgerEntries);
  const ledger = ledgerEntries
    .filter((e) => e.type === 'RECEIPT' && e.quotationRef === quotationId && !reversedReceiptIds.has(e.id))
    .map((e) => {
      const alloc = Math.round(Number(e.amountNgn) || 0);
      const extra = companionPrint.get(String(e.id)) || 0;
      return {
        id: e.id,
        dateStr: formatPrintDate((e.atISO || '').slice(0, 10)),
        iso: (e.atISO || '').slice(0, 10),
        amountNgn: Math.round(alloc + extra),
        source: 'Ledger',
        detail: e.bankReference || e.note || '—',
      };
    });

  const imported = (importedReceipts || [])
    .filter(
      (r) =>
        r.quotationRef === quotationId &&
        String(r.status || '').toLowerCase() !== 'reversed' &&
        !(r.ledgerEntryId && reversedReceiptIds.has(String(r.ledgerEntryId)))
    )
    .map((r) => ({
      id: r.id,
      dateStr: formatPrintDate(r.dateISO) || r.date || '—',
      iso: r.dateISO || '',
      amountNgn:
        r.cashReceivedNgn != null
          ? Math.round(Number(r.cashReceivedNgn) || 0)
          : Math.round(Number(r.amountNgn) || 0),
      source: 'Imported',
      detail: r.method ? `Method: ${r.method}` : 'Imported receipt',
    }));

  const byId = new Map();
  imported.forEach((row) => byId.set(row.id, row));
  ledger.forEach((row) => byId.set(row.id, row));
  return [...byId.values()].sort((a, b) => String(a.iso || a.dateStr).localeCompare(String(b.iso || b.dateStr)));
}

function formatPrintDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
