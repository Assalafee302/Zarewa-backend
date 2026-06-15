/**
 * Unified incident investigation audit pack.
 * @module server/incidentAuditPackOps
 */

import { getDisciplineCase, listDisciplineCaseEvents } from './hrDisciplineCasesOps.js';
import { getIncidentRegistryRow } from './hrAccountabilityOps.js';
import { listCaseResponsibility } from './hrAccountabilityOps.js';
import { listRecoverySchedulesForCase } from './hrIncidentRecoveryOps.js';
import { listHrAuditEventsGlobal } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function buildIncidentAuditPack(db, registryId, opts = {}) {
  const limit = Math.min(500, Math.max(50, Number(opts.limit) || 200));
  const reg = getIncidentRegistryRow(db, registryId);
  if (!reg) return { ok: false, error: 'Incident not found.' };

  const pack = {
    registry: reg,
    disciplineEvents: [],
    hrAudit: [],
    erpAudit: [],
    attendance: [],
    assets: [],
    custody: [],
    gatePasses: [],
    responsibility: [],
    recoverySchedules: [],
    payrollRecoveries: [],
  };

  let incidentDate = null;
  let branchId = reg.branchId;

  if (reg.incidentKind === 'hr_discipline') {
    const c = getDisciplineCase(db, reg.sourceId);
    if (c) {
      incidentDate = c.incidentDateIso || c.reportedDateIso;
      pack.case = c;
      pack.disciplineEvents = listDisciplineCaseEvents(db, c.id);
      pack.responsibility = listCaseResponsibility(db, c.id);
      pack.recoverySchedules = listRecoverySchedulesForCase(db, c.id);

      if (c.assetId && hrTableExists(db, 'fixed_assets')) {
        const asset = db.prepare(`SELECT * FROM fixed_assets WHERE id = ?`).get(c.assetId);
        if (asset) pack.assets.push(asset);
      }
      if (c.machineId && hrTableExists(db, 'machines')) {
        const machine = db.prepare(`SELECT * FROM machines WHERE id = ?`).get(c.machineId);
        if (machine) pack.assets.push({ kind: 'machine', ...machine });
      }

      pack.hrAudit = listHrAuditEventsGlobal(db, { viewAll: true }, { limit: 500 })
        .filter((e) => e.entityId === c.id || e.details?.caseId === c.id)
        .slice(0, limit);

      if (hrTableExists(db, 'audit_log')) {
        const dateFrom = incidentDate ? String(incidentDate).slice(0, 10) : null;
        let sql = `SELECT id, occurred_at_iso, actor_name, action, entity_kind, entity_id, note
                   FROM audit_log WHERE 1=1`;
        const args = [];
        if (branchId) {
          sql += ` AND (entity_id = ? OR entity_id = ? OR note LIKE ?)`;
          args.push(c.id, reg.id, `%${c.id}%`);
        }
        if (dateFrom) {
          sql += ` AND date(occurred_at_iso) >= date(?) AND date(occurred_at_iso) <= date(?, '+1 day')`;
          args.push(dateFrom, dateFrom);
        }
        sql += ` ORDER BY occurred_at_iso DESC LIMIT ?`;
        args.push(limit);
        try {
          pack.erpAudit = db.prepare(sql).all(...args);
        } catch {
          pack.erpAudit = [];
        }
      }

      if (hrTableExists(db, 'hr_payroll_line_recoveries')) {
        pack.payrollRecoveries = db
          .prepare(
            `SELECT r.*, s.case_id FROM hr_payroll_line_recoveries r
             JOIN hr_incident_recovery_schedules s ON s.id = r.schedule_id
             WHERE s.case_id = ? ORDER BY r.period_yyyymm DESC LIMIT ?`
          )
          .all(c.id, limit);
      }
    }
  }

  if (incidentDate && branchId && hrTableExists(db, 'hr_daily_roll_calls')) {
    const day = String(incidentDate).slice(0, 10);
    const roll = db.prepare(`SELECT * FROM hr_daily_roll_calls WHERE branch_id = ? AND day_iso = ?`).get(branchId, day);
    if (roll) pack.attendance.push({ kind: 'daily_roll', ...roll, rows: safeJsonParse(roll.rows_json, []) });
  }

  if (hrTableExists(db, 'asset_custody_events')) {
    const assetIds = pack.assets.map((a) => a.id || a.asset_id).filter(Boolean);
    for (const aid of assetIds) {
      const events = db
        .prepare(`SELECT * FROM asset_custody_events WHERE asset_id = ? OR machine_id = ? ORDER BY created_at_iso DESC LIMIT ?`)
        .all(aid, aid, 50);
      pack.custody.push(...events);
    }
  }

  if (hrTableExists(db, 'gate_pass_events') && branchId && incidentDate) {
    pack.gatePasses = db
      .prepare(`SELECT * FROM gate_pass_events WHERE branch_id = ? AND pass_date_iso = ? ORDER BY created_at_iso DESC LIMIT ?`)
      .all(branchId, String(incidentDate).slice(0, 10), 50);
  }

  return { ok: true, pack };
}

export function buildIncidentAuditPackByCaseId(db, caseId, opts = {}) {
  const row = db.prepare(`SELECT registry_id FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  const registryId = row?.registry_id;
  if (!registryId) return { ok: false, error: 'Case has no registry link.' };
  return buildIncidentAuditPack(db, registryId, opts);
}
