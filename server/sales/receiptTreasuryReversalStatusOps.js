/**
 * A receipt whose bank line has been fully reversed must not stay Cleared.
 * This updates the receipt status only. It does not post a second treasury reversal.
 * Partial reversals stay Cleared; cash reports count only the amount still open.
 */
import { appendAuditLog } from '../controlOps.js';
import { tableExists } from '../ap2ReceivedBasisOps.js';
import { syncQuotationPaidFromReceipts } from '../writeOps.js';
import { selectReceiptsToMarkReversed } from '../../shared/lib/salesPhase1Recognition.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id?: string, name?: string } | null} [actor]
 */
export function markClearedReceiptsWithFullyReversedTreasury(db, actor = null) {
  const receipts = db
    .prepare(
      `SELECT id, ledger_entry_id, customer_id, customer_name, quotation_ref, amount_ngn, status
       FROM sales_receipts
       WHERE LOWER(TRIM(status)) IN ('cleared', 'confirmed')`
    )
    .all()
    .map((row) => ({
      id: row.id,
      ledgerEntryId: row.ledger_entry_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      quotationRef: row.quotation_ref,
      amountNgn: row.amount_ngn,
      status: row.status,
    }));

  const movements = db
    .prepare(
      `SELECT id, source_id, type, amount_ngn, reverses_movement_id
       FROM treasury_movements
       WHERE source_kind = 'LEDGER_RECEIPT'
         AND type IN ('RECEIPT_IN', 'RECEIPT_REVERSAL_OUT')`
    )
    .all()
    .map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      type: row.type,
      amountNgn: row.amount_ngn,
      reversesMovementId: row.reverses_movement_id,
    }));

  const depositAllocations =
    tableExists(db, 'bank_deposit_allocations') && tableExists(db, 'bank_deposits')
      ? db
          .prepare(
            `SELECT a.allocated_to_id AS receiptId, a.amount_ngn AS amountNgn, d.bank_date_iso AS bankDateISO,
                    d.status AS depositStatus, d.reversed_at_iso AS reversedAtISO, d.id AS depositId, a.id AS allocationId
             FROM bank_deposit_allocations a
             JOIN bank_deposits d ON d.id = a.bank_deposit_id
             WHERE a.allocated_to_kind = 'receipt'`
          )
          .all()
      : [];

  const victims = selectReceiptsToMarkReversed(receipts, movements, depositAllocations);
  if (!victims.length) return { ok: true, updated: [] };

  const update = db.prepare(
    `UPDATE sales_receipts SET status = 'Reversed'
     WHERE id = ? AND LOWER(TRIM(status)) IN ('cleared', 'confirmed')`
  );
  const changed = [];
  const apply = db.transaction(() => {
    for (const row of victims) {
      const result = update.run(row.id);
      if (result.changes) changed.push(row);
    }
    const quotes = [...new Set(changed.map((row) => row.quotationRef).filter(Boolean))];
    for (const quotationRef of quotes) {
      syncQuotationPaidFromReceipts(db, quotationRef);
    }
  });
  apply();

  for (const row of changed) {
    appendAuditLog(db, {
      actor: actor?.id ? actor : { name: actor?.name || 'Sales phase 1' },
      action: 'receipt.treasury_reversal_status',
      entityKind: 'sales_receipt',
      entityId: row.id,
      note: `Marked Reversed. The treasury line was already reversed, so this receipt cannot stay Cleared. Quotation ${row.quotationRef || '—'}, ${row.customerName || ''}.`,
      details: {
        quotationRef: row.quotationRef,
        amountNgn: row.amountNgn,
        netNgn: row.netNgn,
        reversedNgn: row.reversedNgn,
      },
    });
  }

  return { ok: true, updated: changed };
}

/**
 * Put a receipt back to Cleared when a bank deposit, not its reversed treasury line, is the funding.
 * Does not post treasury. The deposit line stays the bank record.
 * @param {import('better-sqlite3').Database} db
 * @param {{ receiptId: string, depositId: string, actor?: { id?: string, name?: string } }} opts
 */
export function reinstateDepositFundedReceipt(db, opts) {
  const receiptId = String(opts?.receiptId || '').trim();
  const depositId = String(opts?.depositId || '').trim();
  if (!receiptId || !depositId) return { ok: false, error: 'Receipt and deposit are required.' };

  const receipt = db
    .prepare(`SELECT id, status, quotation_ref, customer_name, amount_ngn FROM sales_receipts WHERE id = ?`)
    .get(receiptId);
  if (!receipt) return { ok: false, error: 'Receipt not found.' };
  if (String(receipt.status || '').trim().toLowerCase() !== 'reversed') {
    return { ok: true, updated: false, status: receipt.status };
  }

  const allocation = db
    .prepare(
      `SELECT a.id, a.amount_ngn, d.bank_date_iso, d.amount_ngn AS deposit_amount, d.status
       FROM bank_deposit_allocations a
       JOIN bank_deposits d ON d.id = a.bank_deposit_id
       WHERE a.bank_deposit_id = ? AND a.allocated_to_kind = 'receipt' AND a.allocated_to_id = ?
         AND (d.reversed_at_iso IS NULL OR TRIM(d.reversed_at_iso) = '')`
    )
    .get(depositId, receiptId);
  if (!allocation) return { ok: false, error: 'No live deposit allocation funds this receipt.' };

  const result = db
    .prepare(`UPDATE sales_receipts SET status = 'Cleared' WHERE id = ? AND LOWER(TRIM(status)) = 'reversed'`)
    .run(receiptId);
  if (!result.changes) return { ok: true, updated: false, status: receipt.status };

  if (receipt.quotation_ref) syncQuotationPaidFromReceipts(db, receipt.quotation_ref);

  const actor = opts.actor?.id ? opts.actor : { name: opts.actor?.name || 'Sales phase 1' };
  appendAuditLog(db, {
    actor,
    action: 'receipt.deposit_funding_reinstated',
    entityKind: 'sales_receipt',
    entityId: receiptId,
    note: `Reinstated to Cleared. Funding is bank deposit ${depositId} (₦${Number(allocation.deposit_amount) || 0} on ${allocation.bank_date_iso}, ₦${Number(allocation.amount_ngn) || 0} allocated). The receipt treasury line stays reversed because it duplicated that deposit. Quotation ${receipt.quotation_ref || '—'}, ${receipt.customer_name || ''}.`,
    details: {
      depositId,
      allocationId: allocation.id,
      allocatedNgn: allocation.amount_ngn,
      depositAmountNgn: allocation.deposit_amount,
      bankDateISO: allocation.bank_date_iso,
      quotationRef: receipt.quotation_ref,
    },
  });

  return { ok: true, updated: true, status: 'Cleared', quotationRef: receipt.quotation_ref };
}
