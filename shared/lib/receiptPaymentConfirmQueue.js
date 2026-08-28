/**
 * Finance desk: one confirm queue row per unconfirmed treasury split when a receipt has multiple payments.
 */

import { isReceiptPendingClearance } from './receiptClearance.js';

/** @param {object | null | undefined} movement treasury movement row */
export function isTreasurySplitFinanceConfirmed(movement) {
  const at = movement?.financeConfirmedAtISO ?? movement?.finance_confirmed_at_iso;
  return at != null && String(at).trim() !== '';
}

/**
 * LEDGER_RECEIPT inflows for a sales receipt mirror row.
 * @param {{ id?: string, ledgerEntryId?: string | null }} receiptRow
 * @param {object[]} treasuryMovements
 */
export function receiptTreasurySplitsForConfirm(receiptRow, treasuryMovements) {
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
        String(m?.sourceKind || m?.source_kind || '').trim() === 'LEDGER_RECEIPT' &&
        ids.has(String(m?.sourceId || m?.source_id || '').trim()) &&
        Number(m?.amountNgn ?? m?.amount_ngn) > 0 &&
        String(m?.type || '').trim() === 'RECEIPT_IN'
    )
    .slice()
    .sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || '')))
    .map((m) => ({
      movementId: m.id,
      treasuryAccountId: m.treasuryAccountId ?? m.treasury_account_id,
      accountName: String(m.accountName || m.account_name || '').trim(),
      accountType: String(m.accountType || m.account_type || '').trim(),
      bankName: String(m.bankName || m.bank_name || '').trim(),
      amountNgn: Math.round(Number(m.amountNgn ?? m.amount_ngn) || 0),
      postedAtISO: m.postedAtISO || m.posted_at_iso || '',
      reference: m.reference || '',
      financeConfirmedAtISO: m.financeConfirmedAtISO ?? m.finance_confirmed_at_iso ?? null,
    }));
}

/** Splits still awaiting finance confirm on this receipt. */
export function unconfirmedTreasurySplitsForReceipt(receiptRow, treasuryMovements) {
  return receiptTreasurySplitsForConfirm(receiptRow, treasuryMovements).filter(
    (s) => !isTreasurySplitFinanceConfirmed(s)
  );
}

export function allTreasurySplitsFinanceConfirmed(receiptRow, treasuryMovements) {
  const splits = receiptTreasurySplitsForConfirm(receiptRow, treasuryMovements);
  return splits.length > 0 && splits.every((s) => isTreasurySplitFinanceConfirmed(s));
}

/**
 * Expand pending receipts into desk confirm rows — one row per unconfirmed split when 2+ splits exist.
 * @param {object[]} receipts
 * @param {object[]} treasuryMovements
 */
export function expandReceiptsToPaymentConfirmQueue(receipts, treasuryMovements) {
  const out = [];
  for (const r of receipts || []) {
    if (!isReceiptPendingClearance(r)) continue;
    const pending = unconfirmedTreasurySplitsForReceipt(r, treasuryMovements);
    if (pending.length > 1) {
      for (const split of pending) {
        out.push({
          ...r,
          _confirmKind: 'payment_split',
          _movementId: split.movementId,
          _splitAmountNgn: split.amountNgn,
          _queueDisplayId: split.movementId,
          _parentReceiptId: r.id,
        });
      }
      continue;
    }
    if (pending.length === 1) {
      out.push({
        ...r,
        _confirmKind: 'receipt_single_split',
        _movementId: pending[0].movementId,
        _splitAmountNgn: pending[0].amountNgn,
      });
      continue;
    }
    out.push({ ...r, _confirmKind: 'receipt' });
  }
  return out;
}

/** Amount shown in the waiting queue for one confirm row (₦). */
export function paymentConfirmQueueRowAmountNgn(row) {
  if (row?._confirmKind === 'payment_split' || row?._confirmKind === 'receipt_single_split') {
    return Math.round(Number(row._splitAmountNgn) || 0);
  }
  return Math.round(Number(row?.cashReceivedNgn ?? row?.amountNgn) || 0);
}
