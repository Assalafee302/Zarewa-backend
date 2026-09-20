/**
 * Layer 1 money-event export for an external accounting system.
 *
 * This is not a journal dump. It streams operational cash and recognition events
 * (treasury, customer ledger, GRNs, completed production, payroll runs) so another
 * product can book GL. Creditors/debtors desks stay in Zarewa.
 */

import { isGlPostingEnabled } from './glPostingGate.js';

export const ACCOUNTING_MONEY_EVENT_KINDS = Object.freeze([
  'TREASURY_MOVEMENT',
  'LEDGER_ENTRY',
  'INVENTORY_RECEIPT',
  'PRODUCTION_COMPLETE',
  'PAYROLL_RUN',
]);

const EXPORT_DEFAULT_LIMIT = 200;
const EXPORT_MAX_LIMIT = 2000;
const SOURCE_FETCH_CAP = 5000;

function isoDay(value) {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function nextIsoDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

function clampExportLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return EXPORT_DEFAULT_LIMIT;
  return Math.min(EXPORT_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function parseKinds(raw) {
  if (raw == null || String(raw).trim() === '' || String(raw).trim().toUpperCase() === 'ALL') {
    return new Set(ACCOUNTING_MONEY_EVENT_KINDS);
  }
  const wanted = String(raw)
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
  const set = new Set();
  for (const k of wanted) {
    if (ACCOUNTING_MONEY_EVENT_KINDS.includes(k)) set.add(k);
  }
  return set.size ? set : new Set(ACCOUNTING_MONEY_EVENT_KINDS);
}

function parseCursor(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const idx = s.indexOf('::');
  if (idx <= 0) return null;
  const occurredAtISO = s.slice(0, idx);
  const eventId = s.slice(idx + 2);
  if (!occurredAtISO || !eventId) return null;
  return { occurredAtISO, eventId };
}

function eventCursor(ev) {
  return `${ev.occurredAtISO}::${ev.eventId}`;
}

function afterCursor(ev, cursor) {
  if (!cursor) return true;
  if (ev.occurredAtISO > cursor.occurredAtISO) return true;
  if (ev.occurredAtISO < cursor.occurredAtISO) return false;
  return ev.eventId > cursor.eventId;
}

function moneyEvent(kind, id, occurredAtISO, amountNgn, branchId, payload) {
  return {
    eventKind: kind,
    eventId: `${kind}:${id}`,
    occurredAtISO: String(occurredAtISO || ''),
    amountNgn: Math.round(Number(amountNgn) || 0),
    branchId: branchId != null && String(branchId).trim() ? String(branchId).trim() : null,
    payload,
  };
}

function loadTreasury(db, startDate, endExclusive, branchScope) {
  const params = [startDate, endExclusive];
  let branchSql = '';
  if (branchScope && branchScope !== 'ALL') {
    branchSql = ' AND ta.branch_id = ?';
    params.push(branchScope);
  }
  params.push(SOURCE_FETCH_CAP);
  return db
    .prepare(
      `SELECT tm.id, tm.posted_at_iso, tm.type, tm.treasury_account_id, tm.amount_ngn, tm.reference,
              tm.counterparty_kind, tm.counterparty_id, tm.counterparty_name, tm.source_kind, tm.source_id,
              tm.note, tm.reverses_movement_id, tm.batch_id, ta.branch_id, ta.name AS treasury_account_name
       FROM treasury_movements tm
       INNER JOIN treasury_accounts ta ON ta.id = tm.treasury_account_id
       WHERE tm.posted_at_iso >= ? AND tm.posted_at_iso < ?${branchSql}
       ORDER BY tm.posted_at_iso ASC, tm.id ASC
       LIMIT ?`
    )
    .all(...params)
    .map((row) =>
      moneyEvent('TREASURY_MOVEMENT', row.id, row.posted_at_iso, row.amount_ngn, row.branch_id, {
        type: row.type,
        treasuryAccountId: row.treasury_account_id,
        treasuryAccountName: row.treasury_account_name,
        reference: row.reference,
        counterpartyKind: row.counterparty_kind,
        counterpartyId: row.counterparty_id,
        counterpartyName: row.counterparty_name,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        note: row.note,
        reversesMovementId: row.reverses_movement_id,
        batchId: row.batch_id,
      })
    );
}

function loadLedger(db, startDate, endExclusive, branchScope) {
  const params = [startDate, endExclusive];
  let branchSql = '';
  if (branchScope && branchScope !== 'ALL') {
    branchSql = ' AND branch_id = ?';
    params.push(branchScope);
  }
  params.push(SOURCE_FETCH_CAP);
  return db
    .prepare(
      `SELECT id, at_iso, type, customer_id, customer_name, amount_ngn, quotation_ref,
              payment_method, bank_reference, purpose, note, branch_id
       FROM ledger_entries
       WHERE at_iso >= ? AND at_iso < ?${branchSql}
       ORDER BY at_iso ASC, id ASC
       LIMIT ?`
    )
    .all(...params)
    .map((row) =>
      moneyEvent('LEDGER_ENTRY', row.id, row.at_iso, row.amount_ngn, row.branch_id, {
        type: row.type,
        customerId: row.customer_id,
        customerName: row.customer_name,
        quotationRef: row.quotation_ref,
        paymentMethod: row.payment_method,
        bankReference: row.bank_reference,
        purpose: row.purpose,
        note: row.note,
      })
    );
}

function loadGrn(db, startDate, endExclusive) {
  return db
    .prepare(
      `SELECT coil_no, po_id, supplier_id, supplier_name, received_at_iso, landed_cost_ngn,
              weight_kg, qty_received, product_id
       FROM coil_lots
       WHERE received_at_iso >= ? AND received_at_iso < ?
         AND COALESCE(landed_cost_ngn, 0) > 0
       ORDER BY received_at_iso ASC, coil_no ASC
       LIMIT ?`
    )
    .all(startDate, endExclusive, SOURCE_FETCH_CAP)
    .map((row) =>
      moneyEvent('INVENTORY_RECEIPT', row.coil_no, row.received_at_iso, row.landed_cost_ngn, null, {
        coilNo: row.coil_no,
        poId: row.po_id,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        productId: row.product_id,
        weightKg: row.weight_kg,
        qtyReceived: row.qty_received,
      })
    );
}

function loadProduction(db, startDate, endExclusive) {
  return db
    .prepare(
      `SELECT job_id, quotation_ref, customer_id, customer_name, completed_at_iso,
              actual_meters, actual_weight_kg, status
       FROM production_jobs
       WHERE status = 'Completed'
         AND completed_at_iso IS NOT NULL
         AND completed_at_iso >= ? AND completed_at_iso < ?
       ORDER BY completed_at_iso ASC, job_id ASC
       LIMIT ?`
    )
    .all(startDate, endExclusive, SOURCE_FETCH_CAP)
    .map((row) =>
      moneyEvent('PRODUCTION_COMPLETE', row.job_id, row.completed_at_iso, 0, null, {
        quotationRef: row.quotation_ref,
        customerId: row.customer_id,
        customerName: row.customer_name,
        actualMeters: row.actual_meters,
        actualWeightKg: row.actual_weight_kg,
      })
    );
}

function loadPayroll(db, startDate, endExclusive) {
  return db
    .prepare(
      `SELECT r.id, r.period_yyyymm, r.status, r.created_at_iso,
              COALESCE(SUM(l.gross_ngn), 0) AS gross_ngn,
              COALESCE(SUM(l.bonus_ngn), 0) AS bonus_ngn,
              COALESCE(SUM(l.tax_ngn), 0) AS tax_ngn,
              COALESCE(SUM(l.pension_ngn), 0) AS pension_ngn,
              COALESCE(SUM(l.net_ngn), 0) AS net_ngn
       FROM hr_payroll_runs r
       LEFT JOIN hr_payroll_lines l ON l.run_id = r.id
       WHERE r.status IN ('locked', 'paid')
         AND r.created_at_iso >= ? AND r.created_at_iso < ?
       GROUP BY r.id, r.period_yyyymm, r.status, r.created_at_iso
       ORDER BY r.created_at_iso ASC, r.id ASC
       LIMIT ?`
    )
    .all(startDate, endExclusive, SOURCE_FETCH_CAP)
    .map((row) =>
      moneyEvent('PAYROLL_RUN', row.id, row.created_at_iso, row.net_ngn, null, {
        periodYyyymm: row.period_yyyymm,
        status: row.status,
        grossNgn: Math.round(Number(row.gross_ngn) || 0),
        bonusNgn: Math.round(Number(row.bonus_ngn) || 0),
        taxNgn: Math.round(Number(row.tax_ngn) || 0),
        pensionNgn: Math.round(Number(row.pension_ngn) || 0),
        netNgn: Math.round(Number(row.net_ngn) || 0),
      })
    );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   startDate?: string,
 *   endDate?: string,
 *   kinds?: string,
 *   limit?: number,
 *   after?: string,
 *   branchScope?: string,
 * }} [opts]
 */
export function listAccountingMoneyEvents(db, opts = {}) {
  const startDate = isoDay(opts.startDate);
  if (!startDate) {
    return { ok: false, error: 'startDate is required (YYYY-MM-DD).', code: 'EXPORT_DATE' };
  }
  const endDate = isoDay(opts.endDate) || startDate;
  if (endDate < startDate) {
    return { ok: false, error: 'endDate must be on or after startDate.', code: 'EXPORT_DATE' };
  }
  const endExclusive = nextIsoDay(endDate);
  const kinds = parseKinds(opts.kinds);
  const limit = clampExportLimit(opts.limit);
  const cursor = parseCursor(opts.after);
  const branchScope = String(opts.branchScope || 'ALL').trim() || 'ALL';

  /** @type {ReturnType<typeof moneyEvent>[]} */
  let events = [];
  try {
    if (kinds.has('TREASURY_MOVEMENT')) {
      events = events.concat(loadTreasury(db, startDate, endExclusive, branchScope));
    }
    if (kinds.has('LEDGER_ENTRY')) {
      events = events.concat(loadLedger(db, startDate, endExclusive, branchScope));
    }
    if (kinds.has('INVENTORY_RECEIPT')) {
      events = events.concat(loadGrn(db, startDate, endExclusive));
    }
    if (kinds.has('PRODUCTION_COMPLETE')) {
      events = events.concat(loadProduction(db, startDate, endExclusive));
    }
    if (kinds.has('PAYROLL_RUN')) {
      events = events.concat(loadPayroll(db, startDate, endExclusive));
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e), code: 'EXPORT_QUERY' };
  }

  events.sort((a, b) => {
    if (a.occurredAtISO < b.occurredAtISO) return -1;
    if (a.occurredAtISO > b.occurredAtISO) return 1;
    if (a.eventId < b.eventId) return -1;
    if (a.eventId > b.eventId) return 1;
    return 0;
  });
  events = events.filter((ev) => afterCursor(ev, cursor));
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const last = page[page.length - 1];

  return {
    ok: true,
    source: 'layer1',
    glPostingEnabled: isGlPostingEnabled(),
    startDate,
    endDate,
    branchScope,
    kinds: [...kinds],
    events: page,
    hasMore,
    nextCursor: hasMore && last ? eventCursor(last) : null,
    count: page.length,
  };
}
