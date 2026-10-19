/**
 * Phase 3 controls (owner, 2026-10-14): read-side lists and the receipt advance check.
 * Rules live in shared/lib/controlsPhase3.js.
 */
import {
  balanceDueAfterProduction,
  LOCKED_PERIOD_CHANGE_FLAG,
  productionGatePaid,
  receiptLinesRepeatingAdvance,
} from '../shared/lib/controlsPhase3.js';
import { advanceBalanceNgnForCustomerDb } from './writeOps.js';

const inList = (n) => Array.from({ length: n }, () => '?').join(',');

function chunked(ids, size = 500) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

function allIn(db, sql, ids) {
  return chunked(ids).flatMap((part) => db.prepare(sql.replace('(?)', `(${inList(part.length)})`)).all(...part));
}

/**
 * Produced jobs whose quotation is under 100% paid (receipts + advance applied − reversals), with the amount owed.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope] branch id or 'ALL'
 */
export function listBalanceDueAfterProduction(db, branchScope = 'ALL') {
  const scoped = branchScope && branchScope !== 'ALL';
  const jobs = db
    .prepare(
      `SELECT job_id, quotation_ref, status, completed_at_iso, customer_name FROM production_jobs
       WHERE LOWER(status) = 'completed' ${scoped ? 'AND branch_id = ?' : ''}`
    )
    .all(...(scoped ? [branchScope] : []));
  const quoteIds = [...new Set(jobs.map((j) => String(j.quotation_ref || '').trim()).filter(Boolean))];
  if (!quoteIds.length) return { rows: [], totalOwedNgn: 0 };

  const quotations = allIn(db, `SELECT id, customer_name, total_ngn FROM quotations WHERE id IN (?)`, quoteIds);
  const receipts = allIn(
    db,
    `SELECT id, ledger_entry_id, quotation_ref, amount_ngn, status FROM sales_receipts WHERE quotation_ref IN (?)`,
    quoteIds
  ).map((r) => ({
    id: r.id,
    ledgerEntryId: r.ledger_entry_id,
    quotationRef: r.quotation_ref,
    amountNgn: r.amount_ngn,
    status: r.status,
  }));
  const ledgerEntries = allIn(
    db,
    `SELECT type, quotation_ref, amount_ngn FROM ledger_entries
     WHERE type IN ('ADVANCE_APPLIED', 'OVERPAY_APPLIED') AND quotation_ref IN (?)`,
    quoteIds
  ).map((e) => ({ type: e.type, quotationRef: e.quotation_ref, amountNgn: e.amount_ngn }));
  const sourceIds = [...new Set(receipts.flatMap((r) => [r.id, r.ledgerEntryId]).filter(Boolean).map(String))];
  const ins = sourceIds.length
    ? allIn(
        db,
        `SELECT id, type, source_id, amount_ngn, reverses_movement_id FROM treasury_movements
         WHERE type = 'RECEIPT_IN' AND source_id IN (?)`,
        sourceIds
      )
    : [];
  const revs = ins.length
    ? allIn(
        db,
        `SELECT id, type, source_id, amount_ngn, reverses_movement_id FROM treasury_movements
         WHERE reverses_movement_id IN (?)`,
        ins.map((m) => m.id)
      )
    : [];
  const treasuryMovements = [...ins, ...revs].map((m) => ({
    id: m.id,
    type: m.type,
    sourceId: m.source_id,
    amountNgn: m.amount_ngn,
    reversesMovementId: m.reverses_movement_id,
  }));

  const paidByQuotation = new Map(
    quotations.map((q) => [
      q.id,
      productionGatePaid({ quotationRef: q.id, receipts, ledgerEntries, treasuryMovements }).paidNgn,
    ])
  );
  return balanceDueAfterProduction({
    jobs: jobs.map((j) => ({
      jobID: j.job_id,
      quotationRef: j.quotation_ref,
      status: j.status,
      completedAtISO: j.completed_at_iso,
      customerName: j.customer_name,
    })),
    quotations: quotations.map((q) => ({ id: q.id, customerName: q.customer_name, totalNgn: q.total_ngn })),
    paidByQuotation,
  });
}

/**
 * Audit rows flagged "Locked-period change" (edits to records dated in a locked month).
 * @param {import('better-sqlite3').Database} db
 * @param {{ fromISO?: string, toISO?: string, limit?: number }} [opts]
 */
export function listLockedPeriodChanges(db, opts = {}) {
  const args = [];
  let sql = `SELECT id, occurred_at_iso, actor_name, action, entity_kind, entity_id, note, details_json
    FROM audit_log WHERE details_json LIKE ?`;
  args.push('%"lockedPeriodChange"%');
  if (opts.fromISO) {
    sql += ` AND occurred_at_iso >= ?`;
    args.push(String(opts.fromISO).slice(0, 10));
  }
  if (opts.toISO) {
    sql += ` AND occurred_at_iso < ?`;
    args.push(`${String(opts.toISO).slice(0, 10)}T99`);
  }
  const limit = Math.min(2000, Math.max(1, Math.floor(Number(opts.limit) || 500)));
  sql += ` ORDER BY occurred_at_iso DESC, id DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...args).map((r) => {
    let details = {};
    try {
      details = JSON.parse(r.details_json || '{}') || {};
    } catch {
      details = {};
    }
    const flag = details.lockedPeriodChange || {};
    return {
      auditId: r.id,
      occurredAtISO: r.occurred_at_iso,
      actorName: r.actor_name || '',
      action: r.action,
      entityKind: r.entity_kind || '',
      entityId: r.entity_id || '',
      periodKey: flag.periodKey || '',
      recordDateISO: flag.recordDateISO || '',
      note: r.note || '',
    };
  });
  return { flag: LOCKED_PERIOD_CHANGE_FLAG, rows };
}

/**
 * Treasury lines on a new receipt that repeat an unapplied advance already in treasury (ADVANCE_IN).
 * @param {import('better-sqlite3').Database} db
 * @param {{ customerID: string, branchId?: string, lines: { amountNgn: number }[] }} input
 */
export function receiptAdvanceRepeats(db, { customerID, branchId, lines }) {
  const advanceBalanceNgn = advanceBalanceNgnForCustomerDb(db, customerID, branchId);
  if (advanceBalanceNgn <= 0) return [];
  const advanceMovements = db
    .prepare(
      `SELECT m.id, m.amount_ngn, m.posted_at_iso FROM treasury_movements m
       WHERE m.type = 'ADVANCE_IN' AND m.counterparty_id = ?
         AND NOT EXISTS (SELECT 1 FROM treasury_movements r WHERE r.reverses_movement_id = m.id)
       ORDER BY m.posted_at_iso DESC`
    )
    .all(String(customerID || ''))
    .map((m) => ({ id: m.id, amountNgn: m.amount_ngn, postedAtISO: m.posted_at_iso }));
  return receiptLinesRepeatingAdvance({ lines, advanceMovements, advanceBalanceNgn });
}
