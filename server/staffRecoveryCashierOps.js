/**
 * Branch cashier collection for staff discipline recovery — treasury in + schedule + obligation ledger.
 * @module server/staffRecoveryCashierOps
 */
import { actorName } from './auth.js';
import { assertPeriodOpen } from './controlOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import {
  applyRecoverySettlementTx,
  listRecoverySettlementsForSchedule,
  mapRecoveryScheduleRow,
  mapRecoverySettlementRow,
  recoverySchedulesTableReady,
  recoverySettlementsTableReady,
} from './hrIncidentRecoveryOps.js';
import { appendHrAuditEvent } from './hrOps.js';
import {
  OBLIGATION_TX_TYPE,
  postObligationTransaction,
  staffObligationTablesReady,
} from './staffObligationOps.js';
import {
  openRecoveryObligationFromSchedule,
  resolveObligationAccountIdForRecoverySchedule,
} from './staffRecoveryObligationOps.js';
import { insertTreasuryMovementTx } from './writeOps.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Active recovery schedules with outstanding balance — for Finance → Desk cashier queue.
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
export function listStaffRecoveriesDueForCashier(db, branchScope = 'ALL') {
  if (!recoverySchedulesTableReady(db)) return [];
  let sql = `
    SELECT s.*, c.case_number, u.display_name AS staff_display_name, p.branch_id
    FROM hr_incident_recovery_schedules s
    INNER JOIN hr_staff_profiles p ON p.user_id = s.user_id
    LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
    LEFT JOIN app_users u ON u.id = s.user_id
    WHERE s.status = 'active'
      AND COALESCE(s.principal_outstanding_ngn, 0) > 0
      AND COALESCE(s.deductions_active, 0) = 1`;
  const args = [];
  if (branchScope && branchScope !== 'ALL') {
    sql += ` AND p.branch_id = ?`;
    args.push(String(branchScope).trim());
  }
  sql += ` ORDER BY s.created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map((row) => {
    const mapped = mapRecoveryScheduleRow(row);
    const obligationAccountId = resolveObligationAccountIdForRecoverySchedule(db, row.id);
    return {
      scheduleId: mapped.id,
      caseId: mapped.caseId,
      caseNumber: mapped.caseNumber,
      userId: mapped.userId,
      staffDisplayName: row.staff_display_name || mapped.userId,
      branchId: String(row.branch_id || DEFAULT_BRANCH_ID).trim(),
      totalAmountNgn: mapped.totalAmountNgn,
      installmentAmountNgn: mapped.installmentAmountNgn,
      principalOutstandingNgn: mapped.principalOutstandingNgn,
      obligationAccountId,
      title: `Recovery — ${mapped.caseNumber || mapped.caseId || mapped.id}`,
    };
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {string} scheduleId
 * @param {{
 *   treasuryAccountId?: number;
 *   amountNgn?: number;
 *   payInFull?: boolean;
 *   paymentDateIso?: string;
 *   note?: string;
 *   workspaceBranchId?: string;
 *   workspaceViewAll?: boolean;
 * }} body
 */
export function recordStaffRecoveryCashierPayment(db, actor, scheduleId, body = {}) {
  if (!recoverySchedulesTableReady(db)) {
    return { ok: false, error: 'Recovery schedules not migrated.' };
  }
  if (!recoverySettlementsTableReady(db)) {
    return { ok: false, error: 'Recovery settlements not migrated.' };
  }
  if (!staffObligationTablesReady(db)) {
    return { ok: false, error: 'Staff obligation ledger not migrated.' };
  }

  const sid = String(scheduleId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(sid);
  if (!row) return { ok: false, error: 'Recovery schedule not found.' };
  if (String(row.status) !== 'active') {
    return { ok: false, error: 'Only active recovery schedules can receive cashier payments.' };
  }

  const prof = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(row.user_id);
  const branchId = String(prof?.branch_id || DEFAULT_BRANCH_ID).trim();
  const workspaceBranchId = String(body.workspaceBranchId || '').trim() || branchId;
  const workspaceViewAll = Boolean(body.workspaceViewAll);

  if (!workspaceViewAll && workspaceBranchId && branchId !== workspaceBranchId) {
    return {
      ok: false,
      error: `This employee belongs to branch ${branchId}. Switch workspace branch before receiving payment.`,
    };
  }

  const outstanding = roundMoney(row.principal_outstanding_ngn);
  if (outstanding <= 0) return { ok: false, error: 'Nothing outstanding on this recovery.' };

  const treasuryAccountId = Number(body.treasuryAccountId);
  if (!treasuryAccountId) return { ok: false, error: 'Treasury account is required.' };

  const payInFull = body.payInFull === true;
  let amountNgn = payInFull ? outstanding : roundMoney(body.amountNgn);
  if (amountNgn <= 0) return { ok: false, error: 'Payment amount must be greater than zero.' };
  if (amountNgn > outstanding) {
    return { ok: false, error: `Payment cannot exceed outstanding (₦${outstanding.toLocaleString('en-NG')}).` };
  }

  const paymentDateIso =
    String(body.paymentDateIso ?? '').trim().slice(0, 10) || nowIso().slice(0, 10);
  const note = String(body.note ?? '').trim() || null;

  try {
    assertPeriodOpen(db, paymentDateIso, 'Staff recovery payment date');
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(row.user_id);
  const staffLabel = staff?.display_name || row.user_id;
  const caseRow = db.prepare(`SELECT case_number FROM hr_discipline_cases WHERE id = ?`).get(row.case_id);
  const caseNumber = caseRow?.case_number || row.case_id;

  let obligationAccountId = resolveObligationAccountIdForRecoverySchedule(db, sid);
  if (!obligationAccountId) {
    const opened = openRecoveryObligationFromSchedule(db, sid, actor);
    if (!opened.ok) return opened;
    obligationAccountId = opened.account?.id || opened.accountId;
  }
  if (!obligationAccountId) {
    return { ok: false, error: 'Could not open staff recovery obligation account.' };
  }

  const completed = amountNgn >= outstanding;
  const settlementKind = completed ? 'lump_sum' : 'partial';
  const now = nowIso();
  let treasuryMovement = null;
  let settlementId = null;
  let obligationTxId = null;
  let receiptReference = null;

  try {
    db.transaction(() => {
      treasuryMovement = insertTreasuryMovementTx(db, {
        type: 'STAFF_RECOVERY_IN',
        treasuryAccountId,
        amountNgn,
        postedAtISO: `${paymentDateIso}T12:00:00.000Z`,
        reference: `Recovery ${caseNumber || sid}`,
        counterpartyKind: 'STAFF',
        counterpartyId: row.user_id,
        counterpartyName: staffLabel,
        sourceKind: 'STAFF_RECOVERY',
        sourceId: sid,
        note: note || `Staff discipline recovery — ${caseNumber || sid}`,
        createdBy: actorName(actor),
        workspaceBranchId: branchId,
        workspaceViewAll,
        actor,
      });
      receiptReference = treasuryMovement.id;

      const applied = applyRecoverySettlementTx(db, actor, row, {
        amountNgn,
        paymentReference: receiptReference,
        paymentDateIso,
        note: note || 'Branch cashier collection',
        settlementKind,
        now,
      });
      settlementId = applied.settlementId;

      const obResult = postObligationTransaction(db, obligationAccountId, {
        type: OBLIGATION_TX_TYPE.CASH_REPAYMENT,
        amountNgn,
        effectiveAtIso: `${paymentDateIso}T12:00:00.000Z`,
        sourceKind: 'staff_recovery_cashier',
        sourceId: receiptReference,
        paymentReference: receiptReference,
        note: note || `Cashier recovery — ${caseNumber || sid}`,
        recordedByUserId: actor?.id || null,
      });
      obligationTxId = obResult.transaction?.id || null;
    })();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  appendHrAuditEvent(db, {
    actorUserId: actor?.id || null,
    action: 'hr.recovery.cashier_payment',
    entityKind: 'hr_incident_recovery_schedule',
    entityId: sid,
    details: {
      amountNgn,
      treasuryMovementId: treasuryMovement?.id,
      obligationAccountId,
      obligationTxId,
      settlementId,
      treasuryAccountId,
      completed,
    },
  });

  const updated = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(sid);
  return {
    ok: true,
    receiptReference,
    treasuryMovementId: treasuryMovement?.id,
    treasuryAccountName: treasuryMovement?.accountName || null,
    obligationAccountId,
    obligationTransactionId: obligationTxId,
    settlement: mapRecoverySettlementRow(
      db.prepare(`SELECT * FROM hr_incident_recovery_settlements WHERE id = ?`).get(settlementId)
    ),
    schedule: {
      ...mapRecoveryScheduleRow(updated),
      staffDisplayName: staffLabel,
      settlements: listRecoverySettlementsForSchedule(db, sid),
    },
    principalOutstandingNgn: roundMoney(updated?.principal_outstanding_ngn),
    paidInFull: completed,
  };
}
