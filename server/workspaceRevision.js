import crypto from 'node:crypto';
import { branchWhere } from './readModel.js';
import { jsonWeakEtag } from './httpEtag.js';

/** @type {ReadonlyArray<[table: string, dateCol: string]>} */
const REVISION_TABLES = [
  ['quotations', 'date_iso'],
  ['sales_receipts', 'date_iso'],
  ['customers', 'last_activity_iso'],
  ['cutting_lists', 'date_iso'],
  ['production_jobs', 'created_at_iso'],
  ['purchase_orders', 'order_date_iso'],
  ['coil_lots', 'received_at_iso'],
  ['ledger_entries', 'at_iso'],
  ['treasury_movements', 'at_iso'],
  ['expenses', 'date'],
  ['payment_requests', 'request_date'],
  ['work_items', 'updated_at_iso'],
  // Credit apply / payout update paid + credit without always bumping dates — fingerprint sums too.
  ['customer_refunds', 'requested_at_iso'],
];

/**
 * Cheap workspace revision — avoids building full bootstrap on poll when nothing changed.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function buildWorkspaceRevision(db, branchScope = 'ALL') {
  const parts = [`scope:${branchScope}`];
  for (const [table, dateCol] of REVISION_TABLES) {
    try {
      const b = branchWhere(db, table, branchScope);
      // Refunds: credit/payout can change without date bumps.
      // Cutting lists: Draft→Waiting (Save list) keeps the same date_iso — fingerprint status.
      const moneyExtra =
        table === 'customer_refunds'
          ? `, COALESCE(SUM(credit_applied_ngn),0) AS credit_sum, COALESCE(SUM(paid_amount_ngn),0) AS paid_sum`
          : table === 'cutting_lists'
            ? `, COALESCE(SUM(CASE WHEN TRIM(status) = 'Draft' THEN 1 ELSE 0 END),0) AS draft_n, COALESCE(SUM(CASE WHEN TRIM(status) = 'Waiting' THEN 1 ELSE 0 END),0) AS wait_n, COALESCE(SUM(print_count),0) AS print_sum`
            : '';
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c, MAX(${dateCol}) AS m${moneyExtra} FROM ${table} WHERE 1=1${b.sql}`
        )
        .get(...b.args);
      const base = `${table}:${row?.c ?? 0}:${row?.m ?? ''}`;
      parts.push(
        table === 'customer_refunds'
          ? `${base}:${row?.credit_sum ?? 0}:${row?.paid_sum ?? 0}`
          : table === 'cutting_lists'
            ? `${base}:${row?.draft_n ?? 0}:${row?.wait_n ?? 0}:${row?.print_sum ?? 0}`
            : base
      );
    } catch {
      parts.push(`${table}:na`);
    }
  }
  const revision = crypto.createHash('sha256').update(parts.join('|')).digest('base64url').slice(0, 24);
  return {
    ok: true,
    revision,
    branchScope,
    checkedAtIso: new Date().toISOString(),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} branchScope
 */
export function workspaceRevisionEtag(db, branchScope = 'ALL') {
  return jsonWeakEtag(buildWorkspaceRevision(db, branchScope));
}
