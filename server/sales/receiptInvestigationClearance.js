/**
 * Receipts suspended or linked to an open investigation stay out of the
 * cashier confirm action. Amounts and dates are unchanged. Unlike the
 * Attah manager hold, nobody can confirm these — including a manager.
 */
import { isInvestigationOpenStatus } from '../../shared/lib/investigationRegister.js';

export function receiptStatusIsSuspended(status) {
  return /suspended/i.test(String(status || ''));
}

function tablesReady(db) {
  try {
    db.prepare(`SELECT 1 FROM investigation_links LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

/** Open investigation case ids for one receipt id or its ledger entry id. */
export function openInvestigationCaseIdsForReceipt(db, receiptId, ledgerEntryId = '') {
  if (!db || !tablesReady(db)) return [];
  const ids = [...new Set([receiptId, ledgerEntryId].map((v) => String(v || '').trim()).filter(Boolean))];
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT l.entity_id, l.case_id, c.status
         FROM investigation_links l
         JOIN investigation_cases c ON c.id = l.case_id
         WHERE l.entity_type = 'receipt' AND l.entity_id IN (${ph})`
      )
      .all(...ids);
  } catch {
    return [];
  }
  return [
    ...new Set(
      rows.filter((r) => isInvestigationOpenStatus(r.status)).map((r) => String(r.case_id || '').trim())
    ),
  ].filter(Boolean);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} receipts
 */
export function attachReceiptInvestigationFlags(db, receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  if (!list.length) return list;
  let rows = [];
  if (tablesReady(db)) {
    try {
      rows = db
        .prepare(
          `SELECT l.entity_id, l.case_id, c.status
           FROM investigation_links l
           JOIN investigation_cases c ON c.id = l.case_id
           WHERE l.entity_type = 'receipt'`
        )
        .all();
    } catch {
      rows = [];
    }
  }
  const byEntity = new Map();
  for (const row of rows) {
    if (!isInvestigationOpenStatus(row.status)) continue;
    const id = String(row.entity_id || '').trim();
    const caseId = String(row.case_id || '').trim();
    if (!id || !caseId) continue;
    if (!byEntity.has(id)) byEntity.set(id, []);
    const listIds = byEntity.get(id);
    if (!listIds.includes(caseId)) listIds.push(caseId);
  }
  return list.map((receipt) => {
    const ids = new Set([
      ...(byEntity.get(String(receipt?.id || '').trim()) || []),
      ...(byEntity.get(String(receipt?.ledgerEntryId || '').trim()) || []),
    ]);
    const caseIds = [...ids];
    const suspended = receiptStatusIsSuspended(receipt?.status);
    return {
      ...receipt,
      investigationCaseIds: caseIds,
      investigationCaseId: caseIds[0] || '',
      underInvestigation: suspended || caseIds.length > 0,
    };
  });
}

/**
 * Server block for finance confirmation. Null when the receipt may be confirmed.
 * @returns {null | { ok: false, code: string, error: string }}
 */
export function receiptInvestigationClearanceBlock(db, row) {
  if (!row) return null;
  const suspended = receiptStatusIsSuspended(row.status);
  const caseIds = openInvestigationCaseIdsForReceipt(db, row.id, row.ledger_entry_id || row.ledgerEntryId);
  if (!suspended && !caseIds.length) return null;
  const caseLabel = caseIds[0] || 'an open investigation';
  return {
    ok: false,
    code: 'UNDER_INVESTIGATION',
    error: suspended
      ? `This receipt is suspended (${caseLabel}) and cannot be confirmed.`
      : `This receipt is linked to open investigation ${caseLabel} and cannot be confirmed.`,
  };
}
