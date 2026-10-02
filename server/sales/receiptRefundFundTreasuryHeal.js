/**
 * Old cashier confirms applied refund fund on the receipt but left the till account
 * showing the payment method Sales assigned at registration. Re-run the same unwind
 * the confirm path uses now: till reversal, method, GL cash, and deposit link.
 */
import { unwindRefundFundedReceiptEffectsTx } from '../writeOps.js';

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function treasuryNetNgn(db, receiptId, ledgerEntryId) {
  const ids = [...new Set([String(receiptId || '').trim(), String(ledgerEntryId || '').trim()].filter(Boolean))];
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s
         FROM treasury_movements
         WHERE source_kind = 'LEDGER_RECEIPT'
           AND source_id IN (${ph})
           AND type IN ('RECEIPT_IN', 'RECEIPT_REVERSAL_OUT')`
      )
      .get(...ids);
    return roundMoney(row?.s);
  } catch {
    return 0;
  }
}

function hasDepositLink(db, ledgerEntryId) {
  const id = String(ledgerEntryId || '').trim();
  if (!id) return false;
  try {
    const row = db
      .prepare(`SELECT 1 AS ok FROM bank_deposit_allocations WHERE allocated_to_id = ? LIMIT 1`)
      .get(id);
    return Boolean(row);
  } catch {
    return false;
  }
}

function methodStillOriginal(method) {
  return String(method || '').trim().toLowerCase() !== 'refund fund';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ limit?: number, receiptIds?: string[], customerId?: string, branchId?: string }} [opts]
 */
export function listReceiptsNeedingRefundFundTreasuryHeal(db, opts = {}) {
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const onlyIds = Array.isArray(opts.receiptIds)
    ? opts.receiptIds.map((id) => String(id || '').trim()).filter(Boolean)
    : null;
  const customerId = String(opts.customerId || '').trim();
  const branchId = String(opts.branchId || '').trim();

  let rows = [];
  try {
    const args = [];
    let sql = `
      SELECT sr.id, sr.ledger_entry_id, sr.bank_received_amount_ngn, sr.method, sr.customer_id, sr.branch_id
      FROM sales_receipts sr
      WHERE TRIM(LOWER(COALESCE(sr.status, ''))) NOT IN ('reversed')
        AND sr.bank_received_amount_ngn IS NOT NULL
        AND (
          (sr.finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(sr.finance_reconciliation_saved_at_iso) != '')
          OR TRIM(LOWER(COALESCE(sr.status, ''))) IN ('cleared', 'confirmed')
        )
        AND EXISTS (
          SELECT 1 FROM refund_credit_applications a
          WHERE a.source_receipt_id = sr.id
            AND LOWER(TRIM(COALESCE(a.status, ''))) != 'reversed'
        )
        AND (
          (
            sr.bank_received_amount_ngn <= 0
            AND LOWER(TRIM(COALESCE(sr.method, ''))) != 'refund fund'
          )
          OR (
            SELECT COALESCE(SUM(tm.amount_ngn), 0)
            FROM treasury_movements tm
            WHERE tm.source_kind = 'LEDGER_RECEIPT'
              AND tm.source_id IN (sr.id, IFNULL(sr.ledger_entry_id, sr.id))
              AND tm.type IN ('RECEIPT_IN', 'RECEIPT_REVERSAL_OUT')
          ) > sr.bank_received_amount_ngn
          OR (
            sr.bank_received_amount_ngn <= 0
            AND EXISTS (
              SELECT 1 FROM bank_deposit_allocations b
              WHERE b.allocated_to_id IN (sr.id, IFNULL(sr.ledger_entry_id, sr.id))
            )
          )
        )`;
    if (onlyIds?.length) {
      sql += ` AND sr.id IN (${onlyIds.map(() => '?').join(',')})`;
      args.push(...onlyIds);
    }
    if (customerId) {
      sql += ` AND sr.customer_id = ?`;
      args.push(customerId);
    }
    if (branchId && branchId !== 'ALL') {
      sql += ` AND sr.branch_id = ?`;
      args.push(branchId);
    }
    sql += ` ORDER BY sr.date_iso ASC, sr.id ASC LIMIT ${limit}`;
    rows = db.prepare(sql).all(...args);
  } catch {
    return [];
  }

  return rows.filter((row) => {
    const keep = roundMoney(row.bank_received_amount_ngn);
    const net = treasuryNetNgn(db, row.id, row.ledger_entry_id);
    if (net > keep) return true;
    if (keep <= 0 && methodStillOriginal(row.method)) return true;
    if (keep <= 0 && hasDepositLink(db, row.ledger_entry_id || row.id)) return true;
    return false;
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {object | null} actor
 */
export function healRefundFundedReceiptEffectsTx(db, receiptId, actor = null) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const [row] = listReceiptsNeedingRefundFundTreasuryHeal(db, { receiptIds: [id], limit: 1 });
  if (!row) return { ok: false, code: 'NOT_NEEDED', error: 'Receipt does not need refund-fund till heal.' };
  const keep = roundMoney(row.bank_received_amount_ngn);
  return unwindRefundFundedReceiptEffectsTx(db, id, keep, actor, { alignBooks: true });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {{ limit?: number, receiptIds?: string[], customerId?: string, branchId?: string, dryRun?: boolean }} [opts]
 */
export function healRefundFundedReceiptEffects(db, actor = null, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const candidates = listReceiptsNeedingRefundFundTreasuryHeal(db, opts);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      count: candidates.length,
      candidates: candidates.map((row) => ({
        receiptId: row.id,
        bankReceivedAmountNgn: roundMoney(row.bank_received_amount_ngn),
        method: row.method || '',
      })),
    };
  }
  const results = [];
  for (const row of candidates) {
    const keep = roundMoney(row.bank_received_amount_ngn);
    try {
      let result = { ok: false };
      db.transaction(() => {
        result = unwindRefundFundedReceiptEffectsTx(db, row.id, keep, actor, { alignBooks: true });
        if (!result.ok) throw new Error(result.error || 'Refund-fund till heal failed.');
      })();
      results.push({ ...result, receiptId: row.id });
    } catch (e) {
      results.push({ ok: false, receiptId: row.id, error: String(e?.message || e) });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    count: results.length,
    healed: results.filter((r) => r.ok).length,
    failures: results.filter((r) => !r.ok),
    results,
  };
}
