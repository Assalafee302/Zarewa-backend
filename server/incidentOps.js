/**
 * Unified incident entry — registry + domain delegation.
 * @module server/incidentOps
 */

import { DEFAULT_BRANCH_ID } from './branches.js';
import { createDisciplineCase, getDisciplineCase } from './hrDisciplineCasesOps.js';
import {
  getIncidentRegistryRow,
  listIncidentRegistry,
  syncRegistryFromDisciplineCase,
  syncRegistryFromMaterialIncident,
  syncRegistryFromOperationalIncident,
  upsertCaseResponsibility,
  upsertIncidentRegistry,
} from './hrAccountabilityOps.js';
import {
  createMaterialIncidentDraft,
  getMaterialIncident,
  materialIncidentsTableReady,
  submitMaterialIncident,
} from './materialIncidentOps.js';
import { appendHrAuditEvent } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';
import crypto from 'node:crypto';

function newOpId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

const OPERATIONAL_TYPE_ALIASES = {
  asset_loss: 'missing_asset',
  missing_pump: 'missing_asset',
};

function normalizeOperationalType(raw) {
  const t = String(raw || 'missing_asset').trim();
  return OPERATIONAL_TYPE_ALIASES[t] || t;
}

function normalizeInvolvedParties(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({
      userId: String(p?.userId || '').trim(),
      role: String(p?.role || 'other').trim(),
      responsibilityWeight: Number(p?.responsibilityWeight ?? p?.responsibility_weight),
      contributionType: String(p?.contributionType || p?.contribution_type || 'negligence').trim(),
      note: String(p?.note || '').trim() || null,
    }))
    .filter((p) => p.userId);
}

function seedCaseResponsibilityFromParties(db, actor, caseId, payload) {
  const parties = normalizeInvolvedParties(payload?.involvedParties);
  if (!parties.length) return null;
  return upsertCaseResponsibility(db, actor, caseId, parties);
}

function involvedStaffIdsFromParties(parties) {
  return parties.map((p) => p.userId).filter(Boolean);
}

export function createPositivePerformanceRecord(db, payload, actor, opts = {}) {
  if (!hrTableExists(db, 'hr_performance_recognitions')) {
    return { ok: false, error: 'Performance recognition module not migrated.' };
  }
  const userId = String(payload.userId || '').trim();
  const summary = String(payload.summary || payload.description || '').trim();
  if (!userId) return { ok: false, error: 'userId is required for performance recognition.' };
  if (summary.length < 10) return { ok: false, error: 'Summary (min 10 chars) is required.' };
  const branchId = String(opts.workspaceBranchId || payload.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const now = new Date().toISOString();
  const id = newOpId('HRPERF');
  const metric = {
    outputAboveTargetPct: payload.outputAboveTargetPct ?? payload.metric?.outputAboveTargetPct ?? null,
    ...(payload.metric && typeof payload.metric === 'object' ? payload.metric : {}),
  };
  db.prepare(
    `INSERT INTO hr_performance_recognitions (
      id, user_id, branch_id, metric_json, summary, bonus_eligible, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    branchId,
    JSON.stringify(metric),
    summary,
    payload.bonusEligible === false ? 0 : 1,
    now,
    actor?.id || null
  );
  const reg = upsertIncidentRegistry(db, {
    incidentKind: 'performance',
    sourceId: id,
    incidentType: String(payload.incidentType || payload.type || 'performance_excellence').trim(),
    severity: 'low',
    status: 'open',
    branchId,
    reporterUserId: actor?.id || null,
    subjectUserId: userId,
    linkedEntities: [],
    summary,
  });
  if (reg.ok && reg.id) {
    db.prepare(`UPDATE hr_performance_recognitions SET registry_id = ? WHERE id = ?`).run(reg.id, id);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.performance.recognition',
    entityKind: 'hr_performance_recognition',
    entityId: id,
    branchId,
    details: { userId, bonusEligible: payload.bonusEligible !== false, metric },
  });
  return {
    ok: true,
    id,
    registryId: reg.ok ? reg.id : null,
    incidentKind: 'performance',
    routedTo: 'recognition',
    bonusEligibilitySuggested: payload.bonusEligible !== false,
    disciplineCaseCreated: false,
  };
}

export function createOperationalIncident(db, payload, actor, opts = {}) {
  if (!hrTableExists(db, 'operational_incidents')) {
    return { ok: false, error: 'Operational incidents module not migrated.' };
  }
  const branchId = String(opts.workspaceBranchId || payload.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const summary = String(payload.summary || payload.description || payload.title || '').trim();
  if (summary.length < 10) return { ok: false, error: 'Summary (min 10 chars) is required.' };
  const incidentType = normalizeOperationalType(payload.incidentType || payload.type);
  const allowed = new Set(['missing_asset', 'unauthorized_movement', 'custody_breach', 'damage']);
  if (!allowed.has(incidentType)) return { ok: false, error: 'Invalid operational incident type.' };
  const now = new Date().toISOString();
  const id = newOpId('OPINC');
  const userId = String(payload.userId || payload.subjectUserId || '').trim() || null;
  const lossNgn = payload.lossValueNgn != null ? Math.max(0, Math.round(Number(payload.lossValueNgn) || 0)) : null;
  db.prepare(
    `INSERT INTO operational_incidents (
      id, branch_id, incident_type, asset_id, machine_id, loss_value_ngn, summary, status,
      severity, subject_user_id, reported_by_user_id, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    branchId,
    incidentType,
    String(payload.assetId || '').trim() || null,
    String(payload.machineId || '').trim() || null,
    lossNgn,
    summary,
    'open',
    String(payload.severity || 'medium').trim(),
    userId,
    actor?.id || null,
    now,
    now
  );
  const reg = syncRegistryFromOperationalIncident(db, id);

  let caseId = null;
  let caseRegistryId = null;
  let responsibilitySeeded = false;
  const involvedParties = normalizeInvolvedParties(payload.involvedParties);
  const openCase = payload.createDisciplineCase !== false && lossNgn > 0 && userId;
  if (openCase) {
    const dc = createDisciplineCase(db, actor, {
      userId,
      branchId,
      description: summary,
      summary: String(payload.title || summary).slice(0, 500),
      caseType: 'property_damage',
      severity: payload.severity || 'critical',
      lossValueNgn: lossNgn,
      assetId: payload.assetId,
      incidentDateIso: payload.incidentDateIso || now.slice(0, 10),
      meta: {
        operationalIncidentId: id,
        location: payload.location || null,
        shift: payload.shift || null,
        title: payload.title || null,
        involvedStaffIds: involvedParties.length
          ? involvedStaffIdsFromParties(involvedParties)
          : Array.isArray(payload.involvedStaffIds)
            ? payload.involvedStaffIds
            : [],
      },
    });
    if (dc.ok) {
      caseId = dc.id;
      const seed = seedCaseResponsibilityFromParties(db, actor, caseId, { involvedParties });
      responsibilitySeeded = Boolean(seed?.ok);
      const sr = syncRegistryFromDisciplineCase(db, caseId);
      caseRegistryId = sr.ok ? sr.id : null;
      if (reg.ok && reg.id && caseRegistryId) {
        const linked = [
          { kind: 'hr_discipline_case', id: caseId, label: dc.caseNumber || caseId },
          ...(payload.assetId ? [{ kind: 'fixed_asset', id: payload.assetId, label: payload.assetId }] : []),
        ];
        db.prepare(`UPDATE incident_registry SET linked_entities_json = ? WHERE id = ?`).run(
          JSON.stringify(linked),
          reg.id
        );
      }
    }
  }

  return {
    ok: true,
    id,
    registryId: reg.ok ? reg.id : null,
    caseId,
    caseRegistryId,
    responsibilitySeeded,
    incidentKind: 'operational',
    status: 'open',
    incident: db.prepare(`SELECT * FROM operational_incidents WHERE id = ?`).get(id),
  };
}

export function createIncident(db, payload, actor, opts = {}) {
  const category = String(payload.incidentCategory || payload.category || 'hr').trim().toLowerCase();

  if (category === 'performance' || String(payload.incidentType || payload.type || '').trim() === 'performance_excellence') {
    return createPositivePerformanceRecord(db, payload, actor, opts);
  }

  if (category === 'hr' || category === 'discipline') {
    const involvedParties = normalizeInvolvedParties(payload.involvedParties);
    const casePayload = { ...payload };
    if (involvedParties.length) {
      const prevMeta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
      casePayload.meta = {
        ...prevMeta,
        involvedStaffIds: involvedStaffIdsFromParties(involvedParties),
      };
    }
    const r = createDisciplineCase(db, actor, casePayload);
    if (!r.ok) return r;
    const seed = seedCaseResponsibilityFromParties(db, actor, r.id, { involvedParties });
    const reg = syncRegistryFromDisciplineCase(db, r.id);
    const c = getDisciplineCase(db, r.id);
    return {
      ok: true,
      registryId: reg.ok ? reg.id : null,
      incidentKind: 'hr_discipline',
      sourceId: r.id,
      caseId: r.id,
      caseNumber: r.caseNumber,
      responsibilitySeeded: Boolean(seed?.ok),
      status: c?.status || 'open',
      incident: c,
    };
  }

  if (category === 'material') {
    if (!materialIncidentsTableReady(db)) return { ok: false, error: 'Material incidents not migrated.' };
    const draft = createMaterialIncidentDraft(db, payload, opts);
    if (!draft.ok) return draft;
    let status = 'draft';
    if (payload.submit !== false) {
      const sub = submitMaterialIncident(db, draft.id, opts);
      if (sub.ok) status = 'submitted';
    }
    syncRegistryFromMaterialIncident(db, draft.id);
    return {
      ok: true,
      registryId: null,
      incidentKind: 'material',
      sourceId: draft.id,
      status,
      incident: getMaterialIncident(db, draft.id),
    };
  }

  if (category === 'operational') {
    return createOperationalIncident(db, payload, actor, opts);
  }

  return { ok: false, error: 'incidentCategory must be hr, material, operational, or performance.' };
}

export function getIncident(db, registryId) {
  const reg = getIncidentRegistryRow(db, registryId);
  if (!reg) return { ok: false, error: 'Incident not found.' };
  let detail = null;
  if (reg.incidentKind === 'hr_discipline') {
    detail = getDisciplineCase(db, reg.sourceId);
  } else if (reg.incidentKind === 'material') {
    detail = getMaterialIncident(db, reg.sourceId);
  } else if (reg.incidentKind === 'operational' && hrTableExists(db, 'operational_incidents')) {
    detail = db.prepare(`SELECT * FROM operational_incidents WHERE id = ?`).get(reg.sourceId);
  } else if (reg.incidentKind === 'performance' && hrTableExists(db, 'hr_performance_recognitions')) {
    detail = db.prepare(`SELECT * FROM hr_performance_recognitions WHERE id = ?`).get(reg.sourceId);
  }
  return { ok: true, registry: reg, detail };
}

export function listIncidents(db, scope, filters = {}) {
  const rows = listIncidentRegistry(db, scope, filters);
  return { ok: true, incidents: rows };
}

export function listPerformanceRecognitions(db, scope, filters = {}) {
  if (!hrTableExists(db, 'hr_performance_recognitions')) {
    return { ok: true, recognitions: [] };
  }
  const params = [];
  let sql = `
    SELECT
      p.id,
      p.user_id AS userId,
      p.branch_id AS branchId,
      p.metric_json AS metricJson,
      p.summary,
      p.bonus_eligible AS bonusEligible,
      p.registry_id AS registryId,
      p.created_at_iso AS createdAtIso,
      p.created_by_user_id AS createdByUserId,
      u.display_name AS staffDisplayName
    FROM hr_performance_recognitions p
    LEFT JOIN app_users u ON u.id = p.user_id
    WHERE 1=1
  `;
  if (!scope.viewAll && scope.branchId) {
    sql += ` AND p.branch_id = ?`;
    params.push(String(scope.branchId).trim());
  }
  const userId = String(filters.userId || '').trim();
  if (userId) {
    sql += ` AND p.user_id = ?`;
    params.push(userId);
  }
  sql += ` ORDER BY p.created_at_iso DESC LIMIT 200`;
  const rows = db.prepare(sql).all(...params);
  return {
    ok: true,
    recognitions: rows.map((row) => {
      let metric = {};
      try {
        metric = JSON.parse(row.metricJson || '{}');
      } catch {
        metric = {};
      }
      return {
        id: row.id,
        userId: row.userId,
        branchId: row.branchId,
        summary: row.summary,
        bonusEligible: Boolean(row.bonusEligible),
        registryId: row.registryId,
        createdAtIso: row.createdAtIso,
        createdByUserId: row.createdByUserId,
        staffDisplayName: row.staffDisplayName,
        metric,
      };
    }),
  };
}

export { listIncidentRegistry, getIncidentRegistryRow };

export function escalateIncidentMemo(db, memoId, actor, body = {}) {
  if (!hrTableExists(db, 'hr_incident_memos')) {
    return { ok: false, error: 'HR incident tables not initialised.' };
  }
  const memo = db.prepare(`SELECT * FROM hr_incident_memos WHERE id = ?`).get(String(memoId || '').trim());
  if (!memo) return { ok: false, error: 'Incident memo not found.' };
  if (memo.discipline_case_id) {
    return { ok: true, caseId: memo.discipline_case_id, alreadyEscalated: true };
  }
  const r = createDisciplineCase(db, actor, {
    userId: memo.user_id,
    branchId: memo.branch_id,
    incidentDateIso: memo.incident_date_iso,
    summary: String(body?.summary || memo.summary).trim(),
    description: String(body?.summary || memo.summary).trim(),
    caseType: String(body?.kind || body?.caseType || 'investigation').trim(),
    severity: String(body?.severity || 'medium').trim(),
  });
  if (!r.ok) return r;
  const reg = syncRegistryFromDisciplineCase(db, r.id);
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE hr_incident_memos SET status = 'escalated', discipline_case_id = ?, registry_id = ?, updated_at_iso = ? WHERE id = ?`
    ).run(r.id, reg.ok ? reg.id : null, now, memo.id);
  } catch {
    db.prepare(`UPDATE hr_incident_memos SET status = 'escalated', updated_at_iso = ? WHERE id = ?`).run(now, memo.id);
  }
  return { ok: true, caseId: r.id, caseNumber: r.caseNumber, registryId: reg.ok ? reg.id : null };
}
