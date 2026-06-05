/**
 * AP1d — credit exception workflow (no GL posting).
 */
import { appendAuditLog } from './controlOps.js';
import { getCreditPolicyConfig, requiredApprovalLevelForCreditAmount } from './creditPolicy.js';
import { evaluateQuotationPaymentForDeliveryRelease } from './deliveryReleaseGate.js';
import { getBranchCodeUpper, bumpHumanSerial } from './humanId.js';
import { listProductionJobs } from './readModel.js';

export const CREDIT_EXCEPTION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
};

export const CREDIT_APPROVAL_LEVEL = {
  BRANCH_MANAGER: 'branch_manager',
  MD: 'md',
  ADMIN: 'admin',
};

function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    try {
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
          )
          .get(name)
      );
    } catch {
      return false;
    }
  }
}

export function creditExceptionsTableReady(db) {
  return tableExists(db, 'credit_exceptions');
}

export function migrateCreditExceptions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_exceptions (
      id TEXT PRIMARY KEY,
      quotation_id TEXT NOT NULL,
      quotation_ref TEXT NOT NULL,
      customer_id TEXT,
      branch_id TEXT,
      amount_ngn INTEGER NOT NULL DEFAULT 0,
      outstanding_ngn_at_request INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      requested_by_user_id TEXT,
      requested_at_iso TEXT NOT NULL,
      approved_by_user_id TEXT,
      approved_at_iso TEXT,
      approval_level TEXT,
      credit_terms_days INTEGER,
      due_date_iso TEXT,
      expires_at_iso TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT,
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_quotation_ref ON credit_exceptions(quotation_ref);
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_customer_id ON credit_exceptions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_branch_id ON credit_exceptions(branch_id);
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_status ON credit_exceptions(status);
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_due_date ON credit_exceptions(due_date_iso);
    CREATE INDEX IF NOT EXISTS idx_credit_exceptions_approved_by ON credit_exceptions(approved_by_user_id);
  `);
}

function nextCreditExceptionId(db, branchId) {
  const code = getBranchCodeUpper(db, branchId);
  const yy = String(new Date().getFullYear()).slice(-2);
  const scope = `CEX:${code}:${yy}`;
  const seq = bumpHumanSerial(db, scope);
  return `CEX-${code}-${yy}-${String(seq).padStart(4, '0')}`;
}

function addDaysIso(isoDate, days) {
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

function rowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    quotationId: row.quotation_id,
    quotationRef: row.quotation_ref,
    customerId: row.customer_id,
    branchId: row.branch_id,
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    outstandingNgnAtRequest: Math.round(Number(row.outstanding_ngn_at_request) || 0),
    reason: row.reason,
    requestedByUserId: row.requested_by_user_id,
    requestedAtISO: row.requested_at_iso,
    approvedByUserId: row.approved_by_user_id,
    approvedAtISO: row.approved_at_iso,
    approvalLevel: row.approval_level,
    creditTermsDays: row.credit_terms_days != null ? Number(row.credit_terms_days) : null,
    dueDateISO: row.due_date_iso,
    expiresAtISO: row.expires_at_iso,
    status: row.status,
    decisionNote: row.decision_note,
    createdAtISO: row.created_at_iso,
    updatedAtISO: row.updated_at_iso,
  };
}

function roleKey(actor) {
  return String(actor?.roleKey || actor?.role || '').toLowerCase();
}

export function userMayRequestCreditException(actor) {
  const rk = roleKey(actor);
  if (rk === 'md' || rk === 'admin') return true;
  if (['sales_manager', 'branch_manager', 'finance_manager'].includes(rk)) return true;
  return false;
}

export function userMayApproveCreditException(actor, requiredLevel) {
  const rk = roleKey(actor);
  if (rk === 'md' || rk === 'admin') return true;
  if (requiredLevel === 'branch_manager' && (rk === 'sales_manager' || rk === 'branch_manager')) {
    return true;
  }
  return false;
}

export function userMayRevokeCreditException(actor) {
  const rk = roleKey(actor);
  return rk === 'md' || rk === 'admin' || rk === 'finance_manager';
}

export function userMayViewCreditExceptions(actor) {
  const rk = roleKey(actor);
  if (userMayRequestCreditException(actor)) return true;
  if (['accounting', 'accountant'].includes(rk)) return true;
  if (rk === 'cashier') return false;
  return rk === 'ceo';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function getQuotationCreditStatus(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref || !creditExceptionsTableReady(db)) {
    return {
      ok: true,
      quotationRef: ref,
      outstandingNgn: 0,
      receivableNgn: 0,
      creditExceptions: [],
      activeCredit: null,
      policy: getCreditPolicyConfig(db),
    };
  }
  const q = db.prepare(`SELECT id, customer_id, branch_id, total_ngn, paid_ngn FROM quotations WHERE id = ?`).get(ref);
  const jobs = listProductionJobs(db, 'ALL');
  const pay = evaluateQuotationPaymentForDeliveryRelease(db, ref, jobs);
  const outstandingNgn = Math.round(Number(pay.balanceNgn) || 0);
  const rows = db
    .prepare(
      `SELECT * FROM credit_exceptions WHERE quotation_ref = ? ORDER BY created_at_iso DESC LIMIT 50`
    )
    .all(ref);
  const dtos = rows.map(rowToDto);
  const active = resolveActiveCreditForQuotation(db, ref, outstandingNgn);
  return {
    ok: true,
    quotationRef: ref,
    quotationId: q?.id || ref,
    customerId: q?.customer_id || null,
    branchId: q?.branch_id || null,
    totalNgn: Math.round(Number(q?.total_ngn) || 0),
    paidNgn: Math.round(Number(q?.paid_ngn) || 0),
    outstandingNgn,
    receivableNgn: pay.policyPhase === 'post_production' ? outstandingNgn : 0,
    policyPhase: pay.policyPhase,
    creditExceptions: dtos,
    activeCredit: active,
    policy: getCreditPolicyConfig(db),
  };
}

function isCreditExpired(row) {
  const exp = String(row?.expires_at_iso || '').trim();
  if (!exp) return false;
  return exp.slice(0, 10) < nowIso().slice(0, 10);
}

/**
 * Active approved credit that covers current outstanding.
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 * @param {number} [balanceNgn]
 */
export function resolveActiveCreditForQuotation(db, quotationRef, balanceNgn = null) {
  const ref = String(quotationRef || '').trim();
  if (!ref || !creditExceptionsTableReady(db)) return null;

  let balance = balanceNgn;
  if (balance == null) {
    const jobs = listProductionJobs(db, 'ALL');
    const pay = evaluateQuotationPaymentForDeliveryRelease(db, ref, jobs);
    balance = Math.round(Number(pay.balanceNgn) || 0);
  }
  if (balance <= 0) return null;

  const rows = db
    .prepare(
      `SELECT * FROM credit_exceptions
       WHERE quotation_ref = ? AND status = ?
       ORDER BY approved_at_iso DESC, created_at_iso DESC`
    )
    .all(ref, CREDIT_EXCEPTION_STATUS.APPROVED);

  for (const row of rows) {
    if (isCreditExpired(row)) continue;
    const amt = Math.round(Number(row.amount_ngn) || 0);
    if (amt >= balance) {
      return {
        ...rowToDto(row),
        coversBalance: true,
        coverageGapNgn: 0,
        effective: true,
      };
    }
  }
  const partial = rows.find((r) => !isCreditExpired(r));
  if (partial) {
    const amt = Math.round(Number(partial.amount_ngn) || 0);
    return {
      ...rowToDto(partial),
      coversBalance: false,
      coverageGapNgn: Math.max(0, balance - amt),
      effective: false,
    };
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string; status?: string; quotationRef?: string; limit?: number }} [filters]
 */
export function listCreditExceptions(db, filters = {}) {
  if (!creditExceptionsTableReady(db)) return [];
  const clauses = [];
  const args = [];
  const st = String(filters.status || '').trim();
  if (st) {
    clauses.push(`status = ?`);
    args.push(st);
  }
  const qref = String(filters.quotationRef || '').trim();
  if (qref) {
    clauses.push(`quotation_ref = ?`);
    args.push(qref);
  }
  const bid = String(filters.branchId || '').trim();
  if (bid && bid !== 'ALL') {
    clauses.push(`(branch_id = ? OR branch_id IS NULL OR branch_id = '')`);
    args.push(bid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, Math.round(Number(filters.limit) || 100)));
  const rows = db
    .prepare(`SELECT * FROM credit_exceptions ${where} ORDER BY updated_at_iso DESC LIMIT ${limit}`)
    .all(...args);
  return rows.map(rowToDto);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload
 * @param {object | null} actor
 */
export function createCreditExceptionRequest(db, payload, actor) {
  if (!creditExceptionsTableReady(db)) {
    return { ok: false, error: 'Credit exceptions are not available. Run migrations.' };
  }
  if (!userMayRequestCreditException(actor)) {
    return { ok: false, error: 'You do not have permission to request a credit exception.', code: 'FORBIDDEN' };
  }

  const quotationRef = String(payload.quotationRef || payload.quotationId || '').trim();
  if (!quotationRef) return { ok: false, error: 'quotationRef is required.' };

  const q = db.prepare(`SELECT id, customer_id, branch_id, total_ngn, paid_ngn FROM quotations WHERE id = ?`).get(quotationRef);
  if (!q) return { ok: false, error: 'Quotation not found.' };

  const jobs = listProductionJobs(db, 'ALL');
  const pay = evaluateQuotationPaymentForDeliveryRelease(db, quotationRef, jobs);
  const outstanding = Math.round(Number(pay.balanceNgn) || 0);
  if (outstanding <= 0) {
    return { ok: false, error: 'Quotation has no outstanding balance — credit exception not required.' };
  }

  const pending = db
    .prepare(
      `SELECT id FROM credit_exceptions WHERE quotation_ref = ? AND status = ? LIMIT 1`
    )
    .get(quotationRef, CREDIT_EXCEPTION_STATUS.PENDING);
  if (pending) {
    return { ok: false, error: 'A pending credit exception already exists for this quotation.', code: 'DUPLICATE_PENDING' };
  }

  const cfg = getCreditPolicyConfig(db);
  const amountNgn = Math.round(Number(payload.amountNgn) || outstanding);
  if (amountNgn <= 0) return { ok: false, error: 'amountNgn must be positive.' };
  if (amountNgn > outstanding) {
    return { ok: false, error: `Requested credit cannot exceed outstanding balance (₦${outstanding.toLocaleString('en-NG')}).` };
  }

  let terms = Math.round(Number(payload.creditTermsDays) || cfg.defaultTermsDays);
  terms = Math.min(cfg.maxTermsDays, Math.max(1, terms));
  const requestDate = String(payload.requestDateISO || '').slice(0, 10) || nowIso().slice(0, 10);
  const dueDateISO = String(payload.dueDateISO || '').slice(0, 10) || addDaysIso(requestDate, terms);
  const expiresAtISO =
    String(payload.expiresAtISO || '').slice(0, 10) || addDaysIso(dueDateISO, 30);

  const required = requiredApprovalLevelForCreditAmount(db, amountNgn);
  const branchId = String(payload.branchId || q.branch_id || '').trim() || null;
  const id = nextCreditExceptionId(db, branchId);
  const t = nowIso();
  const uid = actor?.id != null ? String(actor.id) : null;

  db.prepare(
    `INSERT INTO credit_exceptions (
      id, quotation_id, quotation_ref, customer_id, branch_id,
      amount_ngn, outstanding_ngn_at_request, reason,
      requested_by_user_id, requested_at_iso,
      approved_by_user_id, approved_at_iso, approval_level,
      credit_terms_days, due_date_iso, expires_at_iso,
      status, decision_note, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    q.id,
    quotationRef,
    q.customer_id || null,
    branchId,
    amountNgn,
    outstanding,
    String(payload.reason || '').trim() || null,
    uid,
    t,
    null,
    null,
    null,
    terms,
    dueDateISO,
    expiresAtISO,
    CREDIT_EXCEPTION_STATUS.PENDING,
    null,
    t,
    t
  );

  appendAuditLog(db, {
    actor,
    action: 'credit_exception.requested',
    entityKind: 'credit_exception',
    entityId: id,
    note: `Credit exception requested for ${quotationRef}`,
    details: {
      quotationRef,
      amountNgn,
      outstandingNgn: outstanding,
      requiredApprovalLevel: required.level,
      creditTermsDays: terms,
      dueDateISO,
    },
  });

  const row = db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(id);
  return {
    ok: true,
    creditException: rowToDto(row),
    requiredApprovalLevel: required.level,
    policyNote: cfg.policyNote,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {'approve' | 'reject'} decision
 * @param {object} payload
 * @param {object | null} actor
 */
export function decideCreditException(db, id, decision, payload, actor) {
  if (!creditExceptionsTableReady(db)) {
    return { ok: false, error: 'Credit exceptions are not available.' };
  }
  const row = db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(String(id || '').trim());
  if (!row) return { ok: false, error: 'Credit exception not found.' };
  if (row.status !== CREDIT_EXCEPTION_STATUS.PENDING) {
    return { ok: false, error: `Credit exception is not pending (status: ${row.status}).` };
  }

  const dec = String(decision || '').toLowerCase();
  if (dec !== 'approve' && dec !== 'reject') {
    return { ok: false, error: 'decision must be approve or reject.' };
  }

  const required = requiredApprovalLevelForCreditAmount(db, row.amount_ngn);
  if (!userMayApproveCreditException(actor, required.level)) {
    return {
      ok: false,
      error: 'You do not have permission to approve this credit level.',
      code: 'FORBIDDEN',
      requiredApprovalLevel: required.level,
    };
  }

  const t = nowIso();
  const uid = actor?.id != null ? String(actor.id) : null;
  const rk = roleKey(actor);
  const approvalLevel =
    rk === 'admin' ? CREDIT_APPROVAL_LEVEL.ADMIN : rk === 'md' ? CREDIT_APPROVAL_LEVEL.MD : CREDIT_APPROVAL_LEVEL.BRANCH_MANAGER;

  if (dec === 'reject') {
    db.prepare(
      `UPDATE credit_exceptions SET status = ?, decision_note = ?, approved_by_user_id = ?, approved_at_iso = ?, approval_level = ?, updated_at_iso = ? WHERE id = ?`
    ).run(
      CREDIT_EXCEPTION_STATUS.REJECTED,
      String(payload.decisionNote || payload.note || '').trim() || null,
      uid,
      t,
      approvalLevel,
      t,
      row.id
    );
    appendAuditLog(db, {
      actor,
      action: 'credit_exception.rejected',
      entityKind: 'credit_exception',
      entityId: row.id,
      note: String(payload.decisionNote || '').trim() || 'Credit exception rejected',
      details: { quotationRef: row.quotation_ref },
    });
    return { ok: true, creditException: rowToDto(db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(row.id)) };
  }

  db.prepare(
    `UPDATE credit_exceptions SET status = ?, decision_note = ?, approved_by_user_id = ?, approved_at_iso = ?, approval_level = ?, updated_at_iso = ? WHERE id = ?`
  ).run(
    CREDIT_EXCEPTION_STATUS.APPROVED,
    String(payload.decisionNote || payload.note || '').trim() || null,
    uid,
    t,
    approvalLevel,
    t,
    row.id
  );
  appendAuditLog(db, {
    actor,
    action: 'credit_exception.approved',
    entityKind: 'credit_exception',
    entityId: row.id,
    note: String(payload.decisionNote || '').trim() || 'Credit exception approved',
    details: {
      quotationRef: row.quotation_ref,
      amountNgn: row.amount_ngn,
      approvalLevel,
      dueDateISO: row.due_date_iso,
    },
  });
  return { ok: true, creditException: rowToDto(db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(row.id)) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} payload
 * @param {object | null} actor
 */
export function revokeCreditException(db, id, payload, actor) {
  if (!creditExceptionsTableReady(db)) {
    return { ok: false, error: 'Credit exceptions are not available.' };
  }
  if (!userMayRevokeCreditException(actor)) {
    return { ok: false, error: 'You do not have permission to revoke credit exceptions.', code: 'FORBIDDEN' };
  }
  const row = db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(String(id || '').trim());
  if (!row) return { ok: false, error: 'Credit exception not found.' };
  if (row.status !== CREDIT_EXCEPTION_STATUS.APPROVED) {
    return { ok: false, error: 'Only approved credit exceptions can be revoked.' };
  }
  const t = nowIso();
  db.prepare(
    `UPDATE credit_exceptions SET status = ?, decision_note = ?, updated_at_iso = ? WHERE id = ?`
  ).run(
    CREDIT_EXCEPTION_STATUS.REVOKED,
    String(payload.decisionNote || payload.note || '').trim() || 'Revoked',
    t,
    row.id
  );
  appendAuditLog(db, {
    actor,
    action: 'credit_exception.revoked',
    entityKind: 'credit_exception',
    entityId: row.id,
    note: String(payload.decisionNote || '').trim() || 'Credit exception revoked',
    details: { quotationRef: row.quotation_ref },
  });
  return { ok: true, creditException: rowToDto(db.prepare(`SELECT * FROM credit_exceptions WHERE id = ?`).get(row.id)) };
}

/**
 * Read-only trial / dry-run counts (no PII).
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
export function countCreditExceptionTrialDiagnostics(db, branchScope = 'ALL') {
  const out = {
    pendingCreditExceptionsCount: 0,
    approvedCreditExposureNgn: 0,
    overdueApprovedCreditCount: 0,
    expiredCreditExceptionsCount: 0,
    deliveriesAllowedByCreditCount: 0,
    deliveriesWarningNoCreditCount: 0,
  };
  if (!creditExceptionsTableReady(db)) return out;

  const br =
    branchScope !== 'ALL' && String(branchScope || '').trim()
      ? ` AND (branch_id = ? OR branch_id IS NULL OR branch_id = '') `
      : '';
  const brArgs = branchScope !== 'ALL' && String(branchScope || '').trim() ? [branchScope] : [];

  const today = nowIso().slice(0, 10);

  out.pendingCreditExceptionsCount = Number(
    db
      .prepare(`SELECT COUNT(*) AS c FROM credit_exceptions WHERE status = 'pending' ${br}`)
      .get(...brArgs)?.c ?? 0
  );

  const approvedRows = db
    .prepare(`SELECT amount_ngn, due_date_iso, expires_at_iso FROM credit_exceptions WHERE status = 'approved' ${br}`)
    .all(...brArgs);
  for (const r of approvedRows) {
    out.approvedCreditExposureNgn += Math.round(Number(r.amount_ngn) || 0);
    const due = String(r.due_date_iso || '').slice(0, 10);
    if (due && due < today) out.overdueApprovedCreditCount += 1;
    const exp = String(r.expires_at_iso || '').slice(0, 10);
    if (exp && exp < today) out.expiredCreditExceptionsCount += 1;
  }

  if (!tableExists(db, 'deliveries') || !tableExists(db, 'quotations')) return out;

  let openSql = `SELECT d.id, d.quotation_ref FROM deliveries d
     WHERE UPPER(TRIM(COALESCE(d.status,''))) NOT IN ('DELIVERED','CANCELLED')`;
  const openArgs = [];
  if (br && tableExists(db, 'quotations')) {
    openSql = `SELECT d.id, d.quotation_ref FROM deliveries d
       INNER JOIN quotations q ON q.id = d.quotation_ref
       WHERE UPPER(TRIM(COALESCE(d.status,''))) NOT IN ('DELIVERED','CANCELLED')
         AND (q.branch_id = ? OR q.branch_id IS NULL OR q.branch_id = '')`;
    openArgs.push(...brArgs);
  }
  const openDeliveries = db.prepare(openSql).all(...openArgs);

  const jobs = listProductionJobs(db, branchScope);
  for (const d of openDeliveries) {
    const ref = String(d.quotation_ref || '').trim();
    if (!ref) continue;
    const pay = evaluateQuotationPaymentForDeliveryRelease(db, ref, jobs);
    if (!pay.wouldBlock) continue;
    const credit = resolveActiveCreditForQuotation(db, ref, pay.balanceNgn);
    if (credit?.coversBalance) out.deliveriesAllowedByCreditCount += 1;
    else out.deliveriesWarningNoCreditCount += 1;
  }

  return out;
}
