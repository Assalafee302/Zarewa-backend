/**
 * Persistence for ai_action_proposals.
 *
 * @module server/aiAutomationEngine/repository/proposalRepository
 */

import {
  PROPOSAL_STATUSES,
} from '../../../shared/lib/aiAutomation/proposalTypes.js';

function nowIso() {
  return new Date().toISOString();
}

export function newProposalId() {
  return `AIP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(String(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function proposalsTableReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_action_proposals'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {object} row
 */
export function mapProposalRow(row) {
  if (!row) return null;
  return {
    proposalId: row.id,
    id: row.id,
    type: row.type,
    source: row.source,
    title: row.title,
    description: row.description || '',
    suggestedAction: safeJsonParse(row.payload_json, {}).suggestedAction || null,
    payload: safeJsonParse(row.payload_json, {}),
    confidence: row.confidence_score,
    riskLevel: row.risk_level,
    requiredApprovalLevel: row.required_approval_level,
    linkedEntity: row.linked_entity_id
      ? { type: row.linked_entity_type, id: row.linked_entity_id }
      : null,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at_iso,
    updatedAt: row.updated_at_iso,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at_iso || null,
    rejectedBy: row.rejected_by || null,
    rejectedAt: row.rejected_at_iso || null,
    rejectionReason: row.rejection_reason || null,
    executedAt: row.executed_at_iso || null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} record
 */
export function insertProposal(db, record) {
  const now = nowIso();
  const id = record.id || newProposalId();
  db.prepare(
    `INSERT INTO ai_action_proposals (
      id, type, source, title, description, payload_json, confidence_score, risk_level,
      required_approval_level, status, linked_entity_type, linked_entity_id,
      created_by, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    record.type,
    record.source,
    record.title,
    record.description || '',
    JSON.stringify(record.payload || {}),
    record.confidence_score ?? null,
    record.risk_level || 'low',
    record.required_approval_level || null,
    record.status || PROPOSAL_STATUSES.PENDING,
    record.linked_entity_type || null,
    record.linked_entity_id || null,
    record.created_by || null,
    record.created_at_iso || now,
    record.updated_at_iso || now
  );
  return getProposalById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function getProposalById(db, id) {
  const row = db.prepare(`SELECT * FROM ai_action_proposals WHERE id = ?`).get(String(id || '').trim());
  return mapProposalRow(row);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} filter
 */
export function listProposals(db, filter = {}) {
  const clauses = ['1=1'];
  const params = [];

  if (filter.status) {
    clauses.push('status = ?');
    params.push(String(filter.status));
  }
  if (filter.type) {
    clauses.push('type = ?');
    params.push(String(filter.type));
  }
  if (filter.createdBy) {
    clauses.push('created_by = ?');
    params.push(String(filter.createdBy));
  }
  if (filter.linkedEntityType) {
    clauses.push('linked_entity_type = ?');
    params.push(String(filter.linkedEntityType));
  }
  if (filter.linkedEntityId) {
    clauses.push('linked_entity_id = ?');
    params.push(String(filter.linkedEntityId));
  }

  const limit = Math.min(100, Math.max(1, Number(filter.limit) || 50));
  const offset = Math.max(0, Number(filter.offset) || 0);

  const rows = db
    .prepare(
      `SELECT * FROM ai_action_proposals
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at_iso DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  return rows.map(mapProposalRow);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {object} patch
 */
export function updateProposal(db, id, patch) {
  const now = nowIso();
  const fields = [];
  const params = [];

  const allowed = [
    'status',
    'approved_by',
    'approved_at_iso',
    'rejected_by',
    'rejected_at_iso',
    'rejection_reason',
    'executed_at_iso',
    'payload_json',
    'description',
  ];

  for (const key of allowed) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(patch[key]);
    }
  }

  if (!fields.length) return getProposalById(db, id);

  fields.push('updated_at_iso = ?');
  params.push(now);
  params.push(String(id));

  db.prepare(`UPDATE ai_action_proposals SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getProposalById(db, id);
}
