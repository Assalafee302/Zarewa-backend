/**
 * Investigation platform, phase 1.
 * A case freezes linked receipts, refunds, payouts, and new production until
 * the MD lifts the hold or closes the case. A person named on a linked record
 * (created, approved, confirmed, or paid) cannot be the case officer or a member.
 * Closing a case that still has suspense cash stays on the older suspense close,
 * so the suspense journal is not skipped.
 */
import { actorName } from '../auth.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { allocateHumanId } from '../humanId.js';
import { syncQuotationPaidFromReceipts } from '../writeOps.js';
import {
  INVESTIGATION_PLATFORM_OUTCOMES,
  INVESTIGATION_PLATFORM_STATUSES,
  INVESTIGATION_RECORD_KINDS,
  RECEIPT_SUSPENDED_STATUS,
  actorConflictsWithTouches,
  investigationCaseAgeDays,
  investigationCaseFreezes,
  investigationHoldMessage,
  investigationMoneySummary,
  userIsManagingDirector,
  userMayManageInvestigations,
  userMayViewInvestigationCase,
} from '../../shared/lib/investigationRegister.js';

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

function addColumn(db, table, column, ddl) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function ensureInvestigationPlatformSchema(db) {
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
    CREATE TABLE IF NOT EXISTS investigation_links (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      role TEXT,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS investigation_notes (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      author TEXT,
      at_iso TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investigation_case_links (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      linked_by_user_id TEXT,
      linked_at_iso TEXT NOT NULL,
      prior_status TEXT
    );
    CREATE TABLE IF NOT EXISTS investigation_case_members (
      case_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by_user_id TEXT,
      added_at_iso TEXT NOT NULL,
      PRIMARY KEY (case_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_inv_case_links_case ON investigation_case_links(case_id);
    CREATE INDEX IF NOT EXISTS idx_inv_case_links_record ON investigation_case_links(record_kind, record_id);
    CREATE INDEX IF NOT EXISTS idx_inv_case_members_user ON investigation_case_members(user_id);
  `);
  addColumn(db, 'investigation_cases', 'outcome', 'outcome TEXT');
  addColumn(db, 'investigation_cases', 'case_officer_user_id', 'case_officer_user_id TEXT');
  addColumn(db, 'investigation_cases', 'hold_active', 'hold_active INTEGER');
  addColumn(db, 'investigation_cases', 'hold_lifted_at_iso', 'hold_lifted_at_iso TEXT');
  addColumn(db, 'investigation_cases', 'hold_lifted_by_user_id', 'hold_lifted_by_user_id TEXT');
  addColumn(db, 'investigation_cases', 'written_off_ngn', 'written_off_ngn INTEGER NOT NULL DEFAULT 0');
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_case_links_unique ON investigation_case_links(case_id, record_kind, record_id)`
    );
  } catch {
    /* index already present under another name */
  }
}

function nextChildId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function caseIdShape(id) {
  return /^INV-[A-Z]{2}-\d{2}-\d{4}$/.test(String(id || '').trim());
}

function forbid(error) {
  return { ok: false, status: 403, code: 'FORBIDDEN', error };
}

function userById(db, userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const row = db.prepare(`SELECT id, display_name, username FROM app_users WHERE id = ?`).get(id);
  if (!row) return null;
  return { id: row.id, displayName: row.display_name || '', username: row.username || '' };
}

function memberIds(db, caseId) {
  try {
    return db
      .prepare(`SELECT user_id FROM investigation_case_members WHERE case_id = ?`)
      .all(caseId)
      .map((row) => String(row.user_id || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function accessOf(db, row) {
  return {
    caseOfficerUserId: row.case_officer_user_id || '',
    ownerUserId: row.owner_user_id || '',
    memberUserIds: memberIds(db, row.id),
  };
}

function loadCaseRow(db, caseId) {
  return db.prepare(`SELECT * FROM investigation_cases WHERE id = ?`).get(String(caseId || '').trim());
}

function pushTouch(touches, touch) {
  const userId = String(touch.userId || '').trim();
  const name = String(touch.name || '').trim();
  if (!userId && name.length < 3) return;
  touches.push({
    userId,
    name,
    field: touch.field,
    recordKind: touch.recordKind,
    recordId: touch.recordId,
  });
}

function enrichTouches(db, touches) {
  for (const touch of touches) {
    if (!touch.userId || touch.name) continue;
    const user = userById(db, touch.userId);
    touch.name = user?.displayName || '';
  }
  return touches;
}

function touchesForRecord(db, kind, id) {
  const touches = [];
  const recordKind = kind;
  const recordId = id;
  if (kind === 'customer') {
    const row = db.prepare(`SELECT created_by FROM customers WHERE customer_id = ?`).get(id);
    if (row) pushTouch(touches, { name: row.created_by, field: 'created_by', recordKind, recordId });
  } else if (kind === 'quotation') {
    const row = db.prepare(`SELECT handled_by, handled_by_user_id FROM quotations WHERE id = ?`).get(id);
    if (row) {
      pushTouch(touches, { name: row.handled_by, field: 'handled_by', recordKind, recordId });
      pushTouch(touches, { userId: row.handled_by_user_id, field: 'handled_by_user_id', recordKind, recordId });
    }
  } else if (kind === 'receipt') {
    const row = db.prepare(`SELECT handled_by FROM sales_receipts WHERE id = ?`).get(id);
    if (row) pushTouch(touches, { name: row.handled_by, field: 'handled_by', recordKind, recordId });
    if (hasColumn(db, 'sales_receipts', 'bank_confirmed_by_user_id')) {
      const confirmed = db.prepare(`SELECT bank_confirmed_by_user_id FROM sales_receipts WHERE id = ?`).get(id);
      pushTouch(touches, {
        userId: confirmed?.bank_confirmed_by_user_id,
        field: 'bank_confirmed_by_user_id',
        recordKind,
        recordId,
      });
    }
  } else if (kind === 'production_job') {
    const row = db
      .prepare(
        `SELECT manager_review_signed_by_user_id, manager_review_signed_by_name FROM production_jobs WHERE job_id = ?`
      )
      .get(id);
    if (row) {
      pushTouch(touches, {
        userId: row.manager_review_signed_by_user_id,
        field: 'manager_review_signed_by_user_id',
        recordKind,
        recordId,
      });
      pushTouch(touches, {
        name: row.manager_review_signed_by_name,
        field: 'manager_review_signed_by_name',
        recordKind,
        recordId,
      });
    }
  } else if (kind === 'refund') {
    const row = db
      .prepare(
        `SELECT requested_by, requested_by_user_id, approved_by, paid_by, payee_name FROM customer_refunds WHERE refund_id = ?`
      )
      .get(id);
    if (row) {
      pushTouch(touches, { name: row.requested_by, field: 'requested_by', recordKind, recordId });
      pushTouch(touches, { userId: row.requested_by_user_id, field: 'requested_by_user_id', recordKind, recordId });
      pushTouch(touches, { name: row.approved_by, field: 'approved_by', recordKind, recordId });
      pushTouch(touches, { name: row.paid_by, field: 'paid_by', recordKind, recordId });
      pushTouch(touches, { name: row.payee_name, field: 'payee_name', recordKind, recordId });
    }
  } else if (kind === 'staff') {
    const user = userById(db, id);
    pushTouch(touches, { userId: id, name: user?.displayName, field: 'staff', recordKind, recordId });
  }
  return enrichTouches(db, touches);
}

export function investigationTouchesForLinks(db, links) {
  const touches = [];
  for (const link of links || []) {
    touches.push(...touchesForRecord(db, link.recordKind || link.record_kind, link.recordId || link.record_id));
  }
  return touches;
}

function conflictResult(touch) {
  const who = touch.name || touch.userId || 'This user';
  return {
    ok: false,
    status: 409,
    code: 'INVESTIGATION_CONFLICT',
    error: `${who} is named on ${touch.recordKind} ${touch.recordId} (${touch.field}) and cannot handle this case.`,
  };
}

function officerConflict(db, userId, links) {
  const actor = userById(db, userId);
  if (!actor) return { ok: false, error: 'Case officer was not found.' };
  const touch = actorConflictsWithTouches(
    { id: actor.id, displayName: actor.displayName, username: actor.username },
    investigationTouchesForLinks(db, links)
  );
  if (touch) return conflictResult(touch);
  return null;
}

function resolveRecord(db, kind, rawId) {
  const recordKind = String(kind || '').trim();
  const recordId = String(rawId || '').trim();
  if (!INVESTIGATION_RECORD_KINDS.includes(recordKind)) {
    throw new Error('Unknown record kind.');
  }
  if (!recordId) throw new Error('Record id is required.');
  if (recordKind === 'receipt') {
    const row = db
      .prepare(`SELECT id FROM sales_receipts WHERE id = ? OR ledger_entry_id = ?`)
      .get(recordId, recordId);
    if (!row) throw new Error(`Receipt ${recordId} was not found.`);
    return { recordKind, recordId: row.id };
  }
  const lookups = {
    customer: ['customers', 'customer_id'],
    quotation: ['quotations', 'id'],
    production_job: ['production_jobs', 'job_id'],
    refund: ['customer_refunds', 'refund_id'],
    payout: ['treasury_movements', 'id'],
    expense: ['expenses', 'expense_id'],
    staff: ['app_users', 'id'],
    bank_line: ['bank_reconciliation_lines', 'id'],
  };
  const [table, column] = lookups[recordKind];
  let row = null;
  try {
    row = db.prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ?`).get(recordId);
  } catch {
    row = null;
  }
  if (!row && recordKind === 'expense') {
    try {
      row = db.prepare(`SELECT request_id AS id FROM payment_requests WHERE request_id = ?`).get(recordId);
    } catch {
      row = null;
    }
  }
  if (!row && recordKind === 'staff') {
    try {
      row = db.prepare(`SELECT user_id AS id FROM hr_staff_profiles WHERE user_id = ?`).get(recordId);
    } catch {
      row = null;
    }
  }
  if (!row) throw new Error(`${recordKind} ${recordId} was not found.`);
  return { recordKind, recordId: row.id };
}

function linkedIds(db, caseId, kind) {
  const ids = new Set();
  for (const row of db
    .prepare(`SELECT record_id FROM investigation_case_links WHERE case_id = ? AND record_kind = ?`)
    .all(caseId, kind)) {
    const id = String(row.record_id || '').trim();
    if (id) ids.add(id);
  }
  try {
    for (const row of db
      .prepare(`SELECT entity_id FROM investigation_links WHERE case_id = ? AND entity_type = ?`)
      .all(caseId, kind)) {
      const id = String(row.entity_id || '').trim();
      if (id) ids.add(id);
    }
  } catch {
    /* legacy table missing in a partial test */
  }
  return [...ids];
}

function refundPaidNgn(row) {
  const paid = roundMoney(row?.paid_amount_ngn);
  if (paid > 0) return paid;
  const status = String(row?.status || '').toLowerCase();
  if (status.includes('paid')) return roundMoney(row?.amount_ngn);
  return 0;
}

export function investigationMoneyForCase(db, caseRow) {
  const caseId = caseRow.id;
  const quotationIds = new Set(linkedIds(db, caseId, 'quotation'));
  for (const jobId of linkedIds(db, caseId, 'production_job')) {
    const job = db.prepare(`SELECT quotation_ref FROM production_jobs WHERE job_id = ?`).get(jobId);
    if (job?.quotation_ref) quotationIds.add(String(job.quotation_ref).trim());
  }
  let goods = 0;
  for (const quotationId of quotationIds) {
    if (!quotationId) continue;
    const quote = db.prepare(`SELECT total_ngn FROM quotations WHERE id = ?`).get(quotationId);
    if (!quote) continue;
    const completed = db
      .prepare(
        `SELECT 1 AS x FROM production_jobs
         WHERE quotation_ref = ? AND LOWER(TRIM(status)) IN ('completed', 'complete') LIMIT 1`
      )
      .get(quotationId);
    if (completed) goods += roundMoney(quote.total_ngn);
  }
  let paid = 0;
  const countedRefunds = new Set();
  for (const refundId of linkedIds(db, caseId, 'refund')) {
    const row = db
      .prepare(`SELECT refund_id, paid_amount_ngn, amount_ngn, status FROM customer_refunds WHERE refund_id = ?`)
      .get(refundId);
    if (!row) continue;
    countedRefunds.add(row.refund_id);
    paid += refundPaidNgn(row);
  }
  for (const payoutId of linkedIds(db, caseId, 'payout')) {
    let row = null;
    try {
      row = db.prepare(`SELECT id, amount_ngn, source_id, type FROM treasury_movements WHERE id = ?`).get(payoutId);
    } catch {
      row = null;
    }
    if (!row) continue;
    if (countedRefunds.has(String(row.source_id || '').trim())) continue;
    paid += Math.abs(roundMoney(row.amount_ngn));
  }
  return investigationMoneySummary({
    goodsReleasedNgn: goods,
    moneyPaidOutNgn: paid,
    recoveredNgn: caseRow.amount_recovered_ngn,
    writtenOffNgn: caseRow.written_off_ngn,
  });
}

function mapCase(db, row) {
  const officer = userById(db, row.case_officer_user_id || row.owner_user_id);
  const money = investigationMoneyForCase(db, row);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    outcome: row.outcome || '',
    caseOfficerUserId: row.case_officer_user_id || row.owner_user_id || '',
    caseOfficerName: officer?.displayName || '',
    openedAtISO: row.opened_at_iso,
    closedAtISO: row.closed_at_iso || '',
    branchId: row.branch_id || '',
    holdActive: investigationCaseFreezes(row.status, row.hold_active),
    decisionNote: row.decision_note || '',
    ageDays: investigationCaseAgeDays(row.opened_at_iso, row.closed_at_iso),
    money,
  };
}

function mapLinks(db, caseId) {
  return db
    .prepare(
      `SELECT id, record_kind, record_id, linked_by_user_id, linked_at_iso, prior_status
       FROM investigation_case_links WHERE case_id = ? ORDER BY linked_at_iso, id`
    )
    .all(caseId)
    .map((row) => ({
      id: row.id,
      recordKind: row.record_kind,
      recordId: row.record_id,
      linkedByUserId: row.linked_by_user_id || '',
      linkedByName: userById(db, row.linked_by_user_id)?.displayName || '',
      linkedAtISO: row.linked_at_iso,
      priorStatus: row.prior_status || '',
    }));
}

function mapNotes(db, caseId) {
  return db
    .prepare(`SELECT id, author, at_iso, text FROM investigation_notes WHERE case_id = ? ORDER BY at_iso, id`)
    .all(caseId)
    .map((row) => ({
      id: row.id,
      author: row.author || '',
      atISO: row.at_iso,
      text: row.text,
    }));
}

function packCase(db, row, actor, { logView = false } = {}) {
  const access = accessOf(db, row);
  if (!userMayViewInvestigationCase(actor, access)) {
    return forbid('You cannot open this case.');
  }
  if (logView) {
    appendAuditLog(db, {
      actor,
      action: 'investigation.platform.view',
      entityKind: 'investigation',
      entityId: row.id,
      note: row.id,
      details: { status: row.status },
    });
  }
  return {
    ok: true,
    case: mapCase(db, row),
    links: mapLinks(db, row.id),
    notes: mapNotes(db, row.id),
    members: access.memberUserIds.map((userId) => ({
      userId,
      name: userById(db, userId)?.displayName || '',
    })),
  };
}

function audit(db, actor, action, caseId, details) {
  appendAuditLog(db, {
    actor,
    action,
    entityKind: 'investigation',
    entityId: caseId,
    note: caseId,
    details,
  });
}

function insertLinkTx(db, caseId, link, actor, at) {
  const existing = db
    .prepare(
      `SELECT id FROM investigation_case_links WHERE case_id = ? AND record_kind = ? AND record_id = ?`
    )
    .get(caseId, link.recordKind, link.recordId);
  if (existing) return existing.id;
  const id = nextChildId('INVL');
  db.prepare(
    `INSERT INTO investigation_case_links
      (id, case_id, record_kind, record_id, linked_by_user_id, linked_at_iso)
     VALUES (?,?,?,?,?,?)`
  ).run(id, caseId, link.recordKind, link.recordId, actor?.id ? String(actor.id) : null, at);
  const mirrored = db
    .prepare(
      `SELECT id FROM investigation_links WHERE case_id = ? AND entity_type = ? AND entity_id = ?`
    )
    .get(caseId, link.recordKind, link.recordId);
  if (!mirrored) {
    db.prepare(
      `INSERT INTO investigation_links (id, case_id, entity_type, entity_id, role, note) VALUES (?,?,?,?,?,?)`
    ).run(nextChildId('INVK'), caseId, link.recordKind, link.recordId, 'linked', null);
  }
  return id;
}

function receiptIsSuspended(status) {
  const s = String(status || '').trim().toLowerCase();
  return s.includes('suspended') && s.includes('investigation');
}

function applyHoldTx(db, caseRow, actor) {
  const caseId = caseRow.id;
  const receipts = db
    .prepare(
      `SELECT id, record_id FROM investigation_case_links WHERE case_id = ? AND record_kind = 'receipt'`
    )
    .all(caseId);
  for (const link of receipts) {
    const receipt = db
      .prepare(`SELECT id, status, quotation_ref FROM sales_receipts WHERE id = ?`)
      .get(link.record_id);
    if (!receipt || receiptIsSuspended(receipt.status)) continue;
    db.prepare(`UPDATE investigation_case_links SET prior_status = ? WHERE id = ?`).run(
      String(receipt.status || '').trim() || 'Pending',
      link.id
    );
    db.prepare(`UPDATE sales_receipts SET status = ? WHERE id = ?`).run(RECEIPT_SUSPENDED_STATUS, receipt.id);
    if (receipt.quotation_ref) {
      try {
        syncQuotationPaidFromReceipts(db, receipt.quotation_ref);
      } catch {
        /* paid sync is best-effort; the status hold still stands */
      }
    }
  }
  if (!hasColumn(db, 'customer_refunds', 'payout_hold')) return;
  const reason = investigationHoldMessage(caseId);
  const refundIds = new Set(linkedIds(db, caseId, 'refund'));
  for (const quotationId of linkedIds(db, caseId, 'quotation')) {
    for (const row of db
      .prepare(`SELECT refund_id FROM customer_refunds WHERE quotation_ref = ?`)
      .all(quotationId)) {
      refundIds.add(row.refund_id);
    }
  }
  for (const customerId of linkedIds(db, caseId, 'customer')) {
    for (const row of db
      .prepare(`SELECT refund_id FROM customer_refunds WHERE customer_id = ?`)
      .all(customerId)) {
      refundIds.add(row.refund_id);
    }
  }
  const now = new Date().toISOString();
  for (const refundId of refundIds) {
    const row = db
      .prepare(`SELECT refund_id, status, paid_amount_ngn, payout_hold FROM customer_refunds WHERE refund_id = ?`)
      .get(refundId);
    if (!row || roundMoney(row.paid_amount_ngn) > 0) continue;
    const status = String(row.status || '').toLowerCase();
    if (status.includes('paid') || status.includes('reject') || status.includes('cancel')) continue;
    db.prepare(
      `UPDATE customer_refunds
       SET payout_hold = 1, payout_hold_reason = ?, hold_set_by = ?, hold_set_at = ?
       WHERE refund_id = ?`
    ).run(reason, actorName(actor), now, refundId);
  }
}

function releaseHoldTx(db, caseRow, actor) {
  const caseId = caseRow.id;
  const receipts = db
    .prepare(
      `SELECT record_id, prior_status FROM investigation_case_links
       WHERE case_id = ? AND record_kind = 'receipt' AND prior_status IS NOT NULL AND TRIM(prior_status) <> ''`
    )
    .all(caseId);
  for (const link of receipts) {
    const receipt = db.prepare(`SELECT id, status, quotation_ref FROM sales_receipts WHERE id = ?`).get(link.record_id);
    if (!receipt || !receiptIsSuspended(receipt.status)) continue;
    db.prepare(`UPDATE sales_receipts SET status = ? WHERE id = ?`).run(link.prior_status, receipt.id);
    if (receipt.quotation_ref) {
      try {
        syncQuotationPaidFromReceipts(db, receipt.quotation_ref);
      } catch {
        /* same as apply */
      }
    }
  }
  if (hasColumn(db, 'customer_refunds', 'payout_hold_reason')) {
    db.prepare(
      `UPDATE customer_refunds
       SET payout_hold = 0, hold_cleared_by = ?, hold_cleared_at = ?
       WHERE payout_hold_reason = ?`
    ).run(actorName(actor), new Date().toISOString(), investigationHoldMessage(caseId));
  }
}

function rememberExposure(db, caseId) {
  const row = loadCaseRow(db, caseId);
  if (!row) return;
  const money = investigationMoneyForCase(db, row);
  db.prepare(`UPDATE investigation_cases SET amount_at_risk_ngn = ? WHERE id = ?`).run(money.exposureNgn, caseId);
}

function canRunCase(actor, row) {
  if (userIsManagingDirector(actor)) return true;
  const id = String(actor?.id || '').trim();
  return Boolean(id) && id === String(row.case_officer_user_id || row.owner_user_id || '').trim();
}

export function listInvestigationPlatformCases(db, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!actor?.id && !userIsManagingDirector(actor)) return { ok: true, cases: [] };
  const rows = db
    .prepare(`SELECT * FROM investigation_cases ORDER BY opened_at_iso DESC, id DESC`)
    .all();
  const cases = [];
  for (const row of rows) {
    if (!userMayViewInvestigationCase(actor, accessOf(db, row))) continue;
    cases.push(mapCase(db, row));
  }
  audit(db, actor, 'investigation.platform.list', 'register', { count: cases.length });
  return { ok: true, cases };
}

export function getInvestigationPlatformCase(db, caseId, actor) {
  ensureInvestigationPlatformSchema(db);
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  return packCase(db, row, actor, { logView: true });
}

export function openInvestigationPlatformCase(db, payload, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!userIsManagingDirector(actor) && !userMayManageInvestigations(actor)) {
    return forbid('Only the MD or the Operations Manager can open a case.');
  }
  const title = String(payload?.title || '').trim();
  if (!title) return { ok: false, error: 'Title is required.' };
  const branchId = String(payload?.branchId || payload?.branch_id || 'BR-KD').trim() || 'BR-KD';
  let status = String(payload?.status || '').trim() || 'Open';
  if (!INVESTIGATION_PLATFORM_STATUSES.includes(status) || status === 'Closed') {
    return { ok: false, error: 'Status must be Reported, Open, Referred to police, or Recovery.' };
  }
  let links = [];
  try {
    links = (Array.isArray(payload?.links) ? payload.links : []).map((link) =>
      resolveRecord(db, link.recordKind || link.record_kind, link.recordId || link.record_id)
    );
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!links.length && status !== 'Reported') status = 'Reported';
  const officerId = String(payload?.caseOfficerUserId || payload?.case_officer_user_id || actor?.id || '').trim();
  if (!officerId) return { ok: false, error: 'A case officer is required.' };
  if (!userById(db, officerId)?.id) return { ok: false, error: 'Case officer was not found.' };
  const conflict = officerConflict(db, officerId, links);
  if (conflict) return conflict;
  if (!userIsManagingDirector(actor) && officerId !== String(actor.id)) {
    return forbid('Only the MD can name a case officer.');
  }
  const explicit = String(payload?.id || '').trim();
  if (explicit && !payload?.explicitId) {
    return { ok: false, error: 'Case numbers are assigned by the register.' };
  }
  if (explicit && !caseIdShape(explicit)) return { ok: false, error: 'Case id must look like INV-KD-26-0001.' };
  const at = String(payload?.openedAtISO || '').trim() || new Date().toISOString();
  const holdActive = investigationCaseFreezes(status, 1) ? 1 : 0;
  let id = explicit;
  try {
    const run = () => {
      if (!id) {
        id = allocateHumanId(db, 'INV', branchId, {
          table: 'investigation_cases',
          idColumn: 'id',
          width: 4,
        });
      } else if (loadCaseRow(db, id)) {
        throw new Error(`${id} already exists.`);
      }
      db.prepare(
        `INSERT INTO investigation_cases (
           id, title, case_type, amount_at_risk_ngn, amount_recovered_ngn, suspended_ngn, status,
           owner_user_id, opened_by_user_id, opened_at_iso, branch_id, case_officer_user_id,
           hold_active, outcome, written_off_ngn
         ) VALUES (?,?,?,0,0,0,?,?,?,?,?,?,?,NULL,0)`
      ).run(
        id,
        title,
        String(payload?.caseType || 'other').trim() || 'other',
        status,
        officerId,
        actor?.id ? String(actor.id) : null,
        at,
        branchId,
        officerId,
        holdActive
      );
      for (const link of links) insertLinkTx(db, id, link, actor, at);
      const note = String(payload?.note || '').trim();
      if (note) {
        db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
          nextChildId('INVN'),
          id,
          actorName(actor),
          at,
          note
        );
      }
      const created = loadCaseRow(db, id);
      if (holdActive) applyHoldTx(db, created, actor);
      rememberExposure(db, id);
      audit(db, actor, 'investigation.platform.create', id, {
        title,
        status,
        officerId,
        links,
        holdActive: Boolean(holdActive),
      });
    };
    if (payload?.alreadyInTransaction) run();
    else db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const row = loadCaseRow(db, id);
  return packCase(db, row, actor, { logView: false });
}

export function addInvestigationPlatformLink(db, caseId, link, actor) {
  ensureInvestigationPlatformSchema(db);
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  if (!userMayViewInvestigationCase(actor, accessOf(db, row))) return forbid('You cannot open this case.');
  if (!canRunCase(actor, row)) return forbid('Only the case officer can link records.');
  if (String(row.status) === 'Closed') return { ok: false, error: 'A closed case cannot take new records.' };
  let resolved;
  try {
    resolved = resolveRecord(db, link?.recordKind || link?.record_kind, link?.recordId || link?.record_id);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  const existingLinks = mapLinks(db, row.id).map((item) => ({
    recordKind: item.recordKind,
    recordId: item.recordId,
  }));
  const conflict = officerConflict(db, row.case_officer_user_id || row.owner_user_id, [
    ...existingLinks,
    resolved,
  ]);
  if (conflict) return conflict;
  for (const memberId of memberIds(db, row.id)) {
    const memberConflict = officerConflict(db, memberId, [...existingLinks, resolved]);
    if (memberConflict) return memberConflict;
  }
  try {
    const run = () => {
      insertLinkTx(db, row.id, resolved, actor, new Date().toISOString());
      if (investigationCaseFreezes(row.status, row.hold_active)) applyHoldTx(db, row, actor);
      rememberExposure(db, row.id);
      audit(db, actor, 'investigation.platform.link', row.id, resolved);
    };
    db.transaction(run)();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function addInvestigationPlatformNote(db, caseId, text, actor) {
  ensureInvestigationPlatformSchema(db);
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  if (!userMayViewInvestigationCase(actor, accessOf(db, row))) return forbid('You cannot open this case.');
  if (!canRunCase(actor, row)) return forbid('Only the case officer can write the timeline.');
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'Note text is required.' };
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
        nextChildId('INVN'),
        row.id,
        actorName(actor),
        new Date().toISOString(),
        body
      );
      audit(db, actor, 'investigation.platform.note', row.id, { text: body.slice(0, 500) });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function setInvestigationPlatformOfficer(db, caseId, officerUserId, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!userIsManagingDirector(actor)) return forbid('Only the MD can name the case officer.');
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  const officerId = String(officerUserId || '').trim();
  if (!userById(db, officerId)) return { ok: false, error: 'Case officer was not found.' };
  const conflict = officerConflict(
    db,
    officerId,
    mapLinks(db, row.id).map((item) => ({ recordKind: item.recordKind, recordId: item.recordId }))
  );
  if (conflict) return conflict;
  db.prepare(
    `UPDATE investigation_cases SET case_officer_user_id = ?, owner_user_id = ? WHERE id = ?`
  ).run(officerId, officerId, row.id);
  audit(db, actor, 'investigation.platform.officer', row.id, { officerId });
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function addInvestigationPlatformMember(db, caseId, memberUserId, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!userIsManagingDirector(actor)) return forbid('Only the MD can add someone to a case.');
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  const userId = String(memberUserId || '').trim();
  const user = userById(db, userId);
  if (!user) return { ok: false, error: 'User was not found.' };
  const conflict = officerConflict(
    db,
    userId,
    mapLinks(db, row.id).map((item) => ({ recordKind: item.recordKind, recordId: item.recordId }))
  );
  if (conflict) return conflict;
  db.prepare(
    `INSERT INTO investigation_case_members (case_id, user_id, added_by_user_id, added_at_iso)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE added_by_user_id = VALUES(added_by_user_id)`
  ).run(row.id, userId, actor?.id ? String(actor.id) : null, new Date().toISOString());
  audit(db, actor, 'investigation.platform.member', row.id, { userId });
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function liftInvestigationPlatformHold(db, caseId, payload, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!userIsManagingDirector(actor)) return forbid('Only the MD can lift a hold.');
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  if (!investigationCaseFreezes(row.status, row.hold_active)) {
    return { ok: false, error: 'This case has no active hold.' };
  }
  const note = String(payload?.note || payload?.decisionNote || '').trim();
  if (note.length < 10) return { ok: false, error: 'A note of at least 10 characters is required to lift a hold.' };
  try {
    db.transaction(() => {
      releaseHoldTx(db, row, actor);
      db.prepare(
        `UPDATE investigation_cases
         SET hold_active = 0, hold_lifted_at_iso = ?, hold_lifted_by_user_id = ?
         WHERE id = ?`
      ).run(new Date().toISOString(), actor?.id ? String(actor.id) : null, row.id);
      db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
        nextChildId('INVN'),
        row.id,
        actorName(actor),
        new Date().toISOString(),
        note
      );
      audit(db, actor, 'investigation.platform.lift', row.id, { note });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function closeInvestigationPlatformCase(db, caseId, payload, actor) {
  ensureInvestigationPlatformSchema(db);
  if (!userIsManagingDirector(actor)) return forbid('Only the MD can close a case.');
  const row = loadCaseRow(db, caseId);
  if (!row) return { ok: false, status: 404, error: 'Investigation not found.' };
  if (String(row.status) === 'Closed') return { ok: false, error: 'This case is already closed.' };
  if (roundMoney(row.suspended_ngn) > 0) {
    return {
      ok: false,
      error: 'This case has cash in suspense. Close it on the suspense register so the journal stays in balance.',
    };
  }
  const outcome = String(payload?.outcome || '').trim();
  if (!INVESTIGATION_PLATFORM_OUTCOMES.includes(outcome)) {
    return { ok: false, error: 'Outcome must be Recovered, Written off, or Cleared.' };
  }
  const decision = String(payload?.decisionNote || payload?.decision_note || '').trim();
  if (decision.length < 10) return { ok: false, error: 'A decision note of at least 10 characters is required.' };
  const recovered = payload?.recoveredNgn != null ? roundMoney(payload.recoveredNgn) : roundMoney(row.amount_recovered_ngn);
  const writtenOff = payload?.writtenOffNgn != null ? roundMoney(payload.writtenOffNgn) : roundMoney(row.written_off_ngn);
  if (recovered < 0 || writtenOff < 0) return { ok: false, error: 'Recovered and written off amounts cannot be negative.' };
  try {
    db.transaction(() => {
      releaseHoldTx(db, row, actor);
      db.prepare(
        `UPDATE investigation_cases
         SET status = 'Closed', outcome = ?, decision_note = ?,
             amount_recovered_ngn = ?, written_off_ngn = ?,
             hold_active = 0, closed_by_user_id = ?, closed_at_iso = ?
         WHERE id = ?`
      ).run(
        outcome,
        decision,
        recovered,
        writtenOff,
        actor?.id ? String(actor.id) : null,
        new Date().toISOString(),
        row.id
      );
      db.prepare(`INSERT INTO investigation_notes (id, case_id, author, at_iso, text) VALUES (?,?,?,?,?)`).run(
        nextChildId('INVN'),
        row.id,
        actorName(actor),
        new Date().toISOString(),
        decision
      );
      audit(db, actor, 'investigation.platform.close', row.id, { outcome, recovered, writtenOff });
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  return packCase(db, loadCaseRow(db, row.id), actor, { logView: false });
}

export function investigationPlatformBadges(db, kind, ids) {
  ensureInvestigationPlatformSchema(db);
  const recordKind = String(kind || '').trim();
  const list = (Array.isArray(ids) ? ids : String(ids || '').split(','))
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const badges = {};
  if (!INVESTIGATION_RECORD_KINDS.includes(recordKind)) return { ok: true, badges };
  for (const id of list) {
    const row = db
      .prepare(
        `SELECT c.id
         FROM investigation_case_links l
         JOIN investigation_cases c ON c.id = l.case_id
         WHERE l.record_kind = ? AND l.record_id = ?`
      )
      .all(recordKind, id)
      .find((candidate) => {
        const full = loadCaseRow(db, candidate.id);
        return full && investigationCaseFreezes(full.status, full.hold_active);
      });
    if (!row) continue;
    badges[id] = { caseId: row.id, label: investigationHoldMessage(row.id) };
  }
  return { ok: true, badges };
}
