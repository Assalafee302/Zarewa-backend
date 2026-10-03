/**
 * Service-layer lock: money documents linked to an open investigation
 * cannot be deleted or have their cash edited. Customer, staff, and quotation
 * links stay as flags so a new sale is warned rather than the whole customer frozen.
 */
import { isInvestigationOpenStatus } from '../../shared/lib/investigationRegister.js';

function tablesReady(db) {
  try {
    db.prepare(`SELECT 1 FROM investigation_links LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

export function openInvestigationLinksForEntity(db, entityType, entityId) {
  const type = String(entityType || '').trim();
  const id = String(entityId || '').trim();
  if (!type || !id || !tablesReady(db)) return [];
  const rows = db
    .prepare(
      `SELECT l.case_id, l.entity_type, l.entity_id, l.role, c.status, c.title
       FROM investigation_links l
       JOIN investigation_cases c ON c.id = l.case_id
       WHERE l.entity_type = ? AND l.entity_id = ?`
    )
    .all(type, id);
  return rows.filter((r) => isInvestigationOpenStatus(r.status));
}

export function assertInvestigationAllowsMutation(db, entityType, entityId) {
  const hits = openInvestigationLinksForEntity(db, entityType, entityId);
  if (!hits.length) return { ok: true };
  const caseId = hits[0].case_id;
  return {
    ok: false,
    code: 'UNDER_INVESTIGATION',
    error: `This ${entityType} is linked to open investigation ${caseId} and cannot be edited or deleted.`,
  };
}

export function quotationUnderInvestigation(db, quotationId) {
  const qid = String(quotationId || '').trim();
  if (!qid || !tablesReady(db)) return { underInvestigation: false, caseIds: [] };
  const direct = openInvestigationLinksForEntity(db, 'quotation', qid);
  let viaReceipt = [];
  try {
    viaReceipt = db
      .prepare(
        `SELECT l.case_id, c.status, c.title
         FROM investigation_links l
         JOIN investigation_cases c ON c.id = l.case_id
         JOIN sales_receipts sr ON sr.id = l.entity_id OR sr.ledger_entry_id = l.entity_id
         WHERE l.entity_type = 'receipt' AND sr.quotation_ref = ? AND l.role LIKE 'suspend%'`
      )
      .all(qid)
      .filter((r) => isInvestigationOpenStatus(r.status));
  } catch {
    viaReceipt = [];
  }
  const caseIds = [...new Set([...direct, ...viaReceipt].map((r) => r.case_id))];
  return { underInvestigation: caseIds.length > 0, caseIds };
}
