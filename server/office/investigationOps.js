/**
 * Investigation register.
 * Suspending a receipt reverses its cash on the receipt's own date and posts
 * Dr Suspense (1060) / Cr that bank's cash account. Records are never deleted.
 * Open-case suspense (suspended − recovered) must equal the suspense GL balance.
 */
import { actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { postBalancedJournalTx } from '../glOps.js';
import { allocateHumanId } from '../humanId.js';
import { setRefundPayoutHold } from '../sales/refundPayoutHoldOps.js';
import { insertTreasuryMovementTx, syncQuotationPaidFromReceipts } from '../writeOps.js';
import { assertInvestigationAllowsMutation, quotationUnderInvestigation } from './investigationLock.js';
import {
  INVESTIGATION_CASE_TYPES,
  INVESTIGATION_ENTITY_TYPES,
  INVESTIGATION_LOSS_GL_CODE,
  INVESTIGATION_OPEN_STATUSES,
  INVESTIGATION_STATUSES,
  INVESTIGATION_SUSPENSE_GL_CODE,
  RECEIPT_SUSPENDED_STATUS,
  casesPastReviewDate,
  investigationCasesToCsv,
  investigationTotals,
  openSuspenseExpectedNgn,
  userMayManageInvestigations,
  userMayWriteOffInvestigation,
} from '../../shared/lib/investigationRegister.js';

const NOTE = 'Sept 2026 bank reconciliation – investigation';

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

function forbid() {
  return { ok: false, status: 403, error: 'Only the Managing Director, Head of Accounts, or Operations Manager can use the investigation register.' };
}

export function ensureInvestigationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigation_cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      case_type TEXT NOT NULL,
      amount_at_risk_ngn INTEGER NOT NULL DEFAULT 0,
      amount_recovered_ngn INTEGER NOT NULL DEFAULT 0,
      suspended_ngn INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      owner_user_id TEXT,
      review_date TEXT,
      opened_by_user_id TEXT,
      opened_at_iso TEXT NOT NULL,
      closed_by_user_id TEXT,
      closed_at_iso TEXT,
      decision_note TEXT,
      branch_id TEXT,
      customer_id TEXT,
      staff_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inv_cases_status ON investigation_cases(status, review_date);
    CREATE INDEX IF NOT EXISTS idx_inv_cases_owner ON investigation_cases(owner_user_id);
    CREATE TABLE IF NOT EXISTS investigation_links (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      role TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inv_links_case ON investigation_links(case_id);
    CREATE INDEX IF NOT EXISTS idx_inv_links_entity ON investigation_links(entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS investigation_notes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      author TEXT,
      at_iso TEXT NOT NULL,
      text MEDIUMTEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inv_notes_case ON investigation_notes(case_id, at_iso);
  `);
  try {
    db.exec('ALTER TABLE investigation_notes MODIFY COLUMN `text` MEDIUMTEXT NOT NULL');
  } catch {
    /* already wide, or the host dialect has no MODIFY */
  }
  ensureInvestigationGlAccounts(db);
}

function ensureInvestigationGlAccounts(db) {
  const rows = [
    ['acc-inv-suspense', INVESTIGATION_SUSPENSE_GL_CODE, 'Suspense – under investigation', 'asset', 28],
    ['acc-inv-loss', INVESTIGATION_LOSS_GL_CODE, 'Loss on investigation', 'expense', 99],
  ];
  for (const [id, code, name, type, sort] of rows) {
    const existing = db.prepare(`SELECT id FROM gl_accounts WHERE code = ? OR id = ?`).get(code, id);
    if (existing) continue;
    db.prepare(
      `INSERT INTO gl_accounts (id, code, name, type, is_active, sort_order) VALUES (?,?,?,?,1,?)`
    ).run(id, code, name, type, sort);
  }
}

function mapCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    caseType: row.case_type,
    amountAtRiskNgn: roundMoney(row.amount_at_risk_ngn),
    recoveredNgn: roundMoney(row.amount_recovered_ngn),
    suspendedNgn: roundMoney(row.suspended_ngn),
    status: row.status,
    ownerUserId: row.owner_user_id || '',
    reviewDate: row.review_date || '',
    openedByUserId: row.opened_by_user_id || '',
    openedAtISO: row.opened_at_iso,
    closedByUserId: row.closed_by_user_id || '',
    closedAtISO: row.closed_at_iso || '',
    decisionNote: row.decision_note || '',
    branchId: row.branch_id || '',
    customerId: row.customer_id || '',
    staffId: row.staff_id || '',
  };
}

function nextCaseId(db, branchId) {
  return allocateHumanId(db, 'INV', branchId || 'BR-KD', {
    table: 'investigation_cases',
    idColumn: 'id',
    width: 4,
  });
}

function nextChildId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stampMovement(db, movementId) {
  if (!movementId || !hasColumn(db, 'treasury_movements', 'date_override_reason')) return;
  db.prepare(`UPDATE treasury_movements SET date_override_reason = ? WHERE id = ?`).run(NOTE, movementId);
}

function cashGlCode(treasuryAccountId) {
  const id = Math.round(Number(treasuryAccountId) || 0);
  return id > 0 ? String(1000 + id) : '1000';
}

function postSuspensePair(db, { entryDateISO, amountNgn, debitCode, creditCode, sourceId, memo, actor, branchId }) {
  return postBalancedJournalTx(db, {
    entryDateISO,
    memo: memo || NOTE,
    sourceKind: 'INVESTIGATION_SUSPENSE_GL',
    sourceId,
    branchId: branchId || 'BR-KD',
    createdByUserId: actor?.id ?? null,
    lines: [
      { accountCode: debitCode, debitNgn: amountNgn, memo },
      { accountCode: creditCode, creditNgn: amountNgn, memo },
    ],
  });
}

export function listInvestigationCases(db, filters = {}) {
  ensureInvestigationSchema(db);
  const where = ['1=1'];
  const args = [];
  if (filters.status) {
    where.push('status = ?');
    args.push(String(filters.status));
  }
  if (filters.caseType || filters.type) {
    where.push('case_type = ?');
    args.push(String(filters.caseType || filters.type));
  }
  if (filters.staffId) {
    where.push(`(staff_id = ? OR id IN (SELECT case_id FROM investigation_links WHERE entity_type = 'staff' AND entity_id = ?))`);
    args.push(String(filters.staffId), String(filters.staffId));
  }
  if (filters.customerId) {
    where.push(`(customer_id = ? OR id IN (SELECT case_id FROM investigation_links WHERE entity_type = 'customer' AND entity_id = ?))`);
    args.push(String(filters.customerId), String(filters.customerId));
  }
  const all = db
    .prepare(`SELECT * FROM investigation_cases WHERE ${where.join(' AND ')} ORDER BY opened_at_iso DESC, id DESC`)
    .all(...args)
    .map(mapCase);
  const limit = Number(filters.limit);
  const offset = Math.max(0, Number(filters.offset) || 0);
  const cases = Number.isFinite(limit) && limit > 0 ? all.slice(offset, offset + limit) : all;
  return { ok: true, cases, total: all.length, totals: investigationTotals(all) };
}

export function getInvestigationCase(db, caseId) {
  ensureInvestigationSchema(db);
  const row = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Investigation not found.' };
  const links = db.prepare(`SELECT * FROM investigation_links WHERE case_id = ? ORDER BY id`).all(row.id);
  const notes = db.prepare(`SELECT * FROM investigation_notes WHERE case_id = ? ORDER BY at_iso, id`).all(row.id);
  return { ok: true, case: mapCase(row), links, notes };
}

export function exportInvestigationCasesCsv(db, filters = {}) {
  const listed = listInvestigationCases(db, filters);
  return { ok: true, csv: investigationCasesToCsv(listed.cases), totals: listed.totals };
}

export function createInvestigationCase(db, payload, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const title = String(payload?.title || '').trim();
  const caseType = String(payload?.caseType || payload?.case_type || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };
  if (!INVESTIGATION_CASE_TYPES.includes(caseType)) return { ok: false, error: 'Unknown case type.' };
  const reviewDate = String(payload?.reviewDate || payload?.review_date || '').slice(0, 10);
  if (reviewDate && !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) return { ok: false, error: 'Review date is invalid.' };
  const branchId = String(payload?.branchId || payload?.workspaceBranchId || 'BR-KD').trim() || 'BR-KD';
  const at = String(payload?.openedAtISO || '').trim() || new Date().toISOString();
  if (!payload?.alreadyInTransaction) ensureInvestigationSchema(db);
  const id = nextCaseId(db, branchId);
  const run = () => {
    db.prepare(
      `INSERT INTO investigation_cases (
         id, title, case_type, amount_at_risk_ngn, amount_recovered_ngn, suspended_ngn, status,
         owner_user_id, review_date, opened_by_user_id, opened_at_iso, decision_note, branch_id,
         customer_id, staff_id
       ) VALUES (?,?,?,?,0,0,'open',?,?,?,?,?,?,?,?)`
    ).run(
      id,
      title,
      caseType,
      roundMoney(payload?.amountAtRiskNgn ?? payload?.amount_at_risk_ngn),
      String(payload?.ownerUserId || payload?.owner_user_id || '').trim() || null,
      reviewDate || null,
      actor?.id != null ? String(actor.id) : null,
      at,
      String(payload?.decisionNote || '').trim() || null,
      branchId,
      String(payload?.customerId || '').trim() || null,
      String(payload?.staffId || '').trim() || null
    );
    const links = Array.isArray(payload?.links) ? payload.links : [];
    for (const link of links) addInvestigationLinkTx(db, id, link);
    if (String(payload?.note || '').trim()) addInvestigationNoteTx(db, id, actor, payload.note, at);
    appendAuditLog(db, {
      actor,
      action: 'investigation.create',
      entityKind: 'investigation',
      entityId: id,
      note: NOTE,
      details: { title, caseType, amountAtRiskNgn: roundMoney(payload?.amountAtRiskNgn) },
    });
  };
  try {
    if (payload?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, id);
}

function addInvestigationLinkTx(db, caseId, link) {
  const entityType = String(link?.entityType || link?.entity_type || '').trim();
  const entityId = String(link?.entityId || link?.entity_id || '').trim();
  if (!INVESTIGATION_ENTITY_TYPES.includes(entityType) || !entityId) {
    throw new Error('Each link needs a known entity type and id.');
  }
  const dup = db
    .prepare(
      `SELECT id FROM investigation_links WHERE case_id = ? AND entity_type = ? AND entity_id = ? AND IFNULL(role,'') = ?`
    )
    .get(caseId, entityType, entityId, String(link?.role || '').trim());
  if (dup) return dup.id;
  const id = nextChildId('INVL');
  db.prepare(
    `INSERT INTO investigation_links (id, case_id, entity_type, entity_id, role, note) VALUES (?,?,?,?,?,?)`
  ).run(id, caseId, entityType, entityId, String(link?.role || '').trim() || null, String(link?.note || '').trim() || null);
  return id;
}

export function addInvestigationLink(db, caseId, link, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const row = db.prepare(`SELECT id, status FROM investigation_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Investigation not found.' };
  try {
    const run = () => {
      addInvestigationLinkTx(db, row.id, link);
      appendAuditLog(db, {
        actor,
        action: 'investigation.link',
        entityKind: 'investigation',
        entityId: row.id,
        note: NOTE,
        details: link,
      });
    };
    if (link?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, row.id);
}

function addInvestigationNoteTx(db, caseId, actor, text, at) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Note text is required.');
  db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
    nextChildId('INVN'),
    caseId,
    actorName(actor) || 'Manager',
    at || new Date().toISOString(),
    body
  );
}

export function addInvestigationNote(db, caseId, text, actor, opts = {}) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const row = db.prepare(`SELECT id FROM investigation_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Investigation not found.' };
  try {
    const run = () => {
      addInvestigationNoteTx(db, row.id, actor, text);
      appendAuditLog(db, {
        actor,
        action: 'investigation.note',
        entityKind: 'investigation',
        entityId: row.id,
        note: NOTE,
        details: { text: String(text || '').slice(0, 500) },
      });
    };
    if (opts?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, row.id);
}

function loadReceipt(db, receiptId) {
  const id = String(receiptId || '').trim();
  return db
    .prepare(`SELECT * FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`)
    .get(id, id);
}

function unreversedCashLines(db, receipt) {
  const ids = [receipt.id, receipt.ledger_entry_id].map((x) => String(x || '').trim()).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM treasury_movements tm
       WHERE tm.source_kind = 'LEDGER_RECEIPT' AND tm.source_id IN (${placeholders})
         AND tm.amount_ngn > 0
         AND (tm.reverses_movement_id IS NULL OR TRIM(COALESCE(tm.reverses_movement_id, '')) = '')
         AND NOT EXISTS (SELECT 1 FROM treasury_movements rev WHERE rev.reverses_movement_id = tm.id)`
    )
    .all(...ids);
}

function reverseCashLine(db, row, actor) {
  const day = String(row.posted_at_iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Movement ${row.id} has no posting date.`);
  const created = insertTreasuryMovementTx(db, {
    type: 'RECEIPT_REVERSAL_OUT',
    treasuryAccountId: row.treasury_account_id,
    amountNgn: -roundMoney(row.amount_ngn),
    postedAtISO: `${day}T12:00:00.000Z`,
    reference: row.reference,
    counterpartyKind: row.counterparty_kind,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    note: `${NOTE}. Reverse ${row.id}`,
    createdBy: actorName(actor),
    reversesMovementId: row.id,
    allowNegativeBalance: true,
  });
  stampMovement(db, created.id);
  const gl = postSuspensePair(db, {
    entryDateISO: day,
    amountNgn: roundMoney(row.amount_ngn),
    debitCode: INVESTIGATION_SUSPENSE_GL_CODE,
    creditCode: cashGlCode(row.treasury_account_id),
    sourceId: `${row.id}:suspend`,
    memo: `${NOTE}. Suspend ${row.id}`,
    actor,
    branchId: 'BR-KD',
  });
  if (!gl.ok) throw new Error(gl.error || 'Suspense journal failed.');
  return { reversal: created, journal: gl, day, amountNgn: roundMoney(row.amount_ngn) };
}

/**
 * Move a receipt, or one of its cash lines, into an open case.
 * Cash is reversed on the line's own date. The receipt is not deleted.
 */
export function suspendReceiptForInvestigation(db, caseId, payload, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const cid = String(caseId || '').trim();
  const caseRow = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(cid);
  if (!caseRow) return { ok: false, error: 'Investigation not found.' };
  if (!INVESTIGATION_OPEN_STATUSES.includes(caseRow.status)) {
    return { ok: false, error: 'Only an open investigation can suspend a receipt.' };
  }
  const receipt = loadReceipt(db, payload?.receiptId || payload?.receipt_id);
  if (!receipt) return { ok: false, error: 'Receipt not found.' };
  let lines = unreversedCashLines(db, receipt);
  const onlyMovement = String(payload?.movementId || payload?.movement_id || '').trim();
  if (onlyMovement) lines = lines.filter((l) => l.id === onlyMovement);
  if (!lines.length) return { ok: false, error: 'No unreversed cash line to suspend.' };
  const whole = !onlyMovement || unreversedCashLines(db, receipt).length === lines.length;
  const reversed = [];
  try {
    const run = () => {
      for (const line of lines) reversed.push(reverseCashLine(db, line, actor));
      const suspendedNgn = reversed.reduce((s, r) => s + r.amountNgn, 0);
      if (whole) {
        db.prepare(`UPDATE sales_receipts SET status = ? WHERE id = ?`).run(RECEIPT_SUSPENDED_STATUS, receipt.id);
      } else {
        const bank = roundMoney(receipt.bank_received_amount_ngn != null ? receipt.bank_received_amount_ngn : receipt.amount_ngn);
        const next = Math.max(0, bank - suspendedNgn);
        db.prepare(`UPDATE sales_receipts SET bank_received_amount_ngn = ? WHERE id = ?`).run(next, receipt.id);
      }
      const qref = String(receipt.quotation_ref || '').trim();
      if (qref) syncQuotationPaidFromReceipts(db, qref);
      db.prepare(`UPDATE investigation_cases SET suspended_ngn = suspended_ngn + ? WHERE id = ?`).run(suspendedNgn, cid);
      addInvestigationLinkTx(db, cid, {
        entityType: 'receipt',
        entityId: receipt.id,
        role: whole ? 'suspended' : 'suspended_partial',
        note: payload?.note || NOTE,
      });
      for (const line of lines) {
        addInvestigationLinkTx(db, cid, {
          entityType: 'treasury_movement',
          entityId: line.id,
          role: 'suspended',
          note: payload?.note || '',
        });
        addInvestigationLinkTx(db, cid, {
          entityType: 'receipt_line',
          entityId: line.id,
          role: 'suspended',
          note: payload?.note || '',
        });
      }
      if (qref) {
        addInvestigationLinkTx(db, cid, { entityType: 'quotation', entityId: qref, role: 'context', note: '' });
      }
      if (payload?.note) addInvestigationNoteTx(db, cid, actor, payload.note);
      appendAuditLog(db, {
        actor,
        action: 'investigation.suspend_receipt',
        entityKind: 'investigation',
        entityId: cid,
        note: NOTE,
        details: { receiptId: receipt.id, suspendedNgn: suspendedNgn, whole },
      });
    };
    if (payload?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, cid);
}

/** Refund stays payable-blocked. Amounts are not changed. */
export function holdRefundForInvestigation(db, caseId, refundId, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const cid = String(caseId || '').trim();
  const caseRow = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(cid);
  if (!caseRow) return { ok: false, error: 'Investigation not found.' };
  const rid = String(refundId || '').trim();
  const reason = `${cid} ${caseRow.title}`.trim();
  try {
    const run = () => {
      const hold = setRefundPayoutHold(db, rid, { hold: true, reason }, actor);
      if (!hold?.ok) throw new Error(hold?.error || 'Could not hold the refund.');
      addInvestigationLinkTx(db, cid, { entityType: 'refund', entityId: rid, role: 'held', note: reason });
      appendAuditLog(db, {
        actor,
        action: 'investigation.hold_refund',
        entityKind: 'investigation',
        entityId: cid,
        note: NOTE,
        details: { refundId: rid },
      });
    };
    db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, cid);
}

export function postUnidentifiedInvestigationOut(db, caseId, payload, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const cid = String(caseId || '').trim();
  const caseRow = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(cid);
  if (!caseRow) return { ok: false, error: 'Investigation not found.' };
  const day = String(payload?.dateISO || '').slice(0, 10);
  const amount = roundMoney(payload?.amountNgn);
  const accountId = Number(payload?.treasuryAccountId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'A bank date is required.' };
  if (amount <= 0 || !accountId) return { ok: false, error: 'Amount and treasury account are required.' };
  let movement = null;
  try {
    const run = () => {
      movement = insertTreasuryMovementTx(db, {
        type: 'BANK_RECON_ADJUSTMENT',
        treasuryAccountId: accountId,
        amountNgn: -amount,
        postedAtISO: `${day}T12:00:00.000Z`,
        reference: String(payload?.reference || '').trim() || null,
        sourceKind: 'BANK_RECON_LINE',
        sourceId: cid,
        note: `${payload?.note || 'Unidentified – to reclassify'}. ${NOTE}`,
        createdBy: actorName(actor),
        allowNegativeBalance: true,
        actor,
        workspaceBranchId: payload?.workspaceBranchId || 'BR-KD',
        workspaceViewAll: true,
      });
      stampMovement(db, movement.id);
      addInvestigationLinkTx(db, cid, {
        entityType: 'treasury_movement',
        entityId: movement.id,
        role: 'unidentified_out',
        note: payload?.note || '',
      });
      appendAuditLog(db, {
        actor,
        action: 'investigation.unidentified_out',
        entityKind: 'investigation',
        entityId: cid,
        note: NOTE,
        details: { movementId: movement.id, amountNgn: amount, dateISO: day },
      });
    };
    if (payload?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const packed = getInvestigationCase(db, cid);
  packed.movement = movement;
  return packed;
}

function releaseSuspense(db, caseRow, actor, { debitCode, creditCode, sourceSuffix, memo }) {
  const openNgn = Math.max(0, roundMoney(caseRow.suspended_ngn) - roundMoney(caseRow.amount_recovered_ngn));
  if (openNgn <= 0) return { ok: true, skipped: true, amountNgn: 0 };
  const day = String(caseRow.review_date || caseRow.opened_at_iso || '').slice(0, 10);
  const gl = postSuspensePair(db, {
    entryDateISO: day,
    amountNgn: openNgn,
    debitCode,
    creditCode,
    sourceId: `${caseRow.id}:${sourceSuffix}`,
    memo,
    actor,
    branchId: caseRow.branch_id,
  });
  if (!gl.ok) throw new Error(gl.error || 'Could not clear suspense.');
  return { ok: true, amountNgn: openNgn, journal: gl };
}

export function closeInvestigationCase(db, caseId, payload, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const cid = String(caseId || '').trim();
  const caseRow = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(cid);
  if (!caseRow) return { ok: false, error: 'Investigation not found.' };
  const outcome = String(payload?.status || payload?.outcome || '').trim();
  if (!['recovered', 'written_off', 'cleared'].includes(outcome)) {
    return { ok: false, error: 'Closing status must be recovered, written_off, or cleared.' };
  }
  if (outcome === 'written_off' && !userMayWriteOffInvestigation(actor)) {
    return { ok: false, status: 403, error: 'Only the Managing Director can write off an investigation.' };
  }
  const decision = String(payload?.decisionNote || payload?.decision_note || '').trim();
  if (!decision) return { ok: false, error: 'A decision note is required to close a case.' };
  try {
    db.transaction(() => {
      if (outcome === 'written_off') {
        releaseSuspense(db, caseRow, actor, {
          debitCode: INVESTIGATION_LOSS_GL_CODE,
          creditCode: INVESTIGATION_SUSPENSE_GL_CODE,
          sourceSuffix: 'writeoff',
          memo: `${NOTE}. Write off ${cid}`,
        });
        db.prepare(
          `UPDATE investigation_cases
           SET status = 'written_off', amount_recovered_ngn = suspended_ngn,
               closed_by_user_id = ?, closed_at_iso = ?, decision_note = ?
           WHERE id = ?`
        ).run(actor?.id ?? null, new Date().toISOString(), decision, cid);
      } else if (outcome === 'cleared') {
        releaseSuspense(db, caseRow, actor, {
          debitCode: cashGlCode(payload?.treasuryAccountId || 4),
          creditCode: INVESTIGATION_SUSPENSE_GL_CODE,
          sourceSuffix: 'cleared',
          memo: `${NOTE}. Cleared ${cid}`,
        });
        const receipts = db
          .prepare(
            `SELECT entity_id FROM investigation_links WHERE case_id = ? AND entity_type = 'receipt' AND role LIKE 'suspend%'`
          )
          .all(cid);
        for (const rec of receipts) {
          db.prepare(
            `UPDATE sales_receipts SET status = 'Cleared' WHERE id = ? AND LOWER(status) LIKE 'suspended%investigation'`
          ).run(rec.entity_id);
          const q = db.prepare(`SELECT quotation_ref FROM sales_receipts WHERE id = ?`).get(rec.entity_id);
          if (q?.quotation_ref) syncQuotationPaidFromReceipts(db, q.quotation_ref);
        }
        db.prepare(
          `UPDATE investigation_cases
           SET status = 'cleared', amount_recovered_ngn = suspended_ngn,
               closed_by_user_id = ?, closed_at_iso = ?, decision_note = ?
           WHERE id = ?`
        ).run(actor?.id ?? null, new Date().toISOString(), decision, cid);
      } else {
        const amount = roundMoney(payload?.amountNgn);
        const day = String(payload?.dateISO || '').slice(0, 10);
        const accountId = Number(payload?.treasuryAccountId);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || amount <= 0 || !accountId) {
          throw new Error('Recovery needs a bank account, a positive amount, and the bank date.');
        }
        const openNgn = Math.max(0, roundMoney(caseRow.suspended_ngn) - roundMoney(caseRow.amount_recovered_ngn));
        if (amount > openNgn) throw new Error('Recovery cannot exceed the suspense still open on this case.');
        const movement = insertTreasuryMovementTx(db, {
          type: 'BANK_RECON_ADJUSTMENT',
          treasuryAccountId: accountId,
          amountNgn: amount,
          postedAtISO: `${day}T12:00:00.000Z`,
          sourceKind: 'INVESTIGATION_RECOVERY',
          sourceId: cid,
          note: `${decision}. ${NOTE}`,
          createdBy: actorName(actor),
          allowNegativeBalance: true,
          actor,
          workspaceViewAll: true,
        });
        stampMovement(db, movement.id);
        const gl = postSuspensePair(db, {
          entryDateISO: day,
          amountNgn: amount,
          debitCode: cashGlCode(accountId),
          creditCode: INVESTIGATION_SUSPENSE_GL_CODE,
          sourceId: `${cid}:recovery:${movement.id}`,
          memo: `${NOTE}. Recovery ${cid}`,
          actor,
          branchId: caseRow.branch_id,
        });
        if (!gl.ok) throw new Error(gl.error || 'Recovery journal failed.');
        const nextRecovered = roundMoney(caseRow.amount_recovered_ngn) + amount;
        const done = nextRecovered >= roundMoney(caseRow.suspended_ngn) && roundMoney(caseRow.suspended_ngn) > 0;
        db.prepare(
          `UPDATE investigation_cases
           SET amount_recovered_ngn = ?, status = ?, closed_by_user_id = ?, closed_at_iso = ?, decision_note = ?
           WHERE id = ?`
        ).run(
          nextRecovered,
          done ? 'recovered' : caseRow.status,
          done ? actor?.id ?? null : caseRow.closed_by_user_id,
          done ? new Date().toISOString() : caseRow.closed_at_iso,
          decision,
          cid
        );
        addInvestigationLinkTx(db, cid, {
          entityType: 'treasury_movement',
          entityId: movement.id,
          role: 'recovery',
          note: decision,
        });
      }
      addInvestigationNoteTx(db, cid, actor, decision);
      appendAuditLog(db, {
        actor,
        action: 'investigation.close',
        entityKind: 'investigation',
        entityId: cid,
        note: NOTE,
        details: { outcome, decision },
      });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, cid);
}

export function investigationSuspenseTieOut(db) {
  let glNgn = 0;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_ngn), 0) - COALESCE(SUM(l.credit_ngn), 0) AS n
         FROM gl_journal_lines l
         JOIN gl_accounts a ON a.id = l.account_id
         WHERE a.code = ?`
      )
      .get(INVESTIGATION_SUSPENSE_GL_CODE);
    glNgn = roundMoney(row?.n);
  } catch {
    glNgn = 0;
  }
  let cases = [];
  try {
    cases = db.prepare(`SELECT status, suspended_ngn, amount_recovered_ngn FROM investigation_cases`).all().map((r) => ({
      status: r.status,
      suspendedNgn: r.suspended_ngn,
      recoveredNgn: r.amount_recovered_ngn,
    }));
  } catch {
    cases = [];
  }
  const expectedNgn = openSuspenseExpectedNgn(cases);
  return {
    ok: glNgn === expectedNgn,
    suspenseGlNgn: glNgn,
    suspenseExpectedNgn: expectedNgn,
    differenceNgn: glNgn - expectedNgn,
  };
}

export function investigationDashboardTile(db) {
  try {
    const listed = listInvestigationCases(db, {});
    const open = listed.cases.filter((c) => INVESTIGATION_OPEN_STATUSES.includes(c.status));
    return {
      openCases: open.length,
      amountAtRiskNgn: open.reduce((s, c) => s + c.amountAtRiskNgn, 0),
    };
  } catch {
    return { openCases: 0, amountAtRiskNgn: 0 };
  }
}

export function investigationReminders(db, asOfISO) {
  const listed = listInvestigationCases(db, {});
  const day = String(asOfISO || new Date().toISOString()).slice(0, 10);
  return {
    ok: true,
    asOf: day,
    audience: ['md', 'operations_manager'],
    cases: casesPastReviewDate(listed.cases, day),
  };
}

export function investigationPartyWarning(db, { customerId, staffId, quotationId } = {}) {
  const warnings = [];
  if (customerId) {
    const hits = assertInvestigationAllowsMutation(db, 'customer', customerId);
    if (!hits.ok) warnings.push(`Customer ${customerId} is on an open investigation.`);
  }
  if (staffId) {
    const hits = assertInvestigationAllowsMutation(db, 'staff', staffId);
    if (!hits.ok) warnings.push(`Staff ${staffId} is on an open investigation.`);
  }
  if (quotationId) {
    const badge = quotationUnderInvestigation(db, quotationId);
    if (badge.underInvestigation) warnings.push(`Quotation ${quotationId} is under investigation.`);
  }
  return { underInvestigation: warnings.length > 0, warnings };
}

export function updateInvestigationCase(db, caseId, payload, actor) {
  if (!userMayManageInvestigations(actor)) return forbid();
  const cid = String(caseId || '').trim();
  const row = db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(cid);
  if (!row) return { ok: false, error: 'Investigation not found.' };
  if (!INVESTIGATION_OPEN_STATUSES.includes(row.status) && payload?.status && INVESTIGATION_STATUSES.includes(payload.status)) {
    return { ok: false, error: 'Closed cases stay closed. Open a new case if the facts change.' };
  }
  const status = String(payload?.status || row.status);
  if (!INVESTIGATION_STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  if (['recovered', 'written_off', 'cleared'].includes(status)) {
    return closeInvestigationCase(db, cid, payload, actor);
  }
  const reviewDate = payload?.reviewDate != null ? String(payload.reviewDate).slice(0, 10) : row.review_date;
  const title = payload?.title != null ? String(payload.title).trim() : row.title;
  if (!title) return { ok: false, error: 'Title is required.' };
  const caseType = payload?.caseType != null ? String(payload.caseType).trim() : row.case_type;
  if (!INVESTIGATION_CASE_TYPES.includes(caseType)) return { ok: false, error: 'Unknown case type.' };
  const amountAtRisk =
    payload?.amountAtRiskNgn != null ? roundMoney(payload.amountAtRiskNgn) : roundMoney(row.amount_at_risk_ngn);
  try {
    const run = () => {
      db.prepare(
        `UPDATE investigation_cases
         SET status = ?, title = ?, case_type = ?, amount_at_risk_ngn = ?,
             owner_user_id = ?, review_date = ?, decision_note = COALESCE(?, decision_note)
         WHERE id = ?`
      ).run(
        status,
        title,
        caseType,
        amountAtRisk,
        payload?.ownerUserId != null ? String(payload.ownerUserId) : row.owner_user_id,
        reviewDate || null,
        payload?.decisionNote != null ? String(payload.decisionNote) : null,
        cid
      );
      appendAuditLog(db, {
        actor,
        action: 'investigation.update',
        entityKind: 'investigation',
        entityId: cid,
        note: NOTE,
        details: {
          status,
          reviewDate,
          title,
          caseType,
          amountAtRiskNgn: amountAtRisk,
          previous: {
            title: row.title,
            caseType: row.case_type,
            amountAtRiskNgn: roundMoney(row.amount_at_risk_ngn),
          },
        },
      });
    };
    if (payload?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return getInvestigationCase(db, cid);
}

export { assertInvestigationAllowsMutation };
