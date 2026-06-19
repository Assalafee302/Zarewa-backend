/**
 * Incident financial recovery schedules — payroll deduction (mirrors loan pattern).
 * @module server/hrIncidentRecoveryOps
 */

import crypto from 'node:crypto';
import { hrTableExists } from './hrTableChecks.js';
import { appendHrAuditEvent } from './hrOps.js';
import {
  activeRecoveryObligationBreakdownForPayroll,
  cancelRecoveryObligationAccount,
  mirrorRecoveryCashSettlementToObligation,
  openRecoveryObligationFromSchedule,
  settleRecoveryObligationAfterPayroll,
} from './staffRecoveryObligationOps.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function appendDisciplineCaseEventInline(db, actor, caseId, body = {}) {
  if (!hrTableExists(db, 'hr_discipline_events')) return;
  const cid = String(caseId || '').trim();
  const note = String(body.note || '').trim();
  if (!cid || note.length < 2) return;
  const id = newId('HRDISev');
  db.prepare(
    `INSERT INTO hr_discipline_events (id, case_id, event_kind, note, actor_user_id, created_at_iso)
     VALUES (?,?,?,?,?,?)`
  ).run(id, cid, String(body.eventKind || 'note').trim(), note, actor?.id || null, nowIso());
}

export function recoverySettlementsTableReady(db) {
  return hrTableExists(db, 'hr_incident_recovery_settlements');
}

export function mapRecoverySettlementRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    caseId: row.case_id,
    userId: row.user_id,
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    principalBeforeNgn: Math.round(Number(row.principal_before_ngn) || 0),
    principalAfterNgn: Math.round(Number(row.principal_after_ngn) || 0),
    paymentReference: row.payment_reference || null,
    paymentDateIso: row.payment_date_iso || null,
    note: row.note || null,
    settlementKind: row.settlement_kind || 'lump_sum',
    recordedByUserId: row.recorded_by_user_id || null,
    createdAtIso: row.created_at_iso,
  };
}

export function listRecoverySettlementsForSchedule(db, scheduleId) {
  if (!recoverySettlementsTableReady(db)) return [];
  return db
    .prepare(
      `SELECT * FROM hr_incident_recovery_settlements WHERE schedule_id = ? ORDER BY created_at_iso DESC`
    )
    .all(String(scheduleId || '').trim())
    .map(mapRecoverySettlementRow);
}

function listRecoverySettlementsForSchedules(db, scheduleIds) {
  if (!recoverySettlementsTableReady(db) || !scheduleIds?.length) return new Map();
  const ids = [...new Set(scheduleIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM hr_incident_recovery_settlements WHERE schedule_id IN (${placeholders}) ORDER BY created_at_iso DESC`
    )
    .all(...ids);
  const bySchedule = new Map();
  for (const row of rows) {
    const mapped = mapRecoverySettlementRow(row);
    const list = bySchedule.get(mapped.scheduleId) || [];
    list.push(mapped);
    bySchedule.set(mapped.scheduleId, list);
  }
  return bySchedule;
}

export function recoverySchedulesTableReady(db) {
  return hrTableExists(db, 'hr_incident_recovery_schedules');
}

export function mapRecoveryScheduleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    userId: row.user_id,
    registryId: row.registry_id || null,
    totalAmountNgn: Math.round(Number(row.total_amount_ngn) || 0),
    installmentAmountNgn: Math.round(Number(row.installment_amount_ngn) || 0),
    durationMonths: Math.round(Number(row.duration_months) || 0),
    principalOutstandingNgn: Math.round(Number(row.principal_outstanding_ngn) || 0),
    monthsDeducted: Math.round(Number(row.months_deducted) || 0),
    deductionsActive: Boolean(row.deductions_active),
    status: row.status,
    activatedAtIso: row.activated_at_iso || null,
    closedAtIso: row.closed_at_iso || null,
    caseNumber: row.case_number || null,
    createdAtIso: row.created_at_iso,
  };
}

export function listRecoverySchedulesForCase(db, caseId) {
  if (!recoverySchedulesTableReady(db)) return [];
  const rows = db
    .prepare(
      `SELECT s.*, c.case_number, u.display_name AS staff_display_name
       FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       LEFT JOIN app_users u ON u.id = s.user_id
       WHERE s.case_id = ? ORDER BY s.created_at_iso ASC`
    )
    .all(String(caseId || '').trim());
  const settlementsBySchedule = listRecoverySettlementsForSchedules(
    db,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    ...mapRecoveryScheduleRow(row),
    staffDisplayName: row.staff_display_name || null,
    settlements: settlementsBySchedule.get(row.id) || [],
  }));
}

export function listRecoverySchedulesForUser(db, userId) {
  if (!recoverySchedulesTableReady(db)) return [];
  return db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       WHERE s.user_id = ? AND s.status IN ('active','draft') ORDER BY s.created_at_iso DESC`
    )
    .all(String(userId || '').trim())
    .map(mapRecoveryScheduleRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function activeIncidentRecoveryBreakdown(db, userId) {
  const fromLedger = activeRecoveryObligationBreakdownForPayroll(db, userId);
  if (fromLedger?.recoveries?.length) return fromLedger;

  if (!recoverySchedulesTableReady(db)) return { total: 0, recoveries: [] };
  const rows = db
    .prepare(
      `SELECT s.*, c.case_number FROM hr_incident_recovery_schedules s
       LEFT JOIN hr_discipline_cases c ON c.id = s.case_id
       WHERE s.user_id = ? AND s.deductions_active = 1 AND s.status = 'active'`
    )
    .all(userId);
  const recoveries = [];
  for (const row of rows) {
    const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
    if (outstanding <= 0) continue;
    const monthsTotal = Math.round(Number(row.duration_months) || 0);
    const cur = Math.round(Number(row.months_deducted) || 0);
    if (monthsTotal > 0 && cur >= monthsTotal) continue;
    let amountNgn = Math.round(Number(row.installment_amount_ngn) || 0);
    if (amountNgn <= 0) continue;
    amountNgn = Math.min(amountNgn, outstanding);
    if (amountNgn <= 0) continue;
    recoveries.push({
      scheduleId: row.id,
      amountNgn,
      title: `Recovery ${row.case_number || row.case_id}`,
      caseNumber: row.case_number || row.case_id,
    });
  }
  const total = recoveries.reduce((s, x) => s + x.amountNgn, 0);
  return { total, recoveries };
}

export function createRecoverySchedulesFromCase(db, actor, caseId, opts = {}) {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Case not found.' };
  const lossNgn = Math.round(Number(row.loss_value_ngn) || 0);
  if (lossNgn <= 0) return { ok: false, error: 'loss_value_ngn must be set on the case.' };

  const parties = db
    .prepare(`SELECT * FROM incident_responsibility_map WHERE case_id = ?`)
    .all(row.id);
  if (!parties.length) return { ok: false, error: 'Responsibility map required before recovery schedules.' };

  const durationMonths = Math.max(1, Math.round(Number(opts.durationMonths) || 12));
  const now = nowIso();
  const activate = opts.activate !== false;
  const schedules = [];

  db.transaction(() => {
    for (const p of parties) {
      const weight = Number(p.responsibility_weight) || 0;
      const totalAmountNgn = Math.round((lossNgn * weight) / 100);
      if (totalAmountNgn <= 0) continue;
      const installmentAmountNgn = Math.max(1, Math.round(totalAmountNgn / durationMonths));
      const existing = db
        .prepare(`SELECT id FROM hr_incident_recovery_schedules WHERE case_id = ? AND user_id = ? AND status != 'cancelled'`)
        .get(row.id, p.user_id);
      if (existing?.id) continue;

      const id = newId('HRRcv');
      db.prepare(
        `INSERT INTO hr_incident_recovery_schedules (
          id, case_id, user_id, registry_id, total_amount_ngn, installment_amount_ngn, duration_months,
          principal_outstanding_ngn, months_deducted, deductions_active, status,
          activated_at_iso, created_at_iso, created_by_user_id, approved_by_user_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        row.id,
        p.user_id,
        row.registry_id || null,
        totalAmountNgn,
        installmentAmountNgn,
        durationMonths,
        totalAmountNgn,
        0,
        activate ? 1 : 0,
        activate ? 'active' : 'draft',
        activate ? now : null,
        now,
        actor?.id || null,
        actor?.id || null
      );
      schedules.push(mapRecoveryScheduleRow(db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(id)));
      if (activate) openRecoveryObligationFromSchedule(db, id, actor);
    }
  })();

  if (!schedules.length) {
    const existing = listRecoverySchedulesForCase(db, row.id);
    if (existing.length) return { ok: true, schedules: existing };
    return { ok: false, error: 'No recovery schedules created (check weights and loss amount).' };
  }

  return { ok: true, schedules };
}

export function activateRecoverySchedulesForCase(db, actor, caseId) {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const now = nowIso();
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET status = 'active', deductions_active = 1, activated_at_iso = ?, approved_by_user_id = ?
     WHERE case_id = ? AND status = 'draft'`
  ).run(now, actor?.id || null, String(caseId || '').trim());
  const schedules = listRecoverySchedulesForCase(db, caseId);
  for (const s of schedules) {
    if (String(s.status) === 'active') openRecoveryObligationFromSchedule(db, s.id, actor);
  }
  return { ok: true, schedules };
}

export function cancelRecoverySchedule(db, actor, scheduleId, reason = '') {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  const row = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(String(scheduleId || '').trim());
  if (!row) return { ok: false, error: 'Schedule not found.' };
  if (String(row.status) === 'completed') {
    return { ok: false, error: 'Completed schedules cannot be cancelled.' };
  }
  const now = nowIso();
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET status = 'cancelled', deductions_active = 0, closed_at_iso = ?, cancel_reason = ? WHERE id = ?`
  ).run(now, String(reason || '').trim() || null, row.id);
  cancelRecoveryObligationAccount(db, row.id);
  return { ok: true, schedule: mapRecoveryScheduleRow(db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(row.id)) };
}

/**
 * Record a direct (non-payroll) recovery payment — full or partial lump sum.
 * @param {import('better-sqlite3').Database} db
 * @param {object | null} actor
 * @param {string} scheduleId
 * @param {{ amountNgn?: number; payInFull?: boolean; paymentReference?: string; paymentDateIso?: string; note?: string }} body
 */
export function recordRecoverySettlement(db, actor, scheduleId, body = {}) {
  if (!recoverySchedulesTableReady(db)) return { ok: false, error: 'Recovery schedules not migrated.' };
  if (!recoverySettlementsTableReady(db)) {
    return { ok: false, error: 'Recovery settlements not migrated.' };
  }
  const sid = String(scheduleId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(sid);
  if (!row) return { ok: false, error: 'Schedule not found.' };
  if (String(row.status) !== 'active') {
    return { ok: false, error: 'Only active schedules can receive direct payments.' };
  }

  const outstanding = Math.round(Number(row.principal_outstanding_ngn) || 0);
  if (outstanding <= 0) return { ok: false, error: 'Nothing outstanding on this schedule.' };

  const payInFull = body.payInFull === true;
  let amountNgn = payInFull
    ? outstanding
    : Math.round(Number(body.amountNgn ?? body.amount_ngn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'Payment amount must be greater than zero.' };
  if (amountNgn > outstanding) {
    return { ok: false, error: `Payment cannot exceed outstanding balance (NGN ${outstanding.toLocaleString()}).` };
  }

  const paymentReference = String(body.paymentReference ?? body.payment_reference ?? '').trim() || null;
  const paymentDateIso =
    String(body.paymentDateIso ?? body.payment_date_iso ?? '').trim().slice(0, 10) ||
    nowIso().slice(0, 10);
  const note = String(body.note ?? '').trim() || null;
  const settlementKind = amountNgn >= outstanding ? 'lump_sum' : 'partial';
  const now = nowIso();
  const principalAfter = outstanding - amountNgn;
  const completed = principalAfter <= 0;
  const settlementId = newId('HRRcvPay');

  const staff = db.prepare(`SELECT display_name FROM app_users WHERE id = ?`).get(row.user_id);
  const staffLabel = staff?.display_name || row.user_id;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO hr_incident_recovery_settlements (
        id, schedule_id, case_id, user_id, amount_ngn, principal_before_ngn, principal_after_ngn,
        payment_reference, payment_date_iso, note, settlement_kind, recorded_by_user_id, created_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      settlementId,
      row.id,
      row.case_id,
      row.user_id,
      amountNgn,
      outstanding,
      principalAfter,
      paymentReference,
      paymentDateIso,
      note,
      settlementKind,
      actor?.id || null,
      now
    );
    db.prepare(
      `UPDATE hr_incident_recovery_schedules SET
        principal_outstanding_ngn = ?,
        deductions_active = ?,
        status = ?,
        closed_at_iso = ?
       WHERE id = ?`
    ).run(
      principalAfter,
      completed ? 0 : row.deductions_active,
      completed ? 'completed' : row.status,
      completed ? now : row.closed_at_iso,
      row.id
    );
  })();

  const eventNote = [
    `Direct recovery payment recorded for ${staffLabel}: NGN ${amountNgn.toLocaleString()}`,
    completed ? '(paid in full — payroll deductions stopped)' : `(outstanding now NGN ${principalAfter.toLocaleString()})`,
    paymentReference ? `Ref: ${paymentReference}` : '',
    note || '',
  ]
    .filter(Boolean)
    .join(' · ');

  appendDisciplineCaseEventInline(db, actor, row.case_id, {
    eventKind: 'recovery_settlement',
    note: eventNote,
  });
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.recovery.settlement',
    entityKind: 'hr_incident_recovery_schedule',
    entityId: row.id,
    details: {
      settlementId,
      caseId: row.case_id,
      userId: row.user_id,
      amountNgn,
      principalAfterNgn: principalAfter,
      settlementKind,
      paymentReference,
    },
  });

  const updated = db.prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ?`).get(row.id);
  mirrorRecoveryCashSettlementToObligation(db, sid, actor, {
    amountNgn,
    payInFull: completed,
    paymentReference,
    paymentDateIso,
    note,
  });
  return {
    ok: true,
    settlement: mapRecoverySettlementRow(
      db.prepare(`SELECT * FROM hr_incident_recovery_settlements WHERE id = ?`).get(settlementId)
    ),
    schedule: {
      ...mapRecoveryScheduleRow(updated),
      staffDisplayName: staff?.display_name || null,
      settlements: listRecoverySettlementsForSchedule(db, row.id),
    },
  };
}

export function settleRecoveryAfterPayrollDeduction(db, scheduleId, userId, deductedNgn) {
  if (!recoverySchedulesTableReady(db)) return;
  const row = db
    .prepare(`SELECT * FROM hr_incident_recovery_schedules WHERE id = ? AND user_id = ? AND status = 'active'`)
    .get(scheduleId, userId);
  if (!row || !row.deductions_active) return;
  const ded = Math.max(0, Math.round(Number(deductedNgn) || 0));
  const monthsTotal = Math.round(Number(row.duration_months) || 0);
  const cur = Math.round(Number(row.months_deducted) || 0);
  const nextMonths = cur + 1;
  const pr = Math.max(0, Math.round(Number(row.principal_outstanding_ngn) || 0) - ded);
  let status = row.status;
  let active = row.deductions_active;
  let closedAt = row.closed_at_iso;
  if (pr <= 0 || (monthsTotal > 0 && nextMonths >= monthsTotal)) {
    status = 'completed';
    active = 0;
    closedAt = nowIso();
  }
  db.prepare(
    `UPDATE hr_incident_recovery_schedules SET
      principal_outstanding_ngn = ?, months_deducted = ?, deductions_active = ?, status = ?, closed_at_iso = ?
     WHERE id = ?`
  ).run(pr, nextMonths, active ? 1 : 0, status, closedAt, row.id);
}

export function incrementRecoveriesFromPayrollRun(db, runId) {
  if (!recoverySchedulesTableReady(db)) return;
  if (!hrTableExists(db, 'hr_payroll_line_recoveries')) return;
  const items = db
    .prepare(`SELECT user_id, schedule_id, amount_ngn FROM hr_payroll_line_recoveries WHERE run_id = ? AND amount_ngn > 0`)
    .all(runId);
  for (const it of items) {
    settleRecoveryAfterPayrollDeduction(db, it.schedule_id, it.user_id, it.amount_ngn);
    settleRecoveryObligationAfterPayroll(db, it.schedule_id, it.user_id, it.amount_ngn, runId);
  }
}
