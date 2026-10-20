/**
 * Operational freeze for an open investigation hold.
 * Linked receipts are suspended separately. This gate refuses new refunds,
 * payouts, cutting lists, and production while the hold is active.
 * The MD lifts the hold by setting investigation_cases.hold_active = 0.
 */
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import {
  investigationCaseFreezes,
  investigationHoldMessage,
} from '../../shared/lib/investigationRegister.js';

function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function tablesReady(db, table) {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function freezeRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) =>
    investigationCaseFreezes(row.status, row.hold_active)
  );
}

function selectFreezeRows(db, sql, args) {
  try {
    return freezeRows(db.prepare(sql).all(...args));
  } catch {
    return [];
  }
}

function holdColumn(db) {
  return hasColumn(db, 'investigation_cases', 'hold_active') ? 'c.hold_active' : 'NULL AS hold_active';
}

function directCase(db, { table, kindColumn, idColumn, kind, id }) {
  const recordId = String(id || '').trim();
  if (!recordId || !tablesReady(db, table) || !tablesReady(db, 'investigation_cases')) return null;
  const hold = holdColumn(db);
  const rows = selectFreezeRows(
    db,
    `SELECT c.id, c.status, ${hold}
     FROM ${table} l
     JOIN investigation_cases c ON c.id = l.case_id
     WHERE l.${kindColumn} = ? AND l.${idColumn} = ?`,
    [kind, recordId]
  );
  return rows[0] || null;
}

function caseForCustomer(db, customerId) {
  const id = String(customerId || '').trim();
  if (!id) return null;
  return (
    directCase(db, {
      table: 'investigation_case_links',
      kindColumn: 'record_kind',
      idColumn: 'record_id',
      kind: 'customer',
      id,
    }) ||
    directCase(db, {
      table: 'investigation_links',
      kindColumn: 'entity_type',
      idColumn: 'entity_id',
      kind: 'customer',
      id,
    })
  );
}

function caseForQuotation(db, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return null;
  return (
    directCase(db, {
      table: 'investigation_case_links',
      kindColumn: 'record_kind',
      idColumn: 'record_id',
      kind: 'quotation',
      id,
    }) ||
    directCase(db, {
      table: 'investigation_links',
      kindColumn: 'entity_type',
      idColumn: 'entity_id',
      kind: 'quotation',
      id,
    })
  );
}

function caseForRefund(db, refundId) {
  const id = String(refundId || '').trim();
  if (!id) return null;
  return (
    directCase(db, {
      table: 'investigation_case_links',
      kindColumn: 'record_kind',
      idColumn: 'record_id',
      kind: 'refund',
      id,
    }) ||
    directCase(db, {
      table: 'investigation_links',
      kindColumn: 'entity_type',
      idColumn: 'entity_id',
      kind: 'refund',
      id,
    })
  );
}

/** Same phone as a customer already on a freezing case. Empty phones never match. */
function caseForSharedPhone(db, customerId) {
  const id = String(customerId || '').trim();
  if (!id || !tablesReady(db, 'customers') || !tablesReady(db, 'investigation_case_links')) return null;
  const self = db.prepare(`SELECT phone_number FROM customers WHERE customer_id = ?`).get(id);
  const key = phoneKey(self?.phone_number);
  if (!key) return null;
  const hold = holdColumn(db);
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT c.id, c.status, ${hold}, cu.phone_number
         FROM investigation_case_links l
         JOIN investigation_cases c ON c.id = l.case_id
         JOIN customers cu ON cu.customer_id = l.record_id
         WHERE l.record_kind = 'customer' AND l.record_id <> ?`
      )
      .all(id);
  } catch {
    return null;
  }
  const hit = freezeRows(rows).find((row) => phoneKey(row.phone_number) === key);
  return hit || null;
}

/**
 * @returns {null | { ok: false, code: 'UNDER_INVESTIGATION', error: string, caseId: string }}
 */
export function investigationHoldBlock(db, { customerId, quotationId, refundId } = {}) {
  if (!db) return null;
  const hit =
    caseForRefund(db, refundId) ||
    caseForQuotation(db, quotationId) ||
    caseForCustomer(db, customerId) ||
    caseForSharedPhone(db, customerId);
  if (!hit) return null;
  const caseId = String(hit.id || hit.case_id || '').trim();
  return {
    ok: false,
    code: 'UNDER_INVESTIGATION',
    caseId,
    error: investigationHoldMessage(caseId),
  };
}

/**
 * Badge payload for one record. Visible without opening the case file.
 * @returns {{ caseId: string, label: string } | null}
 */
export function investigationBadgeFor(db, kind, id) {
  const recordKind = String(kind || '').trim();
  const recordId = String(id || '').trim();
  if (!recordKind || !recordId) return null;
  const hit =
    directCase(db, {
      table: 'investigation_case_links',
      kindColumn: 'record_kind',
      idColumn: 'record_id',
      kind: recordKind,
      id: recordId,
    }) ||
    directCase(db, {
      table: 'investigation_links',
      kindColumn: 'entity_type',
      idColumn: 'entity_id',
      kind: recordKind,
      id: recordId,
    });
  if (!hit) return null;
  const caseId = String(hit.id || '').trim();
  return { caseId, label: investigationHoldMessage(caseId) };
}
