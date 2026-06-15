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
      const row = db
        .prepare(`SELECT COUNT(*) AS c, MAX(${dateCol}) AS m FROM ${table} WHERE 1=1${b.sql}`)
        .get(...b.args);
      parts.push(`${table}:${row?.c ?? 0}:${row?.m ?? ''}`);
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
