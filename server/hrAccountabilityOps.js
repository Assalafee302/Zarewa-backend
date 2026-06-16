/**
 * HR accountability — registry sync, responsibility validation, closure gates, decision actions.
 * @module server/hrAccountabilityOps
 */

import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { hrTableExists } from './hrTableChecks.js';
import { nextIncidentRegistryHumanId } from './humanId.js';

export const INCIDENT_KINDS = new Set(['hr_discipline', 'material', 'operational', 'performance']);
export const RESPONSIBILITY_ROLES = new Set([
  'custodian',
  'supervisor',
  'security',
  'operator',
  'approver',
  'other',
]);
export const CONTRIBUTION_TYPES = new Set(['action', 'omission', 'negligence']);
export const DECISION_TYPES = new Set(['warning', 'deduction', 'suspension', 'termination', 'no_action']);

const DECISION_TYPE_ALIASES = {
  salary_deduction: 'deduction',
  financial_recovery: 'deduction',
  recover_salary: 'deduction',
};

export function normalizeDecisionType(raw) {
  const dt = String(raw || '').trim().toLowerCase();
  if (!dt) return '';
  return DECISION_TYPE_ALIASES[dt] || dt;
}

/** High-risk case types require asset, staff, and location before opening a case. */
export function validateHighRiskDisciplinePayload(body = {}) {
  const caseType = String(body.caseType || body.offenceCategory || '').trim();
  if (caseType !== 'theft_fraud') return { ok: true };
  const errors = [];
  if (!String(body.userId || '').trim()) errors.push('Staff assignment is required for theft/fraud cases.');
  if (!String(body.assetId || '').trim()) errors.push('Asset ID is required for theft/fraud cases.');
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
  const loc = String(body.location || body.locationLabel || meta.location || '').trim();
  if (!loc) errors.push('Location is required for theft/fraud cases.');
  if (errors.length) return { ok: false, error: errors.join(' '), errors };
  return { ok: true };
}

const TERMINAL_REGISTRY_STATUSES = new Set(['closed', 'cancelled', 'posted', 'voided', 'rejected']);

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function incidentRegistryTableReady(db) {
  return hrTableExists(db, 'incident_registry');
}

export function responsibilityMapTableReady(db) {
  return hrTableExists(db, 'incident_responsibility_map');
}

export function mapRegistryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    incidentKind: row.incident_kind,
    sourceId: row.source_id,
    incidentType: row.incident_type || '',
    severity: row.severity || 'medium',
    status: row.status,
    branchId: row.branch_id,
    reporterUserId: row.reporter_user_id || null,
    subjectUserId: row.subject_user_id || null,
    linkedEntities: safeJsonParse(row.linked_entities_json, []),
    summary: row.summary || '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

export function upsertIncidentRegistry(db, payload = {}) {
  if (!incidentRegistryTableReady(db)) return { ok: false, error: 'Incident registry not migrated.' };
  const incidentKind = String(payload.incidentKind || '').trim();
  const sourceId = String(payload.sourceId || '').trim();
  if (!INCIDENT_KINDS.has(incidentKind) || !sourceId) {
    return { ok: false, error: 'incidentKind and sourceId are required.' };
  }
  const existing = db
    .prepare(`SELECT id FROM incident_registry WHERE incident_kind = ? AND source_id = ?`)
    .get(incidentKind, sourceId);
  const now = nowIso();
  const branchId = String(payload.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const linkedJson = JSON.stringify(Array.isArray(payload.linkedEntities) ? payload.linkedEntities : []);
  if (existing?.id) {
    db.prepare(
      `UPDATE incident_registry SET
        incident_type = ?, severity = ?, status = ?, branch_id = ?,
        reporter_user_id = ?, subject_user_id = ?, linked_entities_json = ?,
        summary = ?, updated_at_iso = ?
      WHERE id = ?`
    ).run(
      String(payload.incidentType || '').trim() || null,
      String(payload.severity || 'medium').trim(),
      String(payload.status || 'open').trim(),
      branchId,
      payload.reporterUserId || null,
      payload.subjectUserId || null,
      linkedJson,
      String(payload.summary || '').slice(0, 500),
      now,
      existing.id
    );
    return { ok: true, id: existing.id, created: false };
  }
  const id = String(payload.id || '').trim() || nextIncidentRegistryHumanId(db, branchId);
  db.prepare(
    `INSERT INTO incident_registry (
      id, incident_kind, source_id, incident_type, severity, status, branch_id,
      reporter_user_id, subject_user_id, linked_entities_json, summary, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    incidentKind,
    sourceId,
    String(payload.incidentType || '').trim() || null,
    String(payload.severity || 'medium').trim(),
    String(payload.status || 'open').trim(),
    branchId,
    payload.reporterUserId || null,
    payload.subjectUserId || null,
    linkedJson,
    String(payload.summary || '').slice(0, 500),
    now,
    now
  );
  return { ok: true, id, created: true };
}

export function syncRegistryFromDisciplineCase(db, caseId) {
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Case not found.' };
  const linked = [];
  if (row.asset_id) linked.push({ kind: 'fixed_asset', id: row.asset_id, label: row.asset_id });
  if (row.machine_id) linked.push({ kind: 'machine', id: row.machine_id, label: row.machine_id });
  const r = upsertIncidentRegistry(db, {
    id: row.registry_id || undefined,
    incidentKind: 'hr_discipline',
    sourceId: row.id,
    incidentType: row.case_type || row.offence_category || 'query',
    severity: row.severity || 'medium',
    status: row.status,
    branchId: row.branch_id,
    reporterUserId: row.reported_by_user_id || row.opened_by_user_id,
    subjectUserId: row.user_id,
    linkedEntities: linked,
    summary: row.summary || row.description || '',
  });
  if (r.ok && r.id && row.registry_id !== r.id) {
    try {
      db.prepare(`UPDATE hr_discipline_cases SET registry_id = ? WHERE id = ?`).run(r.id, row.id);
    } catch {
      /* column optional pre-migration */
    }
  }
  return r;
}

export function syncRegistryFromMaterialIncident(db, incidentId) {
  const row = db.prepare(`SELECT * FROM material_incidents WHERE id = ?`).get(String(incidentId || '').trim());
  if (!row) return { ok: false, error: 'Material incident not found.' };
  return upsertIncidentRegistry(db, {
    incidentKind: 'material',
    sourceId: row.id,
    incidentType: row.incident_type,
    severity: 'medium',
    status: row.status,
    branchId: row.branch_id,
    reporterUserId: row.created_by_user_id,
    subjectUserId: row.storekeeper_user_id || null,
    linkedEntities: row.coil_no ? [{ kind: 'coil', id: row.coil_no, label: row.coil_no }] : [],
    summary: `${row.incident_type} · ${row.gauge_label || ''} ${row.colour || ''}`.trim(),
  });
}

export function syncRegistryFromOperationalIncident(db, incidentId) {
  const row = db.prepare(`SELECT * FROM operational_incidents WHERE id = ?`).get(String(incidentId || '').trim());
  if (!row) return { ok: false, error: 'Operational incident not found.' };
  const linked = [];
  if (row.asset_id) linked.push({ kind: 'fixed_asset', id: row.asset_id, label: row.asset_id });
  if (row.machine_id) linked.push({ kind: 'machine', id: row.machine_id, label: row.machine_id });
  const r = upsertIncidentRegistry(db, {
    id: row.registry_id || undefined,
    incidentKind: 'operational',
    sourceId: row.id,
    incidentType: row.incident_type,
    severity: row.severity || 'medium',
    status: row.status,
    branchId: row.branch_id,
    reporterUserId: row.reported_by_user_id,
    subjectUserId: row.subject_user_id || null,
    linkedEntities: linked,
    summary: row.summary || '',
  });
  if (r.ok && r.id && row.registry_id !== r.id) {
    db.prepare(`UPDATE operational_incidents SET registry_id = ? WHERE id = ?`).run(r.id, row.id);
  }
  return r;
}

/**
 * When a discipline case closes, propagate terminal status to linked operational/material sources.
 */
export function finalizeLinkedIncidentsOnCaseClose(db, caseId, caseStatus = 'closed') {
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, error: 'Case not found.' };
  const meta = safeJsonParse(row.meta_json, {});
  const terminalStatus = String(caseStatus || 'closed').trim().toLowerCase() === 'cancelled' ? 'cancelled' : 'closed';
  const now = nowIso();
  const synced = [];

  const opId = String(meta.operationalIncidentId || '').trim();
  if (opId && hrTableExists(db, 'operational_incidents')) {
    db.prepare(`UPDATE operational_incidents SET status = ?, updated_at_iso = ? WHERE id = ?`).run(terminalStatus, now, opId);
    const sr = syncRegistryFromOperationalIncident(db, opId);
    if (sr.ok) synced.push({ kind: 'operational', id: opId, registryId: sr.id });
  }

  return { ok: true, synced };
}

export function listIncidentRegistry(db, scope, filters = {}) {
  if (!incidentRegistryTableReady(db)) return [];
  let sql = `SELECT * FROM incident_registry WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(scope?.branchId || DEFAULT_BRANCH_ID);
  }
  if (filters.incidentKind) {
    sql += ` AND incident_kind = ?`;
    args.push(String(filters.incidentKind).trim());
  }
  if (filters.status) {
    sql += ` AND status = ?`;
    args.push(String(filters.status).trim());
  }
  if (filters.severity) {
    sql += ` AND severity = ?`;
    args.push(String(filters.severity).trim());
  }
  if (filters.openOnly) {
    sql += ` AND status NOT IN ('closed','cancelled','posted','voided','rejected')`;
  }
  sql += ` ORDER BY updated_at_iso DESC LIMIT ?`;
  args.push(Math.min(500, Math.max(1, Number(filters.limit) || 200)));
  return db.prepare(sql).all(...args).map(mapRegistryRow);
}

export function getIncidentRegistryRow(db, registryId) {
  if (!incidentRegistryTableReady(db)) return null;
  const row = db.prepare(`SELECT * FROM incident_registry WHERE id = ?`).get(String(registryId || '').trim());
  return mapRegistryRow(row);
}

export function countOpenIncidents(db, branchId = null) {
  if (!incidentRegistryTableReady(db)) return 0;
  if (branchId) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM incident_registry WHERE branch_id = ? AND status NOT IN ('closed','cancelled','posted','voided','rejected')`
        )
        .get(branchId)?.c || 0
    );
  }
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM incident_registry WHERE status NOT IN ('closed','cancelled','posted','voided','rejected')`
      )
      .get()?.c || 0
  );
}

export function listCaseResponsibility(db, caseId) {
  if (!responsibilityMapTableReady(db)) return [];
  return db
    .prepare(
      `SELECT r.*, u.display_name AS staffDisplayName
       FROM incident_responsibility_map r
       LEFT JOIN app_users u ON u.id = r.user_id
       WHERE r.case_id = ?
       ORDER BY r.responsibility_weight DESC, r.created_at_iso ASC`
    )
    .all(String(caseId || '').trim())
    .map((row) => ({
      id: row.id,
      caseId: row.case_id,
      userId: row.user_id,
      staffDisplayName: row.staffDisplayName || row.user_id,
      role: row.role,
      responsibilityWeight: Number(row.responsibility_weight) || 0,
      contributionType: row.contribution_type,
      note: row.note || '',
      createdAtIso: row.created_at_iso,
      createdByUserId: row.created_by_user_id,
    }));
}

export function validateResponsibilityParties(parties) {
  if (!Array.isArray(parties) || !parties.length) {
    return { ok: false, error: 'At least one responsible party is required.' };
  }
  let sum = 0;
  for (const p of parties) {
    const uid = String(p.userId || '').trim();
    if (!uid) return { ok: false, error: 'Each party must have userId.' };
    const role = String(p.role || 'other').trim();
    if (!RESPONSIBILITY_ROLES.has(role)) return { ok: false, error: `Invalid role: ${role}` };
    const ct = String(p.contributionType || p.contribution_type || 'negligence').trim();
    if (!CONTRIBUTION_TYPES.has(ct)) return { ok: false, error: `Invalid contribution type: ${ct}` };
    const w = Number(p.responsibilityWeight ?? p.responsibility_weight);
    if (!Number.isFinite(w) || w <= 0 || w > 100) {
      return { ok: false, error: 'Each weight must be between 0 and 100.' };
    }
    sum += w;
  }
  if (Math.abs(sum - 100) > 0.01) {
    return { ok: false, error: `Responsibility weights must sum to 100% (current: ${sum.toFixed(1)}%).` };
  }
  return { ok: true };
}

export function upsertCaseResponsibility(db, actor, caseId, parties = []) {
  if (!responsibilityMapTableReady(db)) return { ok: false, error: 'Responsibility map not migrated.' };
  const cid = String(caseId || '').trim();
  const cur = db.prepare(`SELECT id FROM hr_discipline_cases WHERE id = ?`).get(cid);
  if (!cur) return { ok: false, error: 'Case not found.' };
  const v = validateResponsibilityParties(parties);
  if (!v.ok) return v;
  const now = nowIso();
  db.transaction(() => {
    db.prepare(`DELETE FROM incident_responsibility_map WHERE case_id = ?`).run(cid);
    for (const p of parties) {
      db.prepare(
        `INSERT INTO incident_responsibility_map (
          id, case_id, user_id, role, responsibility_weight, contribution_type, note, created_at_iso, created_by_user_id
        ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        newId('HRResp'),
        cid,
        String(p.userId).trim(),
        String(p.role || 'other').trim(),
        Number(p.responsibilityWeight ?? p.responsibility_weight),
        String(p.contributionType || p.contribution_type || 'negligence').trim(),
        String(p.note || '').trim() || null,
        now,
        actor?.id || null
      );
    }
  })();
  return { ok: true, parties: listCaseResponsibility(db, cid) };
}

export function deleteCaseResponsibilityParty(db, actor, caseId, partyId) {
  if (!responsibilityMapTableReady(db)) return { ok: false, error: 'Responsibility map not migrated.' };
  const cid = String(caseId || '').trim();
  const pid = String(partyId || '').trim();
  const row = db.prepare(`SELECT id FROM incident_responsibility_map WHERE id = ? AND case_id = ?`).get(pid, cid);
  if (!row) return { ok: false, error: 'Party not found.' };
  db.prepare(`DELETE FROM incident_responsibility_map WHERE id = ?`).run(pid);
  return { ok: true, parties: listCaseResponsibility(db, cid) };
}

export function assertCaseClosureReady(db, caseId) {
  const blockers = [];
  const row = db.prepare(`SELECT * FROM hr_discipline_cases WHERE id = ?`).get(String(caseId || '').trim());
  if (!row) return { ok: false, blockers: ['Case not found.'] };

  const parties = listCaseResponsibility(db, caseId);
  if (!parties.length) blockers.push('Responsibility map is empty.');
  else {
    const sum = parties.reduce((s, p) => s + (Number(p.responsibilityWeight) || 0), 0);
    if (Math.abs(sum - 100) > 0.01) blockers.push(`Responsibility weights sum to ${sum.toFixed(1)}% (must be 100%).`);
  }

  const decisionType = normalizeDecisionType(row.decision_type);
  if (!decisionType || !DECISION_TYPES.has(decisionType)) {
    blockers.push('Structured decision_type is required before closure.');
  }

  const lossNgn = Math.round(Number(row.loss_value_ngn) || 0);
  if (lossNgn > 0 && decisionType === 'deduction') {
    if (!hrTableExists(db, 'hr_incident_recovery_schedules')) {
      blockers.push('Recovery schedules module not migrated.');
    } else {
      const schedules = db
        .prepare(
          `SELECT status FROM hr_incident_recovery_schedules WHERE case_id = ? AND status NOT IN ('cancelled','completed')`
        )
        .all(row.id);
      if (!schedules.length) blockers.push('Active recovery schedules required for deduction decisions with financial impact.');
    }
    if (parties.length) {
      const letters = safeJsonParse(row.related_letter_ids_json, []);
      if (!Array.isArray(letters) || letters.length < parties.length) {
        blockers.push('Salary recovery letters required for each responsible party before closure.');
      } else {
        blockers.push(...letterIssuanceBlockers(db, letters, { parties, letterKind: 'salary_recovery' }));
      }
    }
  }

  if (decisionType === 'suspension') {
    const prof = db.prepare(`SELECT profile_extra_json FROM hr_staff_profiles WHERE user_id = ?`).get(row.user_id);
    const extra = safeJsonParse(prof?.profile_extra_json, {});
    const st = String(extra?.employmentMeta?.salaryStatus || '').toLowerCase();
    if (!['held', 'suspended'].includes(st)) {
      blockers.push('Salary hold/suspension must be applied on staff profile for suspension decisions.');
    }
  }

  if (['warning', 'termination'].includes(decisionType)) {
    const letters = safeJsonParse(row.related_letter_ids_json, []);
    if (!Array.isArray(letters) || !letters.length) {
      blockers.push('At least one linked letter is required for this decision type.');
    } else {
      blockers.push(...letterIssuanceBlockers(db, letters, { requireAnyIssued: true }));
    }
  }

  return blockers.length ? { ok: false, blockers } : { ok: true, blockers: [] };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} letterIds
 * @param {{ parties?: object[]; letterKind?: string; requireAnyIssued?: boolean }} opts
 */
export function letterIssuanceBlockers(db, letterIds, opts = {}) {
  const blockers = [];
  const ids = [...new Set((letterIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return blockers;
  if (!hrTableExists(db, 'hr_employment_letters')) {
    blockers.push('Employment letters module not migrated.');
    return blockers;
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT l.id, l.user_id, l.letter_kind, l.status, l.reference_number, u.display_name AS staffDisplayName
       FROM hr_employment_letters l
       LEFT JOIN app_users u ON u.id = l.user_id
       WHERE l.id IN (${placeholders})`
    )
    .all(...ids);

  const letterKind = String(opts.letterKind || '').trim();
  const parties = Array.isArray(opts.parties) ? opts.parties : [];

  if (letterKind === 'salary_recovery' && parties.length) {
    for (const p of parties) {
      const uid = String(p.userId || '').trim();
      const label = p.staffDisplayName || uid || 'party';
      const letter = rows.find((r) => r.user_id === uid && r.letter_kind === 'salary_recovery');
      if (!letter) {
        blockers.push(`Salary recovery letter missing for ${label}.`);
      } else if (String(letter.status) !== 'issued') {
        blockers.push(`Salary recovery letter for ${label} must be issued (currently ${letter.status}).`);
      }
    }
    return blockers;
  }

  if (opts.requireAnyIssued) {
    const anyIssued = rows.some((r) => String(r.status) === 'issued');
    if (!anyIssued) {
      blockers.push('At least one linked sanction letter must be issued before closure.');
    }
  }

  return blockers;
}

export function isTerminalIncidentStatus(status) {
  return TERMINAL_REGISTRY_STATUSES.has(String(status || '').trim().toLowerCase());
}
