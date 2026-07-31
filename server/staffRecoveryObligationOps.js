/**
 * Adapter — discipline incident recovery schedules ↔ unified staff obligation ledger.
 * @module server/staffRecoveryObligationOps
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendHrAuditEvent, nowIso } from './hrOps.js';
import { recoverySchedulesTableReady } from './hrIncidentRecoveryOps.js';
import {
  OBLIGATION_KIND,
  OBLIGATION_ORIGIN,
  OBLIGATION_STATUS,
  OBLIGATION_TX_TYPE,
  insertObligationAccount,
  mapObligationAccountRow,
  postObligationTransaction,
  recordObligationCashRepayment,
  settleObligationAfterPayrollDeduction,
  staffObligationTablesReady,
} from './staffObligationOps.js';

export function recoveryScheduleIdColumnReady(db) {
  if (!staffObligationTablesReady(db)) return false;
  try {
    const cols = new Set(db.prepare(`PRAGMA table_info(hr_staff_obligation_accounts)`).all().map((c) => c.name));
    return cols.has('recovery_schedule_id');
  } catch {
    return false;
  }
}

export function resolveObligationAccountIdForRecoverySchedule(db, scheduleId) {
  if (!recoveryScheduleIdColumnReady(db)) return null;
  const sid = String(scheduleId || '').trim();
  if (!sid) return null;
  const row = db.prepare(`SELECT id FROM hr_staff_obligation_accounts WHERE recovery_schedule_id = ?`).get(sid);
  return row?.id || null;
}

function insertObligationAccountWithRecovery(db, payload) {
  const base = insertObligationAccount(db, payload);
  if (!base.ok || !payload.recoveryScheduleId || !recoveryScheduleIdColumnReady(db)) return base;
  db.prepare(`UPDATE hr_staff_obligation_accounts SET recovery_schedule_id = ? WHERE id = ?`).run(
    String(payload.recoveryScheduleId),
    base.account.id
  );
  return {
    ok: true,
    account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(base.account.id)),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scheduleId
 * @param {object | null} [actor]
 */
export function openRecoveryObligationFromSchedule(db, scheduleId, actor = null) {
  if (!staffObligationTablesReady(db) || !recoverySchedulesTableReady(db)) {
    return { ok: false, skipped: true };
  }
  const sid = String(scheduleId || '').trim();
  const sched = db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id WHERE s.id = ?`
    )
    .get(sid);
  if (!sched) return { ok: false, error: 'Recovery schedule not found.' };

  const existingId = resolveObligationAccountIdForRecoverySchedule(db, sid);
  if (existingId) return { ok: true, accountId: existingId, already: true };

  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(sched.user_id);
  const branchId = String(prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const total = Math.round(Number(sched.total_amount_ngn) || 0);
  const outstandingRaw = Number(sched.principal_outstanding_ngn);
  const outstanding = Math.round(Number.isFinite(outstandingRaw) ? outstandingRaw : total);
  const installment = Math.round(Number(sched.installment_amount_ngn) || 0);
  const termMonths = Math.round(Number(sched.duration_months) || 0);
  const monthsPaid = Math.round(Number(sched.months_deducted) || 0);
  const active = String(sched.status) === 'active' && Boolean(sched.deductions_active);
  const title = `Recovery — ${sched.case_number || sched.case_id || sid}`;

  let status = OBLIGATION_STATUS.ACTIVE;
  if (String(sched.status) === 'cancelled') status = OBLIGATION_STATUS.CANCELLED;
  else if (String(sched.status) === 'completed' || outstanding <= 0) status = OBLIGATION_STATUS.PAID_OFF;
  else if (!active) status = OBLIGATION_STATUS.PENDING_APPROVAL;

  const ins = insertObligationAccountWithRecovery(db, {
    userId: sched.user_id,
    branchId,
    kind: OBLIGATION_KIND.RECOVERY,
    origin: OBLIGATION_ORIGIN.MIGRATED,
    title,
    principalOriginalNgn: total,
    principalOutstandingNgn: 0,
    installmentNgn: installment,
    termMonths,
    monthsPaid,
    status,
    deductionsActive: active && outstanding > 0,
    disciplineCaseId: sched.case_id,
    recoveryScheduleId: sid,
    note: `Linked recovery schedule ${sid}`,
    createdByUserId: actor?.id || null,
  });
  if (!ins.ok) return ins;

  const accountId = ins.account.id;
  if (outstanding > 0) {
    postObligationTransaction(db, accountId, {
      type: OBLIGATION_TX_TYPE.OPENING_BALANCE,
      amountNgn: outstanding,
      effectiveAtIso: sched.activated_at_iso || sched.created_at_iso || nowIso(),
      sourceKind: 'recovery_schedule',
      sourceId: sid,
      note: 'Incident recovery obligation',
      recordedByUserId: actor?.id || null,
    });
  }

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.obligation.recovery_linked',
    entityKind: 'hr_staff_obligation_account',
    entityId: accountId,
    details: { scheduleId: sid, caseId: sched.case_id },
  });

  return {
    ok: true,
    account: mapObligationAccountRow(db.prepare(`SELECT * FROM hr_staff_obligation_accounts WHERE id = ?`).get(accountId)),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function backfillRecoveryObligationsFromSchedules(db) {
  if (!recoverySchedulesTableReady(db) || !staffObligationTablesReady(db)) {
    return { ok: true, created: 0, skipped: 0, tablesNotReady: true };
  }
  const rows = db
    .prepare(`SELECT id FROM hr_incident_recovery_schedules WHERE status IN ('active', 'completed', 'draft')`)
    .all();
  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const r = openRecoveryObligationFromSchedule(db, row.id, null);
    if (r.already) skipped += 1;
    else if (r.ok) created += 1;
  }
  return { ok: true, created, skipped };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scheduleId
 * @param {string} userId
 * @param {number} deductedNgn
 * @param {string} [payrollRunId]
 */
export function settleRecoveryObligationAfterPayroll(db, scheduleId, userId, deductedNgn, payrollRunId = '') {
  const obId = resolveObligationAccountIdForRecoverySchedule(db, scheduleId);
  if (!obId) return;
  settleObligationAfterPayrollDeduction(db, obId, userId, deductedNgn, payrollRunId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scheduleId
 * @param {object | null} actor
 * @param {object} body
 */
export function mirrorRecoveryCashSettlementToObligation(db, scheduleId, actor, body = {}) {
  const obId = resolveObligationAccountIdForRecoverySchedule(db, scheduleId);
  if (!obId) return { ok: false, skipped: true };
  return recordObligationCashRepayment(db, actor, obId, body);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} scheduleId
 */
export function cancelRecoveryObligationAccount(db, scheduleId) {
  const obId = resolveObligationAccountIdForRecoverySchedule(db, scheduleId);
  if (!obId) return;
  db.prepare(
    `UPDATE hr_staff_obligation_accounts SET status = ?, deductions_active = 0, updated_at_iso = ? WHERE id = ?`
  ).run(OBLIGATION_STATUS.CANCELLED, nowIso(), obId);
}

/**
 * Payroll breakdown from obligation ledger (recovery kind), mapped for legacy payroll lines.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function activeRecoveryObligationBreakdownForPayroll(db, userId) {
  if (!staffObligationTablesReady(db) || !recoveryScheduleIdColumnReady(db)) return null;
  const rows = db
    .prepare(
      `SELECT * FROM hr_staff_obligation_accounts
       WHERE user_id = ? AND kind = ? AND deductions_active = 1 AND status = ? AND principal_outstanding_ngn > 0`
    )
    .all(userId, OBLIGATION_KIND.RECOVERY, OBLIGATION_STATUS.ACTIVE);
  const recoveries = [];
  for (const row of rows) {
    let amountNgn = Math.round(Number(row.installment_ngn) || 0);
    const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
    if (amountNgn <= 0 || outstanding <= 0) continue;
    amountNgn = Math.min(amountNgn, outstanding);
    const termMonths = Math.round(Number(row.term_months) || 0);
    const monthsPaid = Math.round(Number(row.months_paid) || 0);
    if (termMonths > 0 && monthsPaid >= termMonths) continue;
    const scheduleId = String(row.recovery_schedule_id || '').trim();
    recoveries.push({
      scheduleId: scheduleId || row.id,
      obligationAccountId: row.id,
      amountNgn,
      title: row.title || 'Incident recovery',
      caseNumber: row.discipline_case_id || scheduleId || row.id,
    });
  }
  return {
    total: recoveries.reduce((s, x) => s + x.amountNgn, 0),
    recoveries,
  };
}
